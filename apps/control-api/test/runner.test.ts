import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startLeaseExpiryDriver } from '../src/index.ts';
import { bearer, enrolRunner, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';
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

    const done = await post(h.app, '/v1/runners/result', { lease: ref, result: { outcome: 'completed', headSha: 'abc123' } }, as);
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
