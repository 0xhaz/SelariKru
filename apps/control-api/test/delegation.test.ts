import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import { delegationOutputSha256 } from '@selarikru/domain';
import { PROJECT, RUN, TENANT, TEST_RUNNER_REPORT, get, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

/** H11: the owner's browser sends the Project Manager's delegation; the server applies only what the accepted plan covers, from a recorded pmDelegate call. */
let t: TestDb;
let h: Harness;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await h?.app.close(); await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`DELETE FROM runners`);
  await h?.app.close();
  h = makeHarness(t);
  await t.db.update(schema.runs).set({ planRevision: 2 });
  await seedTask(t.db, specFor('t1', { role: 'backend' }));
  await t.db.insert(schema.runners).values({ tenantId: TENANT, runnerId: 'w_back', location: 'local', tokenHash: 'hash-w_back', harnessReport: TEST_RUNNER_REPORT as never, createdAt: new Date(), lastSeenAt: new Date(), lastPolledAt: new Date() });
  await t.db.insert(schema.runnerSettings).values({ tenantId: TENANT, runnerId: 'w_back', field: 'role', desired: 'backend' as never, desiredRevision: 1, effective: 'backend' as never, effectiveRevision: 1, enforcer: 'server', updatedBy: 'o', updatedAt: new Date(), eventProjectId: PROJECT, eventRunId: RUN });
});

const ASSIGN = [{ taskId: 't1', workerId: 'w_back' }];
const record = async (served: string, stepKind = 'pmDelegate', locked = false, over: Record<string, unknown> = {}) => {
  await t.db.insert(schema.agentContexts).values({ tenantId: TENANT, projectId: PROJECT, contextId: 'ctx_pm', taskId: 't1', revision: 1, destination: 'local', contentLabel: served, servedAt: new Date() });
  await t.db.insert(schema.clientReports).values({ tenantId: TENANT, projectId: PROJECT, reportId: 'rpt_pm', subjectKind: 'task', subjectId: 't1', kind: 'route', trust: 'untrusted', reportedBy: 'owner_uid_1',
    payload: { requestId: 'req_pm', taskRevision: 1, effectiveMode: 'ONLY_ON_DEVICE', stepKind, status: 'ok', locked, contextId: 'ctx_pm', outputSha256: delegationOutputSha256(ASSIGN), planRevision: 2, ...over } });
};
const send = (over: Record<string, unknown> = {}) => post(h.app, `/v1/projects/${PROJECT}/runs/${RUN}/delegations`, { planRevision: 2, subjectTaskId: 't1', routeRecordId: 'req_pm', assignments: [{ taskId: 't1', workerId: 'w_back' }], ...over });

const resetRecord = async () => { await t.db.execute(sql`DELETE FROM client_reports`); await t.db.execute(sql`DELETE FROM agent_contexts`); };

