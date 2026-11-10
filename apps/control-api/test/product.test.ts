import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { blueprintFromAnswers, canonicalJson, UNKNOWN_MEASURE, VerificationRecordSchema } from '@selarikru/domain';
import { LocalDiskArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { loadValidRecord } from '../../../services/verifier/src/service.ts';
import { refreshBrains } from '../src/brain.ts';
import { bearer, enrolRunner, get, makeHarness, post, PROJECT, resetDb, RUN, seedTask, setupTestDb, specFor, TENANT, type Harness, type TestDb } from './helpers.ts';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'd'.repeat(40);
const TRUSTED = { checkManifestSha256: 'e'.repeat(64), verifierSha256: '1'.repeat(64) };
const url = `/v1/projects/${PROJECT}/product`;
const CANARY = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

let t: TestDb;
let h: Harness;
let dir: string;
let artifacts: LocalDiskArtifactStore;

beforeAll(async () => {
  t = await setupTestDb(8);
  dir = mkdtempSync(join(tmpdir(), 'product-'));
  artifacts = new LocalDiskArtifactStore(dir);
  h = makeHarness(t, {}, undefined, { evidence: { trusted: () => TRUSTED, artifacts, loadRecord: (key) => loadValidRecord(t.db, artifacts, key, { trusted: TRUSTED }) } });
  await h.app.ready();
});
afterAll(async () => {
  await h.app.close();
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb(t.db);
  await t.db.execute(sql`TRUNCATE runners, runner_pairing_codes, project_onboardings, project_blueprints CASCADE`);
  await t.db.execute(sql`UPDATE runs SET plan_revision = 1`);
});

const FB = [{ id: 'FB-01', text: 'Create feedback with a trimmed title' }, { id: 'FB-03', text: 'List feedback newest first' }];

async function seedOnboarding(): Promise<void> {
  const content = blueprintFromAnswers({ goal: { name: 'FB', idea: 'A feedback board', audience: 'Team leads triaging feedback', firstOutcome: 'See the newest feedback first' }, source: { kind: 'new' }, focus: { tracks: ['saas_web'], modelFeatures: 'no' } } as never);
  await t.db.execute(sql`INSERT INTO project_onboardings (tenant_id, project_id, name, name_key, state, accepted_blueprint_version, project_created, created_by) VALUES (${TENANT}, ${PROJECT}, 'FB', 'fb', 'activated', 1, true, 'owner_uid_1')`);
  await t.db.execute(sql`INSERT INTO project_blueprints (tenant_id, project_id, version, content, content_sha256, origin, created_by) VALUES (${TENANT}, ${PROJECT}, 1, ${JSON.stringify(content)}::jsonb, ${'f'.repeat(64)}, 'controller', 'owner_uid_1')`);
}

async function seedTaskFor(status = 'verified'): Promise<void> {
  await seedTask(t.db, specFor('T1', { title: 'Build the API', baseSha: BASE, allowedPaths: ['server'], requirementIds: ['FB-01', 'FB-03'], criteria: FB }), status);
}

/** A live candidate with a stored, applied verification record that passed FB-01 and FB-03. */
async function seedVerified(): Promise<void> {
  await t.db.execute(sql`INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, tree_sha, parts, status)
    VALUES (${TENANT}, ${PROJECT}, 'cand_1', ${RUN}, 'main', ${SHA}, ${BASE}, ${'c'.repeat(40)}, '[{"taskId":"T1"}]'::jsonb, 'assembled')`);
  const record = VerificationRecordSchema.parse({
    schemaVersion: 1, recordId: 'rec_1', taskId: 'T1', runId: RUN, partTaskIds: ['T1'], candidateSha: SHA, candidateTreeSha: 'c'.repeat(40),
    candidateContentSha256: 'd'.repeat(64), baseSha: BASE, contractRevisions: [], ...TRUSTED, toolVersions: {}, configVersions: {}, environmentImageDigest: 'sha256:img',
    host: 'local-docker', fixtures: [], startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z', result: 'passed', exitCode: 0,
    results: [{ checkId: 'FB-03', status: 'passed', tests: [{ runner: 'vitest', title: 'lists', status: 'passed' }], failures: [], evidenceReferences: [] }],
    runs: [{ attempt: 1, startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z', exitCode: 0, infrastructureError: null, results: [], resultArtifactId: null, logArtifactId: null }],
    flaky: [], taskOutcomes: [], artifactIds: [], verifier: { kind: 'verifier', id: 'verifier-local-1' },
  });
  const ref = await artifacts.put(Buffer.from(JSON.stringify(record)));
  for (const id of ['FB-01', 'FB-03']) {
    await t.db.execute(sql`INSERT INTO check_runs (tenant_id, project_id, check_run_id, task_id, revision, attempt_id, check_id, check_version, candidate_sha, result)
      VALUES (${TENANT}, ${PROJECT}, ${`chk_${id}`}, 'T1', 1, NULL, ${id}, '1', ${SHA}, 'passed')`);
  }
  await t.db.execute(sql`INSERT INTO artifacts (tenant_id, project_id, artifact_id, run_id, type, sha256, source_revision, classification, locator)
    VALUES (${TENANT}, ${PROJECT}, 'rec_1', ${RUN}, 'verification_record', ${ref.sha256}, ${SHA}, 'internal', ${JSON.stringify({ recordId: 'rec_1', candidateSha: SHA, applied: true, checkRunIds: ['chk_FB-01', 'chk_FB-03'] })}::jsonb)`);
}
const seedPr = (status = 'open', mergeCommitSha: string | null = null) => t.db.execute(sql`INSERT INTO change_requests (tenant_id, project_id, run_id, repository, candidate_sha, branch, base_ref, pr_number, url, status, merge_commit_sha)
  VALUES (${TENANT}, ${PROJECT}, ${RUN}, 'acme/fb', ${SHA}, 'selarikru/run', 'main', 12, 'https://github.com/acme/fb/pull/12', ${status}, ${mergeCommitSha})
  ON CONFLICT (tenant_id, project_id, run_id) DO UPDATE SET status = EXCLUDED.status, merge_commit_sha = EXCLUDED.merge_commit_sha`);

const plan = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, requirementIds: ['FB-03'], milestone: 'First slice', metric: 'Minutes from submission to first triage', baseline: UNKNOWN_MEASURE, target: UNKNOWN_MEASURE,
  learningQuestion: 'Do leads triage sooner when the newest is first?', windowDays: 14, dataSource: null, cohort: null, guardrails: ['No drop in submissions'], reviewOwner: 'owner_uid_1',
  reviewDate: null, decisionOptions: ['iterate', 'retain', 'disable', 'investigate'], reportLinks: [{ kind: 'prototype_report', label: 'Paper prototype notes', url: 'https://example.com/proto' }], confidence: 'unknown', ...over,
});
const release = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, runId: RUN, environment: 'production', configuration: null, releasedOn: '2026-11-12', note: null, ...over });
const review = (planRecordId: string, releaseRecordId: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, planRecordId, releaseRecordId, observedEnvironment: 'production', observedConfiguration: null, windowFrom: '2026-11-12', windowTo: '2026-11-26', evidence: [],
  result: UNKNOWN_MEASURE, summary: 'Too few triages in the window to say', unknowns: ['How many leads used it'], decision: 'iterate', followUp: null, ...over,
});

