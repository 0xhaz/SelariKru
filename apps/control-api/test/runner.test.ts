import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, withTx } from '@selarikru/persistence';
import { startLeaseExpiryDriver } from '../src/index.ts';
import { API_POLICY, bearer, enrolRunner, get, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';
import { createScheduler } from '@selarikru/workflow';
import { TEST_CATALOG, POLICY } from '@selarikru/workflow/test-helpers';

let t: TestDb;
let h: Harness;

beforeAll(async () => {
  t = await setupTestDb();
  h = makeHarness(t);
  await h.app.ready();
});
afterAll(async () => {
  await h.app.close();
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
});

describe('runner routes', () => {
  it('claim, heartbeat and result go through the scheduler with the identity from the token', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const { runnerId, token } = await enrolRunner(h.app, 'local');
    const as = bearer(token);

    // Identity fields in the body are not accepted.
    expect((await post(h.app, '/v1/runners/claim', { runnerId: 'someone_else' }, as)).status).toBe(400);

    const claim = await post(h.app, '/v1/runners/claim', {}, as);
    expect(claim.status).toBe(200);
    expect(claim.body.lease).toMatchObject({ runnerId, taskId: 't1', location: 'local' });
    const ref = { attemptId: claim.body.lease.attemptId, fence: claim.body.lease.fence, leaseToken: claim.body.lease.leaseToken };

    h.clock.advance(10);
    const hb = await post(h.app, '/v1/runners/heartbeat', { lease: ref }, as);
    expect(hb.status).toBe(200);
    expect(hb.body.attemptId).toBe(ref.attemptId);

    const wrong = await post(h.app, '/v1/runners/heartbeat', { lease: { ...ref, leaseToken: 'nope' } }, as);
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('lease_conflict');
    expect(wrong.body.error.details.reason).toBe('stale_fence');

    // Another enrolled runner cannot use this lease even with the right token.
    const other = await enrolRunner(h.app, 'local');
    const stolen = await post(h.app, '/v1/runners/heartbeat', { lease: ref }, bearer(other.token));
    expect(stolen.status).toBe(409);

    const done = await post(h.app, '/v1/runners/result', { lease: ref, result: { outcome: 'completed', headSha: 'a'.repeat(40) } }, as);
    expect(done.status).toBe(200);
    expect(done.body.taskStatus).toBe('verifying');
    const ev = await t.db.execute(sql`SELECT actor_kind, actor_id, type FROM events WHERE type = 'attempt.completed'`);
    expect(ev[0]).toMatchObject({ actor_kind: 'worker', actor_id: runnerId });
  });

  it('the leased runner can read the pinned task spec, and nobody else can', async () => {
    await seedTask(t.db, specFor('t1', { baseSha: 'b'.repeat(40), allowedPaths: ['src'] }), 'ready');
    const { token } = await enrolRunner(h.app, 'local');
    const as = bearer(token);
    const claim = await post(h.app, '/v1/runners/claim', {}, as);
    const ref = { attemptId: claim.body.lease.attemptId, fence: claim.body.lease.fence, leaseToken: claim.body.lease.leaseToken };
    const res = await post(h.app, '/v1/runners/task', { lease: ref }, as);
    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({ taskId: 't1', baseSha: 'b'.repeat(40), allowedPaths: ['src'], title: 't1' });
    expect((await post(h.app, '/v1/runners/task', { lease: { ...ref, leaseToken: 'nope' } }, as)).status).toBe(409);
    const other = await enrolRunner(h.app, 'local');
    expect((await post(h.app, '/v1/runners/task', { lease: ref }, bearer(other.token))).status).toBe(409);
  });

  it('a completed result carries the change-set reference into the attempt and its event', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const { token } = await enrolRunner(h.app, 'local');
    const as = bearer(token);
    const claim = await post(h.app, '/v1/runners/claim', {}, as);
    const ref = { attemptId: claim.body.lease.attemptId, fence: claim.body.lease.fence, leaseToken: claim.body.lease.leaseToken };
    const manifest = 'e'.repeat(64);
    const done = await post(h.app, '/v1/runners/result', { lease: ref, result: { outcome: 'completed', changeManifestSha256: manifest } }, as);
    expect(done.status).toBe(200);
    const rows = await t.db.execute(sql`SELECT detail FROM attempts WHERE attempt_id = ${ref.attemptId}`);
    expect(rows[0]!['detail']).toMatchObject({ changeManifestSha256: manifest });
  });

  it('a run with no budget limit is not claimable, and the claim says why', async () => {
    await resetDb(t.db, {});
    await seedTask(t.db, specFor('t1'), 'ready');
    const { token } = await enrolRunner(h.app);
    const claim = await post(h.app, '/v1/runners/claim', {}, bearer(token));
    expect(claim.status).toBe(200);
    expect(claim.body.lease).toBeNull();
    expect(claim.body.reason).toBe('no_claimable_task');
    expect(claim.body.skipped).toEqual([{ taskId: 't1', reason: 'budget:missing_limit' }]);
  });

  it('a revoked runner token stops working', async () => {
    const { token } = await enrolRunner(h.app);
    await t.db.execute(sql`UPDATE runners SET revoked_at = now()`);
    const res = await post(h.app, '/v1/runners/claim', {}, bearer(token));
    expect(res.status).toBe(401);
  });
});

