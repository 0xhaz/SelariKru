import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '@selarikru/persistence';
import { applyDelegation, createScheduler, PM_ACTOR } from './index.ts';
import { CAPS, POLICY, PROJECT, RUN, TENANT, TEST_CATALOG, TEST_RUNNER_REPORT, eventTypes, resetDb, runner, seedTask, setupTestDb, specFor, testClock, type TestClock, type TestDb } from '../test/helpers.ts';

/** H11: the Project Manager delegates on its own only inside the owner's accepted plan; the claim honours a delegation and a worker's role. */
let t: TestDb;
let clock: TestClock;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  clock = testClock();
  await resetDb(t.db);
  await t.db.execute(sql`DELETE FROM runners`);
  await t.db.update(schema.runs).set({ planRevision: 3 });
  for (const [id, role] of [['w_back', 'backend'], ['w_front', 'frontend'], ['w_off', 'backend'], ['w_pm', 'project_manager']] as const) {
    await t.db.insert(schema.runners).values({ tenantId: TENANT, runnerId: id, location: 'local', tokenHash: `hash-${id}`, harnessReport: TEST_RUNNER_REPORT as never, createdAt: clock.now(), lastSeenAt: clock.now(), lastPolledAt: clock.now() });
    await setting(id, 'role', role);
  }
  await setting('w_off', 'enabled', false);
});

async function setting(runnerId: string, field: string, value: unknown): Promise<void> {
  await t.db.insert(schema.runnerSettings).values({ tenantId: TENANT, runnerId, field, desired: value as never, desiredRevision: 1, effective: value as never, effectiveRevision: 1, enforcer: 'server', updatedBy: 'o', updatedAt: clock.now(), eventProjectId: PROJECT, eventRunId: RUN })
    .onConflictDoUpdate({ target: [schema.runnerSettings.tenantId, schema.runnerSettings.runnerId, schema.runnerSettings.field], set: { desired: value as never, effective: value as never } });
}
const ctx = () => ({ db: t.db, now: clock.now });
const delegate = (assignments: Record<string, unknown>[], planRevision = 3) => applyDelegation(ctx(), { tenantId: TENANT, projectId: PROJECT, runId: RUN, planRevision, assignments, actor: PM_ACTOR });
const sched = () => createScheduler({ db: t.db, now: clock.now, policy: POLICY, catalog: TEST_CATALOG, codingWorkers: 'claude_code' });

describe('the Project Manager\'s delegation', () => {
  it('applies inside the accepted plan and records task.delegated by agent:pm with the plan revision', async () => {
    await seedTask(t.db, specFor('t1', { role: 'backend' }));
    const r = await delegate([{ taskId: 't1', workerId: 'w_back', why: 'backend' }]);
    expect(r).toMatchObject({ apply: [{ taskId: 't1', workerId: 'w_back' }], refuse: [], autoDelegate: true });
    const [ev] = await t.db.execute(sql`SELECT actor_kind, actor_id, payload FROM events WHERE type = 'task.delegated'`);
    expect(ev).toMatchObject({ actor_kind: 'agent', actor_id: 'pm', payload: { workerId: 'w_back', planRevision: 3, revision: 1 } });
  });

  it('refuses anything outside the plan and writes nothing: another plan revision, another role, a disabled or unknown worker, a widening field', async () => {
    await seedTask(t.db, specFor('t1', { role: 'backend' }));
    expect((await delegate([{ taskId: 't1', workerId: 'w_back' }], 2))!.refuse[0]!.reason).toBe('plan_revision_not_accepted');
    expect((await delegate([{ taskId: 't1', workerId: 'w_front' }]))!.refuse[0]!.reason).toBe('role_not_in_task');
    expect((await delegate([{ taskId: 't1', workerId: 'w_off' }]))!.refuse[0]!.reason).toBe('worker_disabled');
    expect((await delegate([{ taskId: 't1', workerId: 'nobody' }]))!.refuse[0]!.reason).toBe('worker_unknown');
    expect((await delegate([{ taskId: 'not-in-plan', workerId: 'w_back' }]))!.refuse[0]!.reason).toBe('task_not_in_plan');
    for (const extra of [{ allowedPaths: ['/'] }, { budgetUsd: 100 }, { role: 'admin' }]) expect((await delegate([{ taskId: 't1', workerId: 'w_back', ...extra }]))!.refuse[0]!.reason).toBe('outside_plan_field');
    expect(await eventTypes(t.db)).toEqual([]);
  });

  it('applies nothing on its own when the owner turned auto-delegation off', async () => {
    await seedTask(t.db, specFor('t1', { role: 'backend' }));
    await t.db.insert(schema.runSettings).values({ tenantId: TENANT, projectId: PROJECT, runId: RUN, field: 'auto_delegate', desired: false as never, desiredRevision: 1, effective: false as never, effectiveRevision: 1, enforcer: 'server', updatedBy: 'o', updatedAt: clock.now() });
    const r = await delegate([{ taskId: 't1', workerId: 'w_back' }]);
    expect(r).toMatchObject({ apply: [], autoDelegate: false });
    expect(r!.refuse[0]!.reason).toBe('auto_delegate_off');
  });

  it('a failed task is reassigned only while its attempt limit allows', async () => {
    await seedTask(t.db, specFor('t1', { role: 'backend' }), 'failed');
    for (const n of [1, 2, 3]) await t.db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, taskId: 't1', revision: 1, attemptId: `a${n}`, attemptNumber: n, fence: n, runner: 'w_back', outcome: 'failed', startedAt: clock.now(), endedAt: clock.now() } as never);
    expect((await delegate([{ taskId: 't1', workerId: 'w_back' }]))!.refuse[0]!.reason).toBe('retry_limit_reached');
  });
});

