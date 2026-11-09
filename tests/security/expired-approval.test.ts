/** Case: block an expired approval. Approvals are advisory (the sandbox does not enforce them), so this tests what they do: whether the request can be granted and whether a grant reaches a later attempt. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { post, signalPath, sql, toolWrite, World } from './world.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const ask = JSON.stringify({ operation: 'destructive_data_migration', reason: 'drops a column' });
async function asked(taskId: string): Promise<{ approvalId: string; scopeHash: string }> {
  const runId = await w.newRun();
  await w.plan(runId, [w.task(runId, taskId)]);
  const { report } = await w.runWorker(await w.claim(), ({ stream, cwd }) => { stream.push(`${toolWrite(signalPath(cwd), ask)}\n`); return false; });
  expect(report.outcome).toBe('approval_requested');
  const [a] = (await w.snapshot()).approvals;
  return { approvalId: a.approvalId, scopeHash: a.scopeHash };
}
const grant = async (taskId: string, a: { approvalId: string; scopeHash: string }, key: string) => post(w.app, `/v1/approvals/${a.approvalId}/resolve`, { decision: 'grant', scopeHash: a.scopeHash, expectedRevision: (await w.status(taskId)).rowRevision, idempotencyKey: key });

describe('expired approvals through the real ask and resolve paths', () => {
  it('a request past its expiry cannot be granted, before or after the sweep, and the task stays stopped', async () => {
    const a = await asked('t_ex');
    w.advance(24 * 3600 + 1);
    const early = await grant('t_ex', a, 'k1');
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('approval_expired');
    expect(await w.count('approvals', `outcome = 'granted'`)).toBe(0);
    expect(await w.scheduler.expireApprovals(w.now())).toEqual([a.approvalId]);
    expect((await w.status('t_ex')).status).toBe('blocked');
    expect((await w.snapshot()).tasks[0].blockedReason).toBe('approval_expired');
    const late = await grant('t_ex', a, 'k2');
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('approval_expired');
    expect(await w.count('events', `type = 'approval.granted'`)).toBe(0);
    expect((await w.api().claim()).lease).toBeNull();
  });

  it('a grant that was valid when given but expired before the next claim is never delivered to the attempt', async () => {
    const a = await asked('t_grant');
    expect((await grant('t_grant', a, 'g1')).status).toBe(200);
    await w.t.db.execute(sql`UPDATE approvals SET expires_at = ${new Date(w.now().getTime() + 5000).toISOString()}::timestamptz`);
    w.advance(10);
    const lease = await w.claim();
    expect(lease.grants).toEqual([]);
    // Never handed to the attempt, so never recorded as used by it.
    expect(await w.count('approvals', 'consumed_at IS NOT NULL')).toBe(0);
  });

  it('control: an unexpired grant is delivered to the attempt and spent', async () => {
    const a = await asked('t_ok');
    expect((await grant('t_ok', a, 'g2')).status).toBe(200);
    const lease = await w.claim();
    expect(lease.grants).toEqual([expect.objectContaining({ operation: 'destructive_data_migration' })]);
    expect(await w.count('approvals', 'consumed_at IS NOT NULL')).toBe(1);
  });
});
