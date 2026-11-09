import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Policy } from '@selarikru/policy';
import { createScheduler, type Lease, type PublishResult, type Scheduler } from './index.ts';
import {
  CAPS, CLOUD_POLICY, POLICY, RUN, countRows, eventTypes, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, type TestClock, type TestDb,
} from '../test/helpers.ts';

const POLICY_OPS: Policy = { ...POLICY, operations: { new_domain: 'require_approval', deploy: 'deny', read_approved_docs: 'allow' } };
const CLOUD_APPROVAL: Policy = { ...(CLOUD_POLICY as Policy), operations: { start_cloud_worker: 'require_approval' } };
const CLOUD_RUN = { mode: 'C1', cloudDestination: 'cloud-sandbox-eu' };

let t: TestDb;
let clock: TestClock;
let s: Scheduler;
const sched = (policy: Policy): Scheduler => createScheduler({ db: t.db, now: clock.now, policy });
const useCloudRun = () => t.db.execute(sql`UPDATE runs SET placement = ${JSON.stringify(CLOUD_RUN)}::jsonb`);
const events = async (type: string) => [...(await t.db.execute(sql`SELECT payload, actor_kind, attempt_id FROM events WHERE type = ${type} ORDER BY sequence`))];
const approvals = async () => [...(await t.db.execute(sql`SELECT * FROM approvals ORDER BY created_at`))];
const request = (lease: Lease, operation: string | undefined, reason = 'needs docs.example.com'): Promise<unknown> =>
  s.publishResult(lease, { outcome: 'approval_requested', reason, ...(operation !== undefined ? { operation } : {}) } as PublishResult);

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  clock = testClock();
  await resetDb(t.db);
  s = sched(POLICY_OPS);
});

async function claimOne(id = 't1'): Promise<Lease> {
  await seedTask(t.db, specFor(id));
  return (await s.claimNext(runner('r1'), CAPS))!;
}

describe('runner approval requests', () => {
  it('runner approval request creates one pending row', async () => {
    const lease = await claimOne();
    expect(await request(lease, 'new_domain')).toMatchObject({ ok: true, value: { taskStatus: 'awaiting_approval' } });
    const rows = await approvals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: 't1', revision: 1, run_id: RUN, requester: 'r1', outcome: 'pending', approver: null });
    expect(rows[0]!['scope_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!['action_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!['expected_revisions']).toEqual({ t1: 1 });
    expect(rows[0]!['detail']).toMatchObject({ operation: 'new_domain', reason: 'needs docs.example.com', decisionReason: 'configured:new_domain' });
    expect(new Date(String(rows[0]!['expires_at'])).getTime()).toBe(clock.now().getTime() + 24 * 3600 * 1000);
    // A retried publish is the same operation: still one row.
    await request(lease, 'new_domain');
    expect(await countRows(t.db, 'approvals')).toBe(1);
  });

  it('approval.requested carries approvalId, scopeHash and expiresAt', async () => {
    const lease = await claimOne();
    await request(lease, 'new_domain');
    const row = (await approvals())[0]!;
    const [ev] = await events('approval.requested');
    expect(ev).toMatchObject({ actor_kind: 'scheduler', attempt_id: lease.attemptId });
    expect(ev!['payload']).toMatchObject({
      approvalId: row['approval_id'], scopeHash: row['scope_hash'], expiresAt: new Date(String(row['expires_at'])).toISOString(), reason: 'needs docs.example.com', operation: 'new_domain',
    });
  });

  for (const [name, op, reasonCode] of [
    ['a hard-denied operation', 'deploy', 'policy_denied:hard_deny:deploy'],
    ['an unconfigured operation', 'broader_scope', 'policy_denied:missing_operation_config:broader_scope'],
    ['an unknown operation', 'grant_me_everything', 'policy_denied:unknown_operation'],
    ['a request naming no operation', undefined, 'policy_denied:unknown_operation'],
    ['a kind the runner cannot parameterise', 'start_cloud_worker', 'policy_denied:missing_limit:maxConcurrentTotal'],
    ['an operation policy simply allows', 'read_approved_docs', 'approval_not_required:configured:read_approved_docs'],
  ] as const) {
    it(`policy deny creates no approvable row: ${name}`, async () => {
      const lease = await claimOne();
      expect(await request(lease, op)).toMatchObject({ ok: true, value: { taskStatus: 'blocked' } });
      expect(await countRows(t.db, 'approvals')).toBe(0);
      expect(await events('approval.requested')).toHaveLength(0);
      const [blocked] = await events('task.blocked');
      expect((blocked!['payload'] as { reason: string }).reason).toBe(reasonCode);
      // The worker's own text cannot unlock anything and stays beside the code.
      expect(blocked!['payload']).toMatchObject({ requestedReason: 'needs docs.example.com' });
    });
  }

  it('an admin kind is never approvable for a worker, even when configured', async () => {
    s = sched({ ...POLICY_OPS, operations: { ...POLICY_OPS.operations, modify_credentials: 'require_approval' } });
    const lease = await claimOne();
    await request(lease, 'modify_credentials');
    expect(await countRows(t.db, 'approvals')).toBe(0);
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
  });

  it('a grant returns the task to ready and the next attempt consumes it', async () => {
    const lease = await claimOne();
    await request(lease, 'new_domain');
    await t.db.execute(sql`UPDATE approvals SET outcome = 'granted'`);
    await t.db.execute(sql`UPDATE task_status SET status = 'ready'`);
    const next = (await s.claimNext(runner('r1'), CAPS))!;
    expect(next.attemptId).not.toBe(lease.attemptId);
    expect((await approvals())[0]).toMatchObject({ consumed_by: next.attemptId });
    expect((await approvals())[0]!['consumed_at']).not.toBeNull();
  });
});

