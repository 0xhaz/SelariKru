import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join, posix } from 'node:path';

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
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(relPath);
      } else if (ignoredFile(e.name)) {
        continue;
      } else if (e.isSymbolicLink()) {
        out.set(relPath, { kind: 'symlink', sha256: null, executable: false, linkTarget: await readlink(abs) });
      } else if (e.isFile()) {
        const st = await lstat(abs);
        const sha256 = createHash('sha256').update(await readFile(abs)).digest('hex');
        out.set(relPath, { kind: 'file', sha256, executable: (st.mode & 0o111) !== 0, linkTarget: null });
      } else {
        out.set(relPath, { kind: 'special', sha256: null, executable: false, linkTarget: null });
      }
    }
  };
  await walk('');
  return out;
}

const same = (a: TreeEntry, b: TreeEntry): boolean =>
  a.kind === b.kind && a.sha256 === b.sha256 && a.executable === b.executable && a.linkTarget === b.linkTarget;

export async function computeChanges(base: TreeSnapshot, root: string): Promise<FileChange[]> {
  const now = await snapshotTree(root);
  const changes: FileChange[] = [];
  for (const [path, e] of now) {
    const old = base.get(path);
    if (!old) changes.push({ path, status: 'added', kind: e.kind, sha256: e.sha256, linkTarget: e.linkTarget });
    else if (!same(old, e)) changes.push({ path, status: 'modified', kind: e.kind, sha256: e.sha256, linkTarget: e.linkTarget });
  }
  for (const path of base.keys()) if (!now.has(path)) changes.push({ path, status: 'deleted', kind: null, sha256: null, linkTarget: null });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface Violation {
  readonly path: string;
  readonly reason: 'outside_allowed_paths' | 'symlink_escape' | 'special_file';
}

function normalizeAllowed(p: string): string {
  if (p === '' || p.includes('\0') || p.includes('\\') || p.startsWith('/')) throw new Error(`invalid allowedPaths entry: ${JSON.stringify(p)}`);
  const n = p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (n === '' || n === '.' || n.split('/').some((s) => s === '..' || s === '.' || s === '')) throw new Error(`invalid allowedPaths entry: ${JSON.stringify(p)}`);
  return n;
}

const escapes = (path: string, target: string): boolean => {
  if (target.startsWith('/') || target.includes('\0')) return true;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved === '..' || resolved.startsWith('../');
};

/**
 * The real control over what an agent changed: the actual diff against the base, not what the agent says it did.
 * An empty `allowedPaths` allows nothing. Matching is by whole path segment.
 */
export function checkAllowedPaths(changes: readonly FileChange[], allowedPaths: readonly string[]): { ok: boolean; violations: Violation[] } {
  const allowed = allowedPaths.map(normalizeAllowed);
  const violations: Violation[] = [];
  for (const c of changes) {
    if (!allowed.some((a) => c.path === a || c.path.startsWith(`${a}/`))) {
      violations.push({ path: c.path, reason: 'outside_allowed_paths' });
    } else if (c.kind === 'special') {
      violations.push({ path: c.path, reason: 'special_file' });
    } else if (c.kind === 'symlink' && c.linkTarget !== null && escapes(c.path, c.linkTarget)) {
      violations.push({ path: c.path, reason: 'symlink_escape' });
    }
  }
  return { ok: violations.length === 0, violations };
}