async function confirmSeed(over: Record<string, unknown> = {}): Promise<any> {
  const view = (await get(h.app, url)).body;
  return post(h.app, `${url}/brief`, { expectedRevision: view.brief.revision, confirm: true, content: { ...view.brief.seed, ...over } });
}
const productEvents = () => t.db.execute(sql`SELECT type, actor_kind, actor_id, payload FROM events WHERE type LIKE 'product.%' ORDER BY sequence`);
const row = (view: any, id: string) => view.trace.find((r: any) => r.requirementId === id);
const link = (r: any, kind: string) => r.links.find((l: any) => l.kind === kind);

describe('product records: brief, outcome plan and trace', () => {
  it('traces FB-03 to its brief, plan, task, candidate, verification and pull request, naming each missing link', async () => {
    await seedOnboarding();
    let view = (await get(h.app, url)).body;
    let fb03 = row(view, 'FB-03');
    expect(fb03.links.map((l: any) => [l.kind, l.state])).toEqual([
      ['problem_brief', 'missing'], ['outcome_plan', 'missing'], ['task', 'missing'], ['candidate', 'missing'], ['verification', 'missing'], ['pull_request', 'missing'], ['merge', 'missing'], ['release', 'missing'], ['outcome_review', 'missing'],
    ]);
    // The seed comes from the onboarding brief and cites the accepted brief's anchors in the Project Brain.
    expect(view.brief.seed).toMatchObject({ targetUser: 'Team leads triaging feedback', desiredChange: 'See the newest feedback first', currentWorkaround: null, confidence: 'unknown' });
    expect(view.brief.seed.evidence).toContainEqual({ sourceId: `brief:${PROJECT}`, revision: 1, anchor: 'goals/audience' });
    expect(view.notice).toMatch(/no customer outreach and no connection to production data/);

    expect((await confirmSeed()).status).toBe(201);
    const p = await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan() });
    expect(p.status).toBe(201);
    await seedTaskFor();
    await seedVerified();
    await seedPr();

    view = (await get(h.app, url)).body;
    fb03 = row(view, 'FB-03');
    expect(link(fb03, 'problem_brief')).toMatchObject({ state: 'present', ref: 'brief@r1' });
    expect(link(fb03, 'outcome_plan')).toMatchObject({ state: 'present', ref: `${p.body.record.recordId}@r1` });
    expect(link(fb03, 'task')).toMatchObject({ state: 'present', ref: 'T1' });
    expect(link(fb03, 'candidate')).toMatchObject({ state: 'present', ref: SHA });
    expect(link(fb03, 'verification')).toMatchObject({ state: 'present', ref: 'rec_1' });
    expect(link(fb03, 'pull_request')).toMatchObject({ state: 'present', ref: '#12' });
    expect(link(fb03, 'merge')).toMatchObject({ state: 'missing' });
    expect(fb03.outcome).toMatchObject({ state: 'not_released', label: 'Not released' });
    // FB-01 has no outcome plan, and says so.
    expect(link(row(view, 'FB-01'), 'outcome_plan')).toMatchObject({ state: 'missing', label: 'No outcome plan names FB-01' });
    expect(view.milestones[0]).toMatchObject({ runId: RUN, covered: 2, verified: 2, release: { state: 'not_released' } });
  });

  it('is Not released after a merge without a release note, and Awaiting observations after the release note; a release needs a merge', async () => {
    await seedOnboarding();
    await confirmSeed();
    const p = await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan() });
    await seedTaskFor('merged');
    await seedVerified();
    await seedPr();
    // Not merged yet: a release note is refused.
    const early = await post(h.app, `${url}/releases`, { content: release() });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('product_not_merged');

    await seedPr('merged', MERGE);
    let fb03 = row((await get(h.app, url)).body, 'FB-03');
    expect(link(fb03, 'merge').state).toBe('present');
    expect(fb03.release).toEqual({ state: 'not_released', label: 'Not released' });
    expect(fb03.outcome.label).toBe('Not released');

    const r = await post(h.app, `${url}/releases`, { content: release() });
    expect(r.status).toBe(201);
    fb03 = row((await get(h.app, url)).body, 'FB-03');
    expect(fb03.release.state).toBe('released');
    expect(fb03.outcome).toMatchObject({ state: 'awaiting_observations', label: 'Awaiting observations' });
    expect(p.body.record.recordId).toMatch(/^plan:/);
  });

  it('keeps an unknown baseline unknown through the API and the Project Brain: never 0', async () => {
    await seedOnboarding();
    const p = await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan() });
    expect(p.status).toBe(201);
    expect(p.body.record.content.baseline).toEqual({ value: null, unit: null, provenance: 'unavailable', basis: null });
    expect((await get(h.app, url)).body.plans[0].content.baseline.value).toBeNull();
    // A body that leaves the value out is not filled in with a number.
    const missing = await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan({ baseline: { unit: null, provenance: 'observed', basis: null } }) });
    expect(missing.status).toBe(400);

    const brain = (await get(h.app, `/v1/projects/${PROJECT}/brain`)).body;
    const k = p.body.record.recordId.split(':')[1];
    const baseline = brain.compilation.pages.flatMap((pg: any) => pg.claims).find((c: any) => c.key === `outcome:${k}:baseline`);
    expect(baseline).toMatchObject({ text: 'Unknown', status: 'current', citations: [{ sourceId: `product:${p.body.record.recordId}`, revision: 1, anchor: `plan/${k}/baseline` }] });
    expect(brain.sources.find((s: any) => s.sourceId === `product:${p.body.record.recordId}`)).toMatchObject({ kind: 'product', provenance: { origin: 'product', recordedBy: 'owner_uid_1' } });
  });

  it('an outcome review cannot change a merged task, and its follow-up is a proposal, not a task', async () => {
    await seedOnboarding();
    await confirmSeed();
    const p = await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan() });
    await seedTaskFor('merged');
    await seedVerified();
    await seedPr('merged', MERGE);
    const r = await post(h.app, `${url}/releases`, { content: release() });
    const before = await t.db.execute(sql`SELECT task_id, status, current_revision, row_revision FROM task_status ORDER BY task_id`);
    const revisions = await t.db.execute(sql`SELECT count(*)::int AS n FROM task_revisions`);
    const v = await post(h.app, `${url}/outcome-reviews`, { content: review(p.body.record.recordId, r.body.record.recordId, { followUp: { title: 'Show a triage age on each item', requirementIds: ['FB-03'], reason: 'Leads could not tell what was new' } }) });
    expect(v.status).toBe(201);
    expect(await t.db.execute(sql`SELECT task_id, status, current_revision, row_revision FROM task_status ORDER BY task_id`)).toEqual(before);
    expect(await t.db.execute(sql`SELECT count(*)::int AS n FROM task_revisions`)).toEqual(revisions);
    expect((await t.db.execute(sql`SELECT count(*)::int AS n FROM plan_proposals`))[0]!['n']).toBe(0);

    const view = (await get(h.app, url)).body;
    expect(view.followUps).toEqual([{ reviewRecordId: v.body.record.recordId, title: 'Show a triage age on each item', requirementIds: ['FB-03'], reason: 'Leads could not tell what was new', decision: 'iterate', state: 'proposed' }]);
    // Unknown result: the outcome reads Insufficient data, with the decision kept.
    expect(row(view, 'FB-03').outcome).toMatchObject({ state: 'insufficient_data', decision: 'iterate' });
    // A review is recorded, never silent: an event with the owner as actor says a follow-up was proposed.
    const events = await productEvents();
    expect(events.at(-1)).toMatchObject({ type: 'product.recorded', actor_kind: 'human', actor_id: 'owner_uid_1', payload: { kind: 'outcome_review', action: 'outcome_review_recorded', followUpProposed: true } });
    // A review must name a plan and a release that exist.
    expect((await post(h.app, `${url}/outcome-reviews`, { content: review('plan:nope', r.body.record.recordId) })).status).toBe(404);
  });

  it('agents can propose a brief but not confirm one', async () => {
    await seedOnboarding();
    await seedTask(t.db, specFor('T1', { title: 'Build the API', baseSha: BASE, requirementIds: ['FB-03'], criteria: [FB[1]!] }), 'ready');
    const { token, runnerId } = await enrolRunner(h.app);
    await refreshBrains({ db: t.db, tenantId: TENANT, now: h.clock.now });
    const claim = await post(h.app, '/v1/runners/claim', {}, bearer(token));
    const lease = { attemptId: claim.body.lease.attemptId, fence: claim.body.lease.fence, leaseToken: claim.body.lease.leaseToken };
    const seed = (await get(h.app, url)).body.brief.seed;

    // The confirm route is the owner's: a runner token cannot reach it.
    const asRunner = await post(h.app, `${url}/brief`, { expectedRevision: 0, confirm: true, content: seed }, bearer(token));
    expect([401, 403]).toContain(asRunner.status);

    const proposed = await post(h.app, '/v1/runners/product/brief-proposal', { lease, content: { ...seed, desiredChange: `Newest first, token ${CANARY}` } }, bearer(token));
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ proposalId: expect.stringMatching(/^proposal_/), status: 'proposed' });
    let view = (await get(h.app, url)).body;
    expect(view.brief.confirmed).toBeNull();
    // Kept beside the brief: the owner's revision line is untouched.
    expect(view.brief.latest).toBeNull();
    expect(view.brief.revision).toBe(0);
    expect(view.brief.proposals[0]).toMatchObject({ proposalId: proposed.body.proposalId, proposedBy: { kind: 'worker', id: runnerId } });
    expect(view.brief.proposals[0].content.desiredChange).not.toContain(CANARY);
    expect(link(row(view, 'FB-03'), 'problem_brief').state).toBe('proposed');
    // A proposal is not a Brain source: it is never served as accepted.
    expect((await get(h.app, `/v1/projects/${PROJECT}/brain`)).body.sources.some((s: any) => s.sourceId === 'product:brief')).toBe(false);
    // The database itself refuses a worker's confirmed revision.
    await expect(t.db.execute(sql`INSERT INTO product_records (tenant_id, project_id, record_id, revision, kind, status, classification, content, proposed_by_kind, proposed_by, confirmed_by, seq, recorded_at)
      VALUES (${TENANT}, ${PROJECT}, 'brief', 9, 'problem_brief', 'confirmed', 'internal', '{}'::jsonb, 'worker', ${runnerId}, ${runnerId}, 99, now())`)).rejects.toThrow();

    // A person confirms it, against the revision they read.
    expect((await post(h.app, `${url}/brief`, { expectedRevision: 1, confirm: true, content: view.brief.proposals[0].content })).status).toBe(409);
    const confirmed = await post(h.app, `${url}/brief`, { expectedRevision: 0, confirm: true, content: view.brief.proposals[0].content, fromProposalId: view.brief.proposals[0].proposalId });
    expect(confirmed.status).toBe(201);
    view = (await get(h.app, url)).body;
    expect(view.brief.confirmed).toMatchObject({ revision: 1, status: 'confirmed', confirmedBy: 'owner_uid_1', proposedBy: { kind: 'human' } });

    const events = await productEvents();
    expect(events.map((e: any) => [e.type, e.actor_kind])).toEqual([['product.proposed', 'worker'], ['product.recorded', 'human']]);
    expect(JSON.stringify(events)).not.toContain('Newest first');

    // Restricted work's words stay on the device: no proposal from it.
    await t.db.execute(sql`UPDATE attempts SET detail = jsonb_set(detail, '{terminalStreamable}', 'false')`);
    const restricted = await post(h.app, '/v1/runners/product/brief-proposal', { lease, content: seed }, bearer(token));
    expect(restricted.status).toBe(403);
  });

  it('redacts secrets in owner text and records every write as an owner event carrying ids only', async () => {
    await seedOnboarding();
    const res = await confirmSeed({ currentWorkaround: `They paste ${CANARY} into a sheet` });
    expect(res.status).toBe(201);
    expect(res.body.redacted).toBe(true);
    const stored = await t.db.execute(sql`SELECT content::text AS c FROM product_records`);
    expect(String(stored[0]!['c'])).not.toContain(CANARY);
    const events = await productEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'product.recorded', actor_kind: 'human', actor_id: 'owner_uid_1', payload: { recordId: 'brief', kind: 'problem_brief', revision: 1, status: 'confirmed', action: 'brief_confirmed' } });
    expect(JSON.stringify(events)).not.toContain('sheet');
    // History cannot be rewritten.
    await expect(t.db.execute(sql`UPDATE product_records SET status = 'proposed'`)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/immutable/) } });
    // A plan naming a requirement this project does not have is refused.
    const unknown = await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan({ requirementIds: ['FB-99'] }) });
    expect(unknown.body.error?.code).toBe('product_requirement_unknown');
  });

  it('a record takes the strongest label of what it cites, and a restricted brief is left out of a streamable bundle', async () => {
    await seedOnboarding();
    await seedTask(t.db, specFor('T1', { title: 'Build the API', baseSha: BASE, requirementIds: ['FB-03'], criteria: [FB[1]!] }), 'ready');
    const n = await post(h.app, `/v1/projects/${PROJECT}/brain/notes`, { title: 'Interview', classification: 'restricted', sections: [{ heading: 'Acme interview', text: 'Acme leads miss new items' }] });
    expect(n.status).toBe(201);
    // A citation that does not resolve is refused.
    const bad = await confirmSeed({ evidence: [{ sourceId: n.body.source.sourceId, revision: 1, anchor: 'nope' }] });
    expect(bad.body.error?.code).toBe('product_citation_invalid');
    const res = await confirmSeed({ evidence: [{ sourceId: n.body.source.sourceId, revision: 1, anchor: 'section-1' }], targetUser: 'Acme team leads' });
    expect(res.status).toBe(201);
    expect(res.body.record.classification).toBe('restricted');
    const brain = (await get(h.app, `/v1/projects/${PROJECT}/brain`)).body;
    expect(brain.sources.find((s: any) => s.sourceId === 'product:brief')).toMatchObject({ classification: 'restricted', allowedUse: ['local'] });

    const { token } = await enrolRunner(h.app);
    await refreshBrains({ db: t.db, tenantId: TENANT, now: h.clock.now });
    const claim = await post(h.app, '/v1/runners/claim', {}, bearer(token));
    expect(claim.body.lease).toMatchObject({ taskId: 'T1', streamable: true });
    expect(JSON.stringify(claim.body.lease.context)).not.toContain('Acme team leads');
    expect(claim.body.lease.context.omissions).toContainEqual({ kind: 'source', id: 'product:brief', reason: 'restricted_for_destination' });
  });

  it('a brief can be confirmed before any run exists; its event is appended, in order, once the first run exists', async () => {
    await seedOnboarding();
    await t.db.execute(sql`DELETE FROM runs`);
    const seed = (await get(h.app, url)).body.brief.seed;
    const res = await post(h.app, `${url}/brief`, { expectedRevision: 0, confirm: true, content: seed });
    expect(res.status).toBe(201);
    expect(res.body.record).toMatchObject({ status: 'confirmed', confirmedBy: 'owner_uid_1' });
    expect(await productEvents()).toHaveLength(0);
    // The first run: the next write appends the deferred event first, then its own.
    await t.db.execute(sql`INSERT INTO runs (tenant_id, project_id, run_id, lifecycle, budget) VALUES (${TENANT}, ${PROJECT}, ${RUN}, 'running', '{"limitUsd":10}'::jsonb)`);
    expect((await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan({ requirementIds: ['FB-03'] }) })).status).toBe(201);
    const events = await productEvents();
    expect(events.map((e: any) => [e.payload.action, e.payload.deferred ?? false])).toEqual([['brief_confirmed', true], ['outcome_plan_added', false]]);
    expect(events[0]).toMatchObject({ actor_kind: 'human', actor_id: 'owner_uid_1' });
  });
});