describe('cancel request is honoured by the scheduler', () => {
  const cancel = (taskId: string, rev: number, key: string) => post(h.app, `/v1/tasks/${taskId}/commands`, { command: 'cancel', expectedRevision: rev, idempotencyKey: key });
  const taskRow = async () => (await t.db.execute(sql`SELECT status, row_revision FROM task_status WHERE task_id = 't1'`))[0]!;
  const sched = () => createScheduler({ catalog: TEST_CATALOG, db: t.db, now: h.clock.now, policy: POLICY });

  it('a cancel request writes task.cancel_requested as the human owner and bumps the aggregate revision', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const { token } = await enrolRunner(h.app);
    expect((await post(h.app, '/v1/runners/claim', {}, bearer(token))).body.lease).not.toBeNull();
    const rev = Number((await taskRow())['row_revision']);
    const res = await cancel('t1', rev, 'k1');
    expect(res.body.state).toBe('cancel_requested');
    const ev = await t.db.execute(sql`SELECT type, actor_kind, aggregate_revision FROM events WHERE type = 'task.cancel_requested'`);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_kind: 'human', aggregate_revision: rev + 1 });
    expect(Number((await taskRow())['row_revision'])).toBe(rev + 1);
    expect((await taskRow())['status']).toBe('running');
  });

  it('expiry after a cancel request reaps to cancelled and the task is never re-dispatched', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const r1 = await enrolRunner(h.app);
    const r2 = await enrolRunner(h.app);
    expect((await post(h.app, '/v1/runners/claim', {}, bearer(r1.token))).body.lease).not.toBeNull();
    await cancel('t1', Number((await taskRow())['row_revision']), 'k2');
    h.clock.advance(61);
    expect(await sched().expireLeases(h.clock.now())).toHaveLength(1);
    expect((await taskRow())['status']).toBe('cancelled');
    h.clock.advance(300);
    const again = await post(h.app, '/v1/runners/claim', {}, bearer(r2.token));
    expect(again.body.lease).toBeNull();
    expect(await t.db.execute(sql`SELECT 1 FROM attempts`)).toHaveLength(1);
    const types = (await t.db.execute(sql`SELECT type FROM events ORDER BY sequence`)).map((r) => r['type']);
    expect(types).toContain('task.cancelled');
    expect(types).not.toContain('task.ready');
    const row = (await t.db.execute(sql`SELECT state FROM task_commands WHERE command = 'cancel'`))[0]!;
    expect(row['state']).toBe('cancelled');
    const snap = await get(h.app, `/v1/projects/proj_a/snapshot`);
    expect(snap.body.tasks[0].cancel).toBeNull();
  });

  it('the heartbeat response carries the cancel flag', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const { token } = await enrolRunner(h.app);
    const lease = (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body.lease;
    const ref = { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken };
    expect((await post(h.app, '/v1/runners/heartbeat', { lease: ref }, bearer(token))).body.cancelRequested).toBe(false);
    await cancel('t1', Number((await taskRow())['row_revision']), 'k3');
    h.clock.advance(5);
    expect((await post(h.app, '/v1/runners/heartbeat', { lease: ref }, bearer(token))).body.cancelRequested).toBe(true);
  });

  it('a result published after a cancel request ends in cancelled and closes the request', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const { token } = await enrolRunner(h.app);
    const lease = (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body.lease;
    await cancel('t1', Number((await taskRow())['row_revision']), 'k4');
    const done = await post(h.app, '/v1/runners/result', { lease: { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken }, result: { outcome: 'completed', headSha: 'b'.repeat(40) } }, bearer(token));
    expect(done.status).toBe(200);
    expect(done.body.taskStatus).toBe('cancelled');
    expect((await taskRow())['status']).toBe('cancelled');
    expect((await t.db.execute(sql`SELECT state FROM task_commands WHERE command = 'cancel'`))[0]!['state']).toBe('cancelled');
  });

  it('a published result writes the worker figures to the ledger as estimates, and a retry adds nothing', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const { token } = await enrolRunner(h.app);
    const lease = (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body.lease;
    const body = { lease: { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken }, result: { outcome: 'failed', reason: 'x', reportedCostUsd: 0.5, reportedUsage: { inputTokens: 12 } } };
    expect((await post(h.app, '/v1/runners/result', body, bearer(token))).status).toBe(200);
    const rows = await t.db.execute(sql`SELECT metric, quantity, provenance FROM usage_entries WHERE metric IN ('input_tokens', 'cost_usd') ORDER BY metric`);
    expect(rows).toEqual([{ metric: 'cost_usd', quantity: '0.500000', provenance: 'estimated' }, { metric: 'input_tokens', quantity: '12.000000', provenance: 'estimated' }]);
    await post(h.app, '/v1/runners/result', body, bearer(token));
    expect(await t.db.execute(sql`SELECT 1 FROM usage_entries WHERE metric = 'input_tokens'`)).toHaveLength(1);
  });

  it('a cancelled attempt keeps the reported headSha, reason and its id on the events', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const { token } = await enrolRunner(h.app);
    const lease = (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body.lease;
    await cancel('t1', Number((await taskRow())['row_revision']), 'k5');
    const sha = 'd'.repeat(40);
    await post(h.app, '/v1/runners/result', { lease: { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken }, result: { outcome: 'completed', headSha: sha, reportedCostUsd: 0.5 } }, bearer(token));
    const a = (await t.db.execute(sql`SELECT head_sha, outcome, exit_reason, detail FROM attempts`))[0]!;
    expect(a).toMatchObject({ head_sha: sha, outcome: 'cancelled', exit_reason: 'completed' });
    expect(a['detail']).toMatchObject({ cancelRequested: true, reportedOutcome: 'completed', reportedCostUsd: 0.5 });
    const ev = (await t.db.execute(sql`SELECT attempt_id, payload FROM events WHERE type = 'task.cancelled'`))[0]!;
    expect(ev['attempt_id']).toBe(lease.attemptId);
    expect(ev['payload']).toMatchObject({ reason: 'cancel_requested' });
  });

  it('a failure reason reported after a cancel request is kept, and expiry keeps the attempt id too', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const { token } = await enrolRunner(h.app);
    const lease = (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body.lease;
    await cancel('t1', Number((await taskRow())['row_revision']), 'k6');
    await post(h.app, '/v1/runners/result', { lease: { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken }, result: { outcome: 'failed', reason: 'unit tests failed' } }, bearer(token));
    const a = (await t.db.execute(sql`SELECT exit_reason, detail FROM attempts`))[0]!;
    expect(a['exit_reason']).toBe('unit tests failed');
    expect(a['detail']).toMatchObject({ reportedOutcome: 'failed', reportedReason: 'unit tests failed' });

    await resetDb(t.db);
    await seedTask(t.db, specFor('t1'), 'ready');
    const l2 = (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body.lease;
    await cancel('t1', Number((await taskRow())['row_revision']), 'k7');
    h.clock.advance(61);
    await sched().expireLeases(h.clock.now());
    expect((await t.db.execute(sql`SELECT attempt_id FROM events WHERE type = 'task.cancelled'`))[0]!['attempt_id']).toBe(l2.attemptId);
  });

  it('a normal completion with no cancel request leaves no stale request behind', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const { token } = await enrolRunner(h.app);
    const lease = (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body.lease;
    const done = await post(h.app, '/v1/runners/result', { lease: { attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken }, result: { outcome: 'completed', headSha: 'c'.repeat(40) } }, bearer(token));
    expect(done.body.taskStatus).toBe('verifying');
    expect(await t.db.execute(sql`SELECT 1 FROM task_commands`)).toHaveLength(0);
  });
});

