import { describe, expect, it } from 'vitest';
import { allowedUseFor, buildContextBundle, compileBrain, type BrainSourceRevision } from './brain.ts';
import {
  briefSeed, buildProductTrace, canConfirmBrief, measureText, milestoneSummaries, OutcomePlanContentSchema, OutcomeReviewContentSchema, ProblemBriefContentSchema, productBrainSources,
  ProductRecordSchema, UNKNOWN_MEASURE, type OutcomePlanContent, type ProblemBriefContent, type ProductRecord, type TraceInput,
} from './product.ts';

const AT = '2026-11-10T08:00:00.000Z';
let seq = 0;

const BRIEF: ProblemBriefContent = {
  schemaVersion: 1, owner: 'owner_uid_1', targetUser: 'Team leads triaging feedback', evidence: [{ sourceId: 'brief:proj_a', revision: 1, anchor: 'goals/audience' }],
  permissionScope: 'Onboarding answers only', currentWorkaround: null, assumptions: ['Leads read the list daily'], desiredChange: 'See the newest feedback first', nonGoals: [], unknowns: ['How many leads use it'],
  confidence: 'unknown', confidenceRationale: null,
};
const PLAN: OutcomePlanContent = {
  schemaVersion: 1, requirementIds: ['FB-03'], milestone: 'First slice', metric: 'Minutes from submission to first triage', baseline: UNKNOWN_MEASURE, target: UNKNOWN_MEASURE,
  learningQuestion: 'Do leads triage sooner when newest is first?', windowDays: null, dataSource: null, cohort: null, guardrails: [], reviewOwner: 'owner_uid_1', reviewDate: null,
  decisionOptions: ['iterate', 'retain', 'disable', 'investigate'], reportLinks: [], confidence: 'unknown',
};

function rec(kind: ProductRecord['kind'], recordId: string, content: unknown, over: Partial<ProductRecord> = {}): ProductRecord {
  return ProductRecordSchema.parse({
    recordId, kind, revision: 1, status: kind === 'problem_brief' ? 'confirmed' : 'recorded', classification: 'internal', proposedBy: { kind: 'human', id: 'owner_uid_1' },
    confirmedBy: kind === 'problem_brief' ? 'owner_uid_1' : null, recordedAt: AT, seq: (seq += 1), content, ...over,
  });
}
const brief = (over: Partial<ProductRecord> = {}) => rec('problem_brief', 'brief', BRIEF, over);
const plan = (over: Partial<OutcomePlanContent> = {}) => rec('outcome_plan', 'plan:p1', { ...PLAN, ...over });
const release = (runId = 'run_a') => rec('release_note', 'release:r1', { schemaVersion: 1, runId, environment: 'production', configuration: null, releasedOn: '2026-11-12', note: null });
const review = (over: Record<string, unknown> = {}) => rec('outcome_review', 'review:v1', {
  schemaVersion: 1, planRecordId: 'plan:p1', releaseRecordId: 'release:r1', observedEnvironment: 'production', observedConfiguration: null, windowFrom: '2026-11-12', windowTo: '2026-11-26',
  evidence: [], result: UNKNOWN_MEASURE, summary: 'Too few triages to say', unknowns: ['Cohort size'], decision: 'investigate', followUp: null, ...over,
});

const input = (records: ProductRecord[], over: Partial<TraceInput> = {}): TraceInput => ({
  requirements: [{ id: 'FB-01', text: 'Create feedback' }, { id: 'FB-03', text: 'List newest first' }],
  tasks: [{ taskId: 'T1', runId: 'run_a', title: 'Build the API', status: 'merged', requirementIds: ['FB-01', 'FB-03'] }],
  runs: [{
    runId: 'run_a', candidate: { sha: 'c'.repeat(40), live: true, recordId: 'ver_1', recordValid: true },
    criteria: [{ criterionId: 'FB-01', state: 'passed', verified: true, candidateSha: 'c'.repeat(40) }, { criterionId: 'FB-03', state: 'passed', verified: true, candidateSha: 'c'.repeat(40) }],
    pullRequest: { prNumber: 12, url: 'https://github.com/o/r/pull/12', status: 'merged', mergeCommitSha: 'd'.repeat(40) },
  }],
  records, ...over,
});
const row = (rows: ReturnType<typeof buildProductTrace>, id: string) => rows.find((r) => r.requirementId === id)!;
const link = (r: ReturnType<typeof row>, kind: string) => r.links.find((l) => l.kind === kind)!;

