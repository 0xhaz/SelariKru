import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import { createScheduler, type Scheduler } from './index.ts';
import {
  CAPS, PROJECT, RUN, TENANT, countRows, eventTypes, makeScheduler, resetDb, runner, seedTask, setupTestDb, specFor, statusOf,
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
    for (const caps of [{}, { maxConcurrentTotal: null }, { maxConcurrentTotal: 0 }, { maxConcurrentTotal: 1.5 }]) {
      expect(await s.tryClaim(runner('r1'), caps)).toMatchObject({ ok: false, reason: 'missing_limit:maxConcurrentTotal' });
    }
    expect(await countRows(t.db, 'attempts')).toBe(0);
  });

  it('runner location must fit the task execution setting', async () => {
    await seedTask(t.db, specFor('t1', { execution: 'cloud' }));
    const denied = await s.tryClaim(runner('r1', 'local'), CAPS);
    expect(denied).toMatchObject({ ok: false, reason: 'no_claimable_task', skipped: [{ taskId: 't1', reason: 'location_mismatch' }] });
    expect(await s.claimNext(runner('r2', 'cloud'), CAPS)).not.toBeNull();
  });

  it('a restricted task is never claimable by a cloud runner', async () => {
    await seedTask(t.db, specFor('t1', { classification: 'restricted' }));
    expect(await s.claimNext(runner('r1', 'cloud'), CAPS)).toBeNull();
    expect(await s.claimNext(runner('r2', 'local'), CAPS)).not.toBeNull();
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
    expect(await eventTypes(t.db)).toEqual(['task.ready', 'attempt.started']);
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
    const caps = { maxConcurrentTotal: 5 };
    const a = await s.tryClaim(runner('r1'), caps);
    const b = await s.tryClaim(runner('r2'), caps);
    expect(a.ok && b.ok).toBe(true);
    expect(await s.tryClaim(runner('r3'), caps)).toMatchObject({ ok: false, skipped: [{ taskId: 'x', reason: 'resource_conflict' }] });
  });

  it('skips a conflicted task and leases the next', async () => {
    await seedTask(t.db, specFor('a', { resourceClaims: [{ key: 'k', mode: 'exclusive' }] }));
    await seedTask(t.db, specFor('b', { resourceClaims: [{ key: 'k', mode: 'exclusive' }] }));
    await seedTask(t.db, specFor('c'));
    const caps = { maxConcurrentTotal: 5 };
    const seen = [await s.claimNext(runner('r1'), caps), await s.claimNext(runner('r2'), caps)];
    expect(seen.map((l) => l!.taskId).sort()).toEqual(['a', 'c']);
  });

  it('the repair gate refuses when policy denies, blocking with its reason', async () => {
    const strict = createScheduler({ db: t.db, now: clock.now, policy: { policyVersion: 'p', limits: { repairAttempts: 1 } } });
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

  it('an absent policy denies repairs but not first attempts', async () => {
    const noPolicy = createScheduler({ db: t.db, now: clock.now });
    await seedTask(t.db, specFor('t1', { maxAttempts: 3 }));
    const first = (await noPolicy.claimNext(runner('r1'), CAPS))!;
    await noPolicy.publishResult(first, { outcome: 'failed', reason: 'x' });
    expect(await noPolicy.claimNext(runner('r2'), CAPS)).toBeNull();
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
  });

  it('an interrupted attempt does not consume the repair budget', async () => {
    await seedTask(t.db, specFor('t1', { maxAttempts: 1 }));
    const first = (await s.claimNext(runner('r1'), CAPS))!;
    clock.advance(61);
    await s.expireLeases(clock.now());
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

  it('a denied claim leaves nothing behind', async () => {
    await resetDb(t.db, {});
    await seedTask(t.db, specFor('t1'));
    expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'budget:missing_limit' }] });
    expect(await countRows(t.db, 'attempts')).toBe(0);
    expect(await countRows(t.db, 'budget_reservations')).toBe(0);
    expect(await countRows(t.db, 'events')).toBe(0);
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
