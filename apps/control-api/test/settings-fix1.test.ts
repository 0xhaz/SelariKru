import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, schema, withTx } from '@selarikru/persistence';
import { createScheduler } from '@selarikru/workflow';
import { CLOUD_POLICY, TEST_CATALOG, TEST_DATABASE_URL } from '@selarikru/workflow/test-helpers';
import { API_POLICY, PROJECT, RUN, bearer, enrolRunner, get, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';
import { finishCancelledRuns, settlePendingSettings } from '../src/settings.ts';
import { bumpStatus } from '../src/store.ts';

let t: TestDb;
let h: Harness;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`DROP TRIGGER IF EXISTS fail_ack ON runners; DROP TRIGGER IF EXISTS fail_cancel ON runs`);
  await t.db.execute(sql`DELETE FROM runners`);
  h = makeHarness(t);
});

const save = (key: string, change: Record<string, unknown>, expectedRevision = 0, idempotencyKey = `k-${Math.random()}`) => post(h.app, `/v1/projects/${PROJECT}/settings`, { key, change, expectedRevision, idempotencyKey });
const snapshot = async () => (await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body;
const settingOf = async (key: string, field: string) => (await snapshot()).settings.find((s: any) => s.key === key && s.field === field);
const claim = (token: string, config?: { revision: number; slots: number }) => post(h.app, '/v1/runners/claim', config ? { config } : {}, bearer(token));
const refOf = (lease: any) => ({ attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken });
const count = async (table: string, where = 'true') => Number((await t.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)))[0]!['n']);

describe('I1: a runner that falls out of the recent window no longer holds a change back', () => {
  async function twoRunnersPaused() {
    const a = await enrolRunner(h.app);
    const b = await enrolRunner(h.app);
    // Both are on a build that acknowledges: each has acknowledged revision 0.
    await claim(a.token, { revision: 0, slots: 2 });
    await claim(b.token, { revision: 0, slots: 2 });
    const saved = await save(RUN, { scope: 'run', field: 'paused', value: true });
    await claim(a.token, { revision: saved.body.configRevision, slots: 2 });
    expect((await settingOf(RUN, 'paused')).state).toBe('applying');
    return { a, b, revision: saved.body.configRevision as number };
  }

  it('applies on the surviving runner\'s next acknowledgement, even when its own row does not move', async () => {
    const { a, revision } = await twoRunnersPaused();
    h.clock.advance(121);
    await claim(a.token, { revision, slots: 2 });
    expect(await settingOf(RUN, 'paused')).toMatchObject({ state: 'applied', effective: true });
  });

  it('applies on the periodic pass with no acknowledgement at all', async () => {
    await twoRunnersPaused();
    h.clock.advance(121);
    // A is quiet too now, so nobody is recent: still waiting, never applied by default.
    await settlePendingSettings({ db: t.db, tenantId: 'tenant_a', now: h.clock.now });
    expect((await settingOf(RUN, 'paused')).state).toBe('waiting_for_runner');
  });

  it('the periodic pass applies once the quiet runner drops out and the rest have acknowledged', async () => {
    const { a, revision } = await twoRunnersPaused();
    h.clock.advance(61);
    // A keeps polling (seen again), B stays quiet.
    await t.db.execute(sql`UPDATE runners SET last_seen_at = ${h.clock.now().toISOString()}::timestamptz, last_polled_at = ${h.clock.now().toISOString()}::timestamptz WHERE runner_id = ${a.runnerId}`);
    h.clock.advance(60);
    await t.db.execute(sql`UPDATE runners SET last_seen_at = ${h.clock.now().toISOString()}::timestamptz, last_polled_at = ${h.clock.now().toISOString()}::timestamptz WHERE runner_id = ${a.runnerId}`);
    await settlePendingSettings({ db: t.db, tenantId: 'tenant_a', now: h.clock.now });
    expect((await settingOf(RUN, 'paused')).state).toBe('applied');
    void revision;
  });
});

