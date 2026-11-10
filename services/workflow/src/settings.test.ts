import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import { createScheduler, requestPolicyStop, type Scheduler } from './index.ts';
import { CAPS, CLOUD_POLICY, PROJECT, RUN, TENANT, TEST_CATALOG, countRows, makeScheduler, resetDb, runner, seedTask, setupTestDb, specFor, statusOf, testClock, type TestClock, type TestDb } from '../test/helpers.ts';
import { withTx } from '@selarikru/persistence';

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

const setRun = (field: string, value: unknown, enforcer = 'server') => t.db.insert(schema.runSettings).values({
  tenantId: TENANT, projectId: PROJECT, runId: RUN, field, desired: value, desiredRevision: 1, enforcer, updatedBy: 'owner', updatedAt: clock.now(),
}).onConflictDoUpdate({ target: [schema.runSettings.tenantId, schema.runSettings.projectId, schema.runSettings.runId, schema.runSettings.field], set: { desired: value, desiredRevision: sql`${schema.runSettings.desiredRevision} + 1` } });
const setRunner = (runnerId: string, field: string, value: unknown) => t.db.insert(schema.runnerSettings).values({
  tenantId: TENANT, runnerId, field, desired: value, desiredRevision: 1, enforcer: 'runner', updatedBy: 'owner', updatedAt: clock.now(), eventProjectId: PROJECT, eventRunId: RUN,
});

describe('settings gate every claim on the server', () => {
  it('a paused run grants no claim, and resuming lets the next one through', async () => {
    await seedTask(t.db, specFor('t1'));
    await setRun('paused', true, 'runner');
    const refused = await s.tryClaim(runner('r1'), CAPS);
    expect(refused).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'run_paused' }] });
    expect(await countRows(t.db, 'attempts')).toBe(0);
    await setRun('paused', false, 'runner');
    expect((await s.tryClaim(runner('r1'), CAPS)).ok).toBe(true);
  });

  it('an attempt records the settings revision it started under', async () => {
    await seedTask(t.db, specFor('t1'));
    await t.db.insert(schema.runnerConfig).values({ tenantId: TENANT, revision: 7 });
    await s.claimNext(runner('r1'), CAPS);
    const [row] = await t.db.execute(sql`SELECT detail FROM attempts`);
    expect(row!['detail']).toMatchObject({ configRevision: 7 });
  });

  it('a run with a cancel request grants no claim', async () => {
    await seedTask(t.db, specFor('t1'));
    await t.db.update(schema.runs).set({ cancelRequestedAt: clock.now(), cancelRequestedBy: 'owner' });
    expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, reason: 'no_claimable_task', skipped: [] });
  });

  it('a removed allowed path blocks the task that needs it, visibly, and restoring it lets the task run', async () => {
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src', 'tests'] }));
    await seedTask(t.db, specFor('t2', { allowedPaths: ['src'] }));
    await setRun('allowed_paths', ['src']);
    const first = await s.tryClaim(runner('r1'), CAPS);
    expect(first.ok && first.lease.taskId).toBe('t2');
    const second = await s.tryClaim(runner('r1'), CAPS);
    expect(second).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'placement_blocked:policy_revoked:allowed_paths' }] });
    const [row] = await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 't1'`);
    expect(row!['placement_block']).toBe('policy_revoked:allowed_paths');
    await setRun('allowed_paths', ['src', 'tests']);
    const third = await s.tryClaim(runner('r1'), CAPS);
    expect(third.ok && third.lease.taskId).toBe('t1');
    const [cleared] = await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 't1'`);
    expect(cleared!['placement_block']).toBeNull();
  });

  it('a disabled worker is refused at once, and the others are not', async () => {
    await seedTask(t.db, specFor('t1'));
    await setRunner('r1', 'enabled', false);
    expect(await s.tryClaim(runner('r1'), CAPS)).toMatchObject({ ok: false, reason: 'runner_disabled' });
    expect(await countRows(t.db, 'attempts')).toBe(0);
    expect((await s.tryClaim(runner('r2'), CAPS)).ok).toBe(true);
  });

  it('a worker at the slot limit the owner set takes nothing more', async () => {
    await seedTask(t.db, specFor('t1'));
    await seedTask(t.db, specFor('t2'));
    await setRunner('r3', 'slots', 1);
    expect((await s.tryClaim(runner('r3'), CAPS)).ok).toBe(true);
    expect(await s.tryClaim(runner('r3'), CAPS)).toMatchObject({ ok: false, reason: 'runner_slots_full' });
    expect((await s.tryClaim(runner('r4'), CAPS)).ok).toBe(true);
  });

  it('a run no longer cloud-eligible gives a cloud runner nothing', async () => {
    const cloud = createScheduler({ db: t.db, now: clock.now, policy: CLOUD_POLICY, catalog: TEST_CATALOG });
    await t.db.update(schema.runs).set({ placement: { mode: 'C1', cloudDestination: 'cloud-sandbox-eu' } });
    await seedTask(t.db, specFor('t1', { execution: 'cloud' }));
    await setRun('cloud_eligible', false);
    const refused = await cloud.tryClaim(runner('c1', 'cloud'), CAPS);
    expect(refused.ok).toBe(false);
    expect(refused.skipped[0]!.reason).toBe('placement_blocked:location_disabled:cloud');
    await setRun('cloud_eligible', true);
    expect((await cloud.tryClaim(runner('c1', 'cloud'), CAPS)).ok).toBe(true);
  });
});

