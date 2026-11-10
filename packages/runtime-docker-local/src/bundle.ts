import { execFile, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { snapshotTree, type TreeSnapshot, type BaseIgnores } from './diff.ts';

const execFileP = promisify(execFile);

/** Git sees no user or system config and no templates while building: nothing outside the repo can inject a hook or filter. */
export const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });

export const REQUIRED_CONTRACT_PATH = 'contract/runtime.md';
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class BundleError extends Error {
  constructor(detail: string) {
    super(`task bundle: ${detail}`);
    this.name = 'BundleError';
  }
}

/** `.env`, `.envrc`, `.env.<anything>` and `.env-<anything>` hold real credentials by convention. The checked-in templates do not, and a task may need to read them. */
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist)$/;
const isEnvFile = (segment: string): boolean => (segment === '.env' || segment === '.envrc' || segment.startsWith('.env.') || segment.startsWith('.env-')) && !ENV_TEMPLATE.test(segment);

/**
 * Paths that never go into a worker's workspace: the private verifier calibration (any depth, any case), VCS metadata, and environment files.
 * Workers never see verifier material (spec: pin the verifier outside worker-writable paths), and a tracked `.env` would put its secrets in front of the model.
 * Excluded from the workspace only: the diff is against what was shipped, so an environment file in the repository is left exactly as it is.
 */
export function isExcludedPath(path: string): boolean {
  const segs = path.normalize('NFC').toLowerCase().split('/');
  return segs.some((s) => s === 'verifier-calibration' || s === '.git' || isEnvFile(s));
}

function safeRel(path: string): string {
  if (path === '' || path.includes('\0') || path.includes('\\') || path.startsWith('/')) throw new BundleError(`unsafe path ${JSON.stringify(path)}`);
  const segs = path.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new BundleError(`unsafe path ${JSON.stringify(path)}`);
  return path;
}

const coveredBy = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((p) => {
    const n = p.replace(/\/+$/, '').toLowerCase();
    const lp = path.toLowerCase();
    return lp === n || lp.startsWith(`${n}/`);
  });

interface TreeItem {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

async function listTree(repo: string, sha: string): Promise<TreeItem[]> {
  const { stdout } = await execFileP('git', ['-C', repo, 'ls-tree', '-r', '-z', '--full-tree', sha], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: gitEnv() });
  const items: TreeItem[] = [];
  for (const rec of stdout.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    if (!mode || !type || !oid) throw new BundleError('unparseable tree listing');
    items.push({ mode, type, oid, path: rec.slice(tab + 1) });
  }
  return items;
}

