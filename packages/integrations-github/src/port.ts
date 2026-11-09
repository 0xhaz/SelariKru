/**
 * The only GitHub surface this package uses. It is deliberately narrow: push a branch, find, create (always as a draft) and read a pull
 * request. There is no merge, no auto-merge, no review approval and no branch deletion. Merging stays a human action on GitHub; a
 * test asserts that nothing here can reach a merge endpoint.
 */
export type PullRequestState = 'open' | 'closed' | 'merged';

export interface PullRequestInfo {
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestState;
  readonly draft: boolean;
  /** The branch the PR was opened from. */
  readonly headRef: string;
  /** The exact commit at the head of that branch. */
  readonly headSha: string;
  readonly baseRef: string;
  /** True when the head branch lives in a fork. Such a PR is never adopted. */
  readonly isCrossRepository: boolean;
  /** The commit created on the base branch by a merge. Null unless merged. */
  readonly mergeCommitSha: string | null;
}

export interface GitHubPort {
  /** Pushes exactly `sha` (a commit in the local `repoPath`) to `refs/heads/<branch>` of `repository`. Never forces. */
  pushBranch(input: { repository: string; repoPath: string; sha: string; branch: string }): Promise<void>;
  /** The commit a remote branch points at, or null when the branch does not exist. */
  branchHead(repository: string, branch: string): Promise<string | null>;
  /** Pull requests (any state, newest first, bounded) whose head is `branch`. Empty when there is none. */
  findPullRequests(repository: string, branch: string): Promise<PullRequestInfo[]>;
  /** Opens a DRAFT pull request from `branch` into `base`. */
  createDraftPullRequest(input: { repository: string; branch: string; base: string; title: string; body: string }): Promise<PullRequestInfo>;
  /** Reads a pull request's current state from GitHub. */
  getPullRequest(repository: string, number: number): Promise<PullRequestInfo | null>;
}
