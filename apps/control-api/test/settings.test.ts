import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { API_POLICY, PROJECT, RUN, bearer, enrolRunner, get, makeHarness, owner, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';
import { finishCancelledRuns } from '../src/settings.ts';

let t: TestDb;
let h: Harness;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await h?.app.close(); await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`DELETE FROM runners`);
  h = makeHarness(t);
});

const settingsUrl = `/v1/projects/${PROJECT}/settings`;
const save = (key: string, change: Record<string, unknown>, expectedRevision = 0, idempotencyKey = `k-${Math.random()}`) => post(h.app, settingsUrl, { key, change, expectedRevision, idempotencyKey });
const snapshot = async () => (await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body;
const settingOf = async (scope: string, key: string, field: string) => (await snapshot()).settings.find((s: any) => s.scope === scope && s.key === key && s.field === field);
const claim = (token: string, config?: { revision: number; slots: number }) => post(h.app, '/v1/runners/claim', config ? { config } : {}, bearer(token));
const events = async (type: string) => (await t.db.execute(sql`SELECT actor_kind, actor_id, payload, run_id, task_id FROM events WHERE type = ${type} ORDER BY sequence`));
const refOf = (lease: any) => ({ attemptId: lease.attemptId, fence: lease.fence, leaseToken: lease.leaseToken });

describe('a save is not shown as applied until the enforcer acknowledges it', () => {
  it('a worker model change stays applying until every recent runner acknowledges the config that carries it', async () => {
    const r = await enrolRunner(h.app);
    // A runner on a build that acknowledges says so from its first poll.
    await claim(r.token, { revision: 0, slots: 2 });
    await seedTask(t.db, specFor('t1'));
    const saved = await post(h.app, `/v1/projects/${PROJECT}/model-assignments`, { scope: 'role', key: 'backend', selection: { provider: 'anthropic', model: 'claude-opus-5-5' }, expectedRevision: 0, idempotencyKey: 'm1' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ revision: 1, appliesTo: 'next_attempt', state: 'applying' });
    let snap = await snapshot();
    expect(snap.modelAssignments.find((a: any) => a.key === 'backend')).toMatchObject({ revision: 1, state: 'applying' });
    // The runner is told the new config on its next poll, and acknowledges it on the one after.
    const first = await claim(r.token);
    expect(first.body.config).toMatchObject({ revision: saved.body.configRevision, enabled: true, slots: null, pausedRunIds: [] });
    snap = await snapshot();
    expect(snap.modelAssignments.find((a: any) => a.key === 'backend').state).toBe('applying');
    await claim(r.token, { revision: first.body.config.revision, slots: 2 });
    snap = await snapshot();
    expect(snap.modelAssignments.find((a: any) => a.key === 'backend')).toMatchObject({ state: 'applied' });
    const applied = await events('settings.applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ actor_kind: 'system', payload: { scope: 'assignment', key: 'role:backend', revision: 1 } });
    const changed = await events('settings.changed');
    expect(changed[0]).toMatchObject({ actor_kind: 'human', actor_id: 'owner_uid_1', payload: { scope: 'assignment', key: 'role:backend', from: null, to: { provider: 'anthropic', model: 'claude-opus-5-5' } } });
  });

  it("a worker's slots apply when that runner acknowledges, and the server enforces them from the save", async () => {
    const r = await enrolRunner(h.app);
    await claim(r.token, { revision: 0, slots: 2 });
    await seedTask(t.db, specFor('t1'));
    await seedTask(t.db, specFor('t2'));
    const saved = await save(r.runnerId, { scope: 'runner', field: 'slots', value: 1 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ state: 'applying', desiredRevision: 1, effectiveRevision: 0 });
    expect(await settingOf('runner', r.runnerId, 'slots')).toMatchObject({ desired: 1, effective: null, desiredRevision: 1, effectiveRevision: 0, state: 'applying', enforcer: 'runner', updatedBy: 'owner_uid_1' });
    const first = await claim(r.token);
    expect(first.body.lease).not.toBeNull();
    expect(first.body.config.slots).toBe(1);
    // A second slot gets nothing, whatever the runner has acknowledged.
    expect((await claim(r.token)).body).toMatchObject({ lease: null, reason: 'runner_slots_full' });
    await post(h.app, '/v1/runners/heartbeat', { lease: refOf(first.body.lease), config: { revision: first.body.config.revision, slots: 1 } }, bearer(r.token));
    expect(await settingOf('runner', r.runnerId, 'slots')).toMatchObject({ desired: 1, effective: 1, effectiveRevision: 1, state: 'applied' });
  });

  it('with no runner connected, a runner-acknowledged change waits for one and says so', async () => {
    await save(RUN, { scope: 'run', field: 'paused', value: true });
    expect(await settingOf('run', RUN, 'paused')).toMatchObject({ desired: true, state: 'waiting_for_runner' });
  });

  it('refuses a stale revision and replays an idempotency key', async () => {
    const r = await enrolRunner(h.app);
    expect((await save(r.runnerId, { scope: 'runner', field: 'enabled', value: false }, 0, 'same')).status).toBe(200);
    expect((await save(r.runnerId, { scope: 'runner', field: 'enabled', value: false }, 0, 'same')).status).toBe(200);
    const stale = await save(r.runnerId, { scope: 'runner', field: 'enabled', value: true }, 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'stale_revision', details: { currentRevision: 1 } });
    expect((await events('settings.changed'))).toHaveLength(1);
  });

  it('needs the owner', async () => {
    const r = await enrolRunner(h.app);
    const res = await post(h.app, settingsUrl, { key: RUN, change: { scope: 'run', field: 'paused', value: true }, expectedRevision: 0, idempotencyKey: 'x' }, bearer(r.token));
    expect(res.status).toBe(403);
  });
});

describe('a revoke blocks the next claim in the save itself', () => {
  it('removing an allowed path blocks the task that needs it before any runner polls, and its effective revision is the server\'s', async () => {
    const r = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src', 'tests'] }));
    const saved = await save(RUN, { scope: 'run', field: 'allowed_paths', value: ['src'] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ state: 'applied', desiredRevision: 1, effectiveRevision: 1 });
    const [row] = await t.db.execute(sql`SELECT placement_block FROM task_status WHERE task_id = 't1'`);
    expect(row!['placement_block']).toBe('policy_revoked:allowed_paths');
    expect((await claim(r.token)).body.lease).toBeNull();
    expect(await settingOf('run', RUN, 'allowed_paths')).toMatchObject({ desired: ['src'], effective: ['src'], state: 'applied', enforcer: 'server' });
    const changed = await events('settings.changed');
    expect(changed[0]!['payload']).toMatchObject({ field: 'allowed_paths', from: ['src', 'tests'], to: ['src'], blocked: ['t1'] });
    // Given back, the task is claimable again.
    await save(RUN, { scope: 'run', field: 'allowed_paths', value: ['src', 'tests'] }, 1);
    expect((await claim(r.token)).body.lease).toMatchObject({ taskId: 't1' });
  });

  it('a save waits for a claim already in flight and every later claim reads it: the two never interleave', async () => {
    const r = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src', 'tests'] }));
    // Stands in for a claim holding the scheduler lock: the save cannot commit until it is done.
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let locked!: () => void;
    const lockedP = new Promise<void>((res) => { locked = res; });
    const inFlight = t.db.transaction(async (tx) => { await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'selarikru.scheduler:tenant_a'}, 0))`); locked(); await held; });
    await lockedP;
    let saved = false;
    const saving = save(RUN, { scope: 'run', field: 'allowed_paths', value: ['src'] }).then((x) => { saved = true; return x; });
    await new Promise((res) => setTimeout(res, 150));
    expect(saved).toBe(false);
    release();
    await inFlight;
    expect((await saving).status).toBe(200);
    expect((await claim(r.token)).body.lease).toBeNull();
  });

  it('a path the plan never listed cannot be granted by a setting', async () => {
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src'] }));
    const res = await save(RUN, { scope: 'run', field: 'allowed_paths', value: ['src', 'infra'] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('outside_plan_scope');
  });

  it('a running attempt that needs a removed path is told to stop and ends blocked by policy', async () => {
    const r = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src', 'tests'] }));
    const lease = (await claim(r.token)).body.lease;
    const saved = await save(RUN, { scope: 'run', field: 'allowed_paths', value: ['src'] });
    expect((await events('settings.changed'))[0]!['payload']).toMatchObject({ stopping: ['t1'] });
    const snap = await snapshot();
    expect(snap.tasks.find((x: any) => x.taskId === 't1').cancel).toMatchObject({ state: 'cancel_requested', reason: 'policy_revoked:allowed_paths' });
    const hb = await post(h.app, '/v1/runners/heartbeat', { lease: refOf(lease) }, bearer(r.token));
    expect(hb.body.cancelRequested).toBe(true);
    const done = await post(h.app, '/v1/runners/result', { lease: refOf(lease), result: { outcome: 'failed', reason: 'stopped' } }, bearer(r.token));
    expect(done.body.taskStatus).toBe('ready');
    expect(saved.status).toBe(200);
  });

  it('an owner cancel of a task already stopping for a revoke ends it cancelled, not blocked', async () => {
    const r = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src', 'tests'] }));
    const lease = (await claim(r.token)).body.lease;
    await save(RUN, { scope: 'run', field: 'allowed_paths', value: ['src'] });
    const [st] = await t.db.execute(sql`SELECT row_revision FROM task_status WHERE task_id = 't1'`);
    const cancel = await post(h.app, '/v1/tasks/t1/commands', { command: 'cancel', expectedRevision: Number(st!['row_revision']), idempotencyKey: 'own' });
    expect(cancel.body.state).toBe('cancel_requested');
    const done = await post(h.app, '/v1/runners/result', { lease: refOf(lease), result: { outcome: 'failed', reason: 'stopped' } }, bearer(r.token));
    expect(done.body.taskStatus).toBe('cancelled');
  });

  it('disabling a worker refuses its next claim at once and lets its current attempt finish', async () => {
    const r = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1'));
    await seedTask(t.db, specFor('t2'));
    const lease = (await claim(r.token)).body.lease;
    await save(r.runnerId, { scope: 'runner', field: 'enabled', value: false });
    expect((await claim(r.token)).body).toMatchObject({ lease: null, reason: 'runner_disabled', config: { enabled: false } });
    const hb = await post(h.app, '/v1/runners/heartbeat', { lease: refOf(lease) }, bearer(r.token));
    expect(hb.body.cancelRequested).toBe(false);
  });

  it('lowering the budget below what is committed stops running work through the budget stop', async () => {
    const r = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1', { maxCostUsd: 5 }));
    await claim(r.token);
    const res = await save(RUN, { scope: 'run', field: 'budget_limit_usd', value: 1 });
    expect(res.status).toBe(200);
    const [row] = await t.db.execute(sql`SELECT budget FROM runs`);
    expect(row!['budget']).toMatchObject({ limitUsd: 1 });
    const [cmd] = await t.db.execute(sql`SELECT state, detail FROM task_commands`);
    expect(cmd).toMatchObject({ state: 'cancel_requested', detail: { reason: 'budget_exhausted' } });
  });

  it('cloud cannot be granted to a run that was never placed in the cloud', async () => {
    const res = await save(RUN, { scope: 'run', field: 'cloud_eligible', value: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('outside_recorded_limits');
  });
});

describe('pause and resume', () => {
  it('pause blocks claims at once, reads as requested until every recent runner acknowledges on heartbeat, then paused; running work continues', async () => {
    const r = await enrolRunner(h.app);
    await claim(r.token, { revision: 0, slots: 2 });
    await seedTask(t.db, specFor('t1'));
    await seedTask(t.db, specFor('t2'));
    const lease = (await claim(r.token)).body.lease;
    const saved = await save(RUN, { scope: 'run', field: 'paused', value: true });
    expect(saved.body).toMatchObject({ state: 'applying' });
    expect(await settingOf('run', RUN, 'paused')).toMatchObject({ desired: true, effective: null, state: 'applying' });
    const hb = await post(h.app, '/v1/runners/heartbeat', { lease: refOf(lease) }, bearer(r.token));
    expect(hb.body.cancelRequested).toBe(false);
    expect(hb.body.config).toMatchObject({ revision: saved.body.configRevision, pausedRunIds: [RUN] });
    expect((await claim(r.token)).body.lease).toBeNull();
    await post(h.app, '/v1/runners/heartbeat', { lease: refOf(lease), config: { revision: hb.body.config.revision, slots: 2 } }, bearer(r.token));
    expect(await settingOf('run', RUN, 'paused')).toMatchObject({ desired: true, effective: true, state: 'applied' });
    expect((await events('settings.applied'))[0]!['payload']).toMatchObject({ scope: 'run', key: RUN, field: 'paused', value: true });
  });

  it('resume revalidates the budget and leases before any claim is granted', async () => {
    const r = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1', { maxCostUsd: 1 }));
    await save(RUN, { scope: 'run', field: 'paused', value: true });
    // A budget that is used up refuses the resume, and nothing is recorded.
    await t.db.update(schema.runs).set({ budget: { limitUsd: 0 } });
    const refused = await save(RUN, { scope: 'run', field: 'paused', value: false }, 1);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'resume_refused', details: { reason: 'budget:exhausted' } });
    await t.db.update(schema.runs).set({ budget: { limitUsd: 100 } });
    // A lease that has lapsed but not been reconciled refuses it too.
    await t.db.execute(sql`INSERT INTO attempts (tenant_id, project_id, attempt_id, task_id, revision, attempt_number, runner, lease_fence, lease_token, last_heartbeat_at, lease_expires_at, deadline_at, started_at, outcome)
      VALUES ('tenant_a', ${PROJECT}, 'att_old', 't1', 1, 1, ${r.runnerId}, 1, 'tok', ${h.clock.now().toISOString()}::timestamptz - interval '5 minutes', ${h.clock.now().toISOString()}::timestamptz - interval '4 minutes', ${h.clock.now().toISOString()}::timestamptz + interval '1 hour', ${h.clock.now().toISOString()}::timestamptz - interval '5 minutes', 'running')`);
    const lapsed = await save(RUN, { scope: 'run', field: 'paused', value: false }, 1);
    expect(lapsed.body.error).toMatchObject({ code: 'resume_refused', details: { reason: 'lease_unreconciled' } });
    await t.db.execute(sql`DELETE FROM attempts`);
    const ok = await save(RUN, { scope: 'run', field: 'paused', value: false }, 1);
    expect(ok.status).toBe(200);
    expect((await claim(r.token)).body.lease).toMatchObject({ taskId: 't1' });
  });
});

describe('cancel run', () => {
  it('stops running work, cancels the rest, revokes unused grants, and reads as requested until the attempt has ended', async () => {
    const r = await enrolRunner(h.app);
    await seedTask(t.db, specFor('t1'));
    await seedTask(t.db, specFor('t2'), 'planned');
    const lease = (await claim(r.token)).body.lease;
    await t.db.insert(schema.approvals).values({ tenantId: 'tenant_a', projectId: PROJECT, approvalId: 'apr_1', runId: RUN, taskId: 't2', revision: 1, requester: 'x', scopeHash: 'h', actionHash: 'a', outcome: 'granted', detail: {} });
    const res = await post(h.app, `/v1/runs/${RUN}/cancel`, { expectedPlanRevision: 0, idempotencyKey: 'c1' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'cancel_requested', stopping: ['t1'], cancelled: ['t2'], revokedGrants: ['apr_1'] });
    let snap = await snapshot();
    expect(snap.runs[0]).toMatchObject({ lifecycle: 'running', cancel: { requestedBy: 'owner_uid_1' } });
    expect(snap.tasks.find((x: any) => x.taskId === 't2').status).toBe('cancelled');
    const [grant] = await t.db.execute(sql`SELECT outcome, expires_at FROM approvals WHERE approval_id = 'apr_1'`);
    expect(grant!['outcome']).toBe('granted');
    expect(grant!['expires_at']).not.toBeNull();
    // Nothing more is claimed for it.
    expect((await claim(r.token)).body.lease).toBeNull();
    await finishCancelledRuns({ db: t.db, tenantId: 'tenant_a', now: h.clock.now });
    expect((await snapshot()).runs[0].lifecycle).toBe('running');
    await post(h.app, '/v1/runners/result', { lease: refOf(lease), result: { outcome: 'completed', headSha: 'a'.repeat(40) } }, bearer(r.token));
    snap = await snapshot();
    expect(snap.runs[0].lifecycle).toBe('cancelled');
    expect(snap.tasks.find((x: any) => x.taskId === 't1').status).toBe('cancelled');
    expect((await events('run.cancel_requested'))[0]).toMatchObject({ actor_kind: 'human', actor_id: 'owner_uid_1' });
    expect((await events('run.cancelled'))[0]).toMatchObject({ actor_kind: 'system' });
    // History is kept.
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM attempts`))[0]!['n'])).toBe(1);
    const [hold] = await t.db.execute(sql`SELECT state FROM budget_reservations`);
    expect(hold!['state']).not.toBe('reserved');
  });

  it('a run with nothing running is cancelled at once; a closed run cannot be', async () => {
    await seedTask(t.db, specFor('t1'));
    const res = await post(h.app, `/v1/runs/${RUN}/cancel`, { expectedPlanRevision: 0, idempotencyKey: 'c1' });
    expect(res.body).toMatchObject({ state: 'applied' });
    expect((await snapshot()).runs[0].lifecycle).toBe('cancelled');
    const again = await post(h.app, `/v1/runs/${RUN}/cancel`, { expectedPlanRevision: 0, idempotencyKey: 'c2' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('run_closed');
  });
});

describe('bounded autonomy', () => {
  it('the snapshot states the effective policy, each value labelled configured, recommended or unresolved', async () => {
    await seedTask(t.db, specFor('t1', { allowedPaths: ['src', 'tests'] }));
    const policy = (await snapshot()).runs[0].policy;
    expect(policy).toMatchObject({
      allowedPaths: { value: ['src', 'tests'], basis: 'configured' },
      cloudEligible: { value: false, basis: 'configured' },
      maxConcurrentWorkers: { value: 2, basis: 'configured' },
      repairAttempts: { value: 2, basis: 'configured' },
      budgetLimitUsd: { value: 1000, basis: 'configured' },
      merge: { value: 'human', basis: 'configured' },
    });
    await t.db.update(schema.runs).set({ budget: {} });
    expect((await snapshot()).runs[0].policy.budgetLimitUsd).toMatchObject({ value: null, basis: 'unresolved' });
    const none = makeHarness(t, {}, { ...API_POLICY, limits: {} } as never);
    const p2 = (await (await none.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() })).json()).runs[0].policy;
    expect(p2.repairAttempts).toMatchObject({ value: null, basis: 'unresolved' });
  });
});
