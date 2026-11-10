import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-trial isolation on disk. Every trial gets its own repository holding the starter commit and nothing else: no
 * branch, tag, candidate ref or object from another trial, because none exists in the pristine starter it is cloned
 * from (trials only ever write to their own clone). The clone is removed with the trial.
 */

const gitEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'selarikru-benchmark', GIT_AUTHOR_EMAIL: 'benchmark@selarikru.invalid', GIT_COMMITTER_NAME: 'selarikru-benchmark', GIT_COMMITTER_EMAIL: 'benchmark@selarikru.invalid',
});

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export class IsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationError';
  }
}

/**
 * A new repository at `dest` whose `main` is exactly `sha` from `source`, with a clean worktree. The clone keeps no
 * remote and no other ref, so the trial cannot see anything but the starter.
 */
export function freshStarterRepo(source: string, sha: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  git(dirname(dest), 'clone', '--quiet', '--no-local', '--no-checkout', '--no-tags', source, dest);
  git(dest, 'checkout', '--quiet', '-B', 'main', sha);
  git(dest, 'remote', 'remove', 'origin');
  for (const ref of git(dest, 'for-each-ref', '--format=%(refname)').split('\n').filter((r) => r !== '' && r !== 'refs/heads/main')) git(dest, 'update-ref', '-d', ref);
  const head = git(dest, 'rev-parse', 'HEAD');
  if (head !== sha) throw new IsolationError(`the fresh clone is at ${head}, not the starter ${sha}`);
  if (git(dest, 'status', '--porcelain', '--untracked-files=all') !== '') throw new IsolationError('the fresh clone is not clean');
}

/** What a trial starts from, for the reset proof: the clone's refs and whether its worktree is the starter, untouched. */
export function repoState(repo: string): { readonly head: string; readonly refs: readonly string[]; readonly clean: boolean } {
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    refs: git(repo, 'for-each-ref', '--format=%(refname)').split('\n').filter((r) => r !== ''),
    clean: git(repo, 'status', '--porcelain', '--untracked-files=all') === '',
  };
}

/**
 * Makes a starter repository from a directory of tracked files (the in-repo Feedback Board starter), for the dry run
 * and tests. Build output, dependencies and SQLite files are left out. Returns the starter commit.
 */
export function starterRepoFrom(filesDir: string, dest: string, files?: readonly string[]): string {
  mkdirSync(dest, { recursive: true });
  const list = files ?? walk(filesDir);
  for (const rel of list) {
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    cpSync(join(filesDir, rel), join(dest, rel));
  }
  git(dest, 'init', '--quiet', '-b', 'main');
  git(dest, 'add', '-A');
  git(dest, 'commit', '--quiet', '-m', 'Feedback Board starter');
  return git(dest, 'rev-parse', 'HEAD');
}

const SKIP = new Set(['node_modules', 'dist', '.git']);
function walk(root: string, rel = ''): string[] {
  return readdirSync(join(root, rel)).flatMap((name) => {
    if (SKIP.has(name) || /\.sqlite/.test(name)) return [];
    const r = rel ? `${rel}/${name}` : name;
    return statSync(join(root, r)).isDirectory() ? walk(root, r) : [r];
  });
}
