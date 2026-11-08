import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INTRUDER_TOKEN, OWNER_UID, call, PROJECT, RUN, bearer, enrolRunner, get, makeHarness, owner, post, resetDb, seedTask, setupTestDb, specFor,
  type Harness, type TestDb,
} from './helpers.ts';

let t: TestDb;
let h: Harness;

beforeAll(async () => {
  t = await setupTestDb();
  h = makeHarness(t);
  await h.app.ready();
});
afterAll(async () => {
  await h.app.close();
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
});

const taskStatus = async (id: string) => (await t.db.execute(sql`SELECT status, row_revision FROM task_status WHERE task_id = ${id}`))[0]!;
const countEvents = async () => Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM events`))[0]!['n']);

const OWNER_ROUTES: [string, string][] = [
  ['POST', `/v1/projects/${PROJECT}/runs`],
  ['POST', `/v1/runs/${RUN}/plan-revisions`],
  ['POST', '/v1/tasks/t1/commands'],
  ['POST', '/v1/tasks/t1/client-reports'],
  ['POST', '/v1/approvals/a1/resolve'],
  ['GET', `/v1/projects/${PROJECT}/snapshot`],
  ['GET', `/v1/projects/${PROJECT}/events?after=0`],
  ['POST', '/v1/runners/pairing-codes'],
];
const RUNNER_ROUTES: [string, string][] = [
  ['POST', '/v1/runners/claim'],
  ['POST', '/v1/runners/heartbeat'],
  ['POST', '/v1/runners/result'],
];
const ENROLL: [string, string] = ['POST', '/v1/runners/enroll'];

describe('authentication', () => {
  it('no token → 401 on every route', async () => {
    const all = [...OWNER_ROUTES, ...RUNNER_ROUTES, ENROLL];
    // The table above must cover every registered /v1 route, so a new route cannot ship unchecked.
    const registered = h.app.routeTable.filter((r) => r.url.startsWith('/v1/')).map((r) => `${r.method} ${r.url}`);
    const normalise = (u: string) => u.replace(/\?.*$/, '').replace(/\/(proj_a|run_a|t1|a1)\b/g, '/:id');
    const covered = new Set(all.map(([m, u]) => `${m} ${normalise(u)}`));
    for (const r of registered) expect(covered, `route ${r} missing from the 401 table`).toContain(r.replace(/:[a-zA-Z]+/g, ':id'));

    for (const [method, url] of all) {
      const res = await call(h.app, method as 'GET' | 'POST', url);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code).toBe('unauthenticated');
    }
  });

  it('an invalid owner token is 401, not an owner', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: bearer('garbage') });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_token');
  });

  it('non-owner → 403', async () => {
    for (const [method, url] of OWNER_ROUTES) {
      const res = await call(h.app, method as 'GET' | 'POST', url, bearer(INTRUDER_TOKEN));
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('not_owner');
    }
  });

  it('runner token cannot call owner routes, and an owner token cannot call runner routes', async () => {
    const { token } = await enrolRunner(h.app);
    for (const [method, url] of OWNER_ROUTES) {
      const res = await call(h.app, method as 'GET' | 'POST', url, bearer(token));
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('wrong_principal_type');
    }
    for (const [method, url] of RUNNER_ROUTES) {
      const res = await call(h.app, method as 'GET' | 'POST', url, owner());
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('wrong_principal_type');
    }
  });
});

describe('runner enrolment', () => {
  it('exchanges a one-time pairing code for a scoped token, both hashed at rest', async () => {
    const code = await post(h.app, '/v1/runners/pairing-codes', { location: 'cloud' });
    expect(code.status).toBe(201);
    const pairingCode: string = code.body.pairingCode;
    const stored = await t.db.execute(sql`SELECT code_hash, used_at FROM runner_pairing_codes`);
    expect(JSON.stringify(stored)).not.toContain(pairingCode);

    const ok = await post(h.app, '/v1/runners/enroll', { label: 'laptop' }, bearer(pairingCode));
    expect(ok.status).toBe(201);
    expect(ok.body.location).toBe('cloud');
    const runners = await t.db.execute(sql`SELECT * FROM runners WHERE runner_id = ${ok.body.runnerId}`);
    expect(JSON.stringify(runners)).not.toContain(ok.body.token);
    expect(runners[0]!['location']).toBe('cloud');

    const again = await post(h.app, '/v1/runners/enroll', {}, bearer(pairingCode));
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('invalid_pairing_code');
  });

  it('refuses an expired pairing code', async () => {
    const code = await post(h.app, '/v1/runners/pairing-codes', { location: 'local' });
    h.clock.advance(h.config.pairingCodeTtlSeconds + 1);
    const res = await post(h.app, '/v1/runners/enroll', {}, bearer(code.body.pairingCode));
    expect(res.status).toBe(401);
  });
});

describe('runs', () => {
  it('accepts a run idempotently and sets the budget from the request', async () => {
    const body = { idempotencyKey: 'k1', title: 'Add voting', budgetLimitUsd: 12.5 };
    const a = await post(h.app, `/v1/projects/${PROJECT}/runs`, body);
    const b = await post(h.app, `/v1/projects/${PROJECT}/runs`, body);
    expect(a.status).toBe(201);
    expect(b.body.runId).toBe(a.body.runId);
    expect(a.body.budget).toEqual({ status: 'set', limitUsd: 12.5 });
    const rows = await t.db.execute(sql`SELECT budget FROM runs WHERE run_id = ${a.body.runId}`);
    expect(rows[0]!['budget']).toEqual({ limitUsd: 12.5 });
    const ev = await t.db.execute(sql`SELECT actor_kind, actor_id, type FROM events WHERE run_id = ${a.body.runId}`);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_kind: 'human', actor_id: OWNER_UID, type: 'run.created' });
  });

  it('accepts a run without a budget and says claims are denied, with the reason', async () => {
    const r = await post(h.app, `/v1/projects/${PROJECT}/runs`, { idempotencyKey: 'k2', title: 'No budget' });
    expect(r.status).toBe(201);
    expect(r.body.budget).toEqual({ status: 'missing', limitUsd: null, claimsDenied: true, reason: 'missing_limit:budget.limitUsd' });
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.body.runs.find((x: any) => x.runId === r.body.runId).budget.status).toBe('missing');
  });

  it('takes the actor from the principal and rejects a body that tries to set it', async () => {
    const res = await post(h.app, `/v1/projects/${PROJECT}/runs`, { idempotencyKey: 'k3', title: 'x', actor: { kind: 'scheduler', id: 'evil' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(await countEvents()).toBe(0);
  });

  it('404s an unknown project', async () => {
    const res = await post(h.app, '/v1/projects/nope/runs', { idempotencyKey: 'k', title: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('project_not_found');
  });
});

describe('plan revisions', () => {
  it('validates and persists a DAG, bumping the plan revision; a stale expectedRevision is 409', async () => {
    const tasks = [specFor('pa'), specFor('pb', { dependencies: [{ taskId: 'pa', revision: 1, condition: 'artifact_verified' }] })];
    const ok = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks });
    expect(ok.status).toBe(201);
    expect(ok.body.planRevision).toBe(1);
    expect((await taskStatus('pb'))['status']).toBe('planned');
    const stale = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_revision');
  });

  it('rejects a cyclic plan with 422 and persists nothing', async () => {
    const tasks = [
      specFor('ca', { dependencies: [{ taskId: 'cb', revision: 1, condition: 'artifact_verified' }] }),
      specFor('cb', { dependencies: [{ taskId: 'ca', revision: 1, condition: 'artifact_verified' }] }),
    ];
    const res = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('plan_invalid');
    expect(res.body.error.details[0].kind).toBe('cycle');
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM task_revisions`))[0]!['n'])).toBe(0);
  });

  it('rejects a task for another tenant', async () => {
    const res = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks: [{ ...specFor('x1'), tenantId: 'other_tenant' }] });
    expect(res.status).toBe(422);
  });
});

