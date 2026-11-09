import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, resetDb, type TestDb } from '@selarikru/workflow/test-helpers';
import { openReviewablePr } from './pr.ts';
import { FakeGitHub } from './fake.ts';
import { handleGithubWebhook, signBody, type WebhookDeps } from './webhook.ts';
import { processPendingDeliveries, pollOpenChangeRequests, reconcileRun, startReconciler } from './reconcile.ts';
import { PROJECT, REPO, RUN, SHA, T0, TENANT, SHA2, q, record, seedReadyRun, supersedeCandidate } from './test-fixtures.ts';

const SECRET = 'whsec_test_secret_value';
let tdb: TestDb;
let gh: FakeGitHub;
const wh = (): WebhookDeps => ({ db: tdb.db, tenantId: TENANT, secret: SECRET, now: () => T0 });
const rdeps = () => ({ db: tdb.db, port: gh, now: () => T0 });

function payload(action: string, over: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ action, number: 1, pull_request: { number: 1, merged: action === 'closed', merge_commit_sha: 'f'.repeat(40), head: { sha: SHA } }, repository: { full_name: REPO }, ...over }));
}
function deliver(body: Buffer, id: string, over: { event?: string; signature?: string | null } = {}) {
  const headers: Record<string, string> = { 'x-github-event': over.event ?? 'pull_request', 'x-github-delivery': id };
  if (over.signature !== null) headers['x-hub-signature-256'] = over.signature ?? signBody(SECRET, body);
  return handleGithubWebhook({ rawBody: body, headers }, wh());
}
const status = async (id: string) => String((await q(tdb.db, `SELECT status FROM task_status WHERE task_id = '${id}'`))[0]!['status']);
const lifecycle = async () => String((await q(tdb.db, 'SELECT lifecycle FROM runs'))[0]!['lifecycle']);
const mergedEvents = async () => q(tdb.db, "SELECT task_id, actor_kind FROM events WHERE type = 'change.merged' ORDER BY sequence");

beforeAll(async () => { tdb = await setupTestDb(8); });
afterAll(async () => { await tdb.close(); });
beforeEach(async () => {
  await resetDb(tdb.db); gh = new FakeGitHub(); await seedReadyRun(tdb.db);
  await openReviewablePr({ tenantId: TENANT, projectId: PROJECT, runId: RUN, repoPath: '/r' }, { db: tdb.db, port: gh, loadRecord: async () => record(), now: () => T0 });
});

describe('webhook', () => {
  it('webhook signature verified on raw bytes', async () => {
    const body = payload('opened');
    expect((await deliver(body, 'd1')).status).toBe(202);
    // Same JSON, different bytes: the signature over the original bytes no longer matches.
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect((await deliver(reformatted, 'd2', { signature: signBody(SECRET, body) })).status).toBe(401);
    expect((await deliver(body, 'd3', { signature: null })).status).toBe(401);
    expect((await deliver(body, 'd4', { signature: signBody('other-secret', body) })).status).toBe(401);
    expect((await deliver(body, 'd5', { signature: 'sha256=zz' })).status).toBe(401);
    expect((await deliver(body, 'd6', { signature: 'sha1=' + createHmac('sha1', SECRET).update(body).digest('hex') })).status).toBe(401);
    expect(await q(tdb.db, 'SELECT delivery_id FROM integration_deliveries')).toEqual([{ delivery_id: 'd1' }]);
  });

  it('a missing, empty or non-Buffer body is 401, not a server error', async () => {
    expect((await handleGithubWebhook({ rawBody: undefined as unknown as Buffer, headers: {} }, wh())).status).toBe(401);
    expect((await handleGithubWebhook({ rawBody: 'text' as unknown as Buffer, headers: { 'x-hub-signature-256': signBody(SECRET, Buffer.alloc(0)) } }, wh())).status).toBe(401);
    expect((await deliver(Buffer.alloc(0), 'e1', { signature: null })).status).toBe(401);
  });

  it('rejects unknown events, repositories and malformed bodies', async () => {
    expect((await deliver(payload('opened'), 'u1', { event: 'issues' })).status).toBe(422);
    expect((await deliver(payload('opened', { repository: { full_name: 'evil/other' } }), 'u2')).status).toBe(404);
    expect((await deliver(Buffer.from('not json'), 'u3')).status).toBe(400);
    expect((await deliver(payload('opened'), '', {})).status).toBe(400);
    expect(await q(tdb.db, 'SELECT 1 FROM integration_deliveries')).toHaveLength(0);
  });

  it('duplicate and out-of-order deliveries handled', async () => {
    const closed = payload('closed');
    expect((await deliver(closed, 'd-close')).status).toBe(202);
    const dup = await deliver(closed, 'd-close');
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ duplicate: true });
    // The "opened" delivery arrives after "closed"; the PR is really merged.
    expect((await deliver(payload('opened'), 'd-open')).status).toBe(202);
    expect(await q(tdb.db, 'SELECT 1 FROM integration_deliveries')).toHaveLength(2);
    gh.humanMerges(1);
    await processPendingDeliveries(rdeps());
    expect(await mergedEvents()).toHaveLength(3); // run + two tasks, once
    await processPendingDeliveries(rdeps());
    expect(await mergedEvents()).toHaveLength(3);
    expect(await q(tdb.db, "SELECT 1 FROM integration_deliveries WHERE status <> 'processed'")).toHaveLength(0);
  });
});

