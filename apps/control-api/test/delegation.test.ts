import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
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

const record = async (served: string, stepKind = 'pmDelegate', locked = false) => {
  await t.db.insert(schema.agentContexts).values({ tenantId: TENANT, projectId: PROJECT, contextId: 'ctx_pm', taskId: 't1', revision: 1, destination: 'local', contentLabel: served, servedAt: new Date() });
  await t.db.insert(schema.clientReports).values({ tenantId: TENANT, projectId: PROJECT, reportId: 'rpt_pm', subjectKind: 'task', subjectId: 't1', kind: 'route', trust: 'untrusted', reportedBy: 'owner_uid_1',
    payload: { requestId: 'req_pm', taskRevision: 1, effectiveMode: 'ONLY_ON_DEVICE', stepKind, status: 'ok', locked, contextId: 'ctx_pm' } });
};
const send = (over: Record<string, unknown> = {}) => post(h.app, `/v1/projects/${PROJECT}/runs/${RUN}/delegations`, { planRevision: 2, subjectTaskId: 't1', routeRecordId: 'req_pm', assignments: [{ taskId: 't1', workerId: 'w_back' }], ...over });

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

  it('cannot widen the plan: another plan revision, a path or a budget field come back refused and nothing is applied', async () => {
    await record('internal');
    expect((await send({ planRevision: 1 })).body.refused[0].reason).toBe('plan_revision_not_accepted');
    expect((await send({ assignments: [{ taskId: 't1', workerId: 'w_back', allowedPaths: ['/'] }] })).body.refused[0].reason).toBe('outside_plan_field');
    expect((await send({ assignments: [{ taskId: 't1', workerId: 'w_back', budgetUsd: 9 }] })).body.refused[0].reason).toBe('outside_plan_field');
    expect(await t.db.execute(sql`SELECT 1 FROM events WHERE type = 'task.delegated'`)).toHaveLength(0);
  });
});
