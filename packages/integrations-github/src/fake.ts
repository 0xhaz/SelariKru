import type { GitHubPort, PullRequestInfo } from './port.ts';

/** In-memory GitHub for tests. It records every call and can lose the response of a create. */
export class FakeGitHub implements GitHubPort {
  readonly calls: string[] = [];
  readonly branches = new Map<string, string>();
  readonly prs: (PullRequestInfo & { body: string; title: string })[] = [];
  readonly pushes: { branch: string; sha: string }[] = [];
  /** When set, the next create succeeds on the server and then throws, as when the response is lost. */
  loseNextCreateResponse = false;
  private next = 1;

  async pushBranch(i: { repository: string; repoPath: string; sha: string; branch: string }): Promise<void> {
    this.calls.push('pushBranch');
    this.pushes.push({ branch: i.branch, sha: i.sha });
    this.branches.set(i.branch, i.sha);
  }
  async branchHead(_r: string, branch: string): Promise<string | null> {
    this.calls.push('branchHead');
    return this.branches.get(branch) ?? null;
  }
  async findPullRequest(_r: string, branch: string): Promise<PullRequestInfo | null> {
    this.calls.push('findPullRequest');
    return [...this.prs].reverse().find((p) => p.headRef === branch) ?? null;
  }
  async createDraftPullRequest(i: { repository: string; branch: string; base: string; title: string; body: string }): Promise<PullRequestInfo> {
    this.calls.push('createDraftPullRequest');
    const number = this.next++;
    const pr = { number, url: `https://github.com/${i.repository}/pull/${number}`, state: 'open' as const, draft: true, headRef: i.branch, headSha: this.branches.get(i.branch) ?? '', baseRef: i.base, mergeCommitSha: null, title: i.title, body: i.body };
    this.prs.push(pr);
    if (this.loseNextCreateResponse) { this.loseNextCreateResponse = false; throw new Error('connection reset'); }
    return pr;
  }
  async getPullRequest(_r: string, number: number): Promise<PullRequestInfo | null> {
    this.calls.push('getPullRequest');
    return this.prs.find((p) => p.number === number) ?? null;
  }
  /** Test control: what a human did on GitHub. */
  humanMerges(number: number, mergeCommitSha = 'f'.repeat(40)): void {
    const i = this.prs.findIndex((p) => p.number === number);
    this.prs[i] = { ...this.prs[i]!, state: 'merged', draft: false, mergeCommitSha };
  }
  humanCloses(number: number): void {
    const i = this.prs.findIndex((p) => p.number === number);
    this.prs[i] = { ...this.prs[i]!, state: 'closed' };
  }
  humanPushes(number: number, sha: string): void {
    const i = this.prs.findIndex((p) => p.number === number);
    this.prs[i] = { ...this.prs[i]!, headSha: sha };
  }
}
