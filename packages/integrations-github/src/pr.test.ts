import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, resetDb, type TestDb } from '@selarikru/workflow/test-helpers';
import { PrNotAllowed, branchForCandidate, openReviewablePr, type OpenPrDeps } from './pr.ts';
import { reconcileRun } from './reconcile.ts';
import { buildPrBody } from './body.ts';
import { FakeGitHub } from './fake.ts';
import { PROJECT, REPO, RUN, SHA, T0, TENANT, SHA2, q, record, seedReadyRun, setDefaultBranch, setRun, supersedeCandidate } from './test-fixtures.ts';

let tdb: TestDb;
let gh: FakeGitHub;
const run = { tenantId: TENANT, projectId: PROJECT, runId: RUN, repoPath: '/repos/source' };
const deps = (over: Partial<OpenPrDeps> = {}): OpenPrDeps => ({ db: tdb.db, port: gh, loadRecord: async () => record(), now: () => T0, ...over });

beforeAll(async () => { tdb = await setupTestDb(8); });
afterAll(async () => { await tdb.close(); });
beforeEach(async () => { await resetDb(tdb.db); gh = new FakeGitHub(); await seedReadyRun(tdb.db); });

describe('openReviewablePr', () => {
  it('pushes the exact candidate to a branch named from the run and opens a draft PR into the default branch', async () => {
    const r = await openReviewablePr(run, deps());
    expect(r.status).toBe('opened');
    expect(gh.pushes).toEqual([{ branch: branchForCandidate(RUN, SHA), sha: SHA }]);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]).toMatchObject({ draft: true, headRef: branchForCandidate(RUN, SHA), baseRef: 'main' });
    const rows = await q(tdb.db, 'SELECT * FROM change_requests');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: RUN, candidate_sha: SHA, pr_number: 1, status: 'open', repository: REPO, base_ref: 'main' });
    const ev = await q(tdb.db, "SELECT actor_kind FROM events WHERE type = 'change.proposed'");
    expect(ev).toEqual([{ actor_kind: 'integration' }]);
  });

  it('PR created once across retries (response-lost case queries first)', async () => {
    gh.loseNextCreateResponse = true;
    await expect(openReviewablePr(run, deps())).rejects.toThrow('connection reset');
    expect(await q(tdb.db, 'SELECT 1 FROM change_requests')).toHaveLength(0);
    expect(gh.prs).toHaveLength(1);

    const again = await openReviewablePr(run, deps());
    expect(again.status).toBe('opened');
    expect(again.status === 'opened' && again.adopted).toBe(true);
    expect(gh.prs).toHaveLength(1);
    expect(gh.calls.filter((c) => c === 'createDraftPullRequest')).toHaveLength(1);
    // The lookup happens before any create attempt on the retry.
    const afterFirst = gh.calls.lastIndexOf('createDraftPullRequest');
    expect(gh.calls.slice(afterFirst + 1)).toContain('findPullRequest');

    // A further retry replays the receipt: no new calls at all.
    const before = gh.calls.length;
    const third = await openReviewablePr(run, deps());
    expect(third.status === 'opened' && third.number).toBe(1);
    expect(gh.calls.length).toBe(before);
    expect(await q(tdb.db, 'SELECT 1 FROM change_requests')).toHaveLength(1);
  });

  it('concurrent callers still create one PR', async () => {
    await Promise.all([openReviewablePr(run, deps()), openReviewablePr(run, deps()), openReviewablePr(run, deps())]);
    expect(gh.prs).toHaveLength(1);
  });

  it('builds the body only from recorded data and redacts secrets', async () => {
    const rec = record({
      result: 'passed',
      results: [
        { checkId: 'FB-01', status: 'passed', tests: [{ runner: 'vitest', title: 't', status: 'passed' }], failures: [], evidenceReferences: [] },
        { checkId: 'FB-02', status: 'passed', tests: [], failures: [], evidenceReferences: [] },
      ],
      flaky: ['FB-01'],
    });
    await openReviewablePr(run, deps({
      loadRecord: async () => rec,
      limitations: ['No browser check on Safari. token=ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
      loadUsage: async () => [
        { label: 'Local model tokens', value: 1200, unit: 'tokens', provenance: 'observed' },
        { label: 'Cloud cost', value: 0.42, unit: 'USD', provenance: 'estimated' },
        { label: 'Local compute', value: null, unit: 'seconds', provenance: 'unavailable' },
      ],
    }));
    const body = gh.prs[0]!.body;
    expect(body).toContain(SHA);
    expect(body).toMatch(/FB-01.*passed/);
    expect(body).toMatch(/FB-02.*passed/);
    expect(body).toMatch(/flaky/i);
    expect(body).toContain('No browser check on Safari');
    expect(body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(body).toMatch(/Local model tokens.*1200.*observed/);
    expect(body).toMatch(/Cloud cost.*0\.42.*estimated/);
    expect(body).toMatch(/Local compute.*unavailable/);
    expect(body).not.toMatch(/Local compute[^\n]*\b0\b/);
    expect(body).toMatch(/human/i);
  });

  it('requires a live passing record for the run candidate', async () => {
    await expect(openReviewablePr(run, deps({ loadRecord: async () => null }))).rejects.toMatchObject({ reason: 'no_valid_record' });
    await expect(openReviewablePr(run, deps({ loadRecord: async () => record({ result: 'failed' }) }))).rejects.toMatchObject({ reason: 'record_not_passing' });
    await expect(openReviewablePr(run, deps({ loadRecord: async () => record({ results: [{ checkId: 'FB-01', status: 'skipped', tests: [], failures: [], evidenceReferences: [] }] }) }))).rejects.toMatchObject({ reason: 'record_not_passing' });
    await expect(openReviewablePr(run, deps({ loadRecord: async () => record({ runId: 'other' }) }))).rejects.toBeInstanceOf(PrNotAllowed);
    expect(gh.calls).toEqual([]);
  });

  it('asks for the record of the run candidate, not any other', async () => {
    const asked: string[] = [];
    await openReviewablePr(run, deps({ loadRecord: async (sha) => { asked.push(sha); return record(); } }));
    expect(asked).toEqual([SHA]);
  });

  it('requires the run to be ready_for_review', async () => {
    await setRun(tdb.db, { lifecycle: 'running' });
    await expect(openReviewablePr(run, deps())).rejects.toMatchObject({ reason: 'run_not_ready' });
    expect(gh.calls).toEqual([]);
  });

  it('never targets the default branch', async () => {
    await setDefaultBranch(tdb.db, branchForCandidate(RUN, SHA));
    await expect(openReviewablePr(run, deps())).rejects.toMatchObject({ reason: 'branch_is_default' });
    expect(gh.pushes).toEqual([]);
  });

  it('takes the target repository from project configuration only', async () => {
    const seen: string[] = [];
    const spy = new Proxy(gh, { get: (t, p, r) => (p === 'pushBranch' ? async (i: { repository: string }) => { seen.push(i.repository); } : Reflect.get(t, p, r)) });
    await openReviewablePr({ ...run, repository: 'evil/other' } as typeof run, deps({ port: spy as FakeGitHub }));
    expect(seen).toEqual([REPO]);
  });

  it('repeated benchmark trials create no external PR', async () => {
    await setRun(tdb.db, { trial: true });
    for (let i = 0; i < 3; i++) {
      const r = await openReviewablePr(run, deps());
      expect(r).toEqual({ status: 'skipped', reason: 'trial' });
    }
    expect(gh.calls).toEqual([]);
    expect(await q(tdb.db, 'SELECT 1 FROM change_requests')).toHaveLength(0);
  });
});