describe('lease expiry driver', () => {
  it('expires silent leases using the injected clock, and stops when told to', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const { token } = await enrolRunner(h.app);
    const claim = await post(h.app, '/v1/runners/claim', {}, bearer(token));
    expect(claim.body.lease).not.toBeNull();

    const scheduler = createScheduler({ catalog: TEST_CATALOG, db: t.db, now: h.clock.now, policy: POLICY });
    const driver = startLeaseExpiryDriver({ scheduler, now: h.clock.now, intervalMs: 10 });
    h.clock.advance(61);
    await waitFor(async () => {
      const rows = await t.db.execute(sql`SELECT outcome FROM attempts`);
      expect(rows[0]!['outcome']).toBe('interrupted');
    });
    await driver.stop();
    const ticks = driver.ticks();
    await new Promise((r) => setTimeout(r, 60));
    expect(driver.ticks()).toBe(ticks);
  });

  it('survives a failing tick and reports it', async () => {
    const errors: unknown[] = [];
    const scheduler = { expireLeases: async () => { throw new Error('db down'); } } as unknown as ReturnType<typeof createScheduler>;
    const driver = startLeaseExpiryDriver({ scheduler, now: h.clock.now, intervalMs: 5, onError: (e) => errors.push(e) });
    await waitFor(async () => { expect(errors.length).toBeGreaterThan(1); });
    await driver.stop();
  });
});

