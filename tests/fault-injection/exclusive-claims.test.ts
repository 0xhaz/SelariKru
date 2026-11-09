/** Case: prevent overlapping exclusive claims. Concurrent claims over real HTTP from separately enrolled runners, against the real scheduler lock in Postgres. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { World } from '../security/world.ts';

let w: World;
beforeAll(async () => { w = await World.create({ maxConcurrent: 8, dbMax: 25 }); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const live = (key: string) => w.count('resource_claims', `resource_key = '${key}' AND released_at IS NULL`);
async function tokens(n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await w.enrol()).token);
  return out;
}
const claimAll = async (ts: string[]) => (await Promise.all(ts.map(async (token) => ({ token, lease: (await w.api(token).claim()).lease })))).filter((c) => c.lease !== null).map((c) => ({ ...c.lease!, holderToken: c.token }));

describe('overlapping exclusive claims over the real claim route', () => {
  it('ten runners, three tasks, one exclusive resource: exactly one holds it, and it stays held through verification', async () => {
    const claim = { key: 'lockfile', mode: 'exclusive' as const };
    const runId = await w.newRun();
    expect((await w.plan(runId, ['a', 'b', 'c'].map((id) => w.task(runId, id, { resourceClaims: [claim] })))).status).toBe(201);

    const leases = await claimAll(await tokens(10));
    expect(leases).toHaveLength(1);
    expect(await live('lockfile')).toBe(1);
    expect(await w.count('attempts')).toBe(1);

    const first = leases[0]!;
    const { report } = await w.runWorker(first, ({ write }) => { write('src/x.ts', 'export const x = 1;\n'); }, { token: first.holderToken });
    expect(report.outcome).toBe('completed');
    expect((await w.status(first.taskId)).status).toBe('verifying');
    // The worker is done, but its change is unjudged: the resource is not free for another task to race it.
    expect(await live('lockfile')).toBe(1);
    expect(await claimAll(await tokens(5))).toHaveLength(0);

    // Cancelling the verifying task is the verification's end. Only now may another claim.
    const row = await w.status(first.taskId);
    expect((await w.command(first.taskId, row.rowRevision, 'c1')).status).toBe(202);
    expect(await live('lockfile')).toBe(0);
    const next = await claimAll(await tokens(5));
    expect(next).toHaveLength(1);
    expect(next[0]!.taskId).not.toBe(first.taskId);
    expect(await live('lockfile')).toBe(1);
  });

  it('an exclusive claim and a shared claim on one key cannot run together, whichever comes first', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [
      w.task(runId, 'writer', { resourceClaims: [{ key: 'db', mode: 'exclusive' }] }),
      w.task(runId, 'reader', { resourceClaims: [{ key: 'db', mode: 'shared' }] }),
    ]);
    expect(await claimAll(await tokens(6))).toHaveLength(1);
    expect(await live('db')).toBe(1);
  });

  it('a lease that expired frees its claim, so a stale worker cannot hold the resource for ever', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [w.task(runId, 'a', { resourceClaims: [{ key: 'db', mode: 'exclusive' }] }), w.task(runId, 'b', { resourceClaims: [{ key: 'db', mode: 'exclusive' }] })]);
    const [held] = await claimAll(await tokens(1));
    expect(held).toBeDefined();
    w.advance(61);
    expect(await w.scheduler.expireLeases(w.now())).toHaveLength(1);
    expect(await live('db')).toBe(0);
    const again = await claimAll(await tokens(2));
    expect(again).toHaveLength(1);
    expect(again[0]!.taskId).not.toBe(held!.taskId);
  });

  it('control: disjoint keys and shared claims do run together, so the guard above is not simply refusing everything', async () => {
    const runId = await w.newRun();
    await w.plan(runId, [
      w.task(runId, 'one', { resourceClaims: [{ key: 'cache', mode: 'shared' }] }),
      w.task(runId, 'two', { resourceClaims: [{ key: 'cache', mode: 'shared' }] }),
    ]);
    expect(await claimAll(await tokens(4))).toHaveLength(2);
    expect(await live('cache')).toBe(2);
  });
});
