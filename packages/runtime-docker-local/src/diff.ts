import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export type EntryKind = 'file' | 'symlink' | 'special';

export interface TreeEntry {
  readonly kind: EntryKind;
  readonly sha256: string | null;
  readonly executable: boolean;
  readonly linkTarget: string | null;
}
export type TreeSnapshot = ReadonlyMap<string, TreeEntry>;

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
  readonly kind: EntryKind | null;
  readonly sha256: string | null;
  readonly linkTarget: string | null;
}

/** Directories never reported as changes: VCS metadata (untrusted after a run, never executed here) and build junk. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const IGNORED_FILES = new Set(['.DS_Store']);
const ignoredFile = (name: string): boolean => IGNORED_FILES.has(name) || name.endsWith('.pyc');

/**
 * Hashes the workspace without following symlinks and without running git or anything else from inside it:
 * after a run the workspace is attacker-controlled, so this reads bytes only.
 */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const out = new Map<string, TreeEntry>();
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true });
    for (const e of entries) {
      const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
      const abs = join(root, relPath);
      if (e.name.toLowerCase() === '.git' && e.name !== '.git') {
        // A differently-cased .git is the same directory on a case-insensitive disk: never ignore it, never descend into it.
        out.set(relPath, { kind: 'special', sha256: null, executable: false, linkTarget: null });
      } else if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(relPath);
      } else if (ignoredFile(e.name)) {
        continue;
      } else if (e.isSymbolicLink()) {
        out.set(relPath, { kind: 'symlink', sha256: null, executable: false, linkTarget: await readlink(abs) });
      } else if (e.isFile()) {
        const st = await lstat(abs);
        let bytes: Buffer;
        try {
          bytes = await readRegularFile(abs);
        } catch {
          // Swapped for a link or special file after listing: record it as such, never read through it.
          out.set(relPath, { kind: 'special', sha256: null, executable: false, linkTarget: null });
          continue;
        }
        out.set(relPath, { kind: 'file', sha256: createHash('sha256').update(bytes).digest('hex'), executable: (st.mode & 0o111) !== 0, linkTarget: null });
      } else {
        out.set(relPath, { kind: 'special', sha256: null, executable: false, linkTarget: null });
      }
    }
  };
  await walk('');
  return out;
}

const hasGitSegment = (path: string): boolean => path.normalize('NFC').toLowerCase().split('/').includes('.git');

/**
 * Reads a regular file without following a symlink at the final component and without trusting an earlier `lstat`:
 * open with O_NOFOLLOW, then `fstat` the descriptor. A file swapped for a link between listing and reading fails here.
 */
export async function readRegularFile(path: string): Promise<Buffer> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

const same = (a: TreeEntry, b: TreeEntry): boolean =>
  a.kind === b.kind && a.sha256 === b.sha256 && a.executable === b.executable && a.linkTarget === b.linkTarget;

/** The base commit's `.gitignore` files, by path, as read from git at that commit. Never the worker's copies. */
export type BaseIgnores = ReadonlyMap<string, Buffer>;

const execFileP = promisify(execFile);
const isolatedGitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });

/**
 * Which of `paths` the base's ignore rules cover. Git decides, in a throwaway repository holding nothing but the base's `.gitignore` files, so neither the worker's
 * files nor this machine's git configuration take part. The worker's path names only go in on stdin. A failure throws: the caller then fails the attempt rather than guessing.
 */
async function ignoredByBase(ignores: BaseIgnores, paths: readonly string[]): Promise<ReadonlySet<string>> {
  if (ignores.size === 0 || paths.length === 0) return new Set();
  const dir = await mkdtemp(join(tmpdir(), 'selarikru-ignore-'));
  try {
    await execFileP('git', ['init', '-q', '--template=', dir], { env: isolatedGitEnv() });
    for (const [path, bytes] of ignores) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), bytes);
    }
    const run = execFileP('git', ['-C', dir, 'check-ignore', '-z', '--stdin'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, env: isolatedGitEnv() });
    run.child.stdin?.on('error', () => undefined);
    run.child.stdin?.end(`${paths.join('\0')}\0`);
    // Exit 1 means nothing matched.
    const stdout = await run.then((r) => r.stdout, (e: { code?: unknown; stdout?: Buffer }) => {
      if (e.code === 1) return e.stdout ?? Buffer.alloc(0);
      throw e;
    });
    return new Set(stdout.toString('utf8').split('\0').filter(Boolean));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * What changed against the base. A new path the base's ignore rules cover is build output and never enters the change set; a path the base tracks is reported whatever the rules
 * say, as in git. `baseIgnores` comes from the base commit, so editing `.gitignore` in the workspace widens nothing: that edit is itself a change.
 */