describe('reconciliation', () => {
  it('merged only after authoritative read', async () => {
    // A signed webhook that claims a merge changes nothing by itself.
    await deliver(payload('closed'), 'claim');
    expect(await mergedEvents()).toEqual([]);
    expect(await status('task_a')).toBe('verified');
    // GitHub still says open: processing the hint leaves everything as it was.
    await processPendingDeliveries(rdeps());
    expect(await mergedEvents()).toEqual([]);
    expect(await status('task_a')).toBe('verified');
    expect(await lifecycle()).toBe('ready_for_review');
    // A human merges on GitHub; only now does the authoritative read move state.
    gh.humanMerges(1);
    const out = await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, rdeps());
    expect(out.status).toBe('merged');
    expect(await status('task_a')).toBe('merged');
    expect(await status('task_b')).toBe('merged');
    expect(await lifecycle()).toBe('merged');
    expect((await mergedEvents()).every((e) => e['actor_kind'] === 'integration')).toBe(true);
    expect((await q(tdb.db, 'SELECT status, merge_commit_sha FROM change_requests'))[0]).toEqual({ status: 'merged', merge_commit_sha: 'f'.repeat(40) });
    // Reconciling again is a no-op.
    expect((await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, rdeps())).status).toBe('unchanged');
    expect(await mergedEvents()).toHaveLength(3);
  });

  it('does not record a merge of a different head than the candidate', async () => {
    gh.humanPushes(1, '9'.repeat(40));
    gh.humanMerges(1);
    const out = await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, rdeps());
    expect(out.status).toBe('sha_mismatch');
    expect(await mergedEvents()).toEqual([]);
    expect(await status('task_a')).toBe('verified');
    expect((await q(tdb.db, 'SELECT status FROM change_requests'))[0]).toEqual({ status: 'merged_sha_mismatch' });
  });

  it('a human merge of the old PR after the candidate was invalidated changes nothing', async () => {
    await supersedeCandidate(tdb.db);
    gh.humanMerges(1);
    const out = await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, rdeps());
    expect(out.status).toBe('stale');
    expect(await mergedEvents()).toHaveLength(0);
    expect(await status('task_a')).toBe('verified');
    expect(await status('task_b')).toBe('verified');
    expect(await lifecycle()).toBe('ready_for_review');
    expect((await q(tdb.db, 'SELECT status FROM change_requests'))[0]).toEqual({ status: 'stale_candidate' });
  });

  it('a PR retargeted to another base and merged with the candidate head is not recorded as merged', async () => {
    gh.humanRetargets(1, 'develop');
    gh.humanMerges(1);
    expect((await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, rdeps())).status).toBe('sha_mismatch');
    expect(await mergedEvents()).toHaveLength(0);
    expect(await status('task_a')).toBe('verified');
    expect(await lifecycle()).toBe('ready_for_review');
  });

  it('merges only the tasks that are parts of the candidate', async () => {
    await tdb.db.execute(await import('drizzle-orm').then((m) => m.sql`UPDATE candidates SET parts = '[{"taskId":"task_a"}]'::jsonb`));
    gh.humanMerges(1);
    expect((await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, rdeps())).status).toBe('merged');
    expect(await status('task_a')).toBe('merged');
    expect(await status('task_b')).toBe('verified');
  });

  it('polling observes close, reopen and merge of a closed PR', async () => {
    const driver = startReconciler({ ...rdeps(), intervalMs: 3_600_000 });
    try {
      gh.humanCloses(1);
      await driver.tick();
      expect((await q(tdb.db, 'SELECT status FROM change_requests'))[0]).toEqual({ status: 'closed' });
      gh.humanReopens(1);
      gh.humanMerges(1);
      const r = await driver.tick();
      expect(r.polled).toBe(1);
      expect(await status('task_a')).toBe('merged');
    } finally { await driver.stop(); }
  });

  it('reports failures through onError on the timer path and redacts secrets from stored errors', async () => {
    const leak = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    gh.getPullRequest = async () => { throw new Error(`gh failed token=${leak}`); };
    await deliver(payload('closed'), 'fail-1');
    const errors: unknown[] = [];
    const driver = startReconciler({ ...rdeps(), intervalMs: 3_600_000, onError: (e) => errors.push(e) });
    try {
      const r = await driver.tick();
      expect(r.failed).toBe(2);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.map(String).join('\n')).not.toContain(leak);
    } finally { await driver.stop(); }
    const row = (await q(tdb.db, "SELECT last_error, status FROM integration_deliveries WHERE delivery_id = 'fail-1'"))[0]!;
    expect(row['status']).toBe('received');
    expect(String(row['last_error'])).not.toContain(leak);
  });

  it('the least recently observed closed row is polled first, so the bound cannot starve it', async () => {
    const { CLOSED_POLL_LIMIT } = await import('./reconcile.ts');
    await tdb.db.execute(sql`UPDATE change_requests SET status = 'closed', observed_at = ${new Date(T0.getTime() - 86_400_000).toISOString()}::timestamptz`);
    for (let i = 0; i < CLOSED_POLL_LIMIT; i++) {
      const run = `run_x${i}`;
      await tdb.db.execute(sql`INSERT INTO runs (tenant_id, project_id, run_id, lifecycle) VALUES (${TENANT}, ${PROJECT}, ${run}, 'merged')`);
      await tdb.db.execute(sql`INSERT INTO change_requests (tenant_id, project_id, run_id, repository, candidate_sha, branch, base_ref, pr_number, url, status, observed_at)
        VALUES (${TENANT}, ${PROJECT}, ${run}, ${REPO}, ${SHA}, 'b', 'main', ${1000 + i}, 'u', 'closed', ${T0.toISOString()}::timestamptz)`);
    }
    gh.humanReopens(1);
    gh.humanMerges(1);
    const r = await pollOpenChangeRequests(rdeps());
    expect(r.polled).toBe(CLOSED_POLL_LIMIT);
    expect(await status('task_a')).toBe('merged');
  });

  it('a merge of the same SHA while the run is no longer ready_for_review records nothing', async () => {
    await tdb.db.execute(sql`UPDATE runs SET lifecycle = 'running'`);
    gh.humanMerges(1);
    expect((await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, rdeps())).status).toBe('stale');
    expect(await mergedEvents()).toHaveLength(0);
    expect(await status('task_a')).toBe('verified');
    expect(await lifecycle()).toBe('running');
  });

  it('a poll that read the old PR cannot write its state onto the row that replaced it', async () => {
    const key = { tenantId: TENANT, projectId: PROJECT, runId: RUN };
    await tdb.db.execute(sql`UPDATE change_requests SET status = 'closed'`);
    gh.humanMerges(1, 'a1'.repeat(20));
    const pr2 = gh.foreignPr({ headRef: 'selarikru/run_a/222222222222', headSha: SHA2, baseRef: 'main' });
    const realGet = gh.getPullRequest.bind(gh);
    // The interleaving: while the poll is reading PR 1, a successor open replaces the row with candidate B and PR 2.
    gh.getPullRequest = async (repository, number) => {
      const seen = await realGet(repository, number);
      if (number === 1) {
        await supersedeCandidate(tdb.db);
        await tdb.db.execute(sql`UPDATE change_requests SET candidate_sha = ${SHA2}, pr_number = ${pr2.number}, branch = 'selarikru/run_a/222222222222', status = 'open', merge_commit_sha = NULL`);
      }
      return seen;
    };
    expect((await reconcileRun(key, rdeps())).status).toBe('unchanged');
    expect(await q(tdb.db, 'SELECT candidate_sha, pr_number, status, merge_commit_sha FROM change_requests')).toEqual([
      { candidate_sha: SHA2, pr_number: pr2.number, status: 'open', merge_commit_sha: null }]);
    expect(await mergedEvents()).toHaveLength(0);
    // The run can still finish: a later merge of PR 2 is recorded.
    gh.getPullRequest = realGet;
    gh.humanMerges(pr2.number);
    expect((await reconcileRun(key, rdeps())).status).toBe('merged');
    expect(await status('task_a')).toBe('merged');
    expect(await lifecycle()).toBe('merged');
  });

  it('a PR closed without merging leaves tasks verified', async () => {
    gh.humanCloses(1);
    expect((await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, rdeps())).status).toBe('closed');
    expect(await status('task_a')).toBe('verified');
    expect(await mergedEvents()).toEqual([]);
  });

  it('an unreadable PR (GitHub unreachable) changes nothing', async () => {
    gh.humanMerges(1);
    gh.getPullRequest = async () => { throw new Error('network down'); };
    await expect(reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, rdeps())).rejects.toThrow('network down');
    expect(await mergedEvents()).toEqual([]);
  });

  it('polling reconciles open PRs on the injected clock, without any webhook', async () => {
    gh.humanMerges(1);
    let now = T0.getTime();
    const driver = startReconciler({ ...rdeps(), now: () => new Date(now), intervalMs: 3_600_000 });
    try {
      const r = await driver.tick();
      expect(r.polled).toBe(1);
      expect(await status('task_a')).toBe('merged');
      expect(driver.ticks()).toBe(1);
      expect((await pollOpenChangeRequests(rdeps())).polled).toBe(0);
    } finally { await driver.stop(); }
  });
});
