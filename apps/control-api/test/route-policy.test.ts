import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { PROJECT, RUN, TENANT, get, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

let t: TestDb;
let h: Harness;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await h?.app.close(); await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  h = makeHarness(t);
});

const save = (key: string, change: Record<string, unknown>, expectedRevision = 0, idempotencyKey = `k-${Math.random()}`) =>
  post(h.app, `/v1/projects/${PROJECT}/settings`, { key, change, expectedRevision, idempotencyKey });
const snapshot = async () => (await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body;
const routeOf = async (taskId: string) => (await snapshot()).tasks.find((x: any) => x.taskId === taskId).route;
const events = async (type: string) => t.db.execute(sql`SELECT actor_kind, actor_id, payload, run_id, task_id FROM events WHERE type = ${type} ORDER BY sequence`);
const onboardingChoice = (inference: string) => t.db.execute(sql`UPDATE runs SET setup_snapshot = ${JSON.stringify({ blueprintVersion: 1, execution: 'local', inference, agentBudgetUsd: 10, repository: null, defaultBranch: null, baseSha: null })}::jsonb WHERE run_id = ${RUN}`);
let seq = 0;
const brainSource = (taskId: string, classification: string, sourceId = `note:${taskId}`) => t.db.insert(schema.brainSources).values({
  tenantId: TENANT, projectId: PROJECT, sourceId, revision: 1, kind: 'note', title: 'n', standing: 'accepted', classification, allowedUse: ['local'],
  provenance: { origin: 'owner', ref: 'x', recordedBy: 'u' }, taskId, sections: [], contentSha256: 'a'.repeat(64), seq: (seq += 1), recordedAt: new Date(),
});
const report = (over: Record<string, unknown> = {}) => ({
  kind: 'route', requestId: `req-${Math.random().toString(36).slice(2)}`, stepKind: 'triage', callOverride: null, requestedMode: 'PREFER_ON_DEVICE', observedSource: 'IN_CLOUD', status: 'ok',
  model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 812.4, firstOutputMs: null }, validation: 'passed', blockedReason: null, ...over,
});
const sendReport = (taskId: string, body: Record<string, unknown>) => post(h.app, `/v1/tasks/${taskId}/client-reports`, body);