describe('candidate identity', () => {
  const rebuilt = (): Partial<OpenPrDeps> => ({ loadRecord: async (sha) => record({ candidateSha: sha }) });

  it('refuses a rebuilt sibling candidate with candidate_changed on every retry, without pushing or adopting', async () => {
    await openReviewablePr(run, deps());
    await supersedeCandidate(tdb.db);
    const pushes = gh.pushes.length;
    const calls = gh.calls.length;
    for (let i = 0; i < 3; i++) {
      await expect(openReviewablePr(run, deps(rebuilt()))).rejects.toMatchObject({ reason: 'candidate_changed' });
    }
    expect(gh.pushes.length).toBe(pushes);
    expect(gh.calls.length).toBe(calls);
    expect(gh.prs).toHaveLength(1);
    expect(await q(tdb.db, 'SELECT candidate_sha FROM change_requests')).toEqual([{ candidate_sha: SHA }]);
  });

  it('refuses a fast-forward candidate too and leaves the row unchanged', async () => {
    await openReviewablePr(run, deps());
    gh.fastForwards.add(`${SHA}>${SHA2}`);
    await supersedeCandidate(tdb.db);
    await expect(openReviewablePr(run, deps(rebuilt()))).rejects.toMatchObject({ reason: 'candidate_changed' });
    expect(gh.branches.get(branchForCandidate(RUN, SHA))).toBe(SHA);
    expect(await q(tdb.db, 'SELECT candidate_sha, status FROM change_requests')).toEqual([{ candidate_sha: SHA, status: 'open' }]);
  });

  it('the fake rejects a non-fast-forward push like git does', async () => {
    await gh.pushBranch({ repository: REPO, repoPath: '/r', sha: SHA, branch: 'b' });
    await expect(gh.pushBranch({ repository: REPO, repoPath: '/r', sha: SHA2, branch: 'b' })).rejects.toThrow(/non-fast-forward/);
  });

  it('refuses a candidate built for a target other than the default branch', async () => {
    await tdb.db.execute(await import('drizzle-orm').then((m) => m.sql`UPDATE candidates SET target = 'develop'`));
    await expect(openReviewablePr(run, deps())).rejects.toMatchObject({ reason: 'target_mismatch' });
    expect(gh.calls).toEqual([]);
  });
});

