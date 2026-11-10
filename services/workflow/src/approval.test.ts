import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '@selarikru/persistence';
import { HUMAN_DECISION_KINDS, type Policy } from '@selarikru/policy';
import { WORKER_APPROVAL_OPERATIONS } from '@selarikru/domain';
import { createScheduler, type Lease, type PublishResult, type Scheduler } from './index.ts';
import { TEST_CATALOG,
  CAPS, CLOUD_POLICY, POLICY, PROJECT, RUN, TENANT, countRows, eventTypes, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, type TestClock, type TestDb,
} from '../test/helpers.ts';

const POLICY_OPS: Policy = { ...POLICY, operations: { destructive_data_migration: 'require_approval', deploy: 'deny', read_approved_docs: 'allow' } };
const CLOUD_APPROVAL: Policy = { ...(CLOUD_POLICY as Policy), operations: { start_cloud_worker: 'require_approval' } };
const CLOUD_RUN = { mode: 'C1', cloudDestination: 'cloud-sandbox-eu' };

let t: TestDb;
let clock: TestClock;
let s: Scheduler;
const sched = (policy: Policy): Scheduler => createScheduler({ catalog: TEST_CATALOG, db: t.db, now: clock.now, policy });
const useCloudRun = () => t.db.execute(sql`UPDATE runs SET placement = ${JSON.stringify(CLOUD_RUN)}::jsonb`);
const events = async (type: string) => [...(await t.db.execute(sql`SELECT payload, actor_kind, attempt_id FROM events WHERE type = ${type} ORDER BY sequence`))];
const approvals = async () => [...(await t.db.execute(sql`SELECT * FROM approvals ORDER BY created_at`))];
const request = (lease: Lease, operation: string | undefined, reason = 'needs docs.example.com', over: Record<string, unknown> = {}): Promise<unknown> =>
  s.publishResult(lease, { outcome: 'approval_requested', reason, ...(operation !== undefined ? { operation } : {}), ...over } as PublishResult);

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

describe('the worker approval vocabulary', () => {
  it('is exactly the human-decision kinds, minus the one a grant could never satisfy', () => {
    expect([...WORKER_APPROVAL_OPERATIONS].sort()).toEqual(HUMAN_DECISION_KINDS.filter((k) => k !== 'budget_increase').sort());
  });
});

describe('expiry sweeps isolate each row', () => {
  it('a row whose spec no longer parses does not stop the others expiring', async () => {
    await s.publishResult(await claimOne('t_bad'), { outcome: 'approval_requested', reason: 'x', operation: 'destructive_data_migration' } as PublishResult);
    await s.publishResult(await claimOne('t_good'), { outcome: 'approval_requested', reason: 'y', operation: 'destructive_data_migration' } as PublishResult);
    await t.db.execute(sql`UPDATE task_revisions SET spec = jsonb_set(spec, '{title}', 'null'::jsonb) WHERE task_id = 't_bad'`);
    const past = new Date(clock.now().getTime() + 2 * 24 * 3600 * 1000);
    await expect(s.expireApprovals(past)).rejects.toBeInstanceOf(AggregateError);
    const rows = await approvals();
    expect(rows.find((r) => r['task_id'] === 't_good')).toMatchObject({ outcome: 'expired' });
    expect(rows.find((r) => r['task_id'] === 't_bad')).toMatchObject({ outcome: 'pending' });
  });
});

