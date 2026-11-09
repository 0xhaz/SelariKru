import { createScheduler, type Scheduler } from '@selarikru/workflow';
import { schema } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import { CLOUD_POLICY, POLICY, runner } from '@selarikru/workflow/test-helpers';
import { reconcileRun } from '@selarikru/integrations-github';
import { FakeGitHub } from '@selarikru/integrations-github/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startLeaseExpiryDriver } from '../src/expire.ts';
import { CAPS, PROJECT, RUN, TENANT, API_POLICY, enrolRunner, bearer, get, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

const POLICY_OPS: Policy = { ...API_POLICY, ...POLICY, operations: { assign_replan_tasks: 'allow', destructive_data_migration: 'require_approval', deploy: 'deny' } };
const CLOUD_APPROVAL: Policy = { ...(CLOUD_POLICY as Policy), operations: { start_cloud_worker: 'require_approval' } };

let t: TestDb;
let h: Harness;
let s: Scheduler;

function setup(policy: Policy): void {
  s = createScheduler({ db: t.db, now: makeHarness(t, {}, policy).clock.now, policy });
  h = makeHarness(t, {}, policy, { scheduler: s });
}

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`TRUNCATE candidates, change_requests, task_commands CASCADE`);
  setup(POLICY_OPS);
});

const approvalRows = async () => [...(await t.db.execute(sql`SELECT * FROM approvals ORDER BY created_at`))];
const statusOf = async (id: string) => (await t.db.execute(sql`SELECT status, current_revision, row_revision FROM task_status WHERE task_id = ${id}`))[0]!;
const countEvents = async (type: string) => Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM events WHERE type = ${type}`))[0]!['n']);

async function runnerRequest(id = 't1') {
  await seedTask(t.db, specFor(id));
  const lease = (await s.claimNext(runner('r1'), CAPS))!;
  await s.publishResult(lease, { outcome: 'approval_requested', reason: 'needs docs.example.com', operation: 'destructive_data_migration' });
  return { lease, row: (await approvalRows())[0]! };
}
const resolve = (approvalId: string, body: Record<string, unknown>) => post(h.app, `/v1/approvals/${approvalId}/resolve`, { decision: 'grant', expectedRevision: 0, ...body });

describe('approval rows through the API', () => {
  it('grant releases exactly once', async () => {
    await t.db.execute(sql`UPDATE runs SET placement = ${JSON.stringify({ mode: 'C1', cloudDestination: 'cloud-sandbox-eu' })}::jsonb`);
    setup(CLOUD_APPROVAL);
    await seedTask(t.db, specFor('c1', { execution: 'cloud' }));
    await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    const row = (await approvalRows())[0]!;
    const before = await statusOf('c1');
    const scopeHash = String(row['scope_hash']);
    const expectedRevision = Number(before['row_revision']);
    // Concurrent grants under different keys: one wins.
    const results = await Promise.all(['k1', 'k2', 'k3'].map((idempotencyKey) => resolve(String(row['approval_id']), { scopeHash, expectedRevision, idempotencyKey })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'approval_already_resolved')).toBe(true);
    // A retry of the winning key replays the receipt.
    const winnerKey = ['k1', 'k2', 'k3'][results.findIndex((r) => r.status === 200)]!;
    const retry = await resolve(String(row['approval_id']), { scopeHash, expectedRevision, idempotencyKey: winnerKey });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(results.find((r) => r.status === 200)!.body);
    expect(await countEvents('approval.granted')).toBe(1);
    expect((await statusOf('c1'))['status']).toBe('ready');

    // Released work starts once, and a second claim finds nothing to start.
    const [one, two] = await Promise.all([s.claimNext(runner('cloud1', 'cloud'), CAPS), s.claimNext(runner('cloud2', 'cloud'), CAPS)]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM attempts WHERE detail->>'location' = 'cloud'`))[0]!['n'])).toBe(1);
    expect((await approvalRows())[0]!['consumed_at']).not.toBeNull();
  });

  it('replan supersedes a pending approval', async () => {
    const { row } = await runnerRequest();
    await t.db.execute(sql`UPDATE runs SET plan_revision = 1`);
    expect((await statusOf('t1'))['status']).toBe('awaiting_approval');
    const replanned = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 1, tasks: [specFor('t1', { revision: 2 })] });
    expect(replanned.status).toBe(201);
    expect((await approvalRows())[0]).toMatchObject({ outcome: 'superseded' });
    expect((await statusOf('t1'))).toMatchObject({ status: 'planned', current_revision: 2 });
    const late = await resolve(String(row['approval_id']), { scopeHash: row['scope_hash'], expectedRevision: Number((await statusOf('t1'))['row_revision']), idempotencyKey: 'late' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('approval_already_resolved');
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.body.approvals).toEqual([]);
  });

  it('a grant cannot outrun a policy that now denies the operation', async () => {
    const { row } = await runnerRequest();
    h = makeHarness(t, {}, { ...POLICY_OPS, operations: { assign_replan_tasks: 'allow', destructive_data_migration: 'deny' } }, { scheduler: s });
    const res = await resolve(String(row['approval_id']), { scopeHash: row['scope_hash'], expectedRevision: Number((await statusOf('t1'))['row_revision']), idempotencyKey: 'x1' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('policy_denied');
    expect((await statusOf('t1'))['status']).toBe('awaiting_approval');
    expect((await approvalRows())[0]).toMatchObject({ outcome: 'pending' });
  });

  it('a row that names no operation cannot be granted, but can be denied', async () => {
    await seedTask(t.db, specFor('t9'), 'awaiting_approval');
    const seed = (id: string) => t.db.execute(sql`INSERT INTO approvals (tenant_id, project_id, approval_id, run_id, task_id, revision, requester, action_hash, scope_hash, outcome) VALUES (${TENANT}, ${PROJECT}, ${id}, ${RUN}, 't9', 1, 'worker', 'ah', ${`scope-${id}`}, 'pending')`);
    await seed('a-no-op');
    const res = await resolve('a-no-op', { scopeHash: 'scope-a-no-op', expectedRevision: 0, idempotencyKey: 'n1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'policy_denied', details: { reason: 'approval_operation_missing' } });
    expect((await statusOf('t9'))['status']).toBe('awaiting_approval');
    const denied = await resolve('a-no-op', { decision: 'deny', scopeHash: 'scope-a-no-op', expectedRevision: 0, idempotencyKey: 'n2' });
    expect(denied.status).toBe(200);
    expect((await statusOf('t9'))['status']).toBe('blocked');
  });

  it('an expired approval cannot be granted before or after the sweep, but can still be denied', async () => {
    const { row } = await runnerRequest();
    const id = String(row['approval_id']);
    const scopeHash = row['scope_hash'];
    h.clock.advance(24 * 3600 + 1);
    // Not swept yet: the clock alone refuses the grant.
    const early = await resolve(id, { scopeHash, expectedRevision: Number((await statusOf('t1'))['row_revision']), idempotencyKey: 'e1' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('approval_expired');
    expect(await s.expireApprovals(new Date(Date.parse('2026-11-08T06:00:00.000Z') + 2 * 24 * 3600 * 1000))).toEqual([id]);
    const rev = Number((await statusOf('t1'))['row_revision']);
    expect((await statusOf('t1'))['status']).toBe('blocked');
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.body.tasks.find((x: { taskId: string }) => x.taskId === 't1').blockedReason).toBe('approval_expired');
    expect(snap.body.approvals).toEqual([expect.objectContaining({ approvalId: id, outcome: 'expired' })]);
    const late = await resolve(id, { scopeHash, expectedRevision: rev, idempotencyKey: 'e2' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('approval_expired');
    expect(await countEvents('approval.granted')).toBe(0);
    const denied = await resolve(id, { decision: 'deny', scopeHash, expectedRevision: rev, idempotencyKey: 'e3' });
    expect(denied.status).toBe(200);
    expect((await approvalRows())[0]).toMatchObject({ outcome: 'denied', approver: 'owner_uid_1' });
    expect(await countEvents('approval.denied')).toBe(1);
    expect((await statusOf('t1'))['status']).toBe('blocked');
    expect((await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body.approvals).toEqual([]);
  });

  it('the lease-expiry driver runs both sweeps even when one throws', async () => {
    const calls: string[] = [];
    const failing = startLeaseExpiryDriver({
      scheduler: { expireLeases: async () => { calls.push('leases'); throw new Error('lease sweep broke'); }, expireApprovals: async () => { calls.push('approvals'); return []; } },
      now: () => new Date(), intervalMs: 1_000_000,
    });
    await expect(failing.tick()).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(['leases', 'approvals']);
    await failing.stop();
  });

  it('the lease-expiry driver runs the approval sweep', async () => {
    const { row } = await runnerRequest();
    const sweep = startLeaseExpiryDriver({ scheduler: s, now: () => new Date(Date.parse(String(row['expires_at'])) + 1000), intervalMs: 1_000_000 });
    await sweep.tick();
    await sweep.stop();
    expect((await approvalRows())[0]).toMatchObject({ outcome: 'expired' });
  });

  it('cancelling a task closes its open approval', async () => {
    const { row } = await runnerRequest();
    const rev = Number((await statusOf('t1'))['row_revision']);
    const res = await post(h.app, '/v1/tasks/t1/commands', { command: 'cancel', expectedRevision: rev, idempotencyKey: 'c1' });
    expect(res.status).toBe(202);
    expect((await approvalRows())[0]).toMatchObject({ outcome: 'superseded' });
    const late = await resolve(String(row['approval_id']), { scopeHash: row['scope_hash'], expectedRevision: rev + 1, idempotencyKey: 'x2' });
    expect(late.body.error.code).toBe('approval_already_resolved');
  });

  it('a grant for a task no longer waiting is refused and leaves the task', async () => {
    const { row } = await runnerRequest();
    await t.db.execute(sql`UPDATE task_status SET status = 'ready'`);
    const res = await resolve(String(row['approval_id']), { scopeHash: row['scope_hash'], expectedRevision: Number((await statusOf('t1'))['row_revision']), idempotencyKey: 'x3' });
    expect(res.status).toBe(409);
    expect((await approvalRows())[0]).toMatchObject({ outcome: 'pending' });
  });

  it('the snapshot and the runner route carry the request end to end, and the worker reason is redacted', async () => {
    await seedTask(t.db, specFor('t2'));
    const { token } = await enrolRunner(h.app);
    const claim = await post(h.app, '/v1/runners/claim', {}, bearer(token));
    const canary = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    await post(h.app, '/v1/runners/result', { lease: { attemptId: claim.body.lease.attemptId, fence: claim.body.lease.fence, leaseToken: claim.body.lease.leaseToken }, result: { outcome: 'approval_requested', reason: `need ${canary}`, operation: 'destructive_data_migration' } }, bearer(token));
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(JSON.stringify(snap.body)).not.toContain(canary);
    expect(snap.body.approvals).toHaveLength(1);
    expect(snap.body.approvals[0]).toMatchObject({ taskId: 't2', revision: 1, operation: 'destructive_data_migration', reason: 'need [REDACTED]' });
    expect(typeof snap.body.approvals[0].expiresAt).toBe('string');
    expect(typeof snap.body.approvals[0].requestedAt).toBe('string');
  });

  it('a non-identifier operation is rejected by the runner route', async () => {
    await seedTask(t.db, specFor('t3'));
    const { token } = await enrolRunner(h.app);
    const claim = await post(h.app, '/v1/runners/claim', {}, bearer(token));
    const res = await post(h.app, '/v1/runners/result', { lease: { attemptId: claim.body.lease.attemptId, fence: claim.body.lease.fence, leaseToken: claim.body.lease.leaseToken }, result: { outcome: 'approval_requested', reason: 'r', operation: 'Not An Op!' } }, bearer(token));
    expect(res.status).toBe(400);
  });
});

describe('plan acceptance and blocked tasks', () => {
  it('zero cost cap refused at plan acceptance', async () => {
    const res = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks: [specFor('z1', { maxCostUsd: 0 })] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('plan_invalid');
    expect(res.body.error.details).toEqual([{ kind: 'zero_cost_cap', taskId: 'z1', field: 'limits.maxCostUsd' }]);
    expect(await countEvents('plan.accepted')).toBe(0);
  });

  it('a blocked task can be replanned through the existing route, and the snapshot says why it is blocked', async () => {
    await seedTask(t.db, specFor('b1'), 'blocked');
    await t.db.execute(sql`UPDATE runs SET plan_revision = 1`);
    await t.db.execute(sql`INSERT INTO project_sequences (tenant_id, project_id, last_sequence) VALUES (${TENANT}, ${PROJECT}, 1)`);
    await t.db.execute(sql`INSERT INTO events (tenant_id, project_id, sequence, schema_version, event_id, run_id, task_id, type, aggregate_revision, actor_kind, actor_id, occurred_at, received_at, trace_id, payload)
      VALUES (${TENANT}, ${PROJECT}, 1, 1, 'evt_b1', ${RUN}, 'b1', 'task.reopened', 1, 'integration', 'i', now(), now(), 'trace_b1', '{"status":"blocked","blocked":"resource_conflict:repo"}'::jsonb)`);
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.body.tasks.find((x: { taskId: string }) => x.taskId === 'b1').blockedReason).toBe('resource_conflict:repo');
    const res = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 1, tasks: [specFor('b1', { revision: 2 })] });
    expect(res.status).toBe(201);
    expect((await statusOf('b1'))).toMatchObject({ status: 'planned', current_revision: 2 });
  });
});

describe('budget-stopped runs', () => {
  const seedStopped = async () => {
    await seedTask(t.db, specFor('done', { requirementIds: ['FB-01', 'FB-03'] }), 'verified');
    await seedTask(t.db, specFor('stopped', { requirementIds: ['FB-02', 'FB-03'], acceptanceCheckIds: ['chk-2'] }), 'cancelled');
    await t.db.insert(schema.taskCommands).values({
      tenantId: TENANT, projectId: PROJECT, operationId: 'op_stop', taskId: 'stopped', revision: 1, command: 'cancel', state: 'cancelled', requestedBy: 'budget_enforcer', requestedAt: new Date(), detail: { reason: 'budget_exhausted' },
    });
    await t.db.execute(sql`UPDATE runs SET plan_revision = 1`);
  };
  const accept = (idempotencyKey: string, expectedPlanRevision = 1) => post(h.app, `/v1/runs/${RUN}/accept-reduced-scope`, { idempotencyKey, expectedPlanRevision });

  it('accepted reduced scope never counts stopped criteria as verified', async () => {
    await seedStopped();
    const before = (await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body.runs.find((r: { runId: string }) => r.runId === RUN);
    expect(before.scopeAssessment).toMatchObject({ stopped: [{ taskId: 'stopped', revision: 1 }], stoppingTaskIds: [], deliveredRequirementIds: ['FB-01'] });
    expect(before.scopeAssessment.notDelivered.requirementIds).toEqual(['FB-02', 'FB-03']);
    expect(before.reducedScope).toBeNull();
    const res = await accept('a1');
    expect(res.status).toBe(201);
    expect(res.body.notDelivered).toEqual({ tasks: [{ taskId: 'stopped', revision: 1, status: 'cancelled', budgetStopped: true }], requirementIds: ['FB-02', 'FB-03'], acceptanceCheckIds: ['chk-2'] });
    // FB-03 is shared with a verified task, but a stopped task still owed it: it stays not delivered.
    expect(res.body.deliveredRequirementIds).toEqual(['FB-01']);
    expect((await statusOf('stopped'))['status']).toBe('cancelled');
    expect(await countEvents('verification.passed')).toBe(0);
    const ev = (await t.db.execute(sql`SELECT actor_kind, actor_id, payload FROM events WHERE type = 'run.reduced_scope_accepted'`))[0]!;
    expect(ev).toMatchObject({ actor_kind: 'human', actor_id: 'owner_uid_1' });
    expect((ev['payload'] as { notDelivered: { requirementIds: string[] } }).notDelivered.requirementIds).toContain('FB-03');
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    const run = snap.body.runs.find((r: { runId: string }) => r.runId === RUN);
    expect(run.reducedScope.notDelivered.requirementIds).toEqual(['FB-02', 'FB-03']);
    expect(run.reducedScope.deliveredRequirementIds).toEqual(['FB-01']);
    expect(run.lifecycle).toBe('running');
    // Replaying the key replays the answer; a new key cannot accept twice.
    const replay = await accept('a1');
    expect(replay.status).toBe(201);
    expect(replay.body.decisionId).toBe(res.body.decisionId);
    expect(await countEvents('run.reduced_scope_accepted')).toBe(1);
    const again = await accept('a2');
    expect(again.status).toBe(403);
    expect(again.body.error.details.reason).toBe('already_accepted');
  });

  it('an unstarted task sharing a requirement keeps it not delivered, and is listed with its status', async () => {
    await seedStopped();
    await seedTask(t.db, specFor('later', { requirementIds: ['FB-01'] }), 'ready');
    await seedTask(t.db, specFor('never', { requirementIds: ['FB-07'] }), 'planned');
    const res = await accept('u1');
    expect(res.status).toBe(201);
    expect(res.body.notDelivered.tasks).toEqual([
      { taskId: 'later', revision: 1, status: 'ready', budgetStopped: false },
      { taskId: 'never', revision: 1, status: 'planned', budgetStopped: false },
      { taskId: 'stopped', revision: 1, status: 'cancelled', budgetStopped: true },
    ]);
    expect(res.body.notDelivered.requirementIds).toEqual(['FB-01', 'FB-02', 'FB-03', 'FB-07']);
    expect(res.body.deliveredRequirementIds).toEqual([]);
  });

  it('refuses a run with no budget stop, a stale plan, and a stop still in flight', async () => {
    await seedTask(t.db, specFor('ok1'), 'verified');
    await t.db.execute(sql`UPDATE runs SET plan_revision = 1`);
    const none = await accept('n1');
    expect(none.status).toBe(403);
    expect(none.body.error.details.reason).toBe('not_budget_stopped');
    await seedStopped();
    expect((await accept('stale', 0)).status).toBe(409);
    await seedTask(t.db, specFor('still'), 'running');
    await t.db.insert(schema.taskCommands).values({
      tenantId: TENANT, projectId: PROJECT, operationId: 'op_live', taskId: 'still', revision: 1, command: 'cancel', state: 'cancel_requested', requestedBy: 'budget_enforcer', requestedAt: new Date(), detail: { reason: 'budget_exhausted' },
    });
    const live = await accept('l1');
    expect(live.status).toBe(403);
    expect(live.body.error.code).toBe('cancel_pending');
  });

  it('a runner credential cannot accept reduced scope', async () => {
    await seedStopped();
    const { token } = await enrolRunner(h.app);
    const res = await post(h.app, `/v1/runs/${RUN}/accept-reduced-scope`, { idempotencyKey: 'r', expectedPlanRevision: 1 }, bearer(token));
    expect(res.status).toBe(403);
  });
});

describe('merge reconciliation reaches the owner', () => {
  const SHA = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  let gh: FakeGitHub;
  beforeEach(async () => {
    gh = new FakeGitHub();
    await t.db.execute(sql`UPDATE runs SET lifecycle = 'ready_for_review'`);
    await t.db.insert(schema.candidates).values({ tenantId: TENANT, projectId: PROJECT, candidateId: 'cand_1', runId: RUN, target: 'main', sha: SHA, baseSha: OTHER, treeSha: 'c'.repeat(40), parts: [], status: 'assembled' });
    await t.db.insert(schema.changeRequests).values({ tenantId: TENANT, projectId: PROJECT, runId: RUN, repository: 'acme/repo', candidateSha: SHA, branch: 'b', baseRef: 'main', prNumber: 1, url: 'https://github.com/acme/repo/pull/1', status: 'open' });
    gh.prs.push({ number: 1, url: 'https://github.com/acme/repo/pull/1', state: 'merged', draft: false, headRef: 'b', headSha: OTHER, baseRef: 'main', isCrossRepository: false, mergeCommitSha: 'f'.repeat(40), body: '', title: '' } as never);
  });

  it('merged mismatch reaches the owner', async () => {
    expect((await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, { db: t.db, port: gh, now: h.clock.now })).status).toBe('sha_mismatch');
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.body.changeRequests).toEqual([expect.objectContaining({ runId: RUN, prNumber: 1, url: 'https://github.com/acme/repo/pull/1', status: 'merged_sha_mismatch', candidateSha: SHA, observedHeadSha: OTHER, mergeCommitSha: 'f'.repeat(40) })]);
  });

  it('a stale candidate outcome reaches the owner', async () => {
    await t.db.execute(sql`UPDATE runs SET lifecycle = 'blocked'`);
    expect((await reconcileRun({ tenantId: TENANT, projectId: PROJECT, runId: RUN }, { db: t.db, port: gh, now: h.clock.now })).status).toBe('stale');
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.body.changeRequests[0]).toMatchObject({ status: 'stale_candidate', mergeCommitSha: 'f'.repeat(40) });
  });
});