describe('product records', () => {
  it('keeps unknown as unknown: a null baseline is never coerced, and a figure with no value cannot claim to be observed', () => {
    const parsed = OutcomePlanContentSchema.parse(PLAN);
    expect(parsed.baseline).toEqual({ value: null, unit: null, provenance: 'unavailable', basis: null });
    expect(OutcomePlanContentSchema.safeParse({ ...PLAN, baseline: { value: null, unit: null, provenance: 'observed', basis: null } }).success).toBe(false);
    expect(OutcomePlanContentSchema.safeParse({ ...PLAN, baseline: { value: 0, unit: null, provenance: 'unavailable', basis: null } }).success).toBe(false);
    expect(measureText(parsed.baseline)).toBe('Unknown');
    expect(measureText({ value: 12, unit: 'min', provenance: 'estimated', basis: null })).toBe('12 min (estimated)');
    expect(measureText({ value: 0, unit: null, provenance: 'observed', basis: null })).toBe('0 (observed)');
    // An unknown target needs a learning question in its place.
    expect(OutcomePlanContentSchema.safeParse({ ...PLAN, learningQuestion: null }).success).toBe(false);
  });

  it('refuses a review that records no decision and a brief with no target user', () => {
    expect(OutcomeReviewContentSchema.safeParse({ ...review().content, decision: 'ship' }).success).toBe(false);
    expect(ProblemBriefContentSchema.safeParse({ ...BRIEF, targetUser: '' }).success).toBe(false);
  });

  it('only a person can confirm a brief: a worker or the guide may only propose', () => {
    expect(canConfirmBrief('human')).toBe(true);
    for (const k of ['worker', 'scheduler', 'system', 'integration', 'verifier', 'guide']) expect(canConfirmBrief(k)).toBe(false);
  });

  it('seeds a brief from the onboarding brief, citing its anchors, with unknowns left unknown', () => {
    const seed = briefSeed({ owner: 'owner_uid_1', goals: { idea: 'A board', audience: 'Team leads', firstOutcome: 'Newest first' }, assumptions: ['a'], nonGoals: ['n'], briefSource: { sourceId: 'brief:proj_a', revision: 3, anchors: ['goals/idea', 'goals/audience', 'goals/first-outcome'] } });
    expect(seed).toMatchObject({ targetUser: 'Team leads', desiredChange: 'Newest first', currentWorkaround: null, confidence: 'unknown', assumptions: ['a'], nonGoals: ['n'] });
    expect(seed.evidence).toEqual([{ sourceId: 'brief:proj_a', revision: 3, anchor: 'goals/idea' }, { sourceId: 'brief:proj_a', revision: 3, anchor: 'goals/audience' }, { sourceId: 'brief:proj_a', revision: 3, anchor: 'goals/first-outcome' }]);
    expect(ProblemBriefContentSchema.safeParse(seed).success).toBe(true);
  });
});

