import { execFile } from 'node:child_process';
import { redactSecrets } from '@selarikru/protocol';
import { PushRejectedError, type GitHubPort, type PullRequestInfo, type PullRequestState } from './port.ts';

/** Runs a program with an argument array. No shell is ever involved. */
export type Exec = (file: string, args: readonly string[], opts?: { cwd?: string; input?: string }) => Promise<string>;

/** Exported from this module for its redaction test only; `index.ts` does not re-export it. */
export const defaultExec: Exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, [...args], { cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args[0] ?? ''} failed: ${redactSecrets(String(stderr || error.message)).slice(0, 500)}`));
      else resolve(stdout);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,150}$/;
const SHA = /^[0-9a-f]{40}$/;
const FIELDS = 'number,url,state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,mergeCommit';

export interface GhCliOptions {
  readonly exec?: Exec;
  /** Where `git push` and `git ls-remote` go for a repository. Default: the GitHub HTTPS URL. Tests point this at a local bare repository. */
  readonly remoteUrl?: (repository: string) => string;
}

interface RawPr {
  number: number; url: string; state: string; isDraft: boolean; headRefName: string; headRefOid: string; baseRefName: string; isCrossRepository: boolean; mergeCommit: { oid?: string } | null;
}

function toInfo(raw: RawPr): PullRequestInfo {
  const state: PullRequestState = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open';
  return {
    number: raw.number, url: raw.url, state, draft: raw.isDraft, headRef: raw.headRefName, headSha: raw.headRefOid, baseRef: raw.baseRefName, isCrossRepository: raw.isCrossRepository === true,
    mergeCommitSha: state === 'merged' ? (raw.mergeCommit?.oid ?? null) : null,
  };
}

/**
 * GitHubPort over the `gh` CLI and `git`. Both are run with argument arrays, never through a shell. Branch, repository and SHA arguments
 * are validated before use, so none can be read as an option. The adapter has no merge, auto-merge, review or delete operation.
 * Pushes use the credentials `git` already has (for GitHub, `gh auth setup-git`); nothing here reads or stores a token.
 */
export function createGhCliPort(options: GhCliOptions = {}): GitHubPort {
  const exec = options.exec ?? defaultExec;
  const remoteUrl = options.remoteUrl ?? ((repo: string) => `https://github.com/${repo}.git`);
  const repo = (r: string): string => { if (!REPO.test(r)) throw new Error('invalid repository'); return r; };
  const branchOf = (b: string): string => { if (!BRANCH.test(b) || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')) throw new Error('invalid branch name'); return b; };

  const branchHead = async (repository: string, branch: string): Promise<string | null> => {
    const out = await exec('git', ['ls-remote', '--heads', remoteUrl(repo(repository)), `refs/heads/${branchOf(branch)}`]);
    const m = /^([0-9a-f]{40})\t/m.exec(out);
    return m ? m[1]! : null;
  };

  return {
    branchHead,
    async pushBranch({ repository, repoPath, sha, branch }) {
      if (!SHA.test(sha)) throw new Error('invalid sha');
      const url = remoteUrl(repo(repository));
      const name = branchOf(branch);
      await exec('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repoPath });
      if ((await branchHead(repository, name)) === sha) return;
      // No force: a branch that moved elsewhere makes this fail rather than being overwritten.
      try {
        await exec('git', ['push', '--no-verify', url, `${sha}:refs/heads/${name}`], { cwd: repoPath });
      } catch (e) {
        const message = redactSecrets(String((e as Error).message)).slice(0, 500);
        // Only a non-fast-forward refusal means the branch holds other commits. A hook or branch-protection rejection ("remote rejected") is a different failure.
        if (/\((?:non-fast-forward|fetch first)\)|Updates were rejected because/i.test(message)) throw new PushRejectedError(message);
        throw new Error(message);
      }
    },
    async findPullRequests(repository, branch) {
      const out = await exec('gh', ['pr', 'list', '--repo', repo(repository), '--head', branchOf(branch), '--state', 'all', '--limit', '20', '--json', FIELDS]);
      return (JSON.parse(out) as RawPr[]).map(toInfo);
    },
    async createDraftPullRequest({ repository, branch, base, title, body }) {
      const r = repo(repository);
      const out = await exec('gh', ['pr', 'create', '--repo', r, '--draft', '--head', branchOf(branch), '--base', branchOf(base), '--title', title, '--body-file', '-'], { input: body });
      const m = /\/pull\/(\d+)/.exec(out);
      if (!m) throw new Error('gh did not return a pull request URL');
      return toInfo(JSON.parse(await exec('gh', ['pr', 'view', m[1]!, '--repo', r, '--json', FIELDS])) as RawPr);
    },
    async getPullRequest(repository, number) {
      if (!Number.isInteger(number) || number < 1) throw new Error('invalid pull request number');
      try {
        return toInfo(JSON.parse(await exec('gh', ['pr', 'view', String(number), '--repo', repo(repository), '--json', FIELDS])) as RawPr);
      } catch (e) {
        if (/could not resolve to a pullrequest|not found/i.test(String((e as Error).message))) return null;
        throw e;
      }
    },
  };
}