async function waitFor(fn: () => Promise<void>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try { await fn(); return; } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 20)); }
  }
}

describe('freshness and activity', () => {
  const claimOne = async (token: string) => (await post(h.app, '/v1/runners/claim', {}, bearer(token))).body.lease as { attemptId: string; fence: number; leaseToken: string };
  const ref = (l: { attemptId: string; fence: number; leaseToken: string }) => ({ attemptId: l.attemptId, fence: l.fence, leaseToken: l.leaseToken });

  it('a claim records when the runner was last seen, and the snapshot shows it with no token', async () => {
    const { token, runnerId } = await enrolRunner(h.app);
    const seenAt = async () => (await t.db.execute(sql`SELECT last_seen_at FROM runners WHERE runner_id = ${runnerId}`))[0]!['last_seen_at'];
    expect(await seenAt()).not.toBeNull();
    h.clock.advance(30);
    await post(h.app, '/v1/runners/claim', {}, bearer(token));
    const snap = (await get(h.app, '/v1/projects/proj_a/snapshot')).body;
    expect(snap.runners).toEqual(expect.arrayContaining([expect.objectContaining({ runnerId, lastSeenAt: h.clock.now().toISOString(), location: 'local' })]));
    expect(JSON.stringify(snap)).not.toContain(token);
  });

  it('the heartbeat carries a tool name to the snapshot, and refuses anything that is not one', async () => {
    await seedTask(t.db, specFor('task_a'));
    const { token } = await enrolRunner(h.app);
    const lease = await claimOne(token);
    expect((await post(h.app, '/v1/runners/heartbeat', { lease: ref(lease), activity: 'Edit' }, bearer(token))).status).toBe(200);
    const task = (await get(h.app, '/v1/projects/proj_a/snapshot')).body.tasks[0];
    expect(task.attempts[0].activity).toEqual({ tool: 'Edit', at: h.clock.now().toISOString() });
    for (const activity of ['rm -rf /', 'ghp_' + 'a'.repeat(36), 'Edit\nsecond line', '']) {
      expect((await post(h.app, '/v1/runners/heartbeat', { lease: ref(lease), activity }, bearer(token))).status).toBe(400);
    }
  });

  it('a heartbeat with no activity leaves the last reported tool alone', async () => {
    await seedTask(t.db, specFor('task_a'));
    const { token } = await enrolRunner(h.app);
    const lease = await claimOne(token);
    await post(h.app, '/v1/runners/heartbeat', { lease: ref(lease), activity: 'Bash' }, bearer(token));
    const started = h.clock.now().toISOString();
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(10);
      await post(h.app, '/v1/runners/heartbeat', { lease: ref(lease) }, bearer(token));
    }
    const attempt = (await get(h.app, '/v1/projects/proj_a/snapshot')).body.tasks[0].attempts[0];
    // A hung tool: heartbeats keep arriving, the time it started does not move.
    expect(attempt.activity).toEqual({ tool: 'Bash', at: started });
    expect(attempt.lastHeartbeatAt).toBe(h.clock.now().toISOString());
  });
});