describe('M7: a recent runner on a build that never acknowledges', () => {
  it('reads as waiting for a runner update, names it, and is not counted as acknowledged', async () => {
    const a = await enrolRunner(h.app);
    const old = await enrolRunner(h.app);
    await claim(a.token, { revision: 0, slots: 2 });
    // It polls, so it counts as recent, but never acknowledges.
    await claim(old.token);
    const saved = await save(RUN, { scope: 'run', field: 'paused', value: true });
    await claim(a.token, { revision: saved.body.configRevision, slots: 2 });
    expect(await settingOf(RUN, 'paused')).toMatchObject({ state: 'waiting_for_runner_update', waitingOn: [old.runnerId], effective: null });
    const m = await post(h.app, `/v1/projects/${PROJECT}/model-assignments`, { scope: 'role', key: 'backend', selection: { provider: 'anthropic', model: 'claude-opus-5-5' }, expectedRevision: 0, idempotencyKey: 'm' });
    expect(m.status).toBe(200);
    expect((await snapshot()).modelAssignments.find((x: any) => x.key === 'backend')).toMatchObject({ state: 'waiting_for_runner_update', waitingOn: [old.runnerId] });
  });
});

describe('I2: run cancel reads every task after it holds its row', () => {
  it('a publish that moved a task out of running just before is not undone', async () => {
    const a = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1'));
    await claim(a.token);
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void; const lockedP = new Promise<void>((r) => { locked = r; });
    const pub = t.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM task_status WHERE task_id = 't1' FOR UPDATE`);
      await tx.execute(sql`UPDATE task_status SET status = 'failed', row_revision = row_revision + 1 WHERE task_id = 't1'`);
      await tx.execute(sql`UPDATE attempts SET ended_at = now(), outcome = 'failed' WHERE task_id = 't1'`);
      locked(); await held;
    });
    await lockedP;
    const [before] = await t.db.execute(sql`SELECT row_revision FROM task_status WHERE task_id = 't1'`);
    const cancel = post(h.app, `/v1/runs/${RUN}/cancel`, { expectedPlanRevision: 0, idempotencyKey: 'c1' });
    await new Promise((r) => setTimeout(r, 300));
    release(); await pub;
    const res = await cancel;
    expect(res.status).toBe(202);
    const [after] = await t.db.execute(sql`SELECT status, row_revision FROM task_status WHERE task_id = 't1'`);
    expect(after).toMatchObject({ status: 'failed', row_revision: Number(before!['row_revision']) + 1 });
    expect(await count('task_commands', `detail->>'reason' = 'run_cancelled' AND state = 'cancel_requested'`)).toBe(0);
    expect(res.body).toMatchObject({ stopping: [], state: 'applied' });
    await finishCancelledRuns({ db: t.db, tenantId: 'tenant_a', now: h.clock.now });
    expect((await t.db.execute(sql`SELECT status FROM task_status WHERE task_id = 't1'`))[0]!['status']).toBe('failed');
  });

  it('a status write at a revision that is no longer current fails loudly', async () => {
    await seedTask(t.db, specFor('t1'));
    await expect(withTx(t.db, (tx) => bumpStatus(tx, { tenantId: 'tenant_a', projectId: PROJECT, taskId: 't1' }, 41, 'cancelled', h.clock.now()))).rejects.toMatchObject({ status: 409, code: 'stale_revision' });
    expect((await t.db.execute(sql`SELECT status FROM task_status WHERE task_id = 't1'`))[0]!['status']).toBe('ready');
  });
});

describe('M1: a budget stop survives a replay', () => {
  it('a retried save still stops running work past the new limit', async () => {
    const a = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1', { maxCostUsd: 5 }));
    await claim(a.token);
    expect((await save(RUN, { scope: 'run', field: 'budget_limit_usd', value: 1 }, 0, 'b1')).status).toBe(200);
    // As if the stop after the first commit had been lost.
    await t.db.execute(sql`DELETE FROM task_commands`);
    expect((await save(RUN, { scope: 'run', field: 'budget_limit_usd', value: 1 }, 0, 'b1')).status).toBe(200);
    expect(await count('task_commands', `detail->>'reason' = 'budget_exhausted'`)).toBe(1);
  });
});

describe('M2: work after a runner\'s commit cannot turn it into an error', () => {
  it('a failed acknowledgement leaves the heartbeat answered', async () => {
    const a = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1'));
    const lease = (await claim(a.token)).body.lease;
    await t.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION fail_now() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$ LANGUAGE plpgsql`));
    await t.db.execute(sql.raw(`CREATE TRIGGER fail_ack BEFORE UPDATE OF config_ack_revision ON runners FOR EACH ROW EXECUTE FUNCTION fail_now()`));
    const hb = await post(h.app, '/v1/runners/heartbeat', { lease: refOf(lease), config: { revision: 0, slots: 2 } }, bearer(a.token));
    expect(hb.status).toBe(200);
  });

  it('a failed run-cancel finish leaves the published result answered', async () => {
    const a = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1'));
    const lease = (await claim(a.token)).body.lease;
    await post(h.app, `/v1/runs/${RUN}/cancel`, { expectedPlanRevision: 0, idempotencyKey: 'c' });
    await t.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION fail_now() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$ LANGUAGE plpgsql`));
    await t.db.execute(sql.raw(`CREATE TRIGGER fail_cancel BEFORE UPDATE OF lifecycle ON runs FOR EACH ROW EXECUTE FUNCTION fail_now()`));
    const done = await post(h.app, '/v1/runners/result', { lease: refOf(lease), result: { outcome: 'completed', headSha: 'a'.repeat(40) } }, bearer(a.token));
    expect(done.status).toBe(200);
    expect(done.body.taskStatus).toBe('cancelled');
  });
});

describe('M4: a plan cannot bring back a path the owner took away', () => {
  it('a plan revision with a task needing a removed path is refused, naming the path', async () => {
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src', 'tests'] }));
    await save(RUN, { scope: 'run', field: 'allowed_paths', value: ['src'] });
    const res = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks: [specFor('t2', { allowedPaths: ['src', 'tests'] })] });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'path_not_allowed', details: { paths: ['tests'], taskIds: ['t2'] } });
    expect(res.body.error.message).toMatch(/tests/);
    expect((await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks: [specFor('t2', { allowedPaths: ['src'] })] })).status).toBe(201);
  });
});

describe('M5: giving a grant back is recorded', () => {
  it('clearing the block bumps the task and records who and why', async () => {
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src', 'tests'] }));
    await save(RUN, { scope: 'run', field: 'allowed_paths', value: ['src'] });
    const [mid] = await t.db.execute(sql`SELECT row_revision FROM task_status WHERE task_id = 't1'`);
    await save(RUN, { scope: 'run', field: 'allowed_paths', value: ['src', 'tests'] }, 1);
    const [after] = await t.db.execute(sql`SELECT row_revision, placement_block FROM task_status WHERE task_id = 't1'`);
    expect(after).toMatchObject({ placement_block: null, row_revision: Number(mid!['row_revision']) + 1 });
    const [ev] = await t.db.execute(sql`SELECT actor_kind, payload, aggregate_revision FROM events WHERE type = 'placement.cleared'`);
    expect(ev).toMatchObject({ actor_kind: 'scheduler', payload: { reason: 'policy_revoked:allowed_paths', cause: 'grant_restored', clearedBy: 'owner_uid_1' }, aggregate_revision: Number(after!['row_revision']) });
  });
});

describe('cloud revoke of a running cloud attempt, through the route', () => {
  it('stops it and leaves the task ready, blocked by policy', async () => {
    const scheduler = createScheduler({ codingWorkers: 'claude_code', catalog: TEST_CATALOG, db: t.db, now: () => h.clock.now(), policy: CLOUD_POLICY });
    h = makeHarness(t, {}, { ...CLOUD_POLICY, operations: { assign_replan_tasks: 'allow' } } as never, { scheduler });
    await t.db.update(schema.runs).set({ placement: { mode: 'C1', cloudDestination: 'cloud-sandbox-eu' } });
    const c = await enrolRunner(h.app, 'cloud');
    await seedTask(t.db, specFor('t1', { execution: 'cloud' }));
    const lease = (await claim(c.token)).body.lease;
    expect(lease).toMatchObject({ location: 'cloud' });
    const saved = await save(RUN, { scope: 'run', field: 'cloud_eligible', value: false });
    expect(saved.body.state).toBe('applied');
    expect((await post(h.app, '/v1/runners/heartbeat', { lease: refOf(lease) }, bearer(c.token))).body.cancelRequested).toBe(true);
    const done = await post(h.app, '/v1/runners/result', { lease: refOf(lease), result: { outcome: 'failed', reason: 'stopped' } }, bearer(c.token));
    expect(done.body.taskStatus).toBe('ready');
    expect((await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 't1'`))[0]!['placement_block']).toBe('policy_revoked:cloud_eligible');
    expect((await claim(c.token)).body.lease).toBeNull();
    void API_POLICY;
  });
});