describe('the claim honours delegation and roles', () => {
  it('a delegated task is claimed only by its worker', async () => {
    await seedTask(t.db, specFor('t1', { role: 'backend' }));
    await setting('w_front', 'role', 'backend');
    await delegate([{ taskId: 't1', workerId: 'w_back' }]);
    const other = await sched().tryClaim(runner('w_front'), CAPS);
    expect(other).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'delegated_to_other_worker' }] });
    expect(await sched().tryClaim(runner('w_back'), CAPS)).toMatchObject({ ok: true });
  });

  it('a worker with a role claims only its role\'s tasks, and the Project Manager claims none', async () => {
    await seedTask(t.db, specFor('t1', { role: 'backend' }));
    expect(await sched().tryClaim(runner('w_front'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'role_not_this_worker' }] });
    expect(await sched().tryClaim(runner('w_pm'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'project_manager_claims_no_task' }] });
    expect(await sched().tryClaim(runner('w_back'), CAPS)).toMatchObject({ ok: true });
  });

  it('I6: a delegated task still passes the role gate at claim', async () => {
    await seedTask(t.db, specFor('t1', { role: 'backend' }));
    await delegate([{ taskId: 't1', workerId: 'w_back' }]);
    await setting('w_back', 'role', 'frontend');
    expect(await sched().tryClaim(runner('w_back'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'role_not_this_worker' }] });
  });
});

describe('I6: a delegation never leaves its task stuck', () => {
  const released = async () => (await t.db.execute(sql`SELECT actor_kind, payload FROM events WHERE type = 'task.undelegated'`)) as unknown as { actor_kind: string; payload: { workerId: string; reason: string } }[];
  for (const [why, make] of [
    ['disabled', async () => setting('w_back', 'enabled', false)],
    ['revoked', async () => { await t.db.update(schema.runners).set({ revokedAt: clock.now() }).where(sql`runner_id = 'w_back'`); }],
    ['not_polling', async () => { const old = new Date(clock.now().getTime() - 3_600_000); await t.db.update(schema.runners).set({ lastSeenAt: old, lastPolledAt: old }).where(sql`runner_id = 'w_back'`); }],
    ['role_changed', async () => setting('w_back', 'role', 'frontend')],
  ] as const) {
    it(`released when the delegated worker is ${why}: task.undelegated by the system, then claimed as usual`, async () => {
      await seedTask(t.db, specFor('t1', { role: 'backend' }));
      await setting('w_front', 'role', 'backend');
      await delegate([{ taskId: 't1', workerId: 'w_back' }]);
      await make();
      expect(await sched().tryClaim(runner('w_front'), CAPS)).toMatchObject({ ok: true });
      const rows = await released();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_kind: 'system', payload: { workerId: 'w_back', reason: why } });
      expect(await t.db.execute(sql`SELECT 1 FROM task_delegations`)).toHaveLength(0);
    });
  }

  it('a live, enabled delegated worker keeps its task', async () => {
    await seedTask(t.db, specFor('t1', { role: 'backend' }));
    await setting('w_front', 'role', 'backend');
    await delegate([{ taskId: 't1', workerId: 'w_back' }]);
    expect(await sched().tryClaim(runner('w_front'), CAPS)).toMatchObject({ ok: false, skipped: [{ taskId: 't1', reason: 'delegated_to_other_worker' }] });
    expect(await released()).toHaveLength(0);
  });
});