describe('successor candidates', () => {
  const rebuilt = (): Partial<OpenPrDeps> => ({ loadRecord: async (sha) => record({ candidateSha: sha }) });
  const tid = { tenantId: TENANT, projectId: PROJECT, runId: RUN };

  it('a rebuilt candidate while the prior PR is open is refused and names the PR to close', async () => {
    await openReviewablePr(run, deps());
    await supersedeCandidate(tdb.db);
    const err = await openReviewablePr(run, deps(rebuilt())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrNotAllowed);
    expect(err).toMatchObject({ reason: 'candidate_changed', detail: { prNumber: 1 } });
    expect((err as Error).message).toContain('#1');
    expect(gh.pushes).toHaveLength(1);
  });

  it('after the prior PR is closed the rebuilt candidate opens its own PR on its own branch and replaces the row', async () => {
    await openReviewablePr(run, deps());
    gh.humanCloses(1);
    await reconcileRun(tid, { db: tdb.db, port: gh, now: () => T0 });
    await supersedeCandidate(tdb.db);
    const r = await openReviewablePr(run, deps(rebuilt()));
    expect(r).toMatchObject({ status: 'opened', number: 2, candidateSha: SHA2, branch: branchForCandidate(RUN, SHA2), adopted: false });
    expect(branchForCandidate(RUN, SHA2)).not.toBe(branchForCandidate(RUN, SHA));
    expect(gh.prs).toHaveLength(2);
    expect(await q(tdb.db, 'SELECT candidate_sha, pr_number, status, branch, base_ref, merge_commit_sha FROM change_requests')).toEqual([
      { candidate_sha: SHA2, pr_number: 2, status: 'open', branch: branchForCandidate(RUN, SHA2), base_ref: 'main', merge_commit_sha: null }]);
    expect(await q(tdb.db, "SELECT 1 FROM events WHERE type = 'change.proposed'")).toHaveLength(2);
    // Retrying the same open replays; nothing new happens.
    const calls = gh.calls.length;
    expect((await openReviewablePr(run, deps(rebuilt()))).status).toBe('opened');
    expect(gh.calls.length).toBe(calls);
  });

  it('after a stale_candidate row the rebuilt candidate opens a new PR, and its merge finishes the run', async () => {
    await openReviewablePr(run, deps());
    await supersedeCandidate(tdb.db);
    gh.humanMerges(1);
    expect((await reconcileRun(tid, { db: tdb.db, port: gh, now: () => T0 })).status).toBe('stale');
    expect(await q(tdb.db, 'SELECT status FROM change_requests')).toEqual([{ status: 'stale_candidate' }]);

    const r = await openReviewablePr(run, deps(rebuilt()));
    expect(r).toMatchObject({ status: 'opened', number: 2, candidateSha: SHA2 });
    expect(await q(tdb.db, 'SELECT candidate_sha, status FROM change_requests')).toEqual([{ candidate_sha: SHA2, status: 'open' }]);

    gh.humanMerges(2);
    expect((await reconcileRun(tid, { db: tdb.db, port: gh, now: () => T0 })).status).toBe('merged');
    const tasks = await q(tdb.db, "SELECT task_id, status FROM task_status ORDER BY task_id");
    expect(tasks).toEqual([{ task_id: 'task_a', status: 'merged' }, { task_id: 'task_b', status: 'merged' }]);
    expect(await q(tdb.db, 'SELECT lifecycle FROM runs')).toEqual([{ lifecycle: 'merged' }]);
    expect(await q(tdb.db, "SELECT 1 FROM events WHERE type = 'change.merged'")).toHaveLength(3);
  });

  it('refuses a rebuilt candidate once the run PR was merged', async () => {
    await openReviewablePr(run, deps());
    await supersedeCandidate(tdb.db);
    await tdb.db.execute(await import('drizzle-orm').then((m) => m.sql`UPDATE change_requests SET status = 'merged'`));
    await expect(openReviewablePr(run, deps(rebuilt()))).rejects.toMatchObject({ reason: 'run_already_merged' });
    expect(gh.pushes).toHaveLength(1);
  });

  it('a remote branch that holds other commits is a typed push_rejected refusal', async () => {
    gh.branches.set(branchForCandidate(RUN, SHA), 'f'.repeat(40));
    await expect(openReviewablePr(run, deps())).rejects.toMatchObject({ reason: 'push_rejected' });
    expect(gh.prs).toHaveLength(0);
  });

  it('opens for different candidates cannot both reach the push: the run row is locked and the candidate re-read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const first = openReviewablePr(run, deps({ loadRecord: async (sha) => { entered(); await gate; return record({ candidateSha: sha }); } }));
    await inside;
    await supersedeCandidate(tdb.db); // the rebuild lands while the first open holds the lock
    const second = openReviewablePr(run, deps(rebuilt())).then(() => 'opened', (e: PrNotAllowed) => e.reason);
    await new Promise((r) => setTimeout(r, 150));
    expect(gh.pushes).toEqual([]); // the second is waiting on the lock; the first has not pushed yet
    release();
    expect((await first).status).toBe('opened');
    expect(await second).toBe('candidate_changed');
    expect(gh.pushes).toEqual([{ branch: branchForCandidate(RUN, SHA), sha: SHA }]);
    expect(gh.prs).toHaveLength(1);
  });
});

