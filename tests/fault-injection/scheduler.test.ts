import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import { createScheduler, type Lease, type Scheduler } from '@selarikru/workflow';
import {
  CAPS, POLICY, PROJECT, RUN, TENANT, TEST_DATABASE_URL, capsWith, countRows, eventTypes, makeScheduler, reservedTotal, resetDb, runner, seedTask, setupTestDb, specFor,
  statusOf, testClock, type TestClock, type TestDb,
} from '@selarikru/workflow/test-helpers';

let t: TestDb;
let clock: TestClock;
let s: Scheduler;

// A pool of 25 connections: each of the concurrent claimers below holds its own connection for its transaction.
beforeAll(async () => { t = await setupTestDb(25); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  clock = testClock();
  await resetDb(t.db);
  s = makeScheduler(t.db, clock);
});

const claimAll = (runners: ReturnType<typeof runner>[], caps = CAPS) => Promise.all(runners.map((r) => s.claimNext(r, caps)));
const won = (leases: (Lease | null)[]) => leases.filter((l): l is Lease => l !== null);
const activeLeases = () => countRows(t.db, 'attempts', 'lease_token IS NOT NULL AND ended_at IS NULL');

describe('scheduler fault injection', () => {
  it('20 concurrent claimers, one winner', async () => {
    await seedTask(t.db, specFor('t1'));
    const leases = await claimAll(Array.from({ length: 20 }, (_, i) => runner(`r${i}`)));
    const winners = won(leases);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.fence).toBe(1);
    expect(await countRows(t.db, 'attempts')).toBe(1);
    expect((await statusOf(t.db, 't1')).status).toBe('running');
    expect((await eventTypes(t.db)).filter((e) => e === 'attempt.started')).toHaveLength(1);
    expect(await countRows(t.db, 'budget_reservations')).toBe(1);
  });

  it('overlapping exclusive claims never run together', async () => {
    const claim = { key: 'lockfile', mode: 'exclusive' as const };
    await seedTask(t.db, specFor('a', { resourceClaims: [claim] }));
    await seedTask(t.db, specFor('b', { resourceClaims: [claim] }));
    await seedTask(t.db, specFor('c', { resourceClaims: [claim] }));

    const leases = won(await claimAll(Array.from({ length: 10 }, (_, i) => runner(`r${i}`)), capsWith(5)));
    expect(leases).toHaveLength(1);
    expect(await countRows(t.db, 'resource_claims', 'released_at IS NULL')).toBe(1);

    const first = leases[0]!;
    expect((await s.publishResult(first, { outcome: 'completed' })).ok).toBe(true);
    expect(await countRows(t.db, 'resource_claims', 'released_at IS NULL')).toBe(0);

    const next = won(await claimAll([runner('r10'), runner('r11')], capsWith(5)));
    expect(next).toHaveLength(1);
    expect(next[0]!.taskId).not.toBe(first.taskId);
  });

  it('total concurrency never exceeds 2 across locations', async () => {
    for (let i = 0; i < 6; i++) await seedTask(t.db, specFor(`t${i}`));
    const mixed = Array.from({ length: 20 }, (_, i) => runner(`r${i}`, i % 2 === 0 ? 'local' : 'cloud'));
    const leases = won(await claimAll(mixed));
    expect(leases).toHaveLength(2);
    expect(await activeLeases()).toBe(2);

    expect(await s.tryClaim(runner('late', 'cloud'), CAPS)).toMatchObject({ ok: false, reason: 'concurrency_limit_reached' });

    await s.publishResult(leases[0]!, { outcome: 'completed' });
    const again = won(await claimAll(mixed.slice(0, 8)));
    expect(again).toHaveLength(1);
    expect(await activeLeases()).toBe(2);
  });

  it('stale fence publish → 409, state unchanged', async () => {
    await seedTask(t.db, specFor('t1'));
    const stale = (await s.claimNext(runner('r1'), CAPS))!;
    clock.advance(61);
    expect(await s.expireLeases(clock.now())).toHaveLength(1);
    clock.advance(CAPS.infraRetryBackoffSeconds);
    const current = (await s.claimNext(runner('r2'), CAPS))!;
    expect(current.fence).toBe(stale.fence + 1);

    const before = {
      status: await statusOf(t.db, 't1'),
      attempts: await countRows(t.db, 'attempts'),
      ended: await countRows(t.db, 'attempts', 'ended_at IS NOT NULL'),
      events: await countRows(t.db, 'events'),
      receipts: await countRows(t.db, 'operation_receipts'),
    };

    const result = await s.publishResult(stale, { outcome: 'completed' });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ httpStatus: 409, reason: 'stale_fence', taskId: 't1' }) });

    const forged = await s.publishResult({ ...current, fence: 99 }, { outcome: 'completed' });
    expect(forged.ok).toBe(false);

    expect({
      status: await statusOf(t.db, 't1'),
      attempts: await countRows(t.db, 'attempts'),
      ended: await countRows(t.db, 'attempts', 'ended_at IS NOT NULL'),
      events: await countRows(t.db, 'events'),
      receipts: await countRows(t.db, 'operation_receipts'),
    }).toEqual(before);

    expect((await s.publishResult(current, { outcome: 'completed' })).ok).toBe(true);
    expect((await statusOf(t.db, 't1')).status).toBe('verifying');
  });

  it('lease expires after 60 s of no heartbeat', async () => {
    await seedTask(t.db, specFor('t1', { resourceClaims: [{ key: 'db', mode: 'exclusive' }] }));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    expect(new Date(lease.expiresAt).getTime() - new Date(lease.acquiredAt).getTime()).toBe(60_000);

    clock.advance(59);
    expect(await s.expireLeases(clock.now())).toEqual([]);
    const beat = await s.heartbeat(lease);
    expect(beat.ok).toBe(true);

    // A fresh heartbeat restarts the 60 s, so a long build stays alive.
    clock.advance(59);
    expect(await s.expireLeases(clock.now())).toEqual([]);
    expect((await statusOf(t.db, 't1')).status).toBe('running');

    clock.advance(1);
    const expired = await s.expireLeases(clock.now());
    expect(expired).toEqual([expect.objectContaining({ taskId: 't1', attemptId: lease.attemptId, fence: lease.fence, reason: 'lease_expired' })]);

    expect((await statusOf(t.db, 't1')).status).toBe('ready');
    const rows = await t.db.execute(sql`SELECT outcome, ended_at FROM attempts WHERE attempt_id = ${lease.attemptId}`);
    expect(rows[0]!['outcome']).toBe('interrupted');
    expect(rows[0]!['ended_at']).not.toBeNull();
    expect(await countRows(t.db, 'resource_claims', 'released_at IS NULL')).toBe(0);
    expect(await eventTypes(t.db)).toEqual(['attempt.started', 'placement.decided', 'attempt.failed', 'task.ready']);
    const failed = await t.db.execute(sql`SELECT actor_kind FROM events WHERE type = 'attempt.failed'`);
    expect(failed[0]!['actor_kind']).toBe('system');

    expect((await s.heartbeat(lease)).ok).toBe(false);
    expect(await s.expireLeases(clock.now())).toEqual([]);
    expect(await countRows(t.db, 'events', `type = 'attempt.failed'`)).toBe(1);
  });

  it('concurrent reservations cannot exceed budget', async () => {
    await resetDb(t.db, { limitUsd: 3 });
    for (let i = 0; i < 10; i++) await seedTask(t.db, specFor(`t${i}`, { maxCostUsd: 1 }));
    const leases = won(await claimAll(Array.from({ length: 20 }, (_, i) => runner(`r${i}`)), capsWith(10)));
    expect(leases).toHaveLength(3);
    expect(await reservedTotal(t.db)).toBe(3);
    expect(await countRows(t.db, 'budget_reservations')).toBe(3);

    const denied = await s.tryClaim(runner('late'), capsWith(10));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.skipped.map((c) => c.reason)).toContain('budget:exceeds_limit');
  });

  it('third repair attempt refused, task blocked with reason', async () => {
    await seedTask(t.db, specFor('t1', { maxAttempts: 3 }));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const lease = (await s.claimNext(runner(`r${attempt}`), CAPS))!;
      expect(lease.attemptNumber).toBe(attempt);
      expect(lease.fence).toBe(attempt);
      const published = await s.publishResult(lease, { outcome: 'failed', reason: 'ci_failed' });
      expect(published.ok).toBe(true);
      if (published.ok) expect(published.value.repair).toBe(attempt < 3 ? 'scheduled' : 'refused');
    }
    expect(await statusOf(t.db, 't1')).toMatchObject({ status: 'blocked' });
    const blocked = await t.db.execute(sql`SELECT payload FROM events WHERE type = 'task.blocked'`);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!['payload']).toMatchObject({ reason: 'repair_budget_exhausted' });
    expect(await s.claimNext(runner('r9'), CAPS)).toBeNull();
    expect(await countRows(t.db, 'attempts')).toBe(3);
  });

  it('attempt past its deadline is refused and closed with attempt_timeout', async () => {
    await seedTask(t.db, specFor('t1', { timeoutSeconds: 1800 }));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    expect(new Date(lease.deadlineAt).getTime() - new Date(lease.acquiredAt).getTime()).toBe(1_800_000);

    // A worker that heartbeats forever is still stopped by the deadline.
    for (let elapsed = 0; elapsed + 50 < 1800; elapsed += 50) {
      clock.advance(50);
      expect((await s.heartbeat(lease)).ok).toBe(true);
    }
    expect(await s.expireLeases(clock.now())).toEqual([]);
    clock.advance(50); // now 1800 s after the claim, heartbeat 50 s old

    const before = await statusOf(t.db, 't1');
    expect(await s.heartbeat(lease)).toMatchObject({ ok: false, error: { httpStatus: 409, reason: 'attempt_timeout' } });
    expect(await s.publishResult(lease, { outcome: 'completed' })).toMatchObject({ ok: false, error: { httpStatus: 409, reason: 'attempt_timeout' } });
    expect(await statusOf(t.db, 't1')).toEqual(before);

    const closed = await s.expireLeases(clock.now());
    expect(closed).toEqual([expect.objectContaining({ taskId: 't1', attemptId: lease.attemptId, reason: 'attempt_timeout' })]);
    const rows = await t.db.execute(sql`SELECT outcome, exit_reason FROM attempts`);
    expect(rows[0]).toMatchObject({ outcome: 'failed', exit_reason: 'attempt_timeout' });
    expect((await statusOf(t.db, 't1')).status).toBe('ready');
    const failed = await t.db.execute(sql`SELECT actor_kind, payload FROM events WHERE type = 'attempt.failed'`);
    expect(failed[0]).toMatchObject({ actor_kind: 'system', payload: { reason: 'attempt_timeout' } });
  });

  it('lease-expiry retries back off, are bounded, and stay outside the repair count', async () => {
    const caps = { ...CAPS, maxInfraRetries: 2, infraRetryBackoffSeconds: 10, infraRetryBackoffMaxSeconds: 15 };
    await seedTask(t.db, specFor('t1', { maxAttempts: 1 }));

    const expire = async () => { clock.advance(61); expect(await s.expireLeases(clock.now())).toHaveLength(1); };
    const backingOff = async () => expect(await s.tryClaim(runner('r'), caps)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'infra_retry_backoff' }] });

    expect((await s.claimNext(runner('r1'), caps))!.attemptNumber).toBe(1);
    await expire();
    await backingOff();
    clock.advance(9);
    await backingOff();
    clock.advance(1);
    expect((await s.claimNext(runner('r2'), caps))!.attemptNumber).toBe(2);

    await expire();
    clock.advance(14); // the doubled 20 s delay is capped at 15 s
    await backingOff();
    clock.advance(1);
    expect((await s.claimNext(runner('r3'), caps))!.attemptNumber).toBe(3);

    await expire();
    clock.advance(1000);
    expect(await s.tryClaim(runner('r4'), caps)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'infra_retry_limit_exhausted' }] });
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
    const blocked = await t.db.execute(sql`SELECT payload FROM events WHERE type = 'task.blocked'`);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!['payload']).toMatchObject({ reason: 'infra_retry_limit_exhausted' });
    expect(await countRows(t.db, 'attempts')).toBe(3);
  });

  it('a task in backoff does not stop a sibling from running', async () => {
    await seedTask(t.db, specFor('a'));
    await s.claimNext(runner('r1'), CAPS);
    clock.advance(61);
    await s.expireLeases(clock.now());
    await seedTask(t.db, specFor('b'));
    const outcome = await s.tryClaim(runner('r2'), CAPS);
    expect(outcome.ok && outcome.lease.taskId).toBe('b');
  });

  it('a live lease on a prior revision is skipped and other tasks are still claimed', async () => {
    await seedTask(t.db, specFor('t1'));
    const old = (await s.claimNext(runner('r1'), CAPS))!;
    await t.db.insert(schema.taskRevisions).values({ tenantId: TENANT, projectId: PROJECT, runId: RUN, taskId: 't1', revision: 2, boardId: 'b1', spec: specFor('t1', { revision: 2 }) });
    await t.db.execute(sql`UPDATE task_status SET current_revision = 2, status = 'ready', updated_at = '2020-01-01T00:00:00Z' WHERE task_id = 't1'`);
    await seedTask(t.db, specFor('t2'));

    const outcome = await s.tryClaim(runner('r2'), capsWith(5));
    expect(outcome).toMatchObject({ ok: true, lease: { taskId: 't2' }, skipped: [{ taskId: 't1', reason: 'previous_attempt_active' }] });
    expect((await statusOf(t.db, 't1')).status).toBe('ready');
    expect(await countRows(t.db, 'attempts', 'revision = 2')).toBe(0);

    clock.advance(61);
    await s.expireLeases(clock.now()); // reaps both, including the rev-1 lease
    clock.advance(CAPS.infraRetryBackoffSeconds);
    const resumed = (await s.claimNext(runner('r3'), capsWith(5)))!;
    expect(resumed).toMatchObject({ taskId: 't1', revision: 2, fence: 1 });
    expect(old.revision).toBe(1);
  });

  it('controller restart resumes with no duplicate attempt', async () => {
    await seedTask(t.db, specFor('t1'));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    expect(await s.claimNext(runner('r2'), CAPS)).toBeNull();

    // A fresh instance on a fresh connection pool: nothing of the first instance survives except the database.
    const { db: db2, close: close2 } = createDb(TEST_DATABASE_URL, { max: 5, searchPath: t.schema });
    try {
      const restarted = createScheduler({ db: db2, now: clock.now, policy: POLICY });
      expect(await restarted.claimNext(runner('r3'), CAPS)).toBeNull();
      expect(await restarted.expireLeases(clock.now())).toEqual([]);
      expect((await restarted.heartbeat(lease)).ok).toBe(true);
      expect(await countRows(t.db, 'attempts')).toBe(1);

      clock.advance(61);
      expect(await restarted.expireLeases(clock.now())).toHaveLength(1);
      clock.advance(CAPS.infraRetryBackoffSeconds);
      const resumed = (await restarted.claimNext(runner('r3'), CAPS))!;
      expect(resumed.attemptNumber).toBe(2);
      expect(resumed.fence).toBe(2);
      expect(await countRows(t.db, 'attempts')).toBe(2);
      expect((await restarted.publishResult(lease, { outcome: 'completed' })).ok).toBe(false);
      expect((await statusOf(t.db, 't1')).status).toBe('running');
    } finally {
      await close2();
    }
  });
});