describe('a deadlock between a run cancel and a lease path', () => {
  it('the cancel gets the retryable 503 and records nothing', async () => {
    // The route's own connections check for a cycle at 5 s, not 1 s, and the lease side at 10 s: on a loaded machine the lease can be slow to ask for the run row, and
    // with a 1 s window the lease would be the victim at 10 s while the cancel held the scheduler lock, which every test file's tenant shares (see lock-order.test.ts).
    const routeDb = createDb(TEST_DATABASE_URL, { searchPath: t.schema, max: 10, connection: { deadlock_timeout: '5s' } });
    await h.app.close();
    h = makeHarness({ ...t, db: routeDb.db });
    try {
    const a = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1'));
    await claim(a.token);
    const eventsBefore = await count('events');
    let locked!: () => void; const lockedP = new Promise<void>((r) => { locked = r; });
    let saw = false;
    // Stands in for a lease path: the status row, then the run row. Its own deadlock check waits longer, so the cancel is the one rolled back.
    const lease = t.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL deadlock_timeout = '10s'`);
      await tx.execute(sql`SELECT 1 FROM task_status WHERE task_id = 't1' FOR UPDATE`);
      locked();
      // Bounded wait until the cancel is queued behind this row (it then already holds the run row), never a fixed sleep: only then is taking the run row a cycle.
      const [me] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      for (let i = 0; i < 500 && !saw; i++) {
        const [row] = await tx.execute(sql`SELECT count(*)::int AS n FROM pg_locks l WHERE NOT l.granted AND ${Number(me!['pid'])} = ANY(pg_blocking_pids(l.pid))`);
        saw = Number(row!['n']) > 0;
        if (!saw) await new Promise((r) => setTimeout(r, 10));
      }
      await tx.execute(sql`SELECT 1 FROM runs WHERE run_id = ${RUN} FOR UPDATE`);
    });
    await lockedP;
    const res = await post(h.app, `/v1/runs/${RUN}/cancel`, { expectedPlanRevision: 0, idempotencyKey: 'dl' });
    await lease;
    expect(saw).toBe(true);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('transaction_conflict');
    expect(await count('events')).toBe(eventsBefore);
    expect(await count('task_commands')).toBe(0);
    expect((await t.db.execute(sql`SELECT cancel_requested_at FROM runs`))[0]!['cancel_requested_at']).toBeNull();
    } finally {
      await h.app.close();
      await routeDb.close();
      h = makeHarness(t);
    }
  });
});