describe('trace', () => {
  it('traces FB-03 to its brief, plan, task, candidate, verification and pull request, and names each missing link', () => {
    const none = row(buildProductTrace(input([], { runs: [{ runId: 'run_a', candidate: null, criteria: [], pullRequest: null }], tasks: [] })), 'FB-03');
    expect(none.links.map((l) => [l.kind, l.state])).toEqual([
      ['problem_brief', 'missing'], ['outcome_plan', 'missing'], ['task', 'missing'], ['candidate', 'missing'], ['verification', 'missing'], ['pull_request', 'missing'], ['merge', 'missing'], ['release', 'missing'], ['outcome_review', 'missing'],
    ]);
    for (const l of none.links) expect(l.label.length).toBeGreaterThan(0);

    const full = row(buildProductTrace(input([brief(), plan()])), 'FB-03');
    expect(link(full, 'problem_brief')).toMatchObject({ state: 'present', ref: 'brief@r1' });
    expect(link(full, 'outcome_plan')).toMatchObject({ state: 'present', ref: 'plan:p1@r1' });
    expect(link(full, 'task')).toMatchObject({ state: 'present', ref: 'T1' });
    expect(link(full, 'candidate')).toMatchObject({ state: 'present', ref: 'c'.repeat(40) });
    expect(link(full, 'verification')).toMatchObject({ state: 'present', ref: 'ver_1' });
    expect(link(full, 'pull_request')).toMatchObject({ state: 'present', ref: '#12' });
    expect(link(full, 'merge')).toMatchObject({ state: 'present' });
    // FB-01 has no outcome plan: that link alone is missing.
    expect(link(row(buildProductTrace(input([brief(), plan()])), 'FB-01'), 'outcome_plan').state).toBe('missing');
  });

  it('a proposed brief is shown as proposed, never as the confirmed brief', () => {
    const r = row(buildProductTrace(input([brief({ status: 'proposed', confirmedBy: null, proposedBy: { kind: 'worker', id: 'runner_1' } })])), 'FB-03');
    expect(link(r, 'problem_brief').state).toBe('proposed');
  });

  it('is Not released after a merge without a release note, and Awaiting observations once a release note exists', () => {
    const merged = row(buildProductTrace(input([brief(), plan()])), 'FB-03');
    expect(merged.release).toEqual({ state: 'not_released', label: 'Not released' });
    expect(merged.outcome).toMatchObject({ state: 'not_released', label: 'Not released' });

    const released = row(buildProductTrace(input([brief(), plan(), release()])), 'FB-03');
    expect(released.release.state).toBe('released');
    expect(released.outcome).toMatchObject({ state: 'awaiting_observations', label: 'Awaiting observations' });
    expect(link(released, 'outcome_review').state).toBe('missing');

    // A release note for a run that never merged is not a release.
    const unmerged = input([brief(), plan(), release()]);
    const notMerged = row(buildProductTrace({ ...unmerged, runs: [{ ...unmerged.runs[0]!, pullRequest: { prNumber: 12, url: 'u', status: 'open', mergeCommitSha: null } }] }), 'FB-03');
    expect(notMerged.release.state).toBe('not_released');
  });

  it('after a review, shows its decision, keeping an unknown result as insufficient data', () => {
    const unknown = row(buildProductTrace(input([brief(), plan(), release(), review()])), 'FB-03');
    expect(unknown.outcome).toMatchObject({ state: 'insufficient_data', label: 'Insufficient data', decision: 'investigate' });
    const known = row(buildProductTrace(input([brief(), plan(), release(), review({ result: { value: 9, unit: 'min', provenance: 'observed', basis: null }, decision: 'retain' })])), 'FB-03');
    expect(known.outcome).toMatchObject({ state: 'reviewed', label: 'Reviewed: retain', decision: 'retain' });
  });

  it('a milestone summary is derived per run, deterministic, with citations', () => {
    const i = input([brief(), plan(), release()]);
    const a = milestoneSummaries(i);
    expect(a).toEqual(milestoneSummaries(i));
    expect(a[0]).toMatchObject({ runId: 'run_a', requirementIds: ['FB-01', 'FB-03'], covered: 2, verified: 2, total: 2, release: { state: 'released' } });
    expect(a[0]!.outcomes).toEqual([{ state: 'awaiting_observations', label: 'Awaiting observations', count: 1 }, { state: 'no_outcome_plan', label: 'No outcome plan', count: 1 }]);
    expect(a[0]!.citations.map((c) => c.kind)).toEqual(expect.arrayContaining(['problem_brief', 'outcome_plan', 'verification_record', 'pull_request', 'release_note']));
  });
});

describe('product records as Project Brain sources', () => {
  const toRevision = (s: ReturnType<typeof productBrainSources>[number], i: number): BrainSourceRevision => ({
    sourceId: s.sourceId, revision: 1, kind: 'product', title: s.title, standing: s.standing, classification: s.classification, allowedUse: allowedUseFor(s.classification),
    provenance: { origin: 'product', ref: s.sourceId, recordedBy: 'owner_uid_1' }, derivedFrom: [], taskId: null, sections: s.sections, contentSha256: 'a'.repeat(64), seq: i + 1, recordedAt: AT,
  });

  it('states an unknown baseline as unknown, never as zero, and reads only a confirmed brief', () => {
    const sources = productBrainSources([brief({ status: 'proposed', confirmedBy: null }), plan()]);
    expect(sources.map((s) => s.sourceId)).toEqual(['product:plan:p1']);
    const baseline = sources[0]!.sections.find((s) => s.key === 'outcome:p1:baseline')!;
    expect(baseline.text).toBe('Unknown');
    expect(baseline.text).not.toMatch(/\b0\b/);
  });

  it('a restricted record is omitted from a streamable bundle and listed by source id only', () => {
    const sources = productBrainSources([brief({ classification: 'restricted' }), plan()]);
    const revisions = sources.map(toRevision);
    const compilation = compileBrain({ revisions, revocations: [], kept: new Set(), previous: [], version: 1, generatedAt: AT });
    const b = buildContextBundle({ compilation, revisions, revocations: [], sourceHead: revisions.length, destination: 'local', streamable: true, task: { taskId: 'T1', baseSha: 'c'.repeat(40), criteria: ['FB-03'], dependsOn: [] } });
    expect(b.claims.some((c) => c.key.startsWith('brief:'))).toBe(false);
    expect(b.claims.some((c) => c.key === 'outcome:p1:metric')).toBe(true);
    expect(b.omissions).toContainEqual({ kind: 'source', id: 'product:brief', reason: 'restricted_for_destination' });
    expect(JSON.stringify(b.omissions)).not.toContain('Team leads');
    // A local attempt whose output stays on the device gets it.
    const local = buildContextBundle({ compilation, revisions, revocations: [], sourceHead: revisions.length, destination: 'local', streamable: false, task: { taskId: 'T1', baseSha: 'c'.repeat(40), criteria: [], dependsOn: [] } });
    expect(local.claims.some((c) => c.key === 'brief:target_user')).toBe(true);
  });
});