describe('per-criterion evidence on the snapshot', () => {
  const SHA = 'a'.repeat(40);
  const TRUSTED = { checkManifestSha256: 'e'.repeat(64), verifierSha256: '1'.repeat(64) };
  const trustedHarness = (trusted = TRUSTED): Harness => makeHarness(t, {}, API_POLICY, { evidence: { trusted: () => trusted, loadRecord: async () => null } });

  /** A candidate with its applied record, check rows and verdict, exactly as the verifier leaves them. */
  async function seedEvidence(over: { candidate?: string; applied?: boolean; firstTaskStatus?: string } = {}) {
    await seedTask(t.db, specFor('t1', { requirementIds: ['FB-01', 'FB-02'] }), over.firstTaskStatus ?? 'verified');
    await seedTask(t.db, specFor('t2', { requirementIds: ['FB-03'] }), 'running');
    await t.db.execute(sql`INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, tree_sha, parts, status) VALUES ('tenant_a', 'proj_a', 'c1', 'run_a', 'main', ${SHA}, ${'b'.repeat(40)}, ${'c'.repeat(40)}, '[]'::jsonb, ${over.candidate ?? 'assembled'})`);
    const ids = ['chk_FB-01', 'chk_FB-02'];
    for (const [check, result] of [['FB-01', 'passed'], ['FB-02', 'failed']] as const) {
      await t.db.execute(sql`INSERT INTO check_runs (tenant_id, project_id, check_run_id, task_id, revision, attempt_id, check_id, check_version, candidate_sha, result, log_refs) VALUES ('tenant_a', 'proj_a', ${`chk_${check}`}, 't1', 1, NULL, ${check}, '1', ${SHA}, ${result}, ${JSON.stringify([{ recordId: 'ver_1', attempt: 1 }])}::jsonb)`);
    }
    await t.db.execute(sql`INSERT INTO artifacts (tenant_id, project_id, artifact_id, run_id, type, sha256, source_revision, classification, locator) VALUES ('tenant_a', 'proj_a', 'ver_1', 'run_a', 'verification_record', ${'9'.repeat(64)}, ${SHA}, 'internal', ${JSON.stringify({ recordId: 'ver_1', candidateSha: SHA, applied: over.applied ?? true, checkRunIds: ids })}::jsonb)`);
    await withTx(t.db, (tx) => appendEvent(tx, { schemaVersion: 1, eventId: 'evt_verdict', projectId: 'proj_a', runId: 'run_a', taskId: 't1', attemptId: null, type: 'verification.passed', sequence: 0, aggregateRevision: 1, actor: { kind: 'verifier', id: 'v' }, occurredAt: h.clock.now().toISOString(), receivedAt: h.clock.now().toISOString(), causationId: null, traceId: 't', payload: { recordId: 'ver_1', candidateSha: SHA, ...TRUSTED, host: 'local-docker', flaky: [] } }));
  }
  const run = async (harness = trustedHarness()) => { await harness.app.ready(); const r = (await get(harness.app, '/v1/projects/proj_a/snapshot')).body.runs[0]; await harness.app.close(); return r; };

  it('counts criteria from the per-requirement evidence, never tasks', async () => {
    await seedEvidence();
    const r = await run();
    expect(r.criteria).toEqual({ verified: 1, total: 3 });
    expect(r.evidence.candidate).toMatchObject({ sha: SHA, live: true, recordValid: true, recordId: 'ver_1' });
    expect(r.evidence.criteria.find((c: { criterionId: string }) => c.criterionId === 'FB-01')).toMatchObject({ state: 'passed', verified: true, candidateSha: SHA, check: { checkRunId: 'chk_FB-01', recordId: 'ver_1' } });
    expect(r.evidence.criteria.find((c: { criterionId: string }) => c.criterionId === 'FB-03')).toMatchObject({ state: 'not_run', candidateSha: null, check: null });
  });

  it('a rejected candidate keeps its results but verifies nothing', async () => {
    await seedEvidence({ candidate: 'rejected' });
    expect((await run()).criteria).toEqual({ verified: 0, total: 3 });
  });

  it('a passing row on a task still running is shown and not counted', async () => {
    await seedEvidence({ firstTaskStatus: 'running' });
    const r = await run();
    expect(r.criteria).toEqual({ verified: 0, total: 3 });
    expect(r.evidence.criteria[0]).toMatchObject({ criterionId: 'FB-01', state: 'passed', verified: false });
  });

  it('a verdict with applied false is not a valid record and counts for nothing', async () => {
    await seedEvidence({ applied: false });
    const r = await run();
    expect(r.criteria.verified).toBe(0);
    expect(r.evidence.candidate.recordValid).toBe(false);
  });

  it('a verifier hash change makes the record no longer valid', async () => {
    await seedEvidence();
    const r = await run(trustedHarness({ ...TRUSTED, verifierSha256: '2'.repeat(64) }));
    expect(r.criteria.verified).toBe(0);
    expect(r.evidence.candidate.recordValid).toBe(false);
    expect(r.evidence.criteria[0]).toMatchObject({ state: 'passed', verified: false });
  });

  it('with nothing to trust, nothing counts', async () => {
    await seedEvidence();
    expect((await get(h.app, '/v1/projects/proj_a/snapshot')).body.runs[0].criteria).toEqual({ verified: 0, total: 3 });
  });

  it('with no requirement ids criteria are null, not a task count', async () => {
    await seedTask(t.db, specFor('t1'), 'verified');
    expect((await run()).criteria).toBeNull();
  });

  it('a cancelled task keeps its criteria in the denominator; a superseded one does not', async () => {
    await seedTask(t.db, specFor('t1', { requirementIds: ['FB-01'] }), 'cancelled');
    await seedTask(t.db, specFor('t2', { requirementIds: ['FB-02'] }), 'superseded');
    const r = await run();
    expect(r.criteria).toEqual({ verified: 0, total: 1 });
    expect(r.evidence.criteria[0]).toMatchObject({ criterionId: 'FB-01', state: 'not_delivered' });
  });

  it('the snapshot says when a task entered its status, the slot limit, and the route of the recorded model', async () => {
    await seedTask(t.db, specFor('task_a'));
    const { token } = await enrolRunner(h.app);
    await post(h.app, '/v1/runners/claim', {}, bearer(token));
    const snap = (await get(h.app, '/v1/projects/proj_a/snapshot')).body;
    expect(snap.limits).toEqual({ maxConcurrentTotal: 2 });
    expect(snap.tasks[0]).toMatchObject({ enteredStatusAt: h.clock.now().toISOString(), role: 'backend', dependsOn: [] });
    expect(snap.tasks[0].attempts[0].assignment).toMatchObject({ route: 'cloud' });
    expect(snap.tasks[0].attempts[0].location).toBe('local');
  });

  it('a model only a stale enrolment reports is not offered', async () => {
    await t.db.execute(sql`DELETE FROM runners`);
    await enrolRunner(h.app);
    expect((await get(h.app, '/v1/projects/proj_a/snapshot')).body.modelCatalog.providers.length).toBeGreaterThan(0);
    h.clock.advance(121);
    expect((await get(h.app, '/v1/projects/proj_a/snapshot')).body.modelCatalog.providers).toEqual([]);
  });
});

