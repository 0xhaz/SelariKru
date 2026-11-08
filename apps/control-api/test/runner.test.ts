import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startLeaseExpiryDriver } from '../src/index.ts';
import { bearer, enrolRunner, get, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';
import { createScheduler } from '@selarikru/workflow';
import { POLICY } from '@selarikru/workflow/test-helpers';

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
  const sched = () => createScheduler({ db: t.db, now: h.clock.now, policy: POLICY });

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

    const scheduler = createScheduler({ db: t.db, now: h.clock.now, policy: POLICY });
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
