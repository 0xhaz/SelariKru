import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { leaseHealth, LEASE_EXPIRY_SECONDS, LEASE_SUSPECT_SECONDS, type Lease, type Scheduler } from './index.ts';
import {
  CAPS, countRows, eventTypes, makeScheduler, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, type TestClock, type TestDb,
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

const claim = async (): Promise<Lease> => {
  await seedTask(t.db, specFor('t1'));
  return (await s.claimNext(runner('r1'), CAPS))!;
};

describe('lease timing', () => {
  it('suspect at 30 s, expired at 60 s', () => {
    expect(LEASE_SUSPECT_SECONDS).toBe(30);
    expect(LEASE_EXPIRY_SECONDS).toBe(60);
    const at = (s: number) => leaseHealth('2026-11-08T06:00:00.000Z', new Date(`2026-11-08T06:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.000Z`));
    expect(at(29)).toBe('healthy');
    expect(at(30)).toBe('suspect');
    expect(at(59)).toBe('suspect');
    expect(at(60)).toBe('expired');
  });
});

describe('heartbeat', () => {
  it('renews only the active fence', async () => {
    const lease = await claim();
    clock.advance(10);
    const beat = await s.heartbeat(lease);
    expect(beat).toEqual({ ok: true, value: expect.objectContaining({ fence: 1, expiresAt: new Date(clock.now().getTime() + 60_000).toISOString() }) });
    expect(await eventTypes(t.db)).toEqual(['attempt.started', 'placement.decided']); // heartbeats are not events

    expect(await s.heartbeat({ ...lease, fence: 2 })).toMatchObject({ ok: false, error: { httpStatus: 409, reason: 'stale_fence' } });
    expect(await s.heartbeat({ ...lease, leaseToken: 'wrong' })).toMatchObject({ ok: false, error: { reason: 'stale_fence' } });
  });

  it('cannot revive an expired lease', async () => {
    const lease = await claim();
    clock.advance(60);
    expect(await s.heartbeat(lease)).toMatchObject({ ok: false, error: { reason: 'lease_expired' } });
    expect((await s.expireLeases(clock.now())).length).toBe(1);
  });
});

describe('publishResult', () => {
  it('an expired lease cannot publish, even before reconciliation', async () => {
    const lease = await claim();
    clock.advance(60);
    const before = await statusOf(t.db, 't1');
    expect(await s.publishResult(lease, { outcome: 'completed' })).toMatchObject({ ok: false, error: { reason: 'lease_expired' } });
    expect(await statusOf(t.db, 't1')).toEqual(before);
  });

  it('completed keeps the change-set reference in the attempt state and the event', async () => {
    const lease = await claim();
    const manifest = 'd'.repeat(64);
    expect((await s.publishResult(lease, { outcome: 'completed', changeManifestSha256: manifest })).ok).toBe(true);
    const rows = await t.db.execute(sql`SELECT detail FROM attempts`);
    expect(rows[0]!['detail']).toMatchObject({ changeManifestSha256: manifest });
    const ev = await t.db.execute(sql`SELECT payload FROM events WHERE type = 'attempt.completed'`);
    expect(ev[0]!['payload']).toMatchObject({ changeManifestSha256: manifest });
  });

  it('completed moves to verifying, closes the lease and keeps exclusive claims held', async () => {
    await seedTask(t.db, specFor('t1', { resourceClaims: [{ key: 'contract', mode: 'exclusive' }] }));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    const r = await s.publishResult(lease, { outcome: 'completed', headSha: 'head1', reportedCostUsd: 0.25 });
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ taskStatus: 'verifying', outcome: 'completed' }) });
    const rows = await t.db.execute(sql`SELECT head_sha, ended_at, exit_reason FROM attempts`);
    expect(rows[0]).toMatchObject({ head_sha: 'head1', exit_reason: 'completed' });
    expect(rows[0]!['ended_at']).not.toBeNull();
    const res = await t.db.execute(sql`SELECT amount_usd, state FROM budget_reservations`);
    expect(res[0]).toMatchObject({ amount_usd: '1.000000', state: 'settled' });
    const events = await t.db.execute(sql`SELECT actor_kind, actor_id FROM events WHERE type = 'attempt.completed'`);
    expect(events[0]).toMatchObject({ actor_kind: 'worker', actor_id: 'r1' });
    // Claims are held through verification: they are released on a verification outcome, not at attempt completion.
    expect(await countRows(t.db, 'resource_claims', 'released_at IS NULL')).toBe(1);
  });

  it('a duplicate publish returns the stored receipt without a second effect', async () => {
    const lease = await claim();
    const first = await s.publishResult(lease, { outcome: 'completed' });
    const events = await countRows(t.db, 'events');
    expect(await s.publishResult(lease, { outcome: 'completed' })).toEqual(first);
    expect(await countRows(t.db, 'events')).toBe(events);
  });

  it('a concurrent duplicate publish applies once', async () => {
    const lease = await claim();
    const results = await Promise.all(Array.from({ length: 8 }, () => s.publishResult(lease, { outcome: 'completed' })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await countRows(t.db, 'events', `type = 'attempt.completed'`)).toBe(1);
    expect((await statusOf(t.db, 't1')).status).toBe('verifying');
  });

  it('a publish racing expiry resolves one way only', async () => {
    const lease = await claim();
    clock.advance(59);
    await s.heartbeat(lease);
    clock.advance(60);
    const [expired, published] = await Promise.all([s.expireLeases(clock.now()), s.publishResult(lease, { outcome: 'completed' })]);
    expect(expired).toHaveLength(1);
    expect(published.ok).toBe(false);
    expect((await statusOf(t.db, 't1')).status).toBe('ready');
    expect(await countRows(t.db, 'events', `type = 'attempt.completed'`)).toBe(0);
  });

  it('blocked and approval_requested interrupt the attempt, keeping the budget', async () => {
    await seedTask(t.db, specFor('t1', { maxAttempts: 1 }));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    expect(await s.publishResult(lease, { outcome: 'blocked', reason: 'needs_decision' })).toMatchObject({ ok: true, value: { taskStatus: 'blocked' } });
    const rows = await t.db.execute(sql`SELECT outcome, exit_reason FROM attempts`);
    expect(rows[0]).toMatchObject({ outcome: 'interrupted', exit_reason: 'needs_decision' });
    expect(await eventTypes(t.db)).toEqual(['attempt.started', 'placement.decided', 'task.blocked']);
    expect(await countRows(t.db, 'resource_claims', 'released_at IS NULL')).toBe(0);
  });

  it('approval_requested moves to awaiting_approval and records no grant', async () => {
    const lease = await claim();
    expect(await s.publishResult(lease, { outcome: 'approval_requested', reason: 'new_domain' })).toMatchObject({ ok: true, value: { taskStatus: 'awaiting_approval' } });
    expect(await eventTypes(t.db)).toEqual(['attempt.started', 'placement.decided', 'approval.requested']);
    expect((await eventTypes(t.db)).includes('approval.granted')).toBe(false);
  });
});

