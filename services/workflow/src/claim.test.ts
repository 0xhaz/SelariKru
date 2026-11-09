import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import { applyVerification, createScheduler, type Scheduler } from './index.ts';
import { TEST_CATALOG,
  TEST_MODELS, CAPS, CLOUD_POLICY, PROJECT, RUN, TENANT, capsWith, countRows, eventTypes, makeScheduler, resetDb, runner, seedTask, setupTestDb, specFor, statusOf,
  testClock, type TestClock, type TestDb,
} from '../test/helpers.ts';

let t: TestDb;
let clock: TestClock;
let s: Scheduler;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  clock = testClock();
  await resetDb(t.db);
  s = makeScheduler(t.db, clock);
});

describe('claim preconditions', () => {
  it('a missing or invalid concurrency limit denies claiming', async () => {
    await seedTask(t.db, specFor('t1'));
    const { maxConcurrentTotal: _omit, ...rest } = CAPS;
    for (const caps of [rest, { ...rest, maxConcurrentTotal: null }, { ...rest, maxConcurrentTotal: 0 }, { ...rest, maxConcurrentTotal: 1.5 }]) {
      expect(await s.tryClaim(runner('r1'), caps)).toMatchObject({ ok: false, reason: 'missing_limit:maxConcurrentTotal' });
    }
    expect(await countRows(t.db, 'attempts')).toBe(0);
  });

  it('every other missing limit also denies claiming', async () => {
    await seedTask(t.db, specFor('t1'));
    for (const name of ['attemptTimeoutSeconds', 'maxInfraRetries', 'infraRetryBackoffSeconds', 'infraRetryBackoffMaxSeconds'] as const) {
      const { [name]: _omit, ...missing } = CAPS;
      expect(await s.tryClaim(runner('r1'), missing)).toMatchObject({ ok: false, reason: `missing_limit:${name}` });
      expect(await s.tryClaim(runner('r1'), { ...missing, [name]: -1 })).toMatchObject({ ok: false, reason: `missing_limit:${name}` });
    }
    expect(await countRows(t.db, 'attempts')).toBe(0);
  });

  it('the deadline is the smaller of the spec timeout and the configured limit', async () => {
    await seedTask(t.db, specFor('short', { timeoutSeconds: 50 }));
    await seedTask(t.db, specFor('long', { timeoutSeconds: 5000 }));
    const caps = { ...capsWith(5), attemptTimeoutSeconds: 100 };
    const a = (await s.claimNext(runner('r1'), caps))!;
    const b = (await s.claimNext(runner('r2'), caps))!;
    const seconds = (l: typeof a) => (new Date(l.deadlineAt).getTime() - new Date(l.acquiredAt).getTime()) / 1000;
    expect(Object.fromEntries([a, b].map((l) => [l.taskId, seconds(l)]))).toEqual({ short: 50, long: 100 });
  });

  it('a timeout consumes the repair budget', async () => {
    await seedTask(t.db, specFor('t1', { maxAttempts: 1, timeoutSeconds: 30 }));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    clock.advance(30);
    expect(await s.expireLeases(clock.now())).toEqual([expect.objectContaining({ attemptId: lease.attemptId, reason: 'attempt_timeout' })]);
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
    const rows = await t.db.execute(sql`SELECT payload FROM events WHERE type = 'task.blocked'`);
    expect(rows[0]!['payload']).toMatchObject({ reason: 'repair_budget_exhausted' });
  });

  it('a lease that went silent before the deadline is reaped as lease_expired', async () => {
    await seedTask(t.db, specFor('t1', { timeoutSeconds: 90 }));
    await s.claimNext(runner('r1'), CAPS);
    clock.advance(600); // reaped late: the lease expired at 60 s, before the 90 s deadline
    expect(await s.expireLeases(clock.now())).toEqual([expect.objectContaining({ reason: 'lease_expired' })]);
  });

  it('zero infrastructure retries blocks after the first expiry', async () => {
    const caps = { ...CAPS, maxInfraRetries: 0 };
    await seedTask(t.db, specFor('t1'));
    await s.claimNext(runner('r1'), caps);
    clock.advance(61);
    await s.expireLeases(clock.now());
    expect(await s.tryClaim(runner('r2'), caps)).toMatchObject({ ok: false, skipped: [{ reason: 'infra_retry_limit_exhausted' }] });
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
  });

  it('runner location must fit the task execution setting', async () => {
    await seedTask(t.db, specFor('t1', { execution: 'cloud' }));
    const hybrid = createScheduler({ catalog: TEST_CATALOG, db: t.db, now: clock.now, policy: CLOUD_POLICY, placement: { mode: { id: 'one-each', localSlots: 1, cloudSlots: 1 }, cloudDestination: 'cloud-sandbox-eu' } });
    const denied = await hybrid.tryClaim(runner('r1', 'local'), CAPS);
    expect(denied).toMatchObject({ ok: false, reason: 'no_claimable_task', skipped: [{ taskId: 't1', reason: 'location_mismatch' }] });
    expect(await hybrid.claimNext(runner('r2', 'cloud'), CAPS)).not.toBeNull();
  });

  it('a restricted task is never claimable by a cloud runner, nor on a cloud model from a local one', async () => {
    await seedTask(t.db, specFor('t1', { classification: 'restricted' }));
    expect(await s.claimNext(runner('r1', 'cloud'), CAPS)).toBeNull();
    expect(await s.tryClaim(runner('r2', 'local'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'model_blocked:restricted_requires_device_model:anthropic/claude-sonnet-5-5' }] });
    expect(await countRows(t.db, 'attempts')).toBe(0);
    expect(await countRows(t.db, 'budget_reservations')).toBe(0);
  });

  it('a status row behind the latest task revision is not claimable', async () => {
    await seedTask(t.db, specFor('t1'));
    await t.db.insert(schema.taskRevisions).values({
      tenantId: TENANT, projectId: PROJECT, runId: RUN, taskId: 't1', revision: 2, boardId: 'b1', spec: specFor('t1', { revision: 2 }),
    });
    expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'stale_status' }] });
    expect(await countRows(t.db, 'attempts')).toBe(0);
  });

  it('a spec whose revision differs from its row is not claimable', async () => {
    await seedTask(t.db, specFor('t1'));
    await t.db.update(schema.taskRevisions).set({ spec: specFor('t1', { revision: 7 }) });
    expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'stale_status' }] });
  });

  it('an invalid stored spec is skipped', async () => {
    await seedTask(t.db, specFor('t1'));
    await t.db.update(schema.taskRevisions).set({ spec: { nope: true } });
    expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'invalid_spec' }] });
  });

  it('dependencies gate readiness, and their revision must match', async () => {
    await seedTask(t.db, specFor('a'), 'running');
    const dep = { taskId: 'a', revision: 1, condition: 'artifact_verified' as const };
    await seedTask(t.db, specFor('b', { dependencies: [dep] }), 'planned');

    expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 'b', reason: 'dependencies_unsatisfied' }] });

    await t.db.execute(sql`UPDATE task_status SET status = 'verified' WHERE task_id = 'a'`);
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    expect(lease.taskId).toBe('b');
    expect(await eventTypes(t.db)).toEqual(['task.ready', 'attempt.started', 'placement.decided']);
    expect((await statusOf(t.db, 'b')).status).toBe('running');
  });

  it('a ready task whose dependency regressed is not claimable', async () => {
    await seedTask(t.db, specFor('a'), 'running');
    await seedTask(t.db, specFor('b', { dependencies: [{ taskId: 'a', revision: 1, condition: 'artifact_verified' }] }), 'ready');
    expect(await s.claimNext(runner('r1'), CAPS)).toBeNull();
  });

  it('change_merged dependencies wait for merged, not verified', async () => {
    await seedTask(t.db, specFor('a'), 'verified');
    await seedTask(t.db, specFor('b', { dependencies: [{ taskId: 'a', revision: 1, condition: 'change_merged' }] }), 'planned');
    expect(await s.claimNext(runner('r1'), CAPS)).toBeNull();
  });

  it('terminal runs are not dispatched', async () => {
    await seedTask(t.db, specFor('t1'));
    await t.db.update(schema.runs).set({ lifecycle: 'cancelled' });
    expect(await s.claimNext(runner('r1'), CAPS)).toBeNull();
  });

  it('claims stay inside the runner tenant', async () => {
    await seedTask(t.db, specFor('t1'));
    expect(await s.claimNext({ ...runner('r1'), tenantId: 'tenant_b' }, CAPS)).toBeNull();
  });

  it('shared claims coexist, exclusive conflicts with shared', async () => {
    await seedTask(t.db, specFor('s1', { resourceClaims: [{ key: 'contract', mode: 'shared' }] }));
    await seedTask(t.db, specFor('s2', { resourceClaims: [{ key: 'contract', mode: 'shared' }] }));
    await seedTask(t.db, specFor('x', { resourceClaims: [{ key: 'contract', mode: 'exclusive' }] }));
    const caps = capsWith(5);
    const a = await s.tryClaim(runner('r1'), caps);
    const b = await s.tryClaim(runner('r2'), caps);
    expect(a.ok && b.ok).toBe(true);
    expect(await s.tryClaim(runner('r3'), caps)).toMatchObject({ ok: false, skipped: [{ taskId: 'x', reason: 'resource_conflict' }] });
  });

  it('a second task claiming the same resource stays blocked while the first is verifying, and is released by the verification outcome', async () => {
    await seedTask(t.db, specFor('a', { resourceClaims: [{ key: 'k', mode: 'exclusive' }] }));
    await seedTask(t.db, specFor('b', { resourceClaims: [{ key: 'k', mode: 'exclusive' }] }));
    const caps = capsWith(5);
    const first = (await s.claimNext(runner('r1'), caps))!;
    expect(first.taskId).toBe('a');
    expect(await s.publishResult(first, { outcome: 'completed' })).toMatchObject({ ok: true, value: { taskStatus: 'verifying' } });
    expect(await s.tryClaim(runner('r2'), caps)).toMatchObject({ ok: false, skipped: [{ taskId: 'b', reason: 'resource_conflict' }] });
    // A verification outcome (here: passed) releases the claim, and the second task can then start.
    const done = await applyVerification({ db: t.db, now: clock.now }, { tenantId: TENANT, projectId: PROJECT, taskId: 'a' }, { actor: { kind: 'verifier', id: 'v1' }, outcome: 'passed', detail: {} });
    expect(done).toMatchObject({ applied: true, taskStatus: 'verified' });
    expect(await s.tryClaim(runner('r2'), caps)).toMatchObject({ ok: true });
  });

  it('skips a conflicted task and leases the next', async () => {
    await seedTask(t.db, specFor('a', { resourceClaims: [{ key: 'k', mode: 'exclusive' }] }));
    await seedTask(t.db, specFor('b', { resourceClaims: [{ key: 'k', mode: 'exclusive' }] }));
    await seedTask(t.db, specFor('c'));
    const caps = capsWith(5);
    const seen = [await s.claimNext(runner('r1'), caps), await s.claimNext(runner('r2'), caps)];
    expect(seen.map((l) => l!.taskId).sort()).toEqual(['a', 'c']);
  });

  it('the repair gate refuses when policy denies, blocking with its reason', async () => {
    const strict = createScheduler({ catalog: TEST_CATALOG, db: t.db, now: clock.now, policy: { policyVersion: 'p', models: TEST_MODELS, limits: { repairAttempts: 1 } } });
    await seedTask(t.db, specFor('t1', { maxAttempts: 3 }));
    const first = (await strict.claimNext(runner('r1'), CAPS))!;
    await strict.publishResult(first, { outcome: 'failed', reason: 'x' });
    const second = (await strict.claimNext(runner('r2'), CAPS))!;
    await strict.publishResult(second, { outcome: 'failed', reason: 'y' });

    expect(await strict.claimNext(runner('r3'), CAPS)).toBeNull();
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
    const rows = await t.db.execute(sql`SELECT payload FROM events WHERE type = 'task.blocked'`);
    expect(rows[0]!['payload']).toMatchObject({ reason: 'repair_limit_exhausted' });
    expect(await countRows(t.db, 'attempts')).toBe(2);
  });

  it('an absent policy denies every attempt: with no policy, no model is permitted', async () => {
    const noPolicy = createScheduler({ catalog: TEST_CATALOG, db: t.db, now: clock.now });
    await seedTask(t.db, specFor('t1', { maxAttempts: 3 }));
    expect(await noPolicy.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, skipped: [{ reason: 'model_blocked:model_not_assigned:backend' }] });
    expect(await countRows(t.db, 'attempts')).toBe(0);
  });

  it('a policy without repair limits denies repairs but not first attempts', async () => {
    const noLimits = createScheduler({ catalog: TEST_CATALOG, db: t.db, now: clock.now, policy: { policyVersion: 'p', models: TEST_MODELS } });
    await seedTask(t.db, specFor('t1', { maxAttempts: 3 }));
    const first = (await noLimits.claimNext(runner('r1'), CAPS))!;
    await noLimits.publishResult(first, { outcome: 'failed', reason: 'x' });
    expect(await noLimits.claimNext(runner('r2'), CAPS)).toBeNull();
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
  });

  it('an interrupted attempt does not consume the repair budget', async () => {
    await seedTask(t.db, specFor('t1', { maxAttempts: 1 }));
    const first = (await s.claimNext(runner('r1'), CAPS))!;
    clock.advance(61);
    await s.expireLeases(clock.now());
    clock.advance(CAPS.infraRetryBackoffSeconds);
    const second = (await s.claimNext(runner('r2'), CAPS))!;
    expect(second.attemptNumber).toBe(2);
    expect(second.fence).toBe(first.fence + 1);
    const published = await s.publishResult(second, { outcome: 'failed', reason: 'x' });
    expect(published.ok && published.value.repair).toBe('refused');
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
  });

  it('an unblocked task with no attempts left is refused again, not silently stuck', async () => {
    await seedTask(t.db, specFor('t1', { maxAttempts: 1 }));
    const first = (await s.claimNext(runner('r1'), CAPS))!;
    await s.publishResult(first, { outcome: 'failed', reason: 'x' });
    await t.db.execute(sql`UPDATE task_status SET status = 'ready' WHERE task_id = 't1'`);
    expect(await s.claimNext(runner('r2'), CAPS)).toBeNull();
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
    expect(await countRows(t.db, 'attempts')).toBe(1);
  });

  it('a claim the budget denies starts nothing and is recorded once, not per poll', async () => {
    await resetDb(t.db, {});
    await seedTask(t.db, specFor('t1'));
    expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'budget:missing_limit' }] });
    expect(await countRows(t.db, 'attempts')).toBe(0);
    expect(await countRows(t.db, 'budget_reservations')).toBe(0);
    expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false });
    expect(await countRows(t.db, 'events')).toBe(1);
    expect(await countRows(t.db, 'events', `type = 'placement.blocked' AND payload ->> 'reason' = 'budget:missing_limit'`)).toBe(1);
    expect(await countRows(t.db, 'resource_claims')).toBe(0);
    expect((await statusOf(t.db, 't1')).status).toBe('ready');
  });

  it('the lease token never reaches event payloads', async () => {
    await seedTask(t.db, specFor('t1'));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    const rows = await t.db.execute(sql`SELECT payload::text AS p FROM events`);
    expect(rows.map((r) => String(r['p'])).join()).not.toContain(lease.leaseToken);
  });
});