describe('verification failures', () => {
  const SHA = 'a'.repeat(40);
  const secret = `ghp_${'a'.repeat(36)}`;
  const withRecord = (failures: { test: string; status: 'failed'; message: string }[]) => makeHarness(t, {}, API_POLICY, { evidence: { trusted: () => ({ checkManifestSha256: 'x', verifierSha256: 'y' }), loadRecord: async () => ({ results: [{ checkId: 'FB-02', status: 'failed', tests: [], failures, evidenceReferences: [] }] }) as never } });
  const seedCandidate = () => t.db.execute(sql`INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, tree_sha, parts, status) VALUES ('tenant_a', 'proj_a', 'c1', 'run_a', 'main', ${SHA}, ${'b'.repeat(40)}, ${'c'.repeat(40)}, '[]'::jsonb, 'rejected')`);
  const URL = '/v1/projects/proj_a/runs/run_a/failures';

  it('returns the failure text redacted and bounded, and needs the owner', async () => {
    await seedCandidate();
    const harness = withRecord([{ test: 'FB-02 reject', status: 'failed', message: `leaked ${secret} ${'x'.repeat(5000)}` }]);
    await harness.app.ready();
    expect((await harness.app.inject({ method: 'GET', url: URL })).statusCode).toBe(401);
    const { body } = await get(harness.app, URL);
    await harness.app.close();
    expect(body).toMatchObject({ candidateSha: SHA, available: true });
    expect(body.failures[0].criterionId).toBe('FB-02');
    expect(body.failures[0].message).not.toContain(secret);
    expect(body.failures[0].message.length).toBeLessThanOrEqual(2000);
  });

  it('a record that no longer stands quotes nothing', async () => {
    await seedCandidate();
    expect((await get(h.app, URL)).body).toEqual({ candidateSha: SHA, available: false, failures: [] });
  });

  it('is scoped to the project', async () => {
    await t.db.execute(sql`INSERT INTO projects (tenant_id, project_id, repository, default_branch, classification) VALUES ('tenant_a', 'proj_b', 'r', 'main', 'internal')`);
    expect((await get(h.app, '/v1/projects/proj_b/runs/run_a/failures')).status).toBe(404);
  });
});