describe('route policy: run default, task override, precedence', () => {
  it('the run default is seeded from the onboarding choice, and a task without an override shows it with the suggestion', async () => {
    await onboardingChoice('PREFER_ON_DEVICE');
    await seedTask(t.db, specFor('t1', { description: 'Rename one label.' }));
    const snap = await snapshot();
    expect(snap.runs.find((r: any) => r.runId === RUN).routePolicy).toEqual({ value: 'PREFER_ON_DEVICE', origin: 'onboarding', revision: 0 });
    const route = snap.tasks[0].route;
    expect(route).toMatchObject({ effective: 'PREFER_ON_DEVICE', source: 'run', runDefault: 'PREFER_ON_DEVICE', override: null, overrideRevision: 0, lock: null, lastObserved: null });
    expect(route.suggestion).toMatchObject({ mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', locked: false });
    expect(route.suggestion.reason).toMatch(/Local first/);
  });

  it('with no onboarding choice and nothing saved the route is unset, never a default nobody chose', async () => {
    await seedTask(t.db, specFor('t1'));
    expect((await snapshot()).runs[0].routePolicy).toEqual({ value: null, origin: 'unset', revision: 0 });
    expect(await routeOf('t1')).toMatchObject({ effective: null, source: 'unset' });
  });

  it('the task override beats the run default; clearing it goes back to the run default; each change is a settings.changed by a person', async () => {
    await onboardingChoice('ONLY_ON_DEVICE');
    await seedTask(t.db, specFor('t1'));
    expect((await save(RUN, { scope: 'run', field: 'route_policy', value: 'PREFER_IN_CLOUD' })).body).toMatchObject({ state: 'applied', desiredRevision: 1, effectiveRevision: 1 });
    expect((await snapshot()).runs[0].routePolicy).toEqual({ value: 'PREFER_IN_CLOUD', origin: 'setting', revision: 1 });
    expect(await routeOf('t1')).toMatchObject({ effective: 'PREFER_IN_CLOUD', source: 'run' });

    const set = await save('t1', { scope: 'task', field: 'route_override', value: 'ONLY_IN_CLOUD' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ scope: 'task', key: 't1', field: 'route_override', state: 'applied', desiredRevision: 1 });
    expect(await routeOf('t1')).toMatchObject({ effective: 'ONLY_IN_CLOUD', source: 'task', override: 'ONLY_IN_CLOUD', overrideRevision: 1 });
    const setting = (await snapshot()).settings.find((s: any) => s.scope === 'task' && s.key === 't1');
    expect(setting).toMatchObject({ field: 'route_override', desired: 'ONLY_IN_CLOUD', effective: 'ONLY_IN_CLOUD', state: 'applied', enforcer: 'server' });

    expect((await save('t1', { scope: 'task', field: 'route_override', value: null }, 0)).status).toBe(409); // stale revision
    expect((await save('t1', { scope: 'task', field: 'route_override', value: null }, 1)).status).toBe(200);
    expect(await routeOf('t1')).toMatchObject({ effective: 'PREFER_IN_CLOUD', source: 'run', override: null, overrideRevision: 2 });

    const changed = await events('settings.changed');
    expect(changed).toHaveLength(3);
    for (const e of changed) expect(e).toMatchObject({ actor_kind: 'human', actor_id: 'owner_uid_1', run_id: RUN });
    expect(changed[0]!['payload']).toMatchObject({ scope: 'run', key: RUN, field: 'route_policy', from: 'ONLY_ON_DEVICE', to: 'PREFER_IN_CLOUD' });
    expect(changed[1]!['payload']).toMatchObject({ scope: 'task', key: 't1', field: 'route_override', from: null, to: 'ONLY_IN_CLOUD', revision: 1, enforcer: 'server' });
    expect(changed[2]!['payload']).toMatchObject({ scope: 'task', key: 't1', from: 'ONLY_IN_CLOUD', to: null, revision: 2 });
  });

  it('refuses a task that does not exist, and a run that is closed', async () => {
    expect((await save('nope', { scope: 'task', field: 'route_override', value: 'ONLY_ON_DEVICE' })).status).toBe(404);
    await seedTask(t.db, specFor('t1'));
    await t.db.execute(sql`UPDATE runs SET lifecycle = 'merged' WHERE run_id = ${RUN}`);
    expect((await save('t1', { scope: 'task', field: 'route_override', value: 'ONLY_ON_DEVICE' })).body.error.code).toBe('run_closed');
  });
});

describe('route policy: the data lock', () => {
  it('a restricted task is forced device only, refuses a cloud-capable override with 409 and a reason, and accepts device only', async () => {
    await onboardingChoice('PREFER_IN_CLOUD');
    await seedTask(t.db, specFor('t1', { classification: 'restricted' }));
    const route = await routeOf('t1');
    expect(route).toMatchObject({ effective: 'ONLY_ON_DEVICE', source: 'lock', runDefault: 'PREFER_IN_CLOUD', lock: { label: 'restricted' } });
    expect(route.lock.reason).toMatch(/reclassification/);
    expect(route.suggestion).toMatchObject({ mode: 'ONLY_ON_DEVICE', rule: 'restricted', locked: true });
    for (const value of ['PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD']) {
      const r = await save('t1', { scope: 'task', field: 'route_override', value });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({ code: 'route_locked_restricted', details: { label: 'restricted' } });
      expect(r.body.error.details.reason).toMatch(/restricted/);
    }
    expect((await events('settings.changed'))).toHaveLength(0);
    expect((await save('t1', { scope: 'task', field: 'route_override', value: 'ONLY_ON_DEVICE' })).status).toBe(200);
    // A cloud run default does not reach it either.
    expect((await save(RUN, { scope: 'run', field: 'route_policy', value: 'ONLY_IN_CLOUD' })).status).toBe(200);
    expect(await routeOf('t1')).toMatchObject({ effective: 'ONLY_ON_DEVICE', source: 'task', lock: { label: 'restricted' } });
  });

  it('follows the Brain strongest-label rule: a restricted source of the task or a restricted project locks it; a secret one says secret', async () => {
    await seedTask(t.db, specFor('t1'));
    await seedTask(t.db, specFor('t2'));
    await brainSource('t1', 'restricted');
    await brainSource('t2', 'public');
    expect(await routeOf('t1')).toMatchObject({ source: 'lock', lock: { label: 'restricted' } });
    expect((await routeOf('t2')).lock).toBeNull();
    expect((await save('t1', { scope: 'task', field: 'route_override', value: 'PREFER_IN_CLOUD' })).status).toBe(409);
    await brainSource('t2', 'secret', 'note:t2b');
    expect(await routeOf('t2')).toMatchObject({ lock: { label: 'secret' } });
    await t.db.execute(sql`UPDATE projects SET classification = 'restricted' WHERE project_id = ${PROJECT}`);
    await seedTask(t.db, specFor('t3'));
    expect(await routeOf('t3')).toMatchObject({ lock: { label: 'restricted' } });
  });

  it('no route write lifts the lock; a lower label, as a reclassification decision leaves it, does', async () => {
    await onboardingChoice('PREFER_IN_CLOUD');
    await seedTask(t.db, specFor('t1', { classification: 'restricted' }));
    expect((await save('t1', { scope: 'task', field: 'route_override', value: null })).status).toBe(200);
    expect(await routeOf('t1')).toMatchObject({ source: 'lock' });
    // The accepted plan after a reclassification carries the lowered label as a new task revision.
    await t.db.insert(schema.taskRevisions).values({ tenantId: TENANT, projectId: PROJECT, runId: RUN, taskId: 't1', revision: 2, boardId: 'b1', spec: specFor('t1', { revision: 2, classification: 'internal' }) });
    await t.db.execute(sql`UPDATE task_status SET current_revision = 2 WHERE task_id = 't1'`);
    expect(await routeOf('t1')).toMatchObject({ effective: 'PREFER_IN_CLOUD', source: 'run', lock: null });
  });
});

describe('route records reported by the browser', () => {
  it('stores metadata only, works out the effective route, fallback and conformance itself, and records an event by a person', async () => {
    await onboardingChoice('PREFER_ON_DEVICE');
    await seedTask(t.db, specFor('t1'));
    const body = report();
    const r = await sendReport('t1', body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ trust: 'untrusted' });
    const history = (await get(h.app, `/v1/projects/${PROJECT}/tasks/t1/route`)).body;
    expect(history.route).toMatchObject({ effective: 'PREFER_ON_DEVICE', source: 'run' });
    expect(history.records).toHaveLength(1);
    expect(history.records[0]).toMatchObject({
      taskId: 't1', taskRevision: 1, requestId: body.requestId, requestedMode: 'PREFER_ON_DEVICE', effectiveMode: 'PREFER_ON_DEVICE', policySource: 'run', locked: false,
      observedSource: 'IN_CLOUD', fellBack: true, conformance: 'conforms', timing: { totalMs: 812, firstOutputMs: null }, reportedBy: 'browser', trust: 'untrusted',
    });
    expect((await routeOf('t1')).lastObserved).toMatchObject({ observedSource: 'IN_CLOUD', fellBack: true });
    const ev = await events('inference.reported');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_kind: 'human', actor_id: 'owner_uid_1', task_id: 't1', run_id: RUN });
    // A replay of the same request is the same record and no second event.
    expect((await sendReport('t1', body)).body.reportId).toBe(r.body.reportId);
    expect(await events('inference.reported')).toHaveLength(1);
  });

  it('a restricted task keeps no text: the report shape has no place for it, and a cloud answer is recorded as a violation', async () => {
    await seedTask(t.db, specFor('t1', { classification: 'restricted' }));
    const leak = await sendReport('t1', { ...report(), prompt: 'RESTRICTED-CANARY customer list' });
    expect(leak.status).toBe(400);
    const leak2 = await sendReport('t1', report({ blockedReason: 'RESTRICTED-CANARY customer list' }));
    expect(leak2.status).toBe(400);
    expect((await sendReport('t1', report({ callOverride: 'ONLY_IN_CLOUD', requestedMode: 'ONLY_IN_CLOUD', observedSource: 'IN_CLOUD' }))).status).toBe(201);
    const [rec] = (await get(h.app, `/v1/projects/${PROJECT}/tasks/t1/route`)).body.records;
    expect(rec).toMatchObject({ effectiveMode: 'ONLY_ON_DEVICE', policySource: 'lock', locked: true, conformance: 'violation', callOverride: 'ONLY_IN_CLOUD' });
    const stored = await t.db.execute(sql`SELECT payload FROM client_reports WHERE kind = 'route'`);
    const events_ = await t.db.execute(sql`SELECT payload FROM events WHERE type = 'inference.reported'`);
    const all = JSON.stringify([stored, events_]);
    expect(all).not.toContain('RESTRICTED-CANARY');
    // Every stored key is one of the closed metadata fields.
    const keys = Object.keys(stored[0]!['payload'] as object).sort();
    expect(keys).toEqual(['blockedReason', 'callOverride', 'conformance', 'effectiveMode', 'fellBack', 'locked', 'model', 'observedSource', 'policySource', 'requestId', 'requestedMode', 'status', 'stepKind', 'taskRevision', 'timing', 'validation'].sort());
  });

  it('an unknown source stays unknown', async () => {
    await onboardingChoice('ONLY_ON_DEVICE');
    await seedTask(t.db, specFor('t1'));
    await sendReport('t1', report({ requestedMode: 'ONLY_ON_DEVICE', observedSource: 'UNKNOWN' }));
    expect((await routeOf('t1')).lastObserved).toMatchObject({ observedSource: 'UNKNOWN', fellBack: null, conformance: 'unverified' });
  });

  it('the assistant inference report still works and still states the assistant axis', async () => {
    await seedTask(t.db, specFor('t1'));
    await sendReport('t1', report());
    expect((await sendReport('t1', { kind: 'inference', mode: 'ONLY_ON_DEVICE', observedSource: 'on_device' })).status).toBe(201);
    await sendReport('t1', report());
    const reports = (await snapshot()).clientReports;
    expect(reports.every((r: any) => r.kind === 'inference')).toBe(true);
    expect(reports[0].payload).toMatchObject({ mode: 'ONLY_ON_DEVICE', observedSource: 'on_device' });
  });
});