async function claimLease(): Promise<{ token: string; runnerId: string; lease: { attemptId: string; fence: number; leaseToken: string } }> {
  await seedTask(t.db, specFor('T1', { title: 'Build the API', baseSha: BASE, requirementIds: ['FB-03'], criteria: [FB[1]!] }), 'ready');
  const { token, runnerId } = await enrolRunner(h.app);
  await refreshBrains({ db: t.db, tenantId: TENANT, now: h.clock.now });
  const claim = await post(h.app, '/v1/runners/claim', {}, bearer(token));
  return { token, runnerId, lease: { attemptId: claim.body.lease.attemptId, fence: claim.body.lease.fence, leaseToken: claim.body.lease.leaseToken } };
}
const propose = (token: string, lease: unknown, content: unknown) => post(h.app, '/v1/runners/product/brief-proposal', { lease, content }, bearer(token));

describe('fix round 1', () => {
  it('I1: a released requirement stays released after a second run is planned, each run keeps its summary, and a requirement ever accepted can get a plan', async () => {
    await seedOnboarding();
    await seedTask(t.db, specFor('T1', { title: 'Build', baseSha: BASE, requirementIds: ['FB-03', 'ZZ-1'], criteria: [FB[1]!] }), 'merged');
    await seedPr('merged', MERGE);
    expect((await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan() })).status).toBe(201);
    expect((await post(h.app, `${url}/releases`, { content: release() })).status).toBe(201);
    expect(row((await get(h.app, url)).body, 'FB-03').outcome.label).toBe('Awaiting observations');

    await t.db.execute(sql`INSERT INTO runs (tenant_id, project_id, run_id, lifecycle, budget, plan_revision, created_at) VALUES (${TENANT}, ${PROJECT}, 'run_2', 'running', '{"limitUsd":10}'::jsonb, 1, now() + interval '1 hour')`);
    await seedTask(t.db, specFor('T2', { runId: 'run_2', title: 'Next', baseSha: BASE, requirementIds: ['FB-05'] }), 'ready');
    const v = (await get(h.app, url)).body;
    const fb03 = row(v, 'FB-03');
    expect(fb03.release.state).toBe('released');
    expect(fb03.outcome.label).toBe('Awaiting observations');
    expect(link(fb03, 'task')).toMatchObject({ state: 'missing', label: expect.stringMatching(/^Not in the current plan/) });
    expect(v.milestones.map((m: any) => [m.runId, m.release.state])).toEqual([[RUN, 'released'], ['run_2', 'not_released']]);
    expect((await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan({ requirementIds: ['ZZ-1'] }) })).status).toBe(201);
  });

  it('M2: the brief proposal refuses a wrong fence, a wrong token, another runner, an ended attempt and an expired lease', async () => {
    await seedOnboarding();
    const { token, lease } = await claimLease();
    const seed = (await get(h.app, url)).body.brief.seed;
    expect((await propose(token, { ...lease, fence: lease.fence + 1 }, seed)).status).toBe(409);
    expect((await propose(token, { ...lease, leaseToken: 'x'.repeat(lease.leaseToken.length) }, seed)).status).toBe(409);
    const other = await enrolRunner(h.app);
    expect((await propose(other.token, lease, seed)).status).toBe(409);
    h.clock.advance(600);
    expect((await propose(token, lease, seed)).status).toBe(409);
    await t.db.execute(sql`UPDATE attempts SET ended_at = now(), lease_expires_at = now() + interval '1 day'`);
    expect((await propose(token, lease, seed)).status).toBe(409);
    expect((await t.db.execute(sql`SELECT count(*)::int AS n FROM product_brief_proposals`))[0]!['n']).toBe(0);
  });

  it('M4: restricted work is refused before its body is read', async () => {
    await seedOnboarding();
    const { token, lease } = await claimLease();
    await t.db.execute(sql`UPDATE attempts SET detail = jsonb_set(detail, '{terminalStreamable}', 'false')`);
    const res = await propose(token, lease, { not: 'a brief' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('product_proposal_restricted');
  });

  it('M3: worker proposals sit beside the brief, never move the owner\'s revision or prefill the form, and only the newest five are kept', async () => {
    await seedOnboarding();
    const { token, lease } = await claimLease();
    const v0 = (await get(h.app, url)).body;
    expect((await post(h.app, `${url}/brief`, { expectedRevision: 0, confirm: true, content: { ...v0.brief.seed, targetUser: 'OWNER USER' } })).status).toBe(201);
    const seen = (await get(h.app, url)).body;
    for (let i = 1; i <= 6; i++) expect((await propose(token, lease, { ...v0.brief.seed, targetUser: `WORKER ${i}` })).status).toBe(201);
    const v = (await get(h.app, url)).body;
    expect(v.brief.revision).toBe(seen.brief.revision);
    expect(v.brief.seed.targetUser).toBe('OWNER USER');
    expect(v.brief.confirmed.content.targetUser).toBe('OWNER USER');
    expect(v.brief.proposals.map((p: any) => p.content.targetUser)).toEqual(['WORKER 6', 'WORKER 5', 'WORKER 4', 'WORKER 3', 'WORKER 2']);
    expect(v.brief.droppedProposals).toBe(1);
    // The owner saves against the revision they read, and what is confirmed is the owner's text.
    const saved = await post(h.app, `${url}/brief`, { expectedRevision: seen.brief.revision, confirm: true, content: { ...v0.brief.seed, targetUser: 'OWNER EDIT' } });
    expect(saved.status).toBe(201);
    expect(saved.body.record.content.targetUser).toBe('OWNER EDIT');
    // Using a proposal is explicit and recorded.
    const used = await post(h.app, `${url}/brief`, { expectedRevision: 2, confirm: true, content: v.brief.proposals[0].content, fromProposalId: v.brief.proposals[0].proposalId });
    expect(used.status).toBe(201);
    expect((await productEvents()).at(-1)).toMatchObject({ type: 'product.recorded', payload: { action: 'brief_confirmed', fromProposalId: v.brief.proposals[0].proposalId } });
    expect((await get(h.app, url)).body.brief.proposals.map((p: any) => p.proposalId)).not.toContain(v.brief.proposals[0].proposalId);
  });

  it('M8: a review must be of a release whose run carries the plan\'s requirements, and a follow-up names accepted requirements', async () => {
    await seedOnboarding();
    await seedTaskFor('merged');
    await seedPr('merged', MERGE);
    const other = await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan({ requirementIds: ['FB-05'] }) });
    const p = await post(h.app, `${url}/outcome-plans`, { recordId: null, expectedRevision: 0, content: plan() });
    const r = await post(h.app, `${url}/releases`, { content: release() });
    const mismatch = await post(h.app, `${url}/outcome-reviews`, { content: review(other.body.record.recordId, r.body.record.recordId) });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('product_requirement_mismatch');
    const badFollow = await post(h.app, `${url}/outcome-reviews`, { content: review(p.body.record.recordId, r.body.record.recordId, { followUp: { title: 'x', requirementIds: ['FB-99'], reason: 'y' } }) });
    expect(badFollow.body.error.code).toBe('product_requirement_unknown');
    expect((await post(h.app, `${url}/outcome-reviews`, { content: review(p.body.record.recordId, r.body.record.recordId) })).status).toBe(201);
  });

  it('M9: reading the product view does not take the brain lock when the records have not moved', async () => {
    await seedOnboarding();
    await get(h.app, url);
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.execute(sql`SELECT 1 FROM brain_heads WHERE tenant_id = ${TENANT} AND project_id = ${PROJECT} FOR UPDATE`);
      let timer: NodeJS.Timeout | undefined;
      try {
        const read = await Promise.race([get(h.app, url), new Promise<'blocked'>((resolve) => { timer = setTimeout(() => resolve('blocked'), 4_000); })]);
        expect(read === 'blocked' ? 'blocked' : (read as any).status).toBe(200);
      } finally {
        clearTimeout(timer);
      }
    });
  });

  it('M7: the write answers with whether text was redacted', async () => {
    await seedOnboarding();
    const clean = await confirmSeed();
    expect(clean.body.redacted).toBe(false);
  });
});

