/** Case: fence a stale worker's completion. Lease expiry, re-claim and the stale publish all go through the real route, the real scheduler and the real runner loop. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { World, post, sql, resultLine, CAPS, type ClaimedLease, type FakeStream } from '../security/world.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const ref = (l: Pick<ClaimedLease, 'attemptId' | 'fence' | 'leaseToken'>) => ({ attemptId: l.attemptId, fence: l.fence, leaseToken: l.leaseToken });
const completed = { outcome: 'completed' as const, changeManifestSha256: 'a'.repeat(64) };
const publish = (lease: Pick<ClaimedLease, 'attemptId' | 'fence' | 'leaseToken'>, token: string, result: unknown = completed) => post(w.app, '/v1/runners/result', { lease: ref(lease), result }, auth(token));

async function state(taskId: string) {
  return {
    status: await w.status(taskId),
    attempts: await w.t.db.execute(sql`SELECT attempt_id, outcome, ended_at, detail FROM attempts ORDER BY attempt_number`),
    events: await w.count('events'),
    receipts: await w.count('operation_receipts'),
  };
}

/** Claims, lets the lease lapse, reaps it, waits out the backoff and claims again with a different runner. */
async function supersede(taskId: string): Promise<{ stale: ClaimedLease; current: ClaimedLease; other: string }> {
  const runId = await w.newRun();
  await w.plan(runId, [w.task(runId, taskId)]);
  const stale = await w.claim();
  w.advance(61);
  expect(await w.scheduler.expireLeases(w.now())).toHaveLength(1);
  w.advance(CAPS.infraRetryBackoffSeconds);
  const other = (await w.enrol()).token;
  const current = await w.claim(other);
  expect(current.fence).toBe(stale.fence + 1);
  return { stale, current, other };
}

describe('stale completion through the runner route', () => {
  it('the fenced worker’s completion is a 409 and changes nothing; the current worker’s still counts', async () => {
    const { stale, current, other } = await supersede('t1');
    const before = await state('t1');
    const res = await publish(stale, w.token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('lease_conflict');
    expect(res.body.error.details.reason).toBe('stale_fence');
    expect(await state('t1')).toEqual(before);
    expect((await publish(current, other)).status).toBe(200);
    expect((await w.status('t1')).status).toBe('verifying');
  });

  it('a forged fence, a forged token and another runner’s credentials on the live attempt are all refused without effect', async () => {
    const { current, other } = await supersede('t2');
    const before = await state('t2');
    const forged: [string, Parameters<typeof publish>[0], string][] = [
      ['fence +1', { ...current, fence: current.fence + 1 }, other],
      ['fence -1', { ...current, fence: current.fence - 1 }, other],
      ['wrong token', { ...current, leaseToken: randomUUID() }, other],
      ['someone else\'s runner', current, w.token],
    ];
    for (const [name, lease, token] of forged) expect((await publish(lease, token)).status, name).toBe(409);
    expect(await state('t2')).toEqual(before);
  });

  it('a lease that expired but was never reaped cannot publish either', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't3')]);
    const lease = await w.claim();
    w.advance(61);
    const before = await state('t3');
    const res = await publish(lease, w.token);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('lease_expired');
    expect(await state('t3')).toEqual(before);
  });

  it('a real worker fenced mid-run finishes into nothing: its change never reaches a candidate', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 't4')]);
    const staleLease = await w.claim();

    let stream!: FakeStream;
    let onStart: () => void;
    const started = new Promise<void>((res) => { onStart = res; });
    // A long heartbeat interval, so the worker does not notice the fence by heartbeat and runs on to publish.
    const staleRun = w.runWorker(staleLease, ({ stream: s, write }) => { stream = s; write('src/stale.ts', 'export const from = "stale";\n'); onStart(); return false; }, { heartbeatMs: 60_000 });
    await started;

    w.advance(61);
    expect(await w.scheduler.expireLeases(w.now())).toHaveLength(1);
    w.advance(CAPS.infraRetryBackoffSeconds);
    const otherToken = (await w.enrol()).token;
    const current = await w.claim(otherToken);
    expect(current.fence).toBe(staleLease.fence + 1);
    const before = await state('t4');

    stream.push(`${resultLine}\n`);
    stream.end(0);
    const { report } = await staleRun;
    expect(report.outcome).toBe('lease_lost');
    expect(await state('t4')).toEqual(before);
    expect(await w.count('attempts', `detail ? 'changeManifestSha256'`)).toBe(0);

    const { report: good } = await w.runWorker(current, ({ write }) => { write('src/current.ts', 'export const from = "current";\n'); }, { token: otherToken });
    expect(good.outcome).toBe('completed');
    const assembled = await w.assembly().tick();
    expect(assembled.assembled).toHaveLength(1);
    const files = w.git('ls-tree', '-r', '--name-only', assembled.assembled[0]!);
    expect(files).toContain('src/current.ts');
    expect(files).not.toContain('src/stale.ts');
  });
});