describe('POST delegations (H11)', () => {
  it('applies an assignment inside the accepted plan, records task.delegated by agent:pm, and the snapshot shows it', async () => {
    await record('internal');
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: [{ taskId: 't1', workerId: 'w_back' }], refused: [], autoDelegate: true });
    const snap = (await get(h.app, `/v1/projects/${PROJECT}/snapshot`)).body;
    expect(snap.tasks.find((x: any) => x.taskId === 't1').delegation).toMatchObject({ workerId: 'w_back', planRevision: 2, actor: 'agent' });
  });

  it('refuses output with no recorded pmDelegate call, or from restricted context', async () => {
    expect((await send()).body.error.code).toBe('route_record_missing');
    await record('restricted');
    expect((await send()).body.error.code).toBe('proposal_from_restricted_context');
    expect(await t.db.execute(sql`SELECT 1 FROM events WHERE type = 'task.delegated'`)).toHaveLength(0);
  });

  it('cannot widen the plan: a path or a budget field comes back refused and nothing is applied (the call\'s own output, hashed as reported)', async () => {
    for (const [i, extra] of [{ allowedPaths: ['/'] }, { budgetUsd: 9 }].entries()) {
      await resetRecord();
      const assignments = [{ taskId: 't1', workerId: 'w_back', ...extra }];
      await record('internal', 'pmDelegate', false, { outputSha256: delegationOutputSha256(assignments), requestId: `req_w${i}` });
      expect((await send({ assignments, routeRecordId: `req_w${i}` })).body.refused[0].reason).toBe('outside_plan_field');
    }
    expect(await t.db.execute(sql`SELECT 1 FROM events WHERE type = 'task.delegated'`)).toHaveLength(0);
  });

  it('I1: applies only the call\'s own output, under the plan revision it used, once', async () => {
    await record('internal');
    // Other assignments than the call produced: refused.
    expect((await send({ assignments: [{ taskId: 't1', workerId: 'w_other' }] })).body.error.code).toBe('delegation_output_mismatch');
    // A plan revision other than the one the call used: refused.
    expect((await send({ planRevision: 1 })).body.error.code).toBe('plan_revision_changed');
    // The plan moved on after the call: refused, even with the call's own revision.
    await t.db.update(schema.runs).set({ planRevision: 3 });
    expect((await send()).body.error.code).toBe('plan_revision_changed');
    await t.db.update(schema.runs).set({ planRevision: 2 });
    // Once: a retry of the same request is the first answer, and nothing is applied twice.
    const first = await send();
    expect(first.body.applied).toHaveLength(1);
    await t.db.execute(sql`DELETE FROM task_delegations`);
    const again = await send();
    expect(again.body).toEqual(first.body);
    expect(await t.db.execute(sql`SELECT 1 FROM task_delegations`)).toHaveLength(0);
    expect(await t.db.execute(sql`SELECT 1 FROM events WHERE type = 'task.delegated'`)).toHaveLength(1);
  });

  it('H2: a call whose record says it read restricted input is refused, whatever its context', async () => {
    await t.db.insert(schema.agentContexts).values({ tenantId: TENANT, projectId: PROJECT, contextId: 'ctx_h2', taskId: 't1', revision: 1, destination: 'local', contentLabel: 'internal', servedAt: new Date() });
    const report = { kind: 'route', requestId: 'req_h2', stepKind: 'pmDelegate', callOverride: null, requestedMode: 'ONLY_ON_DEVICE', observedSource: 'ON_DEVICE', status: 'ok', model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 5, firstOutputMs: null }, validation: 'passed', blockedReason: null, contextId: 'ctx_h2', inputLabel: 'restricted' };
    expect((await post(h.app, "/v1/tasks/t1/client-reports", report)).status).toBe(201);
    const [row] = await t.db.execute(sql`SELECT payload FROM client_reports WHERE payload ->> 'requestId' = 'req_h2'`);
    expect((row as { payload: { locked: boolean } }).payload.locked).toBe(true);
    const res = await send({ routeRecordId: 'req_h2' });
    expect(res.body.error.code).toBe('proposal_from_restricted_call');
    expect(await t.db.execute(sql`SELECT 1 FROM events WHERE type = 'task.delegated'`)).toHaveLength(0);
  });

  it('I2: a worker with no role setting takes the role of its most recent claimed task; one with neither is refused as worker_role_unset', async () => {
    await seedTask(t.db, specFor('t0', { role: 'backend' }), 'merged');
    for (const id of ['w_hist', 'w_new']) await t.db.insert(schema.runners).values({ tenantId: TENANT, runnerId: id, location: 'local', tokenHash: `hash-${id}`, harnessReport: TEST_RUNNER_REPORT as never, createdAt: new Date(), lastSeenAt: new Date(), lastPolledAt: new Date() });
    await t.db.insert(schema.attempts).values({ tenantId: TENANT, projectId: PROJECT, attemptId: 'att_hist', taskId: 't0', revision: 1, attemptNumber: 1, runner: 'w_hist', outcome: 'succeeded', startedAt: new Date('2026-11-08T06:00:00Z'), endedAt: new Date('2026-11-08T06:05:00Z'), detail: {} });
    const assignments = [{ taskId: 't1', workerId: 'w_hist' }];
    await record('internal', 'pmDelegate', false, { outputSha256: delegationOutputSha256(assignments) });
    expect((await send({ assignments })).body.applied).toEqual(assignments);
    const res = await post(h.app, `/v1/projects/${PROJECT}/runs/${RUN}/delegations/owner`, { planRevision: 2, assignments: [{ taskId: 't1', workerId: 'w_new' }] });
    expect(res.body.refused[0]).toMatchObject({ reason: 'worker_role_unset' });
  });

  it('I3: the owner assigns through the same rule, recorded as the owner, even with auto-delegate off', async () => {
    await t.db.insert(schema.runSettings).values({ tenantId: TENANT, projectId: PROJECT, runId: RUN, field: 'auto_delegate', desired: false as never, desiredRevision: 1, effective: false as never, effectiveRevision: 1, enforcer: 'server', updatedBy: 'o', updatedAt: new Date() });
    const owner = (body: unknown) => post(h.app, `/v1/projects/${PROJECT}/runs/${RUN}/delegations/owner`, body);
    expect((await owner({ planRevision: 2, assignments: [{ taskId: 't1', workerId: 'w_back', allowedPaths: ['/'] }] })).body.refused[0].reason).toBe('outside_plan_field');
    const res = await owner({ planRevision: 2, assignments: [{ taskId: 't1', workerId: 'w_back' }] });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual([{ taskId: 't1', workerId: 'w_back' }]);
    const [ev] = await t.db.execute(sql`SELECT actor_kind FROM events WHERE type = 'task.delegated'`);
    expect((ev as { actor_kind: string }).actor_kind).toBe('human');
  });

  it('I4: a Project Manager plan is accepted through the plan-revision route only from an unlocked pmPlan call on clean context', async () => {
    const spec = specFor('t9', { role: 'backend' });
    const revise = (routeRecordId: string) => post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 2, idempotencyKey: `k-${routeRecordId}`, tasks: [spec], agentProposal: { taskId: 't1', routeRecordId, stepKind: 'pmPlan' } });
    // No pmPlan record: refused (a pmDelegate record does not count).
    await record('internal');
    expect((await revise('req_pm')).body.error.code).toBe('route_record_missing');
    await resetRecord();
    await record('restricted', 'pmPlan');
    expect((await revise('req_pm')).body.error.code).toBe('proposal_from_restricted_context');
    await resetRecord();
    await record('internal', 'pmPlan', true);
    expect((await revise('req_pm')).body.error.code).toBe('proposal_from_restricted_call');
    await resetRecord();
    await record('internal', 'pmPlan');
    const ok = await revise('req_pm');
    expect(ok.status).toBe(201);
    expect(ok.body.planRevision).toBe(3);
  });
});
