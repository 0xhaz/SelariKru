import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PushRejectedError } from './port.ts';
import { createGhCliPort, defaultExec, type Exec } from './gh-cli.ts';
import { FakeGitHub } from './fake.ts';
import type { GitHubPort } from './port.ts';

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let root: string;
let src: string;
let bare: string;
let sha: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gh-port-'));
  src = join(root, 'src');
  bare = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '-b', 'main', src], { env: gitEnv });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: gitEnv });
  writeFileSync(join(src, 'a.txt'), 'one');
  git(src, 'add', '.'); git(src, 'commit', '-qm', 'one');
  sha = git(src, 'rev-parse', 'HEAD');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PR_JSON = { isCrossRepository: false, number: 7, url: 'https://github.com/acme/r/pull/7', state: 'OPEN', isDraft: true, headRefName: 'selarikru/run_a', headRefOid: 'a'.repeat(40), baseRefName: 'main', mergeCommit: null };

function recorder(answers: (args: readonly string[]) => string = () => '[]'): { exec: Exec; calls: { file: string; args: string[]; input?: string }[] } {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  return { calls, exec: async (file, args, opts) => { calls.push({ file, args: [...args], ...(opts?.input !== undefined ? { input: opts.input } : {}) }); return answers(args); } };
}

describe('gh CLI port', () => {
  it('pushes the exact commit to a bare repository without forcing, and again is a no-op', async () => {
    const port = createGhCliPort({ remoteUrl: () => bare });
    expect(await port.branchHead('acme/r', 'selarikru/run_a')).toBeNull();
    await port.pushBranch({ repository: 'acme/r', repoPath: src, sha, branch: 'selarikru/run_a' });
    expect(git(bare, 'rev-parse', 'refs/heads/selarikru/run_a')).toBe(sha);
    expect(await port.branchHead('acme/r', 'selarikru/run_a')).toBe(sha);
    await port.pushBranch({ repository: 'acme/r', repoPath: src, sha, branch: 'selarikru/run_a' });
    // The default branch of the remote was never touched.
    expect(readdirSync(join(bare, 'refs/heads'))).toEqual(['selarikru']);
  });

  it('refuses to overwrite a branch that moved to a different commit', async () => {
    writeFileSync(join(src, 'a.txt'), 'two');
    git(src, 'commit', '-qam', 'two');
    const other = git(src, 'rev-parse', 'HEAD');
    const port = createGhCliPort({ remoteUrl: () => bare });
    await expect(port.pushBranch({ repository: 'acme/r', repoPath: src, sha: git(src, 'rev-parse', 'HEAD~1'), branch: 'selarikru/run_b' })).resolves.toBeUndefined();
    await expect(port.pushBranch({ repository: 'acme/r', repoPath: src, sha: sha, branch: 'selarikru/run_b' })).resolves.toBeUndefined();
    git(src, 'checkout', '-q', '--orphan', 'x'); writeFileSync(join(src, 'b.txt'), 'x'); git(src, 'add', '.'); git(src, 'commit', '-qm', 'unrelated');
    const unrelated = git(src, 'rev-parse', 'HEAD');
    await expect(port.pushBranch({ repository: 'acme/r', repoPath: src, sha: unrelated, branch: 'selarikru/run_b' })).rejects.toBeInstanceOf(PushRejectedError);
    expect(git(bare, 'rev-parse', 'refs/heads/selarikru/run_b')).toBe(sha);
    expect(other).not.toBe(sha);
  });

  it('rejects branch names that could be options or the default branch pattern', async () => {
    const port = createGhCliPort({ remoteUrl: () => bare });
    for (const branch of ['--force', 'a b', 'x;rm', '../x', '']) {
      await expect(port.pushBranch({ repository: 'acme/r', repoPath: src, sha, branch })).rejects.toThrow(/branch/);
    }
    await expect(port.pushBranch({ repository: 'acme/r', repoPath: src, sha: 'not-a-sha', branch: 'selarikru/x' })).rejects.toThrow(/sha/);
    await expect(port.findPullRequests('not a repo', 'selarikru/x')).rejects.toThrow(/repository/);
  });

  it('invokes gh without a shell, with arguments as an array, and maps PR JSON', async () => {
    const r = recorder(() => JSON.stringify([PR_JSON]));
    const port = createGhCliPort({ exec: r.exec });
    const prs = await port.findPullRequests('acme/r', 'selarikru/run_a');
    expect(prs).toEqual([{ number: 7, url: PR_JSON.url, state: 'open', draft: true, headRef: 'selarikru/run_a', headSha: 'a'.repeat(40), baseRef: 'main', isCrossRepository: false, mergeCommitSha: null }]);
    expect(r.calls[0]!.file).toBe('gh');
    expect(r.calls[0]!.args).toEqual(expect.arrayContaining(['pr', 'list', '--repo', 'acme/r', '--head', 'selarikru/run_a', '--state', 'all', '--limit', '20', '--json', expect.stringContaining('isCrossRepository')]));
  });

  it('maps merged and closed states and merge commit', async () => {
    const merged = { ...PR_JSON, state: 'MERGED', isDraft: false, mergeCommit: { oid: 'f'.repeat(40) } };
    const port = createGhCliPort({ exec: recorder(() => JSON.stringify(merged)).exec });
    expect(await port.getPullRequest('acme/r', 7)).toMatchObject({ state: 'merged', mergeCommitSha: 'f'.repeat(40) });
    const closed = createGhCliPort({ exec: recorder(() => JSON.stringify({ ...PR_JSON, state: 'CLOSED' })).exec });
    expect(await closed.getPullRequest('acme/r', 7)).toMatchObject({ state: 'closed' });
  });

  it('creates only draft PRs and passes the body on stdin', async () => {
    const r = recorder((args) => (args[1] === 'create' ? 'https://github.com/acme/r/pull/7\n' : JSON.stringify(PR_JSON)));
    const port = createGhCliPort({ exec: r.exec });
    const pr = await port.createDraftPullRequest({ repository: 'acme/r', branch: 'selarikru/run_a', base: 'main', title: 'T', body: 'BODY' });
    expect(pr.number).toBe(7);
    const create = r.calls.find((c) => c.args[1] === 'create')!;
    expect(create.args).toContain('--draft');
    expect(create.input).toBe('BODY');
    expect(create.args.join(' ')).not.toContain('BODY');
  });

  it('subprocess failure text is redacted before it becomes an error message', async () => {
    const leak = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    // A harmless local program stands in for gh: nothing here contacts GitHub.
    const err = await defaultExec(process.execPath, ['-e', `console.error('auth failed token=${leak}'); process.exit(1)`]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('auth failed');
    expect((err as Error).message).not.toContain(leak);
  });

  it('no API path can merge', async () => {
    // 1. The port has no merge-capable member, in the adapter or the fake.
    const adapterMembers = Object.keys(createGhCliPort({ exec: async () => '[]' }));
    const fakeMembers = Object.getOwnPropertyNames(FakeGitHub.prototype).filter((n) => n !== 'constructor' && !n.startsWith('human'));
    for (const name of [...adapterMembers, ...fakeMembers]) expect(name).not.toMatch(/merge|auto|approve|review/i);
    // 2. Every command the adapter issues, for every method, contains no merge-related token.
    const r = recorder((args) => (args[1] === 'create' ? 'https://x/pull/7' : JSON.stringify(args[1] === 'list' ? [PR_JSON] : PR_JSON)));
    const port: GitHubPort = createGhCliPort({ exec: r.exec, remoteUrl: () => bare });
    await port.pushBranch({ repository: 'acme/r', repoPath: src, sha, branch: 'selarikru/run_a' }).catch(() => undefined);
    await port.branchHead('acme/r', 'selarikru/run_a');
    await port.findPullRequests('acme/r', 'selarikru/run_a');
    await port.createDraftPullRequest({ repository: 'acme/r', branch: 'selarikru/run_a', base: 'main', title: 'T', body: 'B' });
    await port.getPullRequest('acme/r', 7);
    for (const c of r.calls) expect(c.args.join(' ')).not.toMatch(/\bmerge\b|--auto|--squash|--rebase|--admin|api\b/i);
    // 3. The source of the package never names a merge command or endpoint.
    const dir = new URL('.', import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'fake.ts')) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/['"`]merge['"`]|pr merge|\/merge\b|enablePullRequestAutoMerge|mergePullRequest|--auto\b|--admin\b/);
    }
  });
});
