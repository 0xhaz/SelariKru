import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export class UnsafeWorkspaceError extends Error {
  constructor(detail: string) {
    super(`unsafe workspace: ${detail}`);
    this.name = 'UnsafeWorkspaceError';
  }
}

export interface WorkspaceRules {
  readonly home: string;
  /** Paths that must not be mounted, contain the workspace or be contained by it (the SelariKru repository, for one). */
  readonly forbidden: readonly string[];
  /** When set, the workspace must be inside this directory (the runner's per-attempt root). */
  readonly attemptsRoot: string | null;
}

const SENSITIVE_HOME_DIRS = ['.claude', '.ssh', '.aws', '.config', '.gnupg', '.docker', '.kube', '.npmrc', '.netrc', '.gitconfig', '.git-credentials', 'Library'];

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);

/** True when a path names a Docker socket, wherever it is. */
const isDockerSocket = (p: string): boolean => /docker\.sock$/i.test(p) || /(^|\/)docker(\.raw)?\.sock/i.test(p);

/**
 * Validates the single directory that becomes the sandbox workspace. Returns the resolved path.
 * Fails closed: anything surprising is refused rather than mounted.
 */
export async function assertSafeWorkspace(path: string, rules: WorkspaceRules): Promise<string> {
  const abs = resolve(path);
  if (abs !== path && abs !== path.replace(/\/+$/, '')) throw new UnsafeWorkspaceError('path must be absolute and normalized');
  const home = resolve(rules.home);
  if (abs === sep) throw new UnsafeWorkspaceError('the filesystem root');
  if (isDockerSocket(abs) || abs === '/var/run' || abs === '/run' || abs === '/var') throw new UnsafeWorkspaceError('docker socket');
  if (within(home, abs)) throw new UnsafeWorkspaceError('the home directory or one of its parents');
  for (const d of SENSITIVE_HOME_DIRS) if (within(abs, join(home, d))) throw new UnsafeWorkspaceError(`credential or config directory ~/${d}`);
  for (const f of rules.forbidden) if (overlaps(abs, resolve(f))) throw new UnsafeWorkspaceError('overlaps a path that is never mounted');
  if (rules.attemptsRoot !== null) {
    const root = resolve(rules.attemptsRoot);
    if (abs === root || !within(abs, root)) throw new UnsafeWorkspaceError('outside the per-attempt work root');
  }
  // Existing directories only, never through a symlink at any level below the work root.
  let st;
  try {
    st = await lstat(abs);
  } catch {
    throw new UnsafeWorkspaceError('does not exist');
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafeWorkspaceError('not a plain directory');
  const real = await realpath(abs);
  if (real !== abs) {
    // macOS maps /var to /private/var. Accept only when the difference is outside the checked tree.
    if (rules.attemptsRoot !== null && !within(real, await realpath(resolve(rules.attemptsRoot)))) throw new UnsafeWorkspaceError('resolves outside the work root');
    if (within(home, real)) throw new UnsafeWorkspaceError('resolves to the home directory');
    for (const f of rules.forbidden) if (overlaps(real, resolve(f))) throw new UnsafeWorkspaceError('resolves into a path that is never mounted');
  }
  if (rules.attemptsRoot !== null) {
    // Every component below the root must itself be a plain directory.
    let cur = abs;
    const root = resolve(rules.attemptsRoot);
    while (cur !== root && cur !== dirname(cur)) {
      const s = await lstat(cur);
      if (s.isSymbolicLink()) throw new UnsafeWorkspaceError('symlink inside the work root');
      cur = dirname(cur);
    }
  }
  return abs;
}

/** Audits what `sbx ls --json` says is mounted. Returns the violations; empty means the mounts are exactly the workspace. */
export function auditMounts(mounts: readonly string[], workspace: string, rules: { home: string }): string[] {
  const out: string[] = [];
  let sawWorkspace = false;
  for (const m of mounts) {
    const source = m.split(':')[0] ?? '';
    if (source === workspace) {
      sawWorkspace = true;
      continue;
    }
    if (isDockerSocket(m)) out.push(`docker socket mounted: ${m}`);
    else if (within(rules.home, source) || within(source, rules.home)) out.push(`home directory content mounted: ${m}`);
    else out.push(`unexpected mount: ${m}`);
  }
  if (!sawWorkspace) out.push('the workspace is not mounted');
  return out;
}