export async function computeChanges(base: TreeSnapshot, root: string, baseIgnores: BaseIgnores = new Map()): Promise<FileChange[]> {
  const now = await snapshotTree(root);
  const ignored = await ignoredByBase(baseIgnores, [...now.keys()].filter((p) => !base.has(p) && !hasGitSegment(p)));
  const changes: FileChange[] = [];
  for (const [path, e] of now) {
    if (ignored.has(path)) continue;
    const old = base.get(path);
    if (!old) changes.push({ path, status: 'added', kind: e.kind, sha256: e.sha256, linkTarget: e.linkTarget });
    else if (!same(old, e)) changes.push({ path, status: 'modified', kind: e.kind, sha256: e.sha256, linkTarget: e.linkTarget });
  }
  for (const path of base.keys()) if (!now.has(path)) changes.push({ path, status: 'deleted', kind: null, sha256: null, linkTarget: null });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface Violation {
  readonly path: string;
  readonly reason: 'outside_allowed_paths' | 'symlink' | 'special_file' | 'forbidden_path';
}

const GLOB_CHARS = /[*?[\]{}]/;

export type AllowedPathsCheck = { ok: true; normalized: string[] } | { ok: false; reason: string };

/**
 * `allowedPaths` are plain repo-relative file or directory prefixes. No globs, no absolute paths, no `..`, no `.git`.
 * Validated before a sandbox exists, so a bad spec costs no model run.
 */
export function validateAllowedPaths(paths: readonly string[]): AllowedPathsCheck {
  const normalized: string[] = [];
  for (const p of paths) {
    const bad = (why: string): AllowedPathsCheck => ({ ok: false, reason: `invalid allowedPaths entry ${JSON.stringify(p).slice(0, 80)}: ${why}` });
    if (p === '' || p.includes('\0')) return bad('empty or NUL');
    if (p.includes('\\')) return bad('backslash');
    if (p.startsWith('/')) return bad('absolute path');
    if (GLOB_CHARS.test(p)) return bad('globs are not supported');
    const n = p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (n === '' || n === '.') return bad('empty');
    const segs = n.split('/');
    if (segs.some((x) => x === '..' || x === '.' || x === '')) return bad('parent or empty segment');
    if (hasGitSegment(n)) return bad('.git is never allowed');
    normalized.push(n);
  }
  return { ok: true, normalized };
}

/**
 * The real control over what an agent changed: the actual diff against the base, not what the agent says it did.
 * An empty `allowedPaths` allows nothing. Matching is by whole path segment. Every added or modified symlink is rejected,
 * because a link's target cannot be judged lexically (`src/d -> ..` then `src/x -> d/../f` escapes).
 */
export function checkAllowedPaths(changes: readonly FileChange[], allowedPaths: readonly string[]): { ok: boolean; violations: Violation[] } {
  const v = validateAllowedPaths(allowedPaths);
  if (!v.ok) throw new Error(v.reason);
  const allowed = v.normalized;
  const violations: Violation[] = [];
  for (const c of changes) {
    if (hasGitSegment(c.path)) violations.push({ path: c.path, reason: 'forbidden_path' });
    else if (!allowed.some((a) => c.path === a || c.path.startsWith(`${a}/`))) violations.push({ path: c.path, reason: 'outside_allowed_paths' });
    else if (c.kind === 'symlink') violations.push({ path: c.path, reason: 'symlink' });
    else if (c.kind === 'special') violations.push({ path: c.path, reason: 'special_file' });
  }
  return { ok: violations.length === 0, violations };
}
