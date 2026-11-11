import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import { API_POLICY, PROJECT, RUN, TENANT, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

/**
 * H11 fix round 2 (I4): accepting a Project Manager plan on a run that already has tasks. A task that names `revises` becomes the next revision of that task, with the
 * PM's paths, criteria and dependencies; one without becomes a new task; T-key dependencies map to the final ids. With rolePaths configured, revising the backend and
 * frontend tasks yields no `role_has_many_tasks`.
 */
const SETTINGS = {
  boardId: 'b1', role: 'backend', baseSha: 'abc', allowedPaths: ['apps'], classification: 'internal', policyVersion: 'v1', execution: 'eligible_any', inferencePolicyId: 'p1',
  limits: { maxAttempts: 3, timeoutSeconds: 1800, maxCostUsd: 1 }, allowedRequirementIds: ['FB-01', 'FB-02'], forbiddenMandatoryScope: [],
  rolePaths: { backend: ['apps/api'], frontend: ['apps/web'] }, requirementText: { 'FB-01': 'Posting works.', 'FB-02': 'The list shows posts.' },
};
let t: TestDb;
let h: Harness;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await h?.app.close(); await t.close(); });
beforeEach(async () => {
  await resetDb(t.db);
  await h?.app.close();
  h = makeHarness(t, {}, API_POLICY, { planConfig: (pid: string) => (pid === PROJECT ? (SETTINGS as never) : undefined) });
  await t.db.update(schema.runs).set({ planRevision: 2 });
  await seedTask(t.db, specFor('t_back', { role: 'backend', allowedPaths: ['apps/api'], requirementIds: ['FB-01'] }), 'planned');
  await seedTask(t.db, specFor('t_front', { role: 'frontend', allowedPaths: ['apps/web'], requirementIds: ['FB-02'] }), 'planned');
  await seedTask(t.db, specFor('t_secret', { role: 'docs', allowedPaths: ['apps/docs'], classification: 'restricted' }), 'planned');
  await t.db.insert(schema.agentContexts).values({ tenantId: TENANT, projectId: PROJECT, contextId: 'ctx_plan', taskId: 't_back', revision: 1, destination: 'local', contentLabel: 'internal', servedAt: new Date() });
  await t.db.insert(schema.clientReports).values({ tenantId: TENANT, projectId: PROJECT, reportId: 'rpt_plan', subjectKind: 'task', subjectId: 't_back', kind: 'route', trust: 'untrusted', reportedBy: 'owner_uid_1',
    payload: { requestId: 'req_plan', taskRevision: 1, effectiveMode: 'ONLY_ON_DEVICE', stepKind: 'pmPlan', status: 'ok', locked: false, contextId: 'ctx_plan' } });
});

const task = (over: Record<string, unknown>) => ({ key: 'T1', title: 'Posting API', description: 'Store a post.', role: 'backend', requirementIds: ['FB-01'], paths: ['apps/api/posts'], dependsOn: [], ...over });
const review = (tasks: unknown[]) => post(h.app, `/v1/runs/${RUN}/proposals/review`, { envelope: { operation: 'pmPlan', status: 'ok', data: { tasks } } });
const revise = (tasks: unknown[], expectedRevision = 2) => post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision, idempotencyKey: `k-${Math.random()}`, tasks, agentProposal: { taskId: 't_back', routeRecordId: 'req_plan', stepKind: 'pmPlan' } });

describe('accepting a Project Manager plan revises the run\'s tasks (H11 fix round 2, I4)', () => {
  it('revises the named tasks with the PM\'s paths and dependencies, adds the new one, keeps the rest, and no role has two tasks', async () => {
    const r = await review([
      task({ key: 'T1', revises: 't_back' }),
      task({ key: 'T2', title: 'List screen', role: 'frontend', requirementIds: ['FB-02'], paths: ['apps/web/list'], dependsOn: ['T1'], revises: 't_front' }),
      task({ key: 'T3', title: 'Docs', role: 'docs', requirementIds: ['FB-01'], paths: ['apps/docs'], dependsOn: ['T1', 'T2'] }),
    ]);
    expect(r.status).toBe(200);
    const tasks = r.body.tasks as { taskId: string; revision: number; role: string; allowedPaths: string[]; dependencies: { taskId: string; revision: number }[] }[];
    expect(tasks.map((x) => [x.taskId, x.revision, x.role])).toEqual([['t_back', 2, 'backend'], ['t_front', 2, 'frontend'], [expect.stringMatching(/-3$/), 1, 'docs']]);
    expect(tasks[0]!.allowedPaths).toEqual(['apps/api/posts']);
    expect(tasks[1]!.dependencies).toEqual([{ taskId: 't_back', revision: 2, condition: 'artifact_verified' }]);
    expect(tasks[2]!.dependencies.map((d) => d.taskId)).toEqual(['t_back', 't_front']);
    const done = await revise(r.body.tasks);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.planRevision).toBe(3);
    const rows = await t.db.execute(sql`SELECT task_id, current_revision FROM task_status ORDER BY task_id`);
    expect(rows.map((x) => [x['task_id'], x['current_revision']])).toEqual(expect.arrayContaining([['t_back', 2], ['t_front', 2], ['t_secret', 1]]));
    const [spec] = await t.db.execute(sql`SELECT spec FROM task_revisions WHERE task_id = 't_back' AND revision = 2`);
    expect((spec!['spec'] as { allowedPaths: string[] }).allowedPaths).toEqual(['apps/api/posts']);
  });

  it('refuses a revises id that is unknown, locked, named twice, or changes the task\'s role, and a path outside its role\'s paths', async () => {
    const code = async (tasks: unknown[]) => (await review(tasks)).body.error?.details?.reason ?? (await review(tasks)).body.error?.code;
    expect(await code([task({ revises: 'nope' })])).toBe('revises_unknown');
    expect(await code([task({ revises: 't_secret' })])).toBe('revises_locked');
    expect(await code([task({ revises: 't_back' }), task({ key: 'T2', revises: 't_back' })])).toBe('revises_duplicate');
    expect(await code([task({ revises: 't_back', role: 'frontend', paths: ['apps/web'] })])).toBe('revises_role_changed');
    expect(await code([task({ revises: 't_back', paths: ['apps/web/x'] })])).toBe('path_outside_role');
  });
});