/** Reads blobs in one `git cat-file --batch` process. */
async function readBlobs(repo: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (oids.length === 0) return out;
  const unique = [...new Set(oids)];
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'], env: gitEnv() });
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new BundleError(`git cat-file exited ${code}`))));
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${unique.join('\n')}\n`);
  });
  const buf = Buffer.concat(chunks);
  let pos = 0;
  for (const oid of unique) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new BundleError('truncated blob stream');
    const [gotOid, type, size] = buf.subarray(pos, nl).toString('utf8').split(' ');
    if (gotOid !== oid || type !== 'blob' || size === undefined) throw new BundleError(`unexpected object ${oid}`);
    const n = Number(size);
    out.set(oid, buf.subarray(nl + 1, nl + 1 + n));
    pos = nl + 1 + n + 1;
  }
  return out;
}

export interface BuildBundleInput {
  readonly repoPath: string;
  readonly baseSha: string;
  /** Per-attempt directory. Must be absent or empty. */
  readonly destDir: string;
  /** Task files, written next to the source. They may not replace source files or name excluded paths. */
  readonly taskFiles?: Readonly<Record<string, string>>;
  /** Further exclusions (path prefixes). They can never exclude `contract/runtime.md`. */
  readonly extraExclude?: readonly string[];
}

export interface TaskBundleResult {
  readonly destDir: string;
  readonly fileCount: number;
  readonly excluded: readonly string[];
  readonly skipped: readonly string[];
  /** Hashes of the workspace as shipped, for the post-run diff. */
  readonly baseline: TreeSnapshot;
  /** The base commit's `.gitignore` files, for the post-run diff. */
  readonly baseIgnores: BaseIgnores;
}

/**
 * Materializes the task input: the source tree AT the pinned SHA (no history, no remote, no origin branch names) plus task
 * files. Built from `git ls-tree`/`cat-file`, not a clone, so excluded material cannot be recovered from git objects.
 */
export async function buildTaskBundle(input: BuildBundleInput): Promise<TaskBundleResult> {
  const { repoPath, baseSha, destDir } = input;
  if (!SHA.test(baseSha)) throw new BundleError('base must be a full lowercase commit id');
  try {
    await execFileP('git', ['-C', repoPath, 'cat-file', '-e', `${baseSha}^{commit}`], { env: gitEnv() });
  } catch {
    throw new BundleError('base commit is not in the source repository');
  }
  try {
    const existing = await readdir(destDir);
    if (existing.length > 0) throw new BundleError('destination is not empty');
  } catch (err) {
    if (err instanceof BundleError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await mkdir(destDir, { recursive: true });

  const extra = (input.extraExclude ?? []).map((p) => p.trim()).filter(Boolean);
  const excluded: string[] = [];
  const skipped: string[] = [];
  const keep: TreeItem[] = [];
  for (const item of await listTree(repoPath, baseSha)) {
    if (item.path !== REQUIRED_CONTRACT_PATH && (isExcludedPath(item.path) || coveredBy(item.path, extra))) {
      if (!item.path.startsWith('.git/')) excluded.push(item.path);
      continue;
    }
    if (item.type !== 'blob') {
      skipped.push(item.path); // submodules
      continue;
    }
    safeRel(item.path);
    keep.push(item);
  }

  const blobs = await readBlobs(repoPath, keep.map((k) => k.oid));
  const written = new Set<string>();
  for (const item of keep) {
    const target = join(destDir, item.path);
    await mkdir(dirname(target), { recursive: true });
    const data = blobs.get(item.oid)!;
    if (item.mode === '120000') {
      const linkTarget = data.toString('utf8');
      const resolved = posix.normalize(posix.join(posix.dirname(item.path), linkTarget));
      if (linkTarget.startsWith('/') || resolved === '..' || resolved.startsWith('../') || isExcludedPath(resolved)) {
        skipped.push(item.path);
        continue;
      }
      await symlink(linkTarget, target);
    } else {
      await writeFile(target, data, { mode: item.mode === '100755' ? 0o755 : 0o644 });
      if (item.mode === '100755') await chmod(target, 0o755);
    }
    written.add(item.path);
  }

  for (const [rel, body] of Object.entries(input.taskFiles ?? {})) {
    safeRel(rel);
    if (isExcludedPath(rel)) throw new BundleError(`task file ${JSON.stringify(rel)} names excluded material`);
    const target = join(destDir, rel);
    const st = await lstat(target).catch(() => null);
    if (st !== null || written.has(rel)) throw new BundleError(`task file ${JSON.stringify(rel)} would replace a source file`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, { mode: 0o644 });
    written.add(rel);
  }

  if (!written.has(REQUIRED_CONTRACT_PATH)) throw new BundleError(`${REQUIRED_CONTRACT_PATH} is missing from the source and the task files`);

  // A fresh single-commit repository so the agent has a usable `git diff`. Nothing from the source history is carried.
  const git = (...a: string[]) => execFileP('git', ['-C', destDir, '-c', 'user.name=selarikru', '-c', 'user.email=runner@selarikru.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { env: gitEnv() });
  await git('init', '-q', '--template=');
  await git('add', '-A');
  await git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'task base');

  // Taken from the commit, before any agent runs, and only from regular files: the workspace's own copies never decide what the gate ignores.
  const ignoreItems = keep.filter((k) => /(^|\/)\.gitignore$/.test(k.path) && (k.mode === '100644' || k.mode === '100755'));
  const baseIgnores = new Map(ignoreItems.map((k) => [k.path, blobs.get(k.oid)!] as const));
  return { destDir, fileCount: written.size, excluded, skipped, baseline: await snapshotTree(destDir), baseIgnores };
}