describe('cloud require_approval', () => {
  beforeEach(async () => { await useCloudRun(); s = sched(CLOUD_APPROVAL); });

  it('cloud require_approval creates one pending row and starts nothing', async () => {
    await seedTask(t.db, specFor('c1', { execution: 'cloud' }), 'planned');
    const out = await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    expect(out.ok).toBe(false);
    expect(await countRows(t.db, 'attempts')).toBe(0);
    expect(await countRows(t.db, 'budget_reservations')).toBe(0);
    expect((await statusOf(t.db, 'c1')).status).toBe('awaiting_approval');
    const rows = await approvals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: 'c1', revision: 1, outcome: 'pending', requester: 'scheduler' });
    expect(rows[0]!['detail']).toMatchObject({ operation: 'start_cloud_worker', destination: 'cloud-sandbox-eu' });
    // Further passes change nothing: the task is no longer claimable.
    await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    expect(await countRows(t.db, 'approvals')).toBe(1);
    expect(await eventTypes(t.db)).toEqual(['task.ready', 'approval.requested']);
    expect((await events('approval.requested'))[0]!['payload']).toMatchObject({
      approvalId: rows[0]!['approval_id'], scopeHash: rows[0]!['scope_hash'], operation: 'start_cloud_worker',
      reason: 'approval_required:configured_require_approval:start_cloud_worker',
    });
  });

  it('a deny for the same cloud start creates no approval row and stays visibly blocked', async () => {
    s = sched({ ...CLOUD_APPROVAL, destinations: [] });
    await seedTask(t.db, specFor('c1', { execution: 'cloud' }));
    await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    expect(await countRows(t.db, 'approvals')).toBe(0);
    expect((await statusOf(t.db, 'c1')).status).toBe('ready');
    expect(await eventTypes(t.db)).toEqual(['placement.blocked']);
  });

  it('after a grant the start runs and consumes the grant; a later attempt needs a new approval', async () => {
    await seedTask(t.db, specFor('c1', { execution: 'cloud' }));
    await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    await t.db.execute(sql`UPDATE approvals SET outcome = 'granted'`);
    await t.db.execute(sql`UPDATE task_status SET status = 'ready'`);
    const lease = (await s.claimNext(runner('cloud1', 'cloud'), CAPS))!;
    expect(lease).toMatchObject({ taskId: 'c1', location: 'cloud' });
    expect((await approvals())[0]).toMatchObject({ outcome: 'granted', consumed_by: lease.attemptId });
    const decided = (await events('placement.decided'))[0]!['payload'] as { policyDecision: { decision: string; reason: string } };
    expect(decided.policyDecision).toMatchObject({ decision: 'allow', reason: 'approved:configured_require_approval:start_cloud_worker' });

    await s.publishResult(lease, { outcome: 'failed', reason: 'boom' });
    await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    expect((await statusOf(t.db, 'c1')).status).toBe('awaiting_approval');
    const rows = await approvals();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ outcome: 'pending', scope_hash: rows[0]!['scope_hash'], consumed_at: null });
  });

  it('a grant under another revision or destination releases nothing', async () => {
    await seedTask(t.db, specFor('c1', { execution: 'cloud' }));
    await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    await t.db.execute(sql`UPDATE approvals SET outcome = 'granted'`);
    await t.db.execute(sql`UPDATE task_status SET status = 'ready'`);
    await t.db.execute(sql`UPDATE runs SET placement = ${JSON.stringify({ mode: 'C1', cloudDestination: 'cloud-sandbox-us' })}::jsonb`);
    s = sched({ ...CLOUD_APPROVAL, destinations: [{ destination: 'cloud-sandbox-us', purpose: 'execution', classifications: ['public', 'internal'] }] });
    expect(await s.claimNext(runner('cloud1', 'cloud'), CAPS)).toBeNull();
    expect((await statusOf(t.db, 'c1')).status).toBe('awaiting_approval');
    expect(await countRows(t.db, 'approvals', `outcome = 'pending'`)).toBe(1);
  });

  it('a grant whose policy now denies the start releases nothing', async () => {
    await seedTask(t.db, specFor('c1', { execution: 'cloud' }));
    await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    await t.db.execute(sql`UPDATE approvals SET outcome = 'granted'`);
    await t.db.execute(sql`UPDATE task_status SET status = 'ready'`);
    s = sched({ ...CLOUD_APPROVAL, destinations: [] });
    expect(await s.claimNext(runner('cloud1', 'cloud'), CAPS)).toBeNull();
    expect(await countRows(t.db, 'attempts')).toBe(0);
    expect((await approvals())[0]!['consumed_at']).toBeNull();
  });
});

describe('repair require_approval', () => {
  it('a repair gate waits for a human, then spends the grant on one repair', async () => {
    s = sched({ ...CLOUD_POLICY as Policy, operations: { repair_within_limits: 'require_approval' } });
    await seedTask(t.db, specFor('rp'));
    const lease = (await s.claimNext(runner('l1'), CAPS))!;
    await s.publishResult(lease, { outcome: 'failed', reason: 'boom' });
    expect((await s.tryClaim(runner('l1'), CAPS)).ok).toBe(false);
    expect((await statusOf(t.db, 'rp')).status).toBe('awaiting_approval');
    expect(await countRows(t.db, 'approvals', `outcome = 'pending'`)).toBe(1);
    await t.db.execute(sql`UPDATE approvals SET outcome = 'granted'`);
    await t.db.execute(sql`UPDATE task_status SET status = 'ready'`);
    const repair = (await s.claimNext(runner('l1'), CAPS))!;
    expect(repair.attemptNumber).toBe(2);
    expect((await approvals())[0]).toMatchObject({ consumed_by: repair.attemptId });
  });
});