describe('adoption', () => {
  const branch = branchForCandidate(RUN, SHA);
  for (const [name, over] of [
    ['a different head SHA', { headSha: '9'.repeat(40) }],
    ['a different base', { headSha: SHA, baseRef: 'develop' }],
    ['a cross-repository head', { headSha: SHA, isCrossRepository: true }],
  ] as const) {
    it(`refuses to adopt a PR with ${name}`, async () => {
      gh.foreignPr({ headRef: branch, ...over });
      await expect(openReviewablePr(run, deps())).rejects.toMatchObject({ reason: 'foreign_pr' });
      expect(await q(tdb.db, 'SELECT 1 FROM change_requests')).toHaveLength(0);
      expect(gh.calls).not.toContain('createDraftPullRequest');
    });
  }

  it('adopts the matching PR even when a stranger also has one on the branch name', async () => {
    gh.foreignPr({ headRef: branch, headSha: SHA, baseRef: 'main' });
    gh.foreignPr({ headRef: branch, headSha: '9'.repeat(40), isCrossRepository: true });
    const r = await openReviewablePr(run, deps());
    expect(r.status === 'opened' && r.adopted).toBe(true);
  });
});

describe('buildPrBody', () => {
  it('never reports a skipped or errored check as passed', () => {
    const rec = record({ result: 'failed', results: [
      { checkId: 'FB-01', status: 'skipped', tests: [], failures: [], evidenceReferences: [] },
      { checkId: 'FB-02', status: 'error', tests: [], failures: [], evidenceReferences: [] },
    ] });
    const body = buildPrBody({ runId: RUN, candidateSha: SHA, baseSha: rec.baseSha, record: rec, limitations: [], usage: [] });
    expect(body).toMatch(/FB-01 \| skipped/);
    expect(body).toMatch(/FB-02 \| error/);
    expect(body).toMatch(/FB-01 is skipped; a skipped check is not a pass/);
    expect(body).toContain('No usage recorded.');
  });
});