describe('policy gate', () => {
  it('denies planning and retry when policy does not allow assign_replan_tasks', async () => {
    const strict = makeHarness(t, {}, { policyVersion: 'p', operations: { assign_replan_tasks: 'deny' } });
    await seedTask(t.db, specFor('t1'), 'failed');
    const plan = await post(strict.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks: [specFor('pz')] });
    expect(plan.status).toBe(403);
    expect(plan.body.error).toMatchObject({ code: 'policy_denied', details: { reason: 'configured:assign_replan_tasks' } });
    const retry = await post(strict.app, '/v1/tasks/t1/commands', { command: 'retry', expectedRevision: 0, idempotencyKey: 'pd1' });
    expect(retry.status).toBe(403);
    expect(retry.body.error.code).toBe('policy_denied');
    const missing = makeHarness(t, {}, null);
    expect((await post(missing.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 0, tasks: [specFor('pz')] })).body.error.details.reason).toBe('missing_policy');
    await strict.app.close();
    await missing.app.close();
  });
});

describe('task commands', () => {
  it('stale expected revision → 409', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const res = await post(h.app, '/v1/tasks/t1/commands', { command: 'cancel', expectedRevision: 9, idempotencyKey: 'c1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('stale_revision');
    expect(res.body.error.details).toMatchObject({ currentRevision: 0 });
    expect((await taskStatus('t1'))['status']).toBe('ready');
  });

  it('command returns 202 and operation ID', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const res = await post(h.app, '/v1/tasks/t1/commands', { command: 'cancel', expectedRevision: 0, idempotencyKey: 'c2' });
    expect(res.status).toBe(202);
    expect(res.body.operationId).toMatch(/^op_/);
    expect(res.body.state).toBe('applied');
    expect((await taskStatus('t1'))['status']).toBe('cancelled');
    const ev = await t.db.execute(sql`SELECT type, actor_kind, actor_id FROM events WHERE task_id = 't1'`);
    expect(ev[0]).toMatchObject({ type: 'task.cancelled', actor_kind: 'human', actor_id: OWNER_UID });
    const replay = await post(h.app, '/v1/tasks/t1/commands', { command: 'cancel', expectedRevision: 0, idempotencyKey: 'c2' });
    expect(replay.status).toBe(202);
    expect(replay.body.operationId).toBe(res.body.operationId);
    expect(await countEvents()).toBe(1);
  });

  it('reusing an idempotency key for a different command is rejected', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    await post(h.app, '/v1/tasks/t1/commands', { command: 'cancel', expectedRevision: 0, idempotencyKey: 'c3' });
    const res = await post(h.app, '/v1/tasks/t1/commands', { command: 'retry', expectedRevision: 0, idempotencyKey: 'c3' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_key_conflict');
  });

  it('cancel on a running task is only "requested": status stays running, and the request is visible', async () => {
    await seedTask(t.db, specFor('t1'), 'running');
    const res = await post(h.app, '/v1/tasks/t1/commands', { command: 'cancel', expectedRevision: 0, idempotencyKey: 'c4' });
    expect(res.status).toBe(202);
    expect(res.body.state).toBe('cancel_requested');
    expect(res.body.taskStatus).toBe('running');
    expect((await taskStatus('t1'))['status']).toBe('running');
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.body.tasks.find((x: any) => x.taskId === 't1')).toMatchObject({ status: 'running', cancel: { state: 'cancel_requested', operationId: res.body.operationId } });
  });

  it('a disallowed command is 403 with a stable code', async () => {
    await seedTask(t.db, specFor('t1'), 'merged');
    const res = await post(h.app, '/v1/tasks/t1/commands', { command: 'cancel', expectedRevision: 0, idempotencyKey: 'c5' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('command_not_allowed');
    const pause = await post(h.app, '/v1/tasks/t1/commands', { command: 'pause', expectedRevision: 0, idempotencyKey: 'c6' });
    expect(pause.status).toBe(403);
    expect(pause.body.error.code).toBe('command_not_supported');
  });

  it('retry moves a failed task back to ready', async () => {
    await seedTask(t.db, specFor('t1'), 'failed');
    const res = await post(h.app, '/v1/tasks/t1/commands', { command: 'retry', expectedRevision: 0, idempotencyKey: 'c7' });
    expect(res.status).toBe(202);
    expect((await taskStatus('t1'))['status']).toBe('ready');
  });
});

describe('approvals', () => {
  it('grants with a matching scope hash and revision, as the human principal', async () => {
    await seedTask(t.db, specFor('t1'), 'awaiting_approval');
    await t.db.execute(sql`INSERT INTO approvals (tenant_id, project_id, approval_id, run_id, task_id, revision, requester, action_hash, scope_hash, outcome)
      VALUES ('tenant_a', ${PROJECT}, 'a1', ${RUN}, 't1', 1, 'worker', 'ah', 'scope1', 'pending')`);
    const bad = await post(h.app, '/v1/approvals/a1/resolve', { decision: 'grant', scopeHash: 'other', expectedRevision: 0, idempotencyKey: 'r0' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('scope_mismatch');
    const res = await post(h.app, '/v1/approvals/a1/resolve', { decision: 'grant', scopeHash: 'scope1', expectedRevision: 0, idempotencyKey: 'r1' });
    expect(res.status).toBe(200);
    expect((await taskStatus('t1'))['status']).toBe('ready');
    const ev = await t.db.execute(sql`SELECT type, actor_kind, actor_id FROM events`);
    expect(ev[0]).toMatchObject({ type: 'approval.granted', actor_kind: 'human', actor_id: OWNER_UID });
    const again = await post(h.app, '/v1/approvals/a1/resolve', { decision: 'deny', scopeHash: 'scope1', expectedRevision: 0, idempotencyKey: 'r2' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('approval_already_resolved');
  });
});

describe('client-reported inference metadata', () => {
  it('client-reported inference metadata stored as untrusted, cannot change task state', async () => {
    await seedTask(t.db, specFor('t1'), 'ready');
    const before = await taskStatus('t1');
    const res = await post(h.app, '/v1/tasks/t1/client-reports', { kind: 'inference', mode: 'ONLY_ON_DEVICE', observedSource: 'on_device', model: 'gemini-nano' });
    expect(res.status).toBe(201);
    const rows = await t.db.execute(sql`SELECT trust, kind, payload FROM client_reports`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trust: 'untrusted', kind: 'inference' });
    expect(await taskStatus('t1')).toEqual(before);
    expect(await countEvents()).toBe(0);

    // Anything that looks like a state or verification claim is not accepted at all.
    for (const extra of [{ taskStatus: 'verified' }, { verified: true }, { status: 'merged' }]) {
      const bad = await post(h.app, '/v1/tasks/t1/client-reports', { kind: 'inference', mode: 'ONLY_ON_DEVICE', observedSource: 'on_device', ...extra });
      expect(bad.status).toBe(400);
    }
    expect(await taskStatus('t1')).toEqual(before);

    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    expect(snap.body.clientReports[0]).toMatchObject({ trust: 'untrusted', payload: { observedSource: 'on_device' } });
    expect(snap.body.tasks.find((x: any) => x.taskId === 't1').status).toBe('ready');
  });
});

describe('secrets', () => {
  const CANARY = 'sk_live_CANARY0123456789abcdefXYZ';
  const CANARY2 = 'hunter2hunter2-canary';

  it('secret canary never appears in events or snapshots', async () => {
    // Fields that do not exist are rejected, not stored.
    const rejected = await post(h.app, `/v1/projects/${PROJECT}/runs`, { idempotencyKey: 'sc0', title: 'x', apiKey: CANARY });
    expect(rejected.status).toBe(400);

    // Free text is redacted before it is written anywhere.
    const run = await post(h.app, `/v1/projects/${PROJECT}/runs`, { idempotencyKey: 'sc1', title: `Use ${CANARY} to deploy`, description: `password=${CANARY2} and more`, budgetLimitUsd: 5 });
    expect(run.status).toBe(201);
    await post(h.app, `/v1/runs/${run.body.runId}/plan-revisions`, { expectedRevision: 0, tasks: [{ ...specFor('sc_task'), runId: run.body.runId, title: `token=${CANARY2} ${CANARY}` }] });
    await seedTask(t.db, specFor('t1'), 'ready');
    await post(h.app, '/v1/tasks/t1/client-reports', { kind: 'inference', mode: 'ONLY_IN_CLOUD', observedSource: 'in_cloud', model: CANARY });
    const code = await post(h.app, '/v1/runners/pairing-codes', { location: 'local' });
    await post(h.app, '/v1/runners/enroll', { label: `laptop ${CANARY}` }, bearer(code.body.pairingCode));

    const events = JSON.stringify(await t.db.execute(sql`SELECT * FROM events`));
    const snapshot = JSON.stringify((await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body);
    const stored = JSON.stringify([
      await t.db.execute(sql`SELECT * FROM client_reports`),
      await t.db.execute(sql`SELECT * FROM task_revisions`),
      await t.db.execute(sql`SELECT * FROM runners`),
    ]);
    for (const out of [events, snapshot, stored]) {
      expect(out).not.toContain('CANARY');
      expect(out).not.toContain(CANARY2);
    }
    expect(events).toContain('[REDACTED]');
    expect(snapshot).not.toContain('leaseToken');
  });
});

describe('local mode', () => {
  it('rejects a cross-site browser request and a foreign Host, and answers preflight only for allowed origins', async () => {
    const evil = await h.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner({ origin: 'https://evil.example' }) });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe('origin_not_allowed');
    const site = await h.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner({ 'sec-fetch-site': 'cross-site' }) });
    expect(site.statusCode).toBe(403);
    const host = await h.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner({ host: 'attacker.example' }) });
    expect(host.statusCode).toBe(403);
    expect(host.json().error.code).toBe('host_not_allowed');
    const pre = await h.app.inject({ method: 'OPTIONS', url: `/v1/projects/${PROJECT}/snapshot`, headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const badPre = await h.app.inject({ method: 'OPTIONS', url: `/v1/projects/${PROJECT}/snapshot`, headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(badPre.statusCode).toBe(403);
    const ok = await h.app.inject({ method: 'GET', url: `/v1/projects/${PROJECT}/snapshot`, headers: owner({ origin: 'http://localhost:5173' }) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
