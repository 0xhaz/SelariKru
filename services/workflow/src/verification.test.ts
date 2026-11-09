import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTx } from '@selarikru/persistence';
import { applyVerification, closeVerificationWithoutVerdict, markRunReadyForReview, reopenBlockedVerification, type Scheduler } from './index.ts';
import {
  CAPS, PROJECT, RUN, TENANT, countRows, eventTypes, makeScheduler, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, type TestClock, type TestDb,
} from '../test/helpers.ts';

let t: TestDb;
let clock: TestClock;
let s: Scheduler;
const VERIFIER = { kind: 'verifier', id: 'verifier-1' } as const;
const key = (taskId: string) => ({ tenantId: TENANT, projectId: PROJECT, taskId });
const apply = (taskId: string, outcome: 'passed' | 'failed' | 'error' | 'skipped', actor: { kind: 'verifier' | 'worker'; id: string } = VERIFIER) =>
  applyVerification({ db: t.db, now: clock.now }, key(taskId), { actor, outcome, detail: { checks: ['FB-01'] } });
const toVerifying = async (taskId: string, over: Parameters<typeof specFor>[1] = {}) => {
  await seedTask(t.db, specFor(taskId, over));
  const lease = (await s.claimNext(runner('r1'), CAPS))!;
  await s.publishResult(lease, { outcome: 'completed' });
};

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  clock = testClock();
  await resetDb(t.db);
  s = makeScheduler(t.db, clock);
});

describe('applyVerification', () => {
  it('passed moves verifying to verified, closes the attempt as succeeded and emits verification.passed as the verifier', async () => {
    await toVerifying('t1');
    expect(await apply('t1', 'passed')).toMatchObject({ applied: true, taskStatus: 'verified' });
    expect((await statusOf(t.db, 't1')).status).toBe('verified');
    const ev = await t.db.execute(sql`SELECT actor_kind, actor_id FROM events WHERE type = 'verification.passed'`);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_kind: 'verifier', actor_id: 'verifier-1' });
    expect((await t.db.execute(sql`SELECT outcome FROM attempts`))[0]).toMatchObject({ outcome: 'succeeded' });
  });

  it('a worker actor cannot apply a verification outcome', async () => {
    await toVerifying('t1');
    await expect(apply('t1', 'passed', { kind: 'worker', id: 'r1' })).rejects.toThrow(/verifier/);
    expect((await statusOf(t.db, 't1')).status).toBe('verifying');
    expect(await countRows(t.db, 'events', `type = 'verification.passed'`)).toBe(0);
  });

  it('failed records verification.failed and schedules a bounded repair through the retry path', async () => {
    await toVerifying('t1', { maxAttempts: 2 });
    expect(await apply('t1', 'failed')).toMatchObject({ applied: true, taskStatus: 'ready', repair: 'scheduled' });
    expect(await eventTypes(t.db)).toEqual(expect.arrayContaining(['verification.failed', 'task.ready']));
    // The repaired attempt can start: the failed one is closed, not left "running".
    const second = (await s.claimNext(runner('r1'), CAPS))!;
    expect(second.attemptNumber).toBe(2);
    await s.publishResult(second, { outcome: 'completed' });
    expect(await apply('t1', 'failed')).toMatchObject({ applied: true, taskStatus: 'blocked', repair: 'refused' });
    expect(await eventTypes(t.db)).toContain('task.blocked');
  });

  it('error and skipped are not verdicts: the task stays verifying with its claims held', async () => {
    await toVerifying('t1', { resourceClaims: [{ key: 'k', mode: 'exclusive' }] });
    for (const o of ['error', 'skipped'] as const) {
      expect(await apply('t1', o)).toMatchObject({ applied: false, taskStatus: 'verifying' });
    }
    expect(await countRows(t.db, 'events', `type LIKE 'verification.%'`)).toBe(0);
    expect(await countRows(t.db, 'resource_claims', 'released_at IS NULL')).toBe(1);
  });

  it('a cancelled task stays cancelled: a late result changes no state', async () => {
    await toVerifying('t1');
    await t.db.execute(sql`UPDATE task_status SET status = 'cancelled', row_revision = row_revision + 1`);
    const before = await statusOf(t.db, 't1');
    const events = await countRows(t.db, 'events');
    expect(await apply('t1', 'passed')).toMatchObject({ applied: false, taskStatus: 'cancelled', reason: 'not_verifying' });
    expect(await statusOf(t.db, 't1')).toEqual(before);
    expect(await countRows(t.db, 'events')).toBe(events);
  });

  it('a verdict only applies to the attempt and revision the candidate part carried', async () => {
    await toVerifying('t1', { maxAttempts: 3 });
    const first = String((await t.db.execute(sql`SELECT attempt_id FROM attempts ORDER BY attempt_number`))[0]!['attempt_id']);
    expect(await apply('t1', 'failed')).toMatchObject({ applied: true, repair: 'scheduled' });
    const second = (await s.claimNext(runner('r1'), CAPS))!;
    await s.publishResult(second, { outcome: 'completed' });
    // The old candidate carried attempt 1; the task is verifying a different attempt now.
    const stale = await applyVerification({ db: t.db, now: clock.now }, key('t1'), { actor: VERIFIER, outcome: 'passed', detail: {}, expect: { revision: 1, attemptId: first } });
    expect(stale).toMatchObject({ applied: false, taskStatus: 'verifying', reason: 'stale_candidate' });
    expect((await statusOf(t.db, 't1')).status).toBe('verifying');
    const wrongRevision = await applyVerification({ db: t.db, now: clock.now }, key('t1'), { actor: VERIFIER, outcome: 'passed', detail: {}, expect: { revision: 2, attemptId: second.attemptId } });
    expect(wrongRevision).toMatchObject({ applied: false, reason: 'stale_candidate' });
    const fresh = await applyVerification({ db: t.db, now: clock.now }, key('t1'), { actor: VERIFIER, outcome: 'passed', detail: {}, expect: { revision: 1, attemptId: second.attemptId } });
    expect(fresh).toMatchObject({ applied: true, taskStatus: 'verified' });
  });
});

