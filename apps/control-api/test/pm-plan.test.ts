import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import { withTx, type Tx } from '@selarikru/persistence';
import { canonicalJson, sha256Hex } from '@selarikru/domain';
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
/** The pmPlan call's record carries the hash of its output (fix round 3): bind it to the plan the test sends. */
const bind = (tasks: unknown[]) => t.db.execute(sql`UPDATE client_reports SET payload = payload || ${JSON.stringify({ outputSha256: sha256Hex(canonicalJson({ tasks })) })}::jsonb WHERE report_id = 'rpt_plan'`);
const agentProposal = { taskId: 't_back', routeRecordId: 'req_plan', stepKind: 'pmPlan' };
let lastPlan: unknown[] = [];
const review = async (tasks: unknown[], bound = true) => { lastPlan = tasks; if (bound) await bind(tasks); return post(h.app, `/v1/runs/${RUN}/proposals/review`, { envelope: { operation: 'pmPlan', status: 'ok', data: { tasks } }, agentProposal: { taskId: 't_back', routeRecordId: 'req_plan' } }); };
const revise = (tasks: unknown[], expectedRevision = 2, plan: unknown[] = lastPlan) => post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision, idempotencyKey: `k-${Math.random()}`, tasks, agentProposal, pmPlan: { tasks: plan } });

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

  it('N2 (fix round 3): revises_locked follows the real route lock: a Brain-restricted task, a task downstream of a restricted one, and a restricted project', async () => {
    const code = async (tasks: unknown[]) => { const r = await review(tasks); return r.body.error?.details?.reason ?? r.body.error?.code; };
    await t.db.insert(schema.brainSources).values({
      tenantId: TENANT, projectId: PROJECT, sourceId: 'note:t_back', revision: 1, kind: 'note', title: 'n', standing: 'accepted', classification: 'restricted', allowedUse: ['local'],
      provenance: { origin: 'owner', ref: 'x', recordedBy: 'u' }, taskId: 't_back', sections: [], contentSha256: 'a'.repeat(64), seq: 1, recordedAt: new Date(),
    });
    expect(await code([task({ revises: 't_back' })])).toBe('revises_locked');
    await seedTask(t.db, specFor('t_down', { role: 'frontend', allowedPaths: ['apps/web'], dependencies: [{ taskId: 't_secret', revision: 1, condition: 'artifact_verified' }] }), 'planned');
    expect(await code([task({ revises: 't_down', role: 'frontend', paths: ['apps/web'] })])).toBe('revises_locked');
    await t.db.execute(sql`UPDATE projects SET classification = 'restricted' WHERE project_id = ${PROJECT}`);
    expect(await code([task({ revises: 't_front', role: 'frontend', paths: ['apps/web'] })])).toBe('revises_locked');
  });

  it('N3 (fix round 3): paths are normalised first: .. segments, absolute and empty paths are refused', async () => {
    const code = async (tasks: unknown[]) => { const r = await review(tasks); return r.body.error?.details?.reason ?? r.body.error?.code; };
    for (const p of ['apps/api/../../infra/deploy', '/etc/passwd', '', 'apps/api/./../web']) expect(await code([task({ revises: 't_back', paths: [p] })]), p).toBe('path_invalid');
  });

  it('a new task\'s role must be one of the project\'s roles', async () => {
    const r = await review([task({ role: 'designer', paths: ['apps/api'] })]);
    expect(r.body.error?.details?.reason ?? r.body.error?.code).toBe('role_unknown');
  });

  it('the accepted plan is bound to the PM output: the review and plan-revisions refuse a plan whose hash is not the record\'s, and plan-revisions re-derives the specs', async () => {
    const plan = [task({ revises: 't_back' })];
    await bind([task({ revises: 't_back', title: 'Something else' })]);
    const unbound = await review(plan, false);
    expect(unbound.body.error?.code).toBe('plan_output_mismatch');
    const r = await review(plan);
    expect(r.status).toBe(200);
    // A tampered client changes a reviewed spec (its paths): refused, nothing written.
    const tampered = (r.body.tasks as Record<string, unknown>[]).map((x) => ({ ...x, allowedPaths: ['apps'] }));
    expect((await revise(tampered)).body.error?.code).toBe('plan_output_mismatch');
    // A plan that differs from the record: refused.
    expect((await revise(r.body.tasks, 2, [task({ revises: 't_back', paths: ['apps/api/other'] })])).body.error?.code).toBe('plan_output_mismatch');
    const ok = await revise(r.body.tasks);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

describe('H13: a Project Manager plan with an architecture section', () => {
  it('the architecture is part of the bound output (its hash), and the server still maps the tasks only', async () => {
    const tasks = [task({ revises: 't_back' })];
    const data = { tasks, architecture: 'A posting API (P1) and a list screen (P2).' };
    await t.db.execute(sql`UPDATE client_reports SET payload = payload || ${JSON.stringify({ outputSha256: sha256Hex(canonicalJson(data)) })}::jsonb WHERE report_id = 'rpt_plan'`);
    const r = await post(h.app, `/v1/runs/${RUN}/proposals/review`, { envelope: { operation: 'pmPlan', status: 'ok', data }, agentProposal: { taskId: 't_back', routeRecordId: 'req_plan' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body.tasks as { taskId: string }[]).map((x) => x.taskId)).toEqual(['t_back']);
    // The tasks without the architecture are not the plan the call produced.
    const stripped = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 2, idempotencyKey: 'k-arch-1', tasks: r.body.tasks, agentProposal, pmPlan: { tasks } });
    expect(stripped.body.error?.code).toBe('plan_output_mismatch');
    const ok = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { expectedRevision: 2, idempotencyKey: 'k-arch-2', tasks: r.body.tasks, agentProposal, pmPlan: data });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // An architecture over its bound is refused, as any field the plan schema does not allow.
    const long = { tasks, architecture: 'a'.repeat(2001) };
    await t.db.execute(sql`UPDATE client_reports SET payload = payload || ${JSON.stringify({ outputSha256: sha256Hex(canonicalJson(long)) })}::jsonb WHERE report_id = 'rpt_plan'`);
    const bad = await post(h.app, `/v1/runs/${RUN}/proposals/review`, { envelope: { operation: 'pmPlan', status: 'ok', data: long }, agentProposal: { taskId: 't_back', routeRecordId: 'req_plan' } });
    expect(bad.status).not.toBe(200);
  });
});