describe('a revoke stops a running attempt as blocked by policy, not cancelled', () => {
  it('the runner is told to stop, and its result leaves the task ready but blocked by the revoke, with the repair budget kept', async () => {
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src', 'tests'] }));
    const lease = (await s.claimNext(runner('r1'), CAPS))!;
    await setRun('allowed_paths', ['src']);
    const asked = await withTx(t.db, (tx) => requestPolicyStop(tx, { tenantId: TENANT, projectId: PROJECT, taskId: 't1' }, 'policy_revoked:allowed_paths', 'owner', clock.now()));
    expect(asked).toBe(true);
    const hb = await s.heartbeat(lease);
    expect(hb.ok && hb.value.cancelRequested).toBe(true);
    const r = await s.publishResult(lease, { outcome: 'completed', headSha: 'a'.repeat(40) });
    expect(r).toMatchObject({ ok: true, value: { taskStatus: 'ready' } });
    const st = await statusOf(t.db, 't1');
    expect(st.status).toBe('ready');
    const [row] = await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 't1'`);
    expect(row!['placement_block']).toBe('policy_revoked:allowed_paths');
    const [attempt] = await t.db.execute(sql`SELECT outcome, exit_reason FROM attempts`);
    expect(attempt).toMatchObject({ outcome: 'interrupted', exit_reason: 'policy_revoked:allowed_paths' });
    const types = (await t.db.execute(sql`SELECT type, payload FROM events ORDER BY sequence`)).map((e) => e['type']);
    expect(types).not.toContain('task.cancelled');
    expect(types).toContain('placement.blocked');
  });

  it('a lease that lapses under a policy stop ends the same way', async () => {
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src'] }));
    await s.claimNext(runner('r1'), CAPS);
    await withTx(t.db, (tx) => requestPolicyStop(tx, { tenantId: TENANT, projectId: PROJECT, taskId: 't1' }, 'policy_revoked:cloud_eligible', 'owner', clock.now()));
    clock.advance(61);
    await s.expireLeases(clock.now());
    expect((await statusOf(t.db, 't1')).status).toBe('ready');
    const [row] = await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 't1'`);
    expect(row!['placement_block']).toBe('policy_revoked:cloud_eligible');
  });

  it('asks nothing of a task that is not running or already has a stop open', async () => {
    await seedTask(t.db, specFor('t1'));
    expect(await withTx(t.db, (tx) => requestPolicyStop(tx, { tenantId: TENANT, projectId: PROJECT, taskId: 't1' }, 'policy_revoked:allowed_paths', 'owner', clock.now()))).toBe(false);
    await s.claimNext(runner('r1'), CAPS);
    expect(await withTx(t.db, (tx) => requestPolicyStop(tx, { tenantId: TENANT, projectId: PROJECT, taskId: 't1' }, 'policy_revoked:allowed_paths', 'owner', clock.now()))).toBe(true);
    expect(await withTx(t.db, (tx) => requestPolicyStop(tx, { tenantId: TENANT, projectId: PROJECT, taskId: 't1' }, 'policy_revoked:allowed_paths', 'owner', clock.now()))).toBe(false);
  });
});
