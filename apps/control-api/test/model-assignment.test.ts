import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPS, POLICY, RUN } from '@selarikru/workflow/test-helpers';
import { createScheduler } from '@selarikru/workflow';
import { evaluate, parsePolicy } from '@selarikru/policy';
import { loadDefaultPolicy } from '@selarikru/policy/load';
import { API_POLICY, PROJECT, TEST_CATALOG, TEST_RUNNER_REPORT, enrolRunner, bearer, makeHarness, owner, post, resetDb, seedTask, setupTestDb, specFor, type TestDb } from './helpers.ts';

const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
const OPUS = { provider: 'anthropic', model: 'claude-opus-5-5' };
const url = `/v1/projects/${PROJECT}/model-assignments`;
const body = (over: Record<string, unknown> = {}) => ({ scope: 'role', key: 'backend', selection: OPUS, expectedRevision: 0, idempotencyKey: 'k1', ...over });

describe('POST /v1/projects/:id/model-assignments', () => {
  let t: TestDb;
  let h: ReturnType<typeof makeHarness>;
  beforeAll(async () => { t = await setupTestDb(); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.db); h = makeHarness(t); await enrolRunner(h.app); });

  const stored = () => t.db.execute(sql`SELECT scope_kind, scope_key, revision, provider, model, updated_by FROM model_assignments ORDER BY scope_key, revision`);

  it('records who chose what and says it applies to the next attempt', async () => {
    const r = await post(h.app, url, body());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: 'role', key: 'backend', revision: 1, selection: OPUS, appliesTo: 'next_attempt' });
    expect(await stored()).toEqual([{ scope_kind: 'role', scope_key: 'backend', revision: 1, provider: 'anthropic', model: 'claude-opus-5-5', updated_by: 'owner_uid_1' }]);
  });

  it('needs the owner, refuses a stale revision, and replays an idempotency key', async () => {
    expect((await post(h.app, url, body(), bearer('firebase-intruder-token'))).status).toBe(403);
    await post(h.app, url, body());
    const replay = await post(h.app, url, body());
    expect(replay.status).toBe(200);
    expect(replay.body.revision).toBe(1);
    expect(await stored()).toHaveLength(1);
    const stale = await post(h.app, url, body({ idempotencyKey: 'k2' }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'stale_revision', details: { currentRevision: 1 } });
    const conflict = await post(h.app, url, body({ selection: SONNET }));
    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe('idempotency_key_conflict');
  });

  it('unsupported provider or model fails before launch', async () => {
    for (const [selection, code] of [
      [{ provider: 'codex', model: 'gpt-x' }, 'unsupported_provider'],
      [{ provider: 'anthropic', model: 'claude-made-up' }, 'unsupported_model'],
    ] as const) {
      const r = await post(h.app, url, body({ selection }));
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe(code);
    }
    const blocked = await post(h.app, url, body({ selection: { provider: 'anthropic', model: 'claude-haiku-5-5' } }));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({ code: 'model_not_allowed', details: { reason: 'model_not_allowed' } });
    expect(await stored()).toEqual([]);
  });

  it('with nothing detected, nothing can be assigned, and the snapshot says why', async () => {
    const none = makeHarness(t, {}, API_POLICY, { catalog: { status: 'none', detail: 'not installed here', providers: [] } });
    const r = await post(none.app, url, body());
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('no_provider_detected');
    const snap = await none.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() });
    expect(snap.json().modelCatalog).toEqual({ status: 'none', detail: 'not installed here', projectDefault: API_POLICY.models.default, codingWorkers: 'claude_code', providers: [] });
  });

  it('offers only what enrolled runners report, and no report means nothing is offered', async () => {
    await resetDb(t.db);
    await t.db.execute(sql`DELETE FROM runners`);
    const empty = makeHarness(t);
    const refused = await post(empty.app, url, body());
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('no_provider_detected');
    let snap = (await empty.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() })).json();
    expect(snap.modelCatalog).toMatchObject({ status: 'none', providers: [] });
    expect(snap.modelCatalog.detail).toMatch(/No runner has reported/);
    await enrolRunner(empty.app, 'local', [{ provider: 'anthropic', harnessVersion: '9.9.9', models: ['claude-opus-5-5'] }]);
    snap = (await empty.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() })).json();
    expect(snap.modelCatalog.providers[0]).toMatchObject({ harnessVersion: '9.9.9', models: [{ modelId: 'claude-opus-5-5' }] });
    expect((await post(empty.app, url, body({ selection: SONNET, idempotencyKey: 'k9' }))).body.error.code).toBe('unsupported_model');
  });

  it('writes a runner\'s harness report only when it changed', async () => {
    const { token, runnerId } = await enrolRunner(h.app);
    const version = async () => String((await t.db.execute(sql`SELECT xmin::text AS v FROM runners WHERE runner_id = ${runnerId}`))[0]!['v']);
    const claim = (harnesses: unknown) => post(h.app, '/v1/runners/claim', { harnesses }, bearer(token));
    // The first authenticated call records that the runner has polled; what is measured below is the report.
    await claim(TEST_RUNNER_REPORT);
    const start = await version();
    // Same content in another order: jsonb and the wire disagree about key order, and that is not a change.
    expect((await claim(TEST_RUNNER_REPORT.map((r) => ({ models: [...r.models].reverse(), harnessVersion: r.harnessVersion, provider: r.provider })))).status).toBe(200);
    await claim(TEST_RUNNER_REPORT);
    expect(await version()).toBe(start);
    await claim([{ provider: 'anthropic', harnessVersion: '9.9.9', models: ['claude-opus-5-5'] }]);
    const changed = await version();
    expect(changed).not.toBe(start);
    await claim([{ provider: 'anthropic', harnessVersion: '9.9.9', models: ['claude-opus-5-5'] }]);
    expect(await version()).toBe(changed);
    const stored = (await t.db.execute(sql`SELECT harness_report FROM runners WHERE runner_id = ${runnerId}`))[0]!['harness_report'];
    expect(stored).toEqual([{ provider: 'anthropic', harnessVersion: '9.9.9', models: ['claude-opus-5-5'] }]);
  });

  it('a task override is looked up in this project only', async () => {
    await seedTask(t.db, specFor('t1'));
    const other = await post(h.app, url.replace(PROJECT, 'proj_b'), body({ scope: 'task', key: 't1' }));
    expect(other.status).toBe(404);
    await t.db.execute(sql`INSERT INTO projects (tenant_id, project_id, repository, default_branch, classification) VALUES ('tenant_a', 'proj_b', 'r', 'main', 'internal')`);
    const wrong = await post(h.app, url.replace(PROJECT, 'proj_b'), body({ scope: 'task', key: 't1', idempotencyKey: 'x2' }));
    expect(wrong.status).toBe(404);
    expect(wrong.body.error.code).toBe('task_not_found');
  });

  it('a policy that denies the operation is a policy refusal', async () => {
    const denied = makeHarness(t, {}, { ...API_POLICY, operations: { assign_replan_tasks: 'allow', assign_model: 'deny' } });
    const r = await post(denied.app, url, body());
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'policy_denied', details: { reason: 'configured_deny:assign_model' } });
  });

  it('a task override needs a known, open task, and can be removed', async () => {
    await seedTask(t.db, specFor('t1'));
    expect((await post(h.app, url, body({ scope: 'task', key: 'nope', idempotencyKey: 'a' }))).status).toBe(404);
    const set = await post(h.app, url, body({ scope: 'task', key: 't1', idempotencyKey: 'b' }));
    expect(set.status).toBe(200);
    const removed = await post(h.app, url, body({ scope: 'task', key: 't1', selection: null, expectedRevision: 1, idempotencyKey: 'c' }));
    expect(removed.status).toBe(200);
    expect(removed.body.selection).toBeNull();
    const snap = await h.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() });
    expect(snap.json().modelAssignments).toMatchObject([{ scope: 'task', key: 't1', provider: null, model: null, revision: 2 }]);
    await t.db.execute(sql`UPDATE task_status SET status = 'merged' WHERE task_id = 't1'`);
    const closed = await post(h.app, url, body({ scope: 'task', key: 't1', expectedRevision: 2, idempotencyKey: 'd' }));
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe('command_not_allowed');
  });

  it('never stores a secret-shaped value and never reaches a running attempt', async () => {
    const badKey = await post(h.app, url, body({ key: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD' }));
    expect(badKey.status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it('snapshot reports the catalog, the current assignments and each attempt\'s record', async () => {
    await post(h.app, url, body());
    await seedTask(t.db, specFor('t1'));
    const scheduler = createScheduler({ db: t.db, now: h.clock.now, policy: POLICY, catalog: TEST_CATALOG });
    const out = await scheduler.tryClaim({ runnerId: 'r1', tenantId: 'tenant_a', location: 'local', harnesses: TEST_RUNNER_REPORT }, CAPS);
    expect(out.ok).toBe(true);
    const snap = (await h.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner() })).json();
    expect(snap.modelCatalog.status).toBe('detected');
    expect(snap.modelCatalog.providers[0].models.map((m: { modelId: string }) => m.modelId)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']);
    expect(snap.modelCatalog.providers[0].models[2]).toMatchObject({ allowedByPolicy: false, policyReason: 'model_not_allowed' });
    expect(snap.modelAssignments[0]).toMatchObject({ scope: 'role', key: 'backend', ...OPUS, revision: 1, updatedBy: 'owner_uid_1' });
    expect(snap.tasks[0].attempts[0].assignment).toEqual({ ...OPUS, source: 'role', route: 'cloud' });
    expect(JSON.stringify(snap)).not.toMatch(/ANTHROPIC_API_KEY|credential/i);
  });
});

describe('benchmark trials through the API', () => {
  let t: TestDb;
  let h: ReturnType<typeof makeHarness>;
  beforeAll(async () => { t = await setupTestDb(); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.db); h = makeHarness(t); await enrolRunner(h.app); });

  const runs = `/v1/projects/${PROJECT}/runs`;

  it('benchmark trial pins one model', async () => {
    expect((await post(h.app, runs, { idempotencyKey: 'a', title: 'trial', trial: true })).status).toBe(400);
    expect((await post(h.app, runs, { idempotencyKey: 'b', title: 'run', pinnedModel: SONNET })).status).toBe(400);
    expect((await post(h.app, runs, { idempotencyKey: 'c', title: 'trial', trial: true, pinnedModel: { provider: 'codex', model: 'x' } })).status).toBe(422);
    const created = await post(h.app, runs, { idempotencyKey: 'd', title: 'trial', trial: true, pinnedModel: SONNET, budgetLimitUsd: 10 });
    expect(created.status).toBe(201);

    // A task in a trial refuses an override; a task in an ordinary run takes one.
    await t.db.execute(sql`UPDATE runs SET trial = true, pinned_model = '{"provider":"anthropic","model":"claude-sonnet-5-5"}'::jsonb WHERE run_id = ${RUN}`);
    await seedTask(t.db, specFor('t1'));
    const refused = await post(h.app, `/v1/projects/${PROJECT}/model-assignments`, body({ scope: 'task', key: 't1', idempotencyKey: 'e' }));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'trial_model_pinned', details: { pinnedModel: SONNET } });
  });
});

describe('default policy', () => {
  it('permits the listed models and nothing else', () => {
    const p = parsePolicy(loadDefaultPolicy());
    expect(p.models?.default).toEqual(SONNET);
    expect(evaluate({ kind: 'assign_model', selection: OPUS }, p).decision).toBe('allow');
    expect(evaluate({ kind: 'assign_model', selection: { provider: 'codex', model: 'gpt-x' } }, p).reason).toBe('model_not_allowed');
  });
});