describe('expiry reservation handling', () => {
  it('an expired attempt keeps its worst-case reservation consumed', async () => {
    await seedTask(t.db, specFor('t1', { maxCostUsd: 2 }));
    await s.claimNext(runner('r1'), CAPS);
    clock.advance(61);
    await s.expireLeases(clock.now());
    const res = await t.db.execute(sql`SELECT amount_usd, state FROM budget_reservations`);
    expect(res[0]).toMatchObject({ amount_usd: '2.000000', state: 'expired' });
  });
});

describe('publish identity', () => {
  it('a wrong token cannot read back a stored receipt', async () => {
    const lease = await claim();
    expect((await s.publishResult(lease, { outcome: 'completed' })).ok).toBe(true);
    expect(await s.publishResult({ ...lease, leaseToken: 'guess' }, { outcome: 'completed' })).toMatchObject({ ok: false, error: { reason: 'stale_fence' } });
  });
  it('the lease token is not stored in receipts or events', async () => {
    const lease = await claim();
    await s.publishResult(lease, { outcome: 'completed' });
    const receipts = await t.db.execute(sql`SELECT operation_key, receipt::text AS r FROM operation_receipts`);
    const events = await t.db.execute(sql`SELECT payload::text AS p FROM events`);
    const stored = [...receipts.map((r) => `${r['operation_key']}${r['r']}`), ...events.map((r) => String(r['p']))].join();
    expect(stored).not.toContain(lease.leaseToken);
  });
  it('a tampered run id on the lease does not move the budget or the event scope', async () => {
    const lease = await claim();
    expect((await s.publishResult({ ...lease, runId: 'run_forged', reservationId: 'res_forged' }, { outcome: 'completed' })).ok).toBe(true);
    const rows = await t.db.execute(sql`SELECT DISTINCT run_id FROM events`);
    expect(rows.map((r) => r['run_id'])).toEqual(['run_a']);
    const res = await t.db.execute(sql`SELECT state FROM budget_reservations`);
    expect(res[0]).toMatchObject({ state: 'settled' });
  });
});
