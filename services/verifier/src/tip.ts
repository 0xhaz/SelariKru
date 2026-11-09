/**
 * Where a target branch's tip is read from. With GitHub enabled merges land only there, so the local ref says nothing about main: the tip comes from the remote, and the commit is
 * fetched into the source repository before anything is built on it. With GitHub off the local branch is the only main there is. Imports are relative for the same reason as `service.ts`.
 */
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/;
const gitEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };

/** The part of the GitHub port the drivers need. Structural, so the verifier does not import the integration. */
export interface RemoteTips {
  branchHead(repository: string, branch: string): Promise<string | null>;
  fetchBranch(input: { repository: string; repoPath: string; branch: string; sha: string }): Promise<void>;
}

export async function resolveLocalTip(repoPath: string, target: string): Promise<string> {
  if (!SAFE_BRANCH.test(target) || target.includes('..')) throw new Error('refusing an unsafe target branch name');
  const { stdout } = await execFileP('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`], { cwd: repoPath, env: gitEnv, encoding: 'utf8' });
  return stdout.trim();
}

/** The target's current tip. Throws when it cannot be read, or the branch is gone: nothing may be concluded from that. */
export async function readTip(repoPath: string, remote: RemoteTips | undefined, repository: string, target: string): Promise<string> {
  if (remote === undefined) return resolveLocalTip(repoPath, target);
  const head = await remote.branchHead(repository, target);
  if (head === null) throw new Error(`${target} does not exist on the remote`);
  return head;
}