describe('fix round 2', () => {
  it('a backlog written before any run is flushed when a run is created, with no further product write, every row marked deferred under a frozen clock', async () => {
    // A project set up outside onboarding, so a run can be created directly; it has no run yet.
    await t.db.execute(sql`DELETE FROM runs`);
    const content = { schemaVersion: 1, owner: 'owner_uid_1', targetUser: 'Team leads', evidence: [], permissionScope: 'Owner notes only', currentWorkaround: null, assumptions: [], desiredChange: 'Newest first', nonGoals: [], unknowns: [], confidence: 'unknown', confidenceRationale: null };
    // The clock does not move: deferral is read from the log position, not from time.
    expect((await post(h.app, `${url}/brief`, { expectedRevision: 0, confirm: false, content })).status).toBe(201);
    expect((await post(h.app, `${url}/brief`, { expectedRevision: 1, confirm: true, content })).status).toBe(201);
    expect(await productEvents()).toHaveLength(0);
    const run = await post(h.app, `/v1/projects/${PROJECT}/runs`, { idempotencyKey: 'r2-run', title: 'First run', budgetLimitUsd: 5 });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const events = await productEvents();
    expect(events.map((e: any) => [e.payload.action, e.payload.deferred])).toEqual([['brief_saved', true], ['brief_confirmed', true]]);
    // The next write is the current one: not deferred.
    expect((await post(h.app, `${url}/brief`, { expectedRevision: 2, confirm: true, content })).status).toBe(201);
    expect(((await productEvents()).at(-1) as any).payload.deferred).toBeUndefined();
  });

  it('the periodic Brain pass flushes a backlog too', async () => {
    await seedOnboarding();
    await t.db.execute(sql`DELETE FROM runs`);
    expect((await confirmSeed()).status).toBe(201);
    // A run that appeared without any route (a seed script): only the periodic pass can see it.
    await t.db.execute(sql`INSERT INTO runs (tenant_id, project_id, run_id, lifecycle, budget) VALUES (${TENANT}, ${PROJECT}, ${RUN}, 'running', '{"limitUsd":10}'::jsonb)`);
    await refreshBrains({ db: t.db, tenantId: TENANT, now: h.clock.now });
    expect((await productEvents()).map((e: any) => e.payload.deferred)).toEqual([true]);
  });

  it('a worker proposal leaves an audit of what was proposed (digest and length, no text) after it is used or dropped', async () => {
    await seedOnboarding();
    const { token, lease } = await claimLease();
    const seed = (await get(h.app, url)).body.brief.seed;
    const p1 = await propose(token, lease, { ...seed, targetUser: 'FIRST WORKER TEXT' });
    const shown = (await get(h.app, url)).body.brief.proposals[0];
    for (let i = 0; i < 5; i++) await propose(token, lease, { ...seed, targetUser: `LATER ${i}` });
    const audit = await t.db.execute(sql`SELECT proposal_id, content_sha256, content_length, outcome FROM product_proposal_audit ORDER BY proposal_id`);
    const first = audit.find((r: any) => r['proposal_id'] === p1.body.proposalId) as Record<string, unknown>;
    const text = canonicalJson(shown.content);
    expect(first).toMatchObject({ content_sha256: createHash('sha256').update(text).digest('hex'), content_length: text.length, outcome: 'dropped' });
    expect(JSON.stringify(await t.db.execute(sql`SELECT * FROM product_brief_proposals`))).not.toContain('FIRST WORKER TEXT');
    expect(JSON.stringify(audit)).not.toContain('WORKER');
    const ev = (await productEvents()).find((e: any) => e.payload.proposalId === p1.body.proposalId)!;
    expect(ev.payload).toMatchObject({ contentSha256: first['content_sha256'], contentLength: text.length });

    const used = (await get(h.app, url)).body.brief.proposals[0];
    expect((await post(h.app, `${url}/brief`, { expectedRevision: 0, confirm: true, content: used.content, fromProposalId: used.proposalId })).status).toBe(201);
    const after = await t.db.execute(sql`SELECT outcome FROM product_proposal_audit WHERE proposal_id = ${used.proposalId}`);
    expect(after[0]!['outcome']).toBe('used');
    expect((await t.db.execute(sql`SELECT count(*)::int AS n FROM product_proposal_audit`))[0]!['n']).toBe(6);
  });
});