describe('H12 step 0: plan-revisions derives the PM plan under its locks, and one pmPlan record accepts one plan', () => {
  /** Resolves once some other backend is waiting on a lock this one holds. */
  async function queuedBehind(tx: Tx): Promise<void> {
    const [me] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    const pid = Number(me!['pid']);
    for (let i = 0; i < 2000; i++) {
      const [row] = await t.db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`);
      if (Number(row!['n']) > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the route never queued behind the scheduler lock');
  }

  it('a task locked while plan-revisions waits for the scheduler lock is judged locked: the specs are derived after lockBeforeRunRow, inside the transaction', async () => {
    const r = await review([task({ revises: 't_back' })]);
    expect(r.status).toBe(200);
    let pending: Promise<Awaited<ReturnType<typeof revise>>> | undefined;
    await withTx(t.db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${TENANT}`}, 0))`);
      pending = revise(r.body.tasks);
      await queuedBehind(tx);
      // While the route waits, t_back becomes restricted (a Brain source), committed before the scheduler lock is released.
      await t.db.insert(schema.brainSources).values({
        tenantId: TENANT, projectId: PROJECT, sourceId: 'note:late', revision: 1, kind: 'note', title: 'n', standing: 'accepted', classification: 'restricted', allowedUse: ['local'],
        provenance: { origin: 'owner', ref: 'x', recordedBy: 'u' }, taskId: 't_back', sections: [], contentSha256: 'a'.repeat(64), seq: 1, recordedAt: new Date(),
      });
    });
    const done = await pending!;
    expect(done.body.error?.details?.reason ?? done.body.error?.code, JSON.stringify(done.body)).toBe('revises_locked');
    const [row] = await t.db.execute(sql`SELECT current_revision FROM task_status WHERE task_id = 't_back'`);
    expect(row!['current_revision']).toBe(1);
  });

  it('a pmPlan record accepts one plan: the same request again gets the first answer, any other use of the record is refused (pm_plan:<record>)', async () => {
    const r = await review([task({ revises: 't_back' })]);
    const body = { expectedRevision: 2, idempotencyKey: 'k-once', tasks: r.body.tasks, agentProposal, pmPlan: { tasks: lastPlan } };
    const first = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, body);
    expect(again.body).toEqual(first.body);
    // The same record, under a new key and the plan revision now in force: refused, nothing written.
    const reuse = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, { ...body, expectedRevision: 3, idempotencyKey: 'k-twice' });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error?.code).toBe('route_record_used');
    const [run] = await t.db.execute(sql`SELECT plan_revision FROM runs`);
    expect(run!['plan_revision']).toBe(3);
  });
});