describe('runner approval requests', () => {
  it.each([
    ['new_domain', 'egress_enforcement_unavailable', { destination: { kind: 'network_host', host: 'docs.example.com' } }],
    ['new_domain', 'egress_enforcement_unavailable', {}],
    ['new_connector', 'egress_enforcement_unavailable', { destination: { kind: 'network_host', host: 'docs.example.com' } }],
    ['scope_change', 'scope_grant_unavailable', {}],
    ['broader_scope', 'scope_grant_unavailable', {}],
  ] as const)('%s opens no approval: a grant could not take effect (%s)', async (operation, reason, over) => {
    s = sched({ ...POLICY_OPS, operations: { ...POLICY_OPS.operations, new_domain: 'require_approval', new_connector: 'require_approval', scope_change: 'require_approval', broader_scope: 'require_approval' } });
    const lease = await claimOne();
    expect(await request(lease, operation, 'needs it', over)).toMatchObject({ ok: true, value: { taskStatus: 'blocked' } });
    expect(await approvals()).toHaveLength(0);
    expect((await events('task.blocked'))[0]!['payload']).toMatchObject({ reason, operation });
  });

  it('runner approval request creates one pending row', async () => {
    const lease = await claimOne();
    expect(await request(lease, 'destructive_data_migration')).toMatchObject({ ok: true, value: { taskStatus: 'awaiting_approval' } });
    const rows = await approvals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: 't1', revision: 1, run_id: RUN, requester: 'r1', outcome: 'pending', approver: null });
    expect(rows[0]!['scope_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!['action_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!['expected_revisions']).toEqual({ t1: 1 });
    expect(rows[0]!['detail']).toMatchObject({ operation: 'destructive_data_migration', reason: 'needs docs.example.com', decisionReason: 'configured:destructive_data_migration' });
    expect(new Date(String(rows[0]!['expires_at'])).getTime()).toBe(clock.now().getTime() + 24 * 3600 * 1000);
    // A retried publish is the same operation: still one row.
    await request(lease, 'destructive_data_migration');
    expect(await countRows(t.db, 'approvals')).toBe(1);
  });

  it('approval.requested carries approvalId, scopeHash and expiresAt', async () => {
    const lease = await claimOne();
    await request(lease, 'destructive_data_migration');
    const row = (await approvals())[0]!;
    const [ev] = await events('approval.requested');
    expect(ev).toMatchObject({ actor_kind: 'scheduler', attempt_id: lease.attemptId });
    expect(ev!['payload']).toMatchObject({
      approvalId: row['approval_id'], scopeHash: row['scope_hash'], expiresAt: new Date(String(row['expires_at'])).toISOString(), reason: 'needs docs.example.com', operation: 'destructive_data_migration',
    });
  });

  for (const [name, op, reasonCode] of [
    ['a hard-denied operation', 'deploy', 'policy_denied:hard_deny:deploy'],
    ['an unconfigured operation', 'breaking_api_change', 'policy_denied:missing_operation_config:breaking_api_change'],
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
    await request(lease, 'destructive_data_migration');
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

  const grantFirst = async () => {
    await seedTask(t.db, specFor('c1', { execution: 'cloud' }));
    await s.tryClaim(runner('cloud1', 'cloud'), CAPS);
    await t.db.execute(sql`UPDATE approvals SET outcome = 'granted'`);
    await t.db.execute(sql`UPDATE task_status SET status = 'ready'`);
  };

  it('a grant under another destination releases nothing', async () => {
    await grantFirst();
    await t.db.execute(sql`UPDATE runs SET placement = ${JSON.stringify({ mode: 'C1', cloudDestination: 'cloud-sandbox-us' })}::jsonb`);
    s = sched({ ...CLOUD_APPROVAL, destinations: [{ destination: 'cloud-sandbox-us', purpose: 'execution', classifications: ['public', 'internal'] }] });
    expect(await s.claimNext(runner('cloud1', 'cloud'), CAPS)).toBeNull();
    expect((await statusOf(t.db, 'c1')).status).toBe('awaiting_approval');
    expect(await countRows(t.db, 'approvals', `outcome = 'pending'`)).toBe(1);
    expect(await countRows(t.db, 'attempts')).toBe(0);
  });

  it('a grant under another revision releases nothing', async () => {
    await grantFirst();
    await t.db.insert(schema.taskRevisions).values({ tenantId: TENANT, projectId: PROJECT, runId: RUN, taskId: 'c1', revision: 2, boardId: 'b1', spec: specFor('c1', { execution: 'cloud', revision: 2 }) });
    await t.db.execute(sql`UPDATE task_status SET current_revision = 2`);
    expect(await s.claimNext(runner('cloud1', 'cloud'), CAPS)).toBeNull();
    expect((await statusOf(t.db, 'c1')).status).toBe('awaiting_approval');
    expect(await countRows(t.db, 'approvals', `outcome = 'pending' AND revision = 2`)).toBe(1);
    expect(await countRows(t.db, 'attempts')).toBe(0);
    expect((await approvals())[0]!['consumed_at']).toBeNull();
  });

  it('an expired grant releases nothing', async () => {
    await grantFirst();
    clock.advance(24 * 3600 + 1);
    expect(await s.claimNext(runner('cloud1', 'cloud'), CAPS)).toBeNull();
    expect(await countRows(t.db, 'attempts')).toBe(0);
    expect((await statusOf(t.db, 'c1')).status).toBe('awaiting_approval');
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

describe('approval expiry', () => {
  it('the sweep expires a pending approval, blocks the task with a readable reason, and is idempotent', async () => {
    const lease = await claimOne();
    await request(lease, 'destructive_data_migration');
    const row = (await approvals())[0]!;
    expect(await s.expireApprovals(clock.now())).toEqual([]);
    expect((await approvals())[0]).toMatchObject({ outcome: 'pending' });
    clock.advance(24 * 3600);
    expect(await s.expireApprovals(clock.now())).toEqual([row['approval_id']]);
    expect((await approvals())[0]).toMatchObject({ outcome: 'expired' });
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
    const [ev] = await events('task.blocked');
    expect(ev!['payload']).toMatchObject({ reason: 'approval_expired', approvalId: row['approval_id'], scopeHash: row['scope_hash'] });
    // A second pass finds nothing and writes nothing.
    expect(await s.expireApprovals(clock.now())).toEqual([]);
    expect(await events('task.blocked')).toHaveLength(1);
    expect((await statusOf(t.db, 't1')).status).toBe('blocked');
  });

  it('leaves a task that is no longer waiting on the approval alone', async () => {
    const lease = await claimOne();
    await request(lease, 'destructive_data_migration');
    await t.db.execute(sql`UPDATE task_status SET status = 'cancelled'`);
    clock.advance(24 * 3600);
    await s.expireApprovals(clock.now());
    expect((await approvals())[0]).toMatchObject({ outcome: 'expired' });
    expect((await statusOf(t.db, 't1')).status).toBe('cancelled');
    expect(await events('task.blocked')).toHaveLength(0);
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


describe('a restricted attempt: the server keeps the agent\'s words out whatever the runner sends', () => {
  const WORDS = 'drop the patients table holding RESTRICTED-CANARY rows';
  const restrict = (lease: Lease) => t.db.execute(sql`UPDATE attempts SET detail = detail || '{"terminalStreamable": false}'::jsonb WHERE attempt_id = ${lease.attemptId}`);
  const leaked = async () => JSON.stringify([
    ...(await t.db.execute(sql`SELECT * FROM approvals`)),
    ...(await t.db.execute(sql`SELECT exit_reason FROM attempts`)),
    ...(await t.db.execute(sql`SELECT payload FROM events`)),
  ]).includes('RESTRICTED-CANARY');

  it('an approval request is recorded with a fixed sentence naming the operation', async () => {
    const lease = await claimOne();
    await restrict(lease);
    await request(lease, 'destructive_data_migration', WORDS);
    expect((await statusOf(t.db, 't1')).status).toBe('awaiting_approval');
    expect(await leaked()).toBe(false);
    const [row] = await approvals();
    expect(String((row!['detail'] as { reason: string }).reason)).toMatch(/destructive_data_migration.*restricted/);
  });

  it('a request that cannot take effect or that policy denies is blocked without the words too', async () => {
    const a = await claimOne('t_net');
    await restrict(a);
    await request(a, 'new_domain', WORDS, { destination: { kind: 'network_host', host: 'docs.example.com' } });
    const b = await claimOne('t_deny');
    await restrict(b);
    await request(b, undefined, WORDS);
    expect(await leaked()).toBe(false);
  });

  it('a diff reason with paths is cut to the count', async () => {
    const lease = await claimOne();
    await restrict(lease);
    await s.publishResult(lease, { outcome: 'failed', reason: 'diff outside allowedPaths: 1 path(s): secret/RESTRICTED-CANARY.md (outside)' } as PublishResult);
    expect(await leaked()).toBe(false);
    expect(String((await t.db.execute(sql`SELECT exit_reason FROM attempts`))[0]!['exit_reason'])).toMatch(/^diff outside allowedPaths: 1 path\(s\); the paths stay on the device/);
  });

  it('a streamable attempt keeps the agent\'s words', async () => {
    const lease = await claimOne();
    await request(lease, 'destructive_data_migration', WORDS);
    expect(await leaked()).toBe(true);
  });
});
