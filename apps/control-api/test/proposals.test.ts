import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@selarikru/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_POLICY, PROJECT, RUN, TENANT, INTRUDER_TOKEN, bearer, makeHarness, owner, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';
import { loadPlanConfigFile, reviewPlanProposal, type ProjectPlanConfig, type ProposalEnvelope } from '../src/proposals.ts';

const CONFIG: ProjectPlanConfig = {
  tenantId: TENANT, projectId: PROJECT, runId: RUN, boardId: 'b1', role: 'backend', baseSha: 'abc123',
  allowedPaths: ['src'], classification: 'internal', policyVersion: 'v1', execution: 'eligible_any', inferencePolicyId: 'p1',
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
      taskId: 'prop-1', title: 'Feedback form', requirementIds: ['FB-01'], baseSha: 'abc123', allowedPaths: ['src'],
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
    const r = reviewPlanProposal(e, CONFIG, { ...opts, acknowledgedIssuePaths: ['forbidden_scope:/tasks/0/title'] });
    expect(r.ok && r.value.needsReview).toBe(true);
    expect(r.ok && r.value.issues[0]?.heuristic).toBe('deterministic_phrase_match');
  });
});

describe('server-side gates in reviewPlanProposal', () => {
  const data = plan().data;
  const sha = createHash('sha256').update(canonicalJson(data)).digest('hex');
  const grant = { grantId: 'dec_1', draftId: 'd1', contentSha256: sha, sourceClassification: 'restricted', targetClassification: 'internal' } as const;

  it('refuses restricted and secret project content unless a server-verified grant is presented', () => {
    for (const classification of ['restricted', 'secret'] as const) {
      const r = reviewPlanProposal(plan(), { ...CONFIG, classification }, opts);
      expect(r.ok, classification).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('proposal_not_acceptable');
    }
    const ok = reviewPlanProposal(plan(), { ...CONFIG, classification: 'restricted' }, { ...opts, grant });
    expect(ok.ok && ok.value.tasks[0]!.classification).toBe('internal');
    // A grant for different content, or any grant on a secret project, does not help.
    expect(reviewPlanProposal(plan(), { ...CONFIG, classification: 'restricted' }, { ...opts, grant: { ...grant, contentSha256: 'f'.repeat(64) } }).ok).toBe(false);
    expect(reviewPlanProposal(plan(), { ...CONFIG, classification: 'secret' }, { ...opts, grant }).ok).toBe(false);
  });

  it('declared restricted provenance needs a verified grant even when the project is internal', () => {
    const none = reviewPlanProposal(plan(), CONFIG, { ...opts, declaredRestricted: true });
    expect(!none.ok && none.error.code).toBe('proposal_not_acceptable');
    const ok = reviewPlanProposal(plan(), CONFIG, { ...opts, declaredRestricted: true, grant });
    expect(ok.ok && ok.value.tasks[0]!.classification).toBe('internal');
  });

  it('forbiddenMandatoryScope is required, not defaulted', () => {
    const { forbiddenMandatoryScope: _f, ...rest } = CONFIG;
    const r = reviewPlanProposal(plan(), rest as never, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('missing_server_config');
  });

  it('needs_review candidates require the issue paths to be acknowledged', () => {
    const e = plan({ data: { tasks: [{ title: 'Add login', description: 'D', requirementIds: ['FB-01'] }] } });
    const no = reviewPlanProposal(e, CONFIG, opts);
    expect(!no.ok && no.error.code).toBe('acknowledgement_required');
    const wrong = reviewPlanProposal(e, CONFIG, { ...opts, acknowledgedIssuePaths: ['forbidden_scope:/tasks/9/title'] });
    expect(wrong.ok).toBe(false);
    const yes = reviewPlanProposal(e, CONFIG, { ...opts, acknowledgedIssuePaths: ['forbidden_scope:/tasks/0/title'] });
    expect(yes.ok && yes.value.needsReview).toBe(true);
  });

  it('a null or malformed envelope returns an error instead of throwing', () => {
    expect(reviewPlanProposal(null as never, CONFIG, opts).ok).toBe(false);
    expect(reviewPlanProposal({} as never, CONFIG, opts).ok).toBe(false);
  });
});

describe('review and reclassification routes', () => {
  let t: TestDb;
  let h: Harness;
  const { tenantId: _t, projectId: _p, runId: _r, ...SETTINGS } = CONFIG;
  const mk = (settings: Record<string, unknown> = SETTINGS, policy = { ...API_POLICY, operations: { ...API_POLICY.operations, modify_policy: 'allow' } } as never) =>
    makeHarness(t, {}, policy, { planConfig: (pid: string) => (pid === PROJECT ? (settings as never) : undefined) });
  beforeAll(async () => { t = await setupTestDb(); h = mk(); await h.app.ready(); });
  afterAll(async () => { await h.app.close(); await t.close(); });
  beforeEach(async () => { await resetDb(t.db); });
  const count = async (table: string) => Number((await t.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`)))[0]!['n']);
  const review = (body: unknown, headers?: Record<string, string>) => post(h.app, `/v1/runs/${RUN}/proposals/review`, body, headers);
  const env = plan();

  it('re-validates on the request path, returns candidates and mutates nothing', async () => {
    const ok = await review({ envelope: env });
    expect(ok.status).toBe(200);
    expect(ok.body.expectedRevision).toBe(0);
    expect(ok.body.tasks[0]).toMatchObject({ title: 'Feedback form', baseSha: 'abc123', tenantId: TENANT, projectId: PROJECT, runId: RUN });
    expect(await count('task_revisions')).toBe(0);
    expect(await count('events')).toBe(0);

    const bad = await review({ envelope: { ...env, data: { tasks: [{ title: 'T', description: 'D', requirementIds: ['FB-05'] }] } } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('proposal_rejected');
    expect(JSON.stringify(bad.body)).not.toContain('FB-05');
    for (const status of ['route_violation', 'unverified_source']) {
      const r = await review({ envelope: { ...env, status } });
      expect(r.body.error.code, status).toBe('proposal_not_acceptable');
    }
    // The envelope is parsed; a null or missing one is a 400, never a thrown 500.
    expect((await review({ envelope: null })).status).toBe(400);
    expect((await review({})).status).toBe(400);
    expect((await review({ envelope: { operation: 'draftTaskPlan', status: null, data: {} } })).status).toBe(400);
  });

  it('is owner-only', async () => {
    const r = await review({ envelope: env }, bearer(INTRUDER_TOKEN));
    expect([401, 403]).toContain(r.status);
  });

  it('missing project configuration blocks', async () => {
    const none = makeHarness(t, {}, API_POLICY);
    await none.app.ready();
    const r = await post(none.app, `/v1/runs/${RUN}/proposals/review`, { envelope: env });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('missing_server_config');
    await none.app.close();
  });

  it('needs_review candidates come back only with the issue paths acknowledged', async () => {
    const e = { ...env, data: { tasks: [{ title: 'Add login', description: 'D', requirementIds: ['FB-01'] }] } };
    const no = await review({ envelope: e });
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe('acknowledgement_required');
    expect(no.body.error.details.paths).toEqual(['forbidden_scope:/tasks/0/title']);
    const yes = await review({ envelope: e, acknowledgedIssuePaths: ['forbidden_scope:/tasks/0/title'] });
    expect(yes.status).toBe(200);
    expect(yes.body.needsReview).toBe(true);
  });

  describe('restricted content', () => {
    const sha = createHash('sha256').update(canonicalJson(env.data)).digest('hex');
    const ask = (over: Record<string, unknown> = {}) =>
      post(h.app, `/v1/projects/${PROJECT}/draft-reclassifications`, { draftId: 'draft-1', contentSha256: sha, sourceClassification: 'restricted', targetClassification: 'internal', reason: 'owner approved sharing', ...over });

    it('a restricted project is refused without a grant and accepted with one bound to the content', async () => {
      const rh = mk({ ...SETTINGS, classification: 'restricted' });
      await rh.app.ready();
      const rr = (body: unknown) => post(rh.app, `/v1/runs/${RUN}/proposals/review`, body);
      expect((await rr({ envelope: env })).body.error.code).toBe('proposal_not_acceptable');

      const g = await post(rh.app, `/v1/projects/${PROJECT}/draft-reclassifications`, { draftId: 'draft-1', contentSha256: sha, sourceClassification: 'restricted', targetClassification: 'internal', reason: 'owner approved sharing' });
      expect(g.status).toBe(201);
      expect(g.body.grant).toMatchObject({ draftId: 'draft-1', contentSha256: sha, sourceClassification: 'restricted', targetClassification: 'internal', decision: { decision: 'allow', record: 'policy_decision' } });
      const rows = await t.db.execute(sql`SELECT context, rationale, author FROM decisions`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ author: 'owner_uid_1', rationale: 'owner approved sharing' });

      const withGrant = await rr({ envelope: env, restricted: { draftId: 'draft-1', grantId: g.body.grant.grantId } });
      expect(withGrant.status).toBe(200);
      expect(withGrant.body.tasks[0].classification).toBe('internal');

      // Changed content, another draft id or an invented grant id do not verify.
      const edited = { ...env, data: { tasks: [{ title: 'Other', description: 'D', requirementIds: ['FB-01'] }] } };
      expect((await rr({ envelope: edited, restricted: { draftId: 'draft-1', grantId: g.body.grant.grantId } })).status).toBe(422);
      expect((await rr({ envelope: env, restricted: { draftId: 'draft-2', grantId: g.body.grant.grantId } })).status).toBe(422);
      expect((await rr({ envelope: env, restricted: { draftId: 'draft-1', grantId: 'dec_invented' } })).status).toBe(422);
      await rh.app.close();
    });

    it('declared restricted provenance is verified whatever the project classification', async () => {
      const rr = (body: unknown) => review(body);
      const bad = await rr({ envelope: env, restricted: { draftId: 'draft-1', grantId: 'dec_invented' } });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('proposal_not_acceptable');
      const g = await ask();
      const good = await rr({ envelope: env, restricted: { draftId: 'draft-1', grantId: g.body.grant.grantId } });
      expect(good.status).toBe(200);
      expect(good.body.tasks[0].classification).toBe('internal');
    });

    it('a stored grant does not outlive the policy that allowed it', async () => {
      const g = await ask();
      const use = (hh: Harness) => post(hh.app, `/v1/runs/${RUN}/proposals/review`, { envelope: env, restricted: { draftId: 'draft-1', grantId: g.body.grant.grantId } });
      const denied = mk(SETTINGS, { ...API_POLICY, operations: { ...API_POLICY.operations, modify_policy: 'deny' } } as never);
      const newer = mk(SETTINGS, { ...API_POLICY, policyVersion: 'test.2', operations: { ...API_POLICY.operations, modify_policy: 'allow' } } as never);
      for (const hh of [denied, newer]) {
        await hh.app.ready();
        const r = await use(hh);
        expect(r.status).toBe(422);
        expect(r.body.error.code).toBe('proposal_not_acceptable');
        await hh.app.close();
      }
      expect((await use(h)).status).toBe(200);
    });

    it('a grant expires after the configured lifetime', async () => {
      const g = await ask();
      h.clock.advance(h.config.reclassificationGrantTtlSeconds - 1);
      expect((await review({ envelope: env, restricted: { draftId: 'draft-1', grantId: g.body.grant.grantId } })).status).toBe(200);
      h.clock.advance(2);
      expect((await review({ envelope: env, restricted: { draftId: 'draft-1', grantId: g.body.grant.grantId } })).status).toBe(422);
    });

    it('a newer grant for the same draft supersedes the older one', async () => {
      const first = await ask();
      const second = await ask({ reason: 'owner approved again' });
      const use = (id: string) => review({ envelope: env, restricted: { draftId: 'draft-1', grantId: id } });
      expect((await use(first.body.grant.grantId)).status).toBe(422);
      expect((await use(second.body.grant.grantId)).status).toBe(200);
    });

    it('a grant bound to a run is not usable on another', async () => {
      const g = await ask({ runId: 'run_other' });
      expect((await review({ envelope: env, restricted: { draftId: 'draft-1', grantId: g.body.grant.grantId } })).status).toBe(422);
      const own = await ask({ runId: RUN });
      expect((await review({ envelope: env, restricted: { draftId: 'draft-1', grantId: own.body.grant.grantId } })).status).toBe(200);
    });

    it('a very deep body is refused, not a 500', async () => {
      const deep = '['.repeat(20_000) + '1' + ']'.repeat(20_000);
      for (const restricted of ['"restricted":{"draftId":"draft-1","grantId":"dec_x"},', '']) {
        const res = await h.app.inject({
          method: 'POST', url: `/v1/runs/${RUN}/proposals/review`, headers: { ...owner(), 'content-type': 'application/json' },
          payload: `{${restricted}"envelope":{"operation":"draftTaskPlan","status":"ok","data":${deep}}}`,
        });
        expect(res.statusCode).toBeLessThan(500);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
      }
    });

    it('a denying policy records the decision and issues no grant; secret and empty reasons are refused', async () => {
      const dh = mk(SETTINGS, API_POLICY as never);
      await dh.app.ready();
      const r = await post(dh.app, `/v1/projects/${PROJECT}/draft-reclassifications`, { draftId: 'draft-1', contentSha256: sha, sourceClassification: 'restricted', targetClassification: 'internal', reason: 'try' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('policy_denied');
      expect(r.body.grant).toBeUndefined();
      expect(await count('decisions')).toBe(1);
      await dh.app.close();

      expect((await ask({ reason: '  ' })).status).toBe(400);
      expect((await ask({ sourceClassification: 'secret' })).status).toBe(422);
      expect((await ask({ targetClassification: 'restricted' })).status).toBe(400);
      expect((await ask({ text: 'restricted words' })).status).toBe(400);
      expect(await count('decisions')).toBe(1);
    });
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
    expect(stored).toMatchObject({ baseSha: 'abc123', allowedPaths: ['src'], title: 'Feedback form' });
  });
});

describe('loadPlanConfigFile (production source of project settings)', () => {
  const { tenantId: _t, projectId: _p, runId: _r, ...SETTINGS } = CONFIG;
  const write = (obj: unknown) => {
    const p = join(mkdtempSync(join(tmpdir(), 'plancfg-')), 'plan.json');
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  it('returns settings per project, nothing for unknown projects, and rejects incomplete files', () => {
    const src = loadPlanConfigFile(write({ projects: { [PROJECT]: SETTINGS } }));
    expect(src(PROJECT)?.baseSha).toBe('abc123');
    expect(src('other')).toBeUndefined();
    expect(src('__proto__')).toBeUndefined();
    const { limits: _l, ...noLimits } = SETTINGS;
    expect(() => loadPlanConfigFile(write({ projects: { [PROJECT]: noLimits } }))).toThrow();
  });
});