describe('markRunReadyForReview', () => {
  const ready = (expected: string[]) => withTx(t.db, (tx) => markRunReadyForReview(tx, { tenantId: TENANT, projectId: PROJECT, taskId: expected[0]! }, 'run_a', expected));
  const lifecycle = async () => String((await t.db.execute(sql`SELECT lifecycle FROM runs`))[0]!['lifecycle']);

  it('needs the verified set to be exactly the run\'s live tasks', async () => {
    await toVerifying('a');
    await toVerifying('b');
    await apply('a', 'passed');
    expect(await ready(['a'])).toBe(false);
    await apply('b', 'passed');
    expect(await ready(['a'])).toBe(false); // b is live and not covered
    expect(await lifecycle()).toBe('running');
    expect(await ready(['a', 'b'])).toBe(true);
    expect(await lifecycle()).toBe('ready_for_review');
  });

  it('a covered task that is cancelled does not count as verified', async () => {
    await toVerifying('a');
    await toVerifying('b');
    await apply('a', 'passed');
    await t.db.execute(sql`UPDATE task_status SET status = 'cancelled' WHERE task_id = 'b'`);
    expect(await ready(['a', 'b'])).toBe(false);
    expect(await lifecycle()).toBe('running');
  });
});

describe('reopenBlockedVerification eligibility', () => {
  const run = { tenantId: TENANT, projectId: PROJECT, runId: RUN };
  const reopen = () => withTx(t.db, (tx) => reopenBlockedVerification({ now: clock.now }, tx, run, 'owner', 'op_1'));

  it('a reason the worker reported is not eligible, even when it reads like a verifier error', async () => {
    await seedTask(t.db, specFor('t1'));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    await s.publishResult(lease, { outcome: 'blocked', reason: 'verification_error' });
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
    expect(await reopen()).toEqual({ ok: false, reason: 'nothing_to_reverify' });
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
  });

  it('the scheduler\'s own close of a verification without a verdict is eligible', async () => {
    await toVerifying('t1');
    const attemptId = String((await t.db.execute(sql`SELECT attempt_id FROM attempts`))[0]!['attempt_id']);
    expect(await withTx(t.db, (tx) => closeVerificationWithoutVerdict({ now: clock.now }, tx, key('t1'), { reason: 'verification_error', expect: { revision: 1, attemptId } }))).toBe(true);
    expect(await reopen()).toEqual({ ok: true, reopened: ['t1'] });
  });
});
