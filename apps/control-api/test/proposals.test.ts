import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT, RUN, TENANT, INTRUDER_TOKEN, bearer, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';
import { reviewPlanProposal, type ProjectPlanConfig, type ProposalEnvelope } from '../src/proposals.ts';

const CONFIG: ProjectPlanConfig = {
  tenantId: TENANT, projectId: PROJECT, runId: RUN, boardId: 'b1', role: 'backend', baseSha: 'abc123',
  allowedPaths: ['src/**'], classification: 'internal', policyVersion: 'v1', execution: 'eligible_any', inferencePolicyId: 'p1',
  limits: { maxAttempts: 3, timeoutSeconds: 1800, maxCostUsd: 1 },
  allowedRequirementIds: ['FB-01', 'FB-02'], forbiddenMandatoryScope: ['login', 'payments'],
};
const plan = (over: Partial<ProposalEnvelope> = {}): ProposalEnvelope => ({
  operation: 'draftTaskPlan', status: 'ok',
  data: { tasks: [{ title: 'Feedback form', description: 'Build the form with validation.', requirementIds: ['FB-01'] }, { title: 'Persist', description: 'Store it.', requirementIds: ['FB-02'] }] },
  ...over,
});
const opts = { taskIdPrefix: 'prop' };

describe('reviewPlanProposal (server re-validation)', () => {
  it('maps title and requirement IDs; every server-owned field comes from project config', () => {
    const r = reviewPlanProposal(plan(), CONFIG, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.needsReview).toBe(false);
    expect(r.value.droppedFields).toContain('description');
    expect(r.value.tasks).toHaveLength(2);
    expect(r.value.tasks[0]).toMatchObject({
      taskId: 'prop-1', title: 'Feedback form', requirementIds: ['FB-01'], baseSha: 'abc123', allowedPaths: ['src/**'],
      classification: 'internal', policyVersion: 'v1', limits: { maxAttempts: 3, timeoutSeconds: 1800, maxCostUsd: 1 }, dependencies: [], resourceClaims: [],
    });
    expect(r.value.tasks[0]).not.toHaveProperty('description');
  });

  it('rejects proposal-supplied server-owned fields and shell/tool authority', () => {
    for (const extra of [{ allowedPaths: ['/'] }, { classification: 'public' }, { limits: {} }, { policyVersion: 'x' }, { baseSha: 'evil' }, { command: 'rm -rf /' }]) {
      const e = plan();
      const r = reviewPlanProposal({ ...e, data: { tasks: [{ title: 'T', description: 'D', requirementIds: ['FB-01'], ...extra }] } }, CONFIG, opts);
      expect(r.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it('server config that is missing a required field blocks; missing is never defaulted', () => {
    const { limits: _l, ...noLimits } = CONFIG;
    const r = reviewPlanProposal(plan(), noLimits as never, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('missing_server_config');
    const noPaths = reviewPlanProposal(plan(), { ...CONFIG, allowedPaths: undefined } as never, opts);
    expect(noPaths.ok).toBe(false);
  });

  it('disallowed requirement IDs are re-checked server-side against the server list, not the client claim', () => {
    const r = reviewPlanProposal(plan({ data: { tasks: [{ title: 'T', description: 'D', requirementIds: ['FB-05'] }] } }), CONFIG, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('proposal_rejected');
  });

  it('route_violation, unverified_source and other non-ok statuses are not acceptable', () => {
    for (const status of ['route_violation', 'unverified_source', 'invalid', 'blocked', 'error'] as const) {
      const r = reviewPlanProposal(plan({ status }), CONFIG, opts);
      expect(r.ok, status).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('proposal_not_acceptable');
    }
    expect(reviewPlanProposal(plan({ operation: 'draftBrief' }), CONFIG, opts).ok).toBe(false);
  });

  it('forbidden-scope phrase matches need explicit acknowledgement', () => {
    const e = plan({ data: { tasks: [{ title: 'Add login', description: 'D', requirementIds: ['FB-01'] }] } });
    const r = reviewPlanProposal(e, CONFIG, opts);
    expect(r.ok && r.value.needsReview).toBe(true);
    expect(r.ok && r.value.issues[0]?.heuristic).toBe('deterministic_phrase_match');
  });
});

describe('acceptance goes through the existing plan-revision path', () => {
  let t: TestDb;
  let h: Harness;
  beforeAll(async () => { t = await setupTestDb(); h = makeHarness(t); await h.app.ready(); });
  afterAll(async () => { await h.app.close(); await t.close(); });
  beforeEach(async () => { await resetDb(t.db); });

  it('the owner posts the mapped candidates; a non-owner cannot; client reports change nothing', async () => {
    const r = reviewPlanProposal(plan(), CONFIG, opts);
    if (!r.ok) throw new Error('expected ok');
    const body = { expectedRevision: 0, tasks: r.value.tasks };

    const intruder = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, body, bearer(INTRUDER_TOKEN));
    expect([401, 403]).toContain(intruder.status);
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM task_revisions`))[0]!['n'])).toBe(0);

    // A client report claiming a route or acceptance does not create a plan or change a task.
    await seedTask(t.db, specFor('t1'));
    const before = JSON.stringify(await t.db.execute(sql`SELECT * FROM task_status`));
    const rep = await post(h.app, '/v1/tasks/t1/client-reports', { kind: 'inference', mode: 'ONLY_ON_DEVICE', observedSource: 'on_device' });
    expect(rep.body.trust).toBe('untrusted');
    expect(JSON.stringify(await t.db.execute(sql`SELECT * FROM task_status`))).toBe(before);
    expect(Number((await t.db.execute(sql`SELECT count(*)::int AS n FROM task_revisions WHERE task_id LIKE 'prop-%'`))[0]!['n'])).toBe(0);

    const ok = await post(h.app, `/v1/runs/${RUN}/plan-revisions`, body);
    expect(ok.status).toBe(201);
    expect(ok.body.planRevision).toBe(1);
    const stored = (await t.db.execute(sql`SELECT spec FROM task_revisions WHERE task_id = 'prop-1'`))[0]!['spec'] as any;
    expect(stored).toMatchObject({ baseSha: 'abc123', allowedPaths: ['src/**'], title: 'Feedback form' });
  });
});
