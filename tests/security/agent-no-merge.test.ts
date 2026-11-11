/**
 * Case: agent push to a protected branch denied. What this repository controls is proved here: the workspace has no remote, history or credential to push with, nothing an agent does in `.git`
 * reaches the change set, runner credentials cannot open or merge anything, and the one code path that pushes writes only a run-scoped branch. The push is real git against a local bare repository
 * with a pre-receive hook protecting main. Not exercised: the real sandbox's network policy and credential mediation, and real GitHub branch protection. See the T7.2 report.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGhCliPort } from '@selarikru/integrations-github';
import { buildApp } from '@selarikru/control-api';
import { fakeVerifier, testConfig } from '@selarikru/control-api/test-helpers';
import { createScheduler } from '@selarikru/workflow';
import { loadValidRecord } from '../../services/verifier/src/service.ts';
import { TEST_CATALOG } from '@selarikru/workflow/test-helpers';
import { launchPayload, owner, passing, post, PROJECT, readTree, sql, TENANT, toolUse, World } from './world.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const hostGit = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('what the agent has to push with', () => {
  it('the workspace has a fresh one-commit repository, no remote, and no credential file, and no secret reaches the launch', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_w')]);
    const lease = await w.claim();
    let tree: Record<string, string> = {};
    let remotes = ''; let log = ''; let gitConfig = '';
    const { report, sbx } = await w.runWorker(lease, ({ cwd, write }) => {
      tree = readTree(cwd);
      remotes = hostGit(cwd, 'remote', '-v');
      log = hostGit(cwd, 'log', '--format=%s');
      gitConfig = readFileSync(join(cwd, '.git/config'), 'utf8');
      write('src/a.ts', 'export const a = 1;\n');
    });
    expect(report.outcome).toBe('completed');
    expect(remotes).toBe('');
    expect(log).toBe('task base');
    expect(gitConfig).not.toMatch(/url\s*=|\[remote|\[credential|insteadOf/i);
    expect(Object.keys(tree).filter((f) => /git-credentials|\.netrc|\.ssh|\.npmrc|credentials\.json/.test(f))).toEqual([]);
    expect(tree['TASK.md']).toContain('Do not commit, push');
    const payload = launchPayload(sbx);
    for (const s of [w.token, lease.leaseToken, 'GH_TOKEN', 'GITHUB_TOKEN']) expect(payload.includes(s), s).toBe(false);
    // The sandbox gets the workspace and nothing else: no home, no credential directory.
    const create = sbx.calls.find((c) => c[0] === 'create')!;
    expect(create[create.length - 1]).toBe(join(w.root, 'work', 'attempts', lease.attemptId, 'workspace'));
    expect(create.join(' ')).not.toMatch(/\.ssh|\.config|\.claude|\.docker|docker\.sock/);
  });

  it('commits and remotes an agent makes in its own .git never reach the candidate, and nothing but the diff leaves the sandbox', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_commit')]);
    const { report } = await w.runWorker(await w.claim(), ({ cwd, write, stream }) => {
      write('src/a.ts', 'export const a = 1;\n');
      hostGit(cwd, 'add', '-A');
      hostGit(cwd, '-c', 'user.name=agent', '-c', 'user.email=a@a', 'commit', '-q', '-m', 'agent commit');
      hostGit(cwd, 'remote', 'add', 'origin', 'https://github.com/acme/feedback-board.git');
      // The real sandbox's network is out of reach here; the point is what the system does with whatever happened inside.
      stream.push(`${toolUse('Bash', { command: 'git push --force origin HEAD:main' })}\n`);
    });
    expect(report.outcome).toBe('completed');
    const sha = (await w.assembly().tick()).assembled[0]!;
    expect(w.git('log', '--format=%s', `${w.baseSha}..${sha}`)).not.toContain('agent commit');
    expect(w.git('show', `${sha}:src/a.ts`)).toBe('export const a = 1;');
    expect(w.gh.pushes).toEqual([]);
  });

  it('a write to .git never reaches a change set, and a differently cased .GIT is a forbidden path that fails the attempt', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_dotgit')]);
    const quiet = await w.runWorker(await w.claim(), ({ write }) => { write('.git/hooks/pre-push', '#!/bin/sh\nexit 0\n'); write('src/a.ts', 'export const a = 1;\n'); });
    expect(quiet.report.outcome).toBe('completed');
    const changes = JSON.parse(Buffer.from((await w.store().get(quiet.report.changeManifest!))!).toString()).changes as { path: string }[];
    expect(changes.map((c) => c.path)).toEqual(['src/a.ts']);

    const run2 = await w.newRun();
    await w.plan(run2, [w.task(run2, 't_dotgit2')]);
    const { report } = await w.runWorker(await w.claim(), ({ write }) => { write('src/.GIT', 'gitdir: /tmp/evil\n'); });
    expect(report.outcome).toBe('failed');
    expect(report.reason).toMatch(/diff outside allowedPaths/);
    expect((await w.status('t_dotgit2')).status).not.toBe('verifying');
  });
});

describe('what a credential can do', () => {
  it('a runner token cannot open a PR, resolve an approval, or reach a merge route; there is no merge route', async () => {
    const { runId } = await w.verifiedRun(['t_auth']);
    const auth = { authorization: `Bearer ${w.token}` };
    const pr = await post(w.app, `/v1/runs/${runId}/pull-request`, {}, auth);
    expect(pr.status).toBe(403);
    expect(pr.body.error.code).toBe('wrong_principal_type');
    expect((await post(w.app, `/v1/approvals/x/resolve`, { decision: 'grant', scopeHash: 'x', expectedRevision: 0, idempotencyKey: 'a' }, auth)).status).toBe(403);
    expect(w.gh.calls).toEqual([]);
    expect(w.app.routeTable.map((r) => `${r.method} ${r.url}`).filter((u) => /merge/i.test(u))).toEqual([]);
  });

  it('a merge_protected_branch approval cannot be granted by anyone, even the owner', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_m')]);
    const lease = await w.claim();
    expect((await post(w.app, '/v1/runners/result', { lease: { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken }, result: { outcome: 'approval_requested', reason: 'r', operation: 'merge_protected_branch' } }, { authorization: `Bearer ${w.token}` })).status).toBe(400);
    await w.t.db.execute(sql`INSERT INTO approvals (tenant_id, project_id, approval_id, run_id, task_id, revision, requester, action_hash, scope_hash, outcome, detail, expected_revisions) VALUES (${TENANT}, ${PROJECT}, 'apr_m', ${runId}, 't_m', 1, 'worker', 'a', 's', 'pending', ${JSON.stringify({ operation: 'merge_protected_branch' })}::jsonb, '{}'::jsonb)`);
    await w.t.db.execute(sql`UPDATE task_status SET status = 'awaiting_approval' WHERE task_id = 't_m'`);
    const { rowRevision } = await w.status('t_m');
    const res = await post(w.app, '/v1/approvals/apr_m/resolve', { decision: 'grant', scopeHash: 's', expectedRevision: rowRevision, idempotencyKey: 'g' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('policy_denied');
    expect(await w.count('approvals', `outcome = 'granted'`)).toBe(0);
  });

  it('a worker claiming a head commit of its own does not change what gets pushed', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't_h')]);
    const report = await w.claimAndComplete('t_h');
    expect(report.changeManifest).not.toBeNull();
    const sha = (await w.assembly().tick()).assembled[0]!;
    expect((await w.verification(passing).tick()).verified).toBe(sha);
    await w.t.db.execute(sql`UPDATE attempts SET head_sha = ${w.baseSha}`);
    const res = await post(w.app, `/v1/runs/${runId}/pull-request`, {});
    expect(res.status).toBe(200);
    expect(w.gh.pushes.map((p) => p.sha)).toEqual([sha]);
  });
});

describe('the one path that pushes, with real git against a protected bare remote', () => {
  async function protectedRemote(): Promise<{ bare: string; hook: string; before: string }> {
    const bare = join(w.root, `remote-${Date.now()}.git`);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: gitEnv });
    hostGit(w.repo, 'push', '-q', bare, `${w.baseSha}:refs/heads/main`);
    const before = hostGit(bare, 'rev-parse', 'refs/heads/main');
    const hook = join(bare, 'hooks', 'pre-receive');
    mkdirSync(join(bare, 'hooks'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/main" ]; then echo "protected branch" >&2; exit 1; fi; done\nexit 0\n');
    chmodSync(hook, 0o755);
    return { bare, hook, before };
  }

  it('the verified candidate goes only to a run-scoped branch; main is untouched and no ref is forced', async () => {
    const { bare, before } = await protectedRemote();
    const { runId, sha } = await w.verifiedRun(['t_push']);
    // A real git push to the bare remote. `gh` itself is the only part scripted, because it can only talk to github.com.
    const port = createGhCliPort({
      remoteUrl: () => bare,
      exec: async (file, args, opts) => {
        if (file !== 'git') return args[1] === 'create' ? 'https://github.com/acme/feedback-board/pull/1\n' : args[1] === 'list' ? '[]' : JSON.stringify({ number: 1, url: 'https://github.com/acme/feedback-board/pull/1', state: 'OPEN', isDraft: true, headRefName: 'x', headRefOid: sha, baseRefName: 'main', isCrossRepository: false, mergeCommit: null });
        return execFileSync(file, [...args], { cwd: opts?.cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      },
    });
    const store = w.store();
    const app = buildApp({
      config: testConfig({ allowedOrigins: [] }), db: w.t.db, verifier: fakeVerifier, now: w.now, scheduler: createScheduler({ codingWorkers: 'claude_code', catalog: TEST_CATALOG, db: w.t.db, now: w.now, policy: w.policy }), policy: w.policy, catalog: TEST_CATALOG,
      github: { pullRequests: { port, repoPath: w.repo, loadRecord: (key) => loadValidRecord(w.t.db, store, key) } },
    });
    await app.ready();
    try {
      const res = await post(app, `/v1/runs/${runId}/pull-request`, {});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.branch).toBe(`selarikru/${runId}/${sha.slice(0, 12)}`);
      expect(hostGit(bare, 'rev-parse', 'refs/heads/main')).toBe(before);
      expect(hostGit(bare, 'rev-parse', `refs/heads/${res.body.branch as string}`)).toBe(sha);
      expect(hostGit(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort()).toEqual([`refs/heads/${res.body.branch as string}`, 'refs/heads/main'].sort());
    } finally {
      await app.close();
    }
  });

  it('a project whose default branch is the run branch is refused before any push', async () => {
    const { runId, sha } = await w.verifiedRun(['t_d']);
    const branch = `selarikru/${runId}/${sha.slice(0, 12)}`;
    await w.t.db.execute(sql`UPDATE projects SET default_branch = ${branch}`);
    await w.t.db.execute(sql`UPDATE candidates SET target = ${branch}`);
    const res = await post(w.app, `/v1/runs/${runId}/pull-request`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('branch_is_default');
    expect(w.gh.pushes).toEqual([]);
  });

  it('control: owner and policy can still open the normal draft PR', async () => {
    const { runId, sha } = await w.verifiedRun(['t_ok']);
    const res = await w.app.inject({ method: 'POST', url: `/v1/runs/${runId}/pull-request`, payload: {}, headers: owner() });
    expect(res.statusCode).toBe(200);
    expect(w.gh.pushes).toEqual([{ branch: `selarikru/${runId}/${sha.slice(0, 12)}`, sha }]);
    expect(w.gh.prs[0]).toMatchObject({ draft: true, baseRef: 'main', headSha: sha });
  });
});
