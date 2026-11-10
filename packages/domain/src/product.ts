import { z } from 'zod';
import { BrainCitationSchema, BrainClassificationSchema, type BrainClassification, type BrainSection } from './brain.ts';

/**
 * Product-learning records (docs/product-engineer-alignment.md §4, phase 1 of §7): a problem brief, an outcome plan, a manual release note and a manual outcome review. Versioned
 * and immutable: an edit is a new revision. Pure and browser-safe, so the server, the demo and the screens derive the same trace and summaries.
 *
 * Unknown is a value of its own. A figure with no value is `unavailable` (the provenance labels every usage figure carries), a text with no answer is null, and confidence can be
 * `unknown`. Nothing here turns an unknown into 0, an empty string or a guess.
 *
 * Release and outcome states come from records, never from time: `Not released` until a merge and a release note for that run both exist; `Awaiting observations` once released
 * with an outcome plan that no review has answered; then the review's result. A merge alone is not a release. A review records a person's decision and never changes a task.
 */

const Text = (max: number) => z.string().trim().min(1).max(max);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a date (YYYY-MM-DD)');
/** A requirement or criterion id, as plans and blueprints name them. */
export const RequirementIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/, 'expected a requirement id');

/** What creating a brief does not do. Shown with every brief. */
export const PRODUCT_NOTICE = 'A brief records a problem. It authorizes no customer outreach and no connection to production data.';

export const PRODUCT_RECORD_KINDS = ['problem_brief', 'outcome_plan', 'release_note', 'outcome_review'] as const;
export type ProductRecordKind = (typeof PRODUCT_RECORD_KINDS)[number];
export const PRODUCT_DECISIONS = ['iterate', 'retain', 'disable', 'investigate'] as const;
export type ProductDecision = (typeof PRODUCT_DECISIONS)[number];
export const PRODUCT_CONFIDENCE = ['low', 'medium', 'high', 'unknown'] as const;
/** The provenance labels usage figures carry. `unavailable` is shown as Unknown. */
export const MEASURE_PROVENANCE = ['observed', 'estimated', 'unavailable'] as const;

/** A figure with its provenance. `unavailable` exactly when there is no value: an unknown is never stored as a number. */
export const MeasureSchema = z.strictObject({
  value: z.number().finite().nullable(),
  unit: z.string().trim().max(40).nullable(),
  provenance: z.enum(MEASURE_PROVENANCE),
  /** Where the figure came from, or why there is none. */
  basis: z.string().trim().max(300).nullable(),
}).superRefine((m, ctx) => {
  if (m.provenance === 'unavailable' && m.value !== null) ctx.addIssue({ code: 'custom', path: ['value'], message: 'an unknown figure has no value' });
  if (m.provenance !== 'unavailable' && m.value === null) ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'a figure with no value is unknown, not observed or estimated' });
});
export type Measure = z.infer<typeof MeasureSchema>;
export const UNKNOWN_MEASURE: Measure = { value: null, unit: null, provenance: 'unavailable', basis: null };

/** How a figure is shown: its value, unit and provenance, or `Unknown`. */
export function measureText(m: Measure): string {
  if (m.value === null || m.provenance === 'unavailable') return 'Unknown';
  return `${m.value}${m.unit ? ` ${m.unit}` : ''} (${m.provenance})`;
}

export const ProblemBriefContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  owner: Text(120),
  /** The target user or workflow. */
  targetUser: Text(300),
  /** Project Brain source revisions and anchors this brief rests on. */
  evidence: z.array(BrainCitationSchema).max(20),
  /** What the cited evidence may be used for. */
  permissionScope: Text(300),
  /** Null: unknown. */
  currentWorkaround: Text(400).nullable(),
  assumptions: z.array(Text(240)).max(12),
  desiredChange: Text(400),
  nonGoals: z.array(Text(200)).max(12),
  unknowns: z.array(Text(240)).max(12),
  confidence: z.enum(PRODUCT_CONFIDENCE),
  /** Null: no rationale given. */
  confidenceRationale: Text(400).nullable(),
});
export type ProblemBriefContent = z.infer<typeof ProblemBriefContentSchema>;

export const REPORT_LINK_KINDS = ['prototype_report', 'eval_report'] as const;
/** A link to a prototype or evaluation report kept elsewhere. A link only: nothing here reads, runs or trusts it. */
export const ReportLinkSchema = z.strictObject({ kind: z.enum(REPORT_LINK_KINDS), label: Text(120), url: z.url({ protocol: /^https?$/ }).max(500) });

export const OutcomePlanContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** The requirements or criteria this plan is about. */
  requirementIds: z.array(RequirementIdSchema).min(1).max(20),
  milestone: Text(120).nullable(),
  /** The metric definition. */
  metric: Text(300),
  baseline: MeasureSchema,
  target: MeasureSchema,
  /** What the observation should teach when there is no target. */
  learningQuestion: Text(300).nullable(),
  /** Null: unknown. */
  windowDays: z.number().int().min(1).max(366).nullable(),
  /** Where observations will come from. Null: unknown. */
  dataSource: Text(200).nullable(),
  /** Who is observed. Null: unknown. */
  cohort: Text(200).nullable(),
  guardrails: z.array(Text(200)).max(8),
  reviewOwner: Text(120),
  reviewDate: Day.nullable(),
  decisionOptions: z.array(z.enum(PRODUCT_DECISIONS)).min(1).max(4),
  reportLinks: z.array(ReportLinkSchema).max(8),
  confidence: z.enum(PRODUCT_CONFIDENCE),
}).superRefine((p, ctx) => {
  if (p.target.provenance === 'unavailable' && p.learningQuestion === null) ctx.addIssue({ code: 'custom', path: ['learningQuestion'], message: 'with no target, say what the observation should teach' });
  if (new Set(p.requirementIds).size !== p.requirementIds.length) ctx.addIssue({ code: 'custom', path: ['requirementIds'], message: 'requirement ids must be unique' });
});
export type OutcomePlanContent = z.infer<typeof OutcomePlanContentSchema>;

/** A person's note that a merged run was released. Manual: nothing deploys anything. */
export const ReleaseNoteContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(120),
  environment: Text(80),
  configuration: Text(200).nullable(),
  releasedOn: Day,
  note: Text(600).nullable(),
});
export type ReleaseNoteContent = z.infer<typeof ReleaseNoteContentSchema>;

export const FollowUpSchema = z.strictObject({ title: Text(120), requirementIds: z.array(RequirementIdSchema).max(8), reason: Text(300) });
export type FollowUp = z.infer<typeof FollowUpSchema>;

/** A person's manual review of what was observed after a release. It records a decision; it changes no task, and an association it reports is not proof of cause. */
export const OutcomeReviewContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planRecordId: z.string().min(1).max(80),
  releaseRecordId: z.string().min(1).max(80),
  observedEnvironment: Text(120).nullable(),
  observedConfiguration: Text(200).nullable(),
  windowFrom: Day.nullable(),
  windowTo: Day.nullable(),
  evidence: z.array(BrainCitationSchema).max(20),
  result: MeasureSchema,
  summary: Text(600),
  unknowns: z.array(Text(240)).max(12),
  decision: z.enum(PRODUCT_DECISIONS),
  /** A new scoped task this review suggests. Only ever a proposal: it enters a plan through a plan revision, never by itself. */
  followUp: FollowUpSchema.nullable(),
});
export type OutcomeReviewContent = z.infer<typeof OutcomeReviewContentSchema>;

/** `brief` for the project's one brief; `plan:…`, `release:…`, `review:…` for the others. */
export const ProductRecordIdSchema = z.string().regex(/^(?:brief|(?:plan|release|review):[A-Za-z0-9_-]{1,60})$/, 'expected a product record id');

const Base = z.strictObject({
  recordId: ProductRecordIdSchema,
  revision: z.number().int().min(1),
  /** `proposed`: a brief someone may confirm. `confirmed`: a brief a person confirmed. `recorded`: any other record, written by a person. */
  status: z.enum(['proposed', 'confirmed', 'recorded']),
  /** The strongest of the project's label, any label the owner set, and everything the record cites. */
  classification: BrainClassificationSchema,
  proposedBy: z.strictObject({ kind: z.enum(['human', 'worker']), id: z.string().min(1).max(200) }),
  confirmedBy: z.string().min(1).max(200).nullable(),
  recordedAt: z.iso.datetime(),
  /** Position in the project's product log. */
  seq: z.number().int().min(1),
});
export const ProductRecordSchema = z.discriminatedUnion('kind', [
  Base.extend({ kind: z.literal('problem_brief'), content: ProblemBriefContentSchema }),
  Base.extend({ kind: z.literal('outcome_plan'), content: OutcomePlanContentSchema }),
  Base.extend({ kind: z.literal('release_note'), content: ReleaseNoteContentSchema }),
  Base.extend({ kind: z.literal('outcome_review'), content: OutcomeReviewContentSchema }),
]);
export type ProductRecord = z.infer<typeof ProductRecordSchema>;
type Of<K extends ProductRecordKind> = Extract<ProductRecord, { kind: K }>;

/** Only a person confirms a brief. A worker or the guide may propose one. */
export const canConfirmBrief = (actorKind: string): boolean => actorKind === 'human';

/** The latest revision of every record. */
export function latestProductRecords(records: readonly ProductRecord[]): ProductRecord[] {
  const out = new Map<string, ProductRecord>();
  for (const r of records) if ((out.get(r.recordId)?.revision ?? 0) < r.revision) out.set(r.recordId, r);
  return [...out.values()].sort((a, b) => a.seq - b.seq);
}

/** The latest confirmed revision of the brief, and the latest revision whatever its status. */
export function briefState(records: readonly ProductRecord[]): { readonly confirmed: Of<'problem_brief'> | null; readonly latest: Of<'problem_brief'> | null } {
  const briefs = records.filter((r): r is Of<'problem_brief'> => r.kind === 'problem_brief').sort((a, b) => b.revision - a.revision);
  return { confirmed: briefs.find((b) => b.status === 'confirmed') ?? null, latest: briefs[0] ?? null };
}

const ofKind = <K extends ProductRecordKind>(records: readonly ProductRecord[], kind: K): Of<K>[] => latestProductRecords(records).filter((r): r is Of<K> => r.kind === kind);

export interface BriefSeedInput {
  readonly owner: string;
  readonly goals: { readonly idea: string; readonly audience: string; readonly firstOutcome: string };
  readonly assumptions: readonly string[];
  readonly nonGoals: readonly string[];
  /** The accepted brief's Brain source, when it exists: the seed cites its goal anchors. */
  readonly briefSource: { readonly sourceId: string; readonly revision: number; readonly anchors: readonly string[] } | null;
}

/** A first draft from the onboarding brief, for the owner to edit and confirm. Nothing it does not know is filled in. */
export function briefSeed(input: BriefSeedInput): ProblemBriefContent {
  const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    schemaVersion: 1, owner: clip(input.owner, 120), targetUser: clip(input.goals.audience, 300),
    evidence: (input.briefSource?.anchors ?? []).map((anchor) => ({ sourceId: input.briefSource!.sourceId, revision: input.briefSource!.revision, anchor })),
    permissionScope: 'The onboarding answers recorded in this project only.', currentWorkaround: null,
    assumptions: input.assumptions.map((a) => clip(a, 240)).filter(Boolean).slice(0, 12), desiredChange: clip(input.goals.firstOutcome, 400),
    nonGoals: input.nonGoals.map((a) => clip(a, 200)).filter(Boolean).slice(0, 12), unknowns: [], confidence: 'unknown', confidenceRationale: null,
  };
}

// ---- trace ------------------------------------------------------------------------------------------------------------

export const TRACE_LINK_KINDS = ['problem_brief', 'outcome_plan', 'task', 'candidate', 'verification', 'pull_request', 'merge', 'release', 'outcome_review'] as const;
export type TraceLinkKind = (typeof TRACE_LINK_KINDS)[number];
/** `present`: the link exists and holds. `proposed`: only a proposal exists. `failed`: it exists and says no. `stale`: it exists but no longer counts. `missing`: there is none. */
export const TRACE_LINK_STATES = ['present', 'proposed', 'failed', 'stale', 'missing'] as const;
export const OUTCOME_STATES = ['no_outcome_plan', 'not_released', 'awaiting_observations', 'insufficient_data', 'reviewed'] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

export const TraceLinkSchema = z.strictObject({ kind: z.enum(TRACE_LINK_KINDS), state: z.enum(TRACE_LINK_STATES), label: z.string().min(1), ref: z.string().nullable() });
export type TraceLink = z.infer<typeof TraceLinkSchema>;
export const ReleaseStateSchema = z.strictObject({ state: z.enum(['released', 'not_released']), label: z.string() });
export const OutcomeStateSchema = z.strictObject({ state: z.enum(OUTCOME_STATES), label: z.string(), decision: z.enum(PRODUCT_DECISIONS).nullable() });
export const TraceRowSchema = z.strictObject({
  requirementId: z.string(), text: z.string().nullable(), runIds: z.array(z.string()), links: z.array(TraceLinkSchema), release: ReleaseStateSchema, outcome: OutcomeStateSchema,
});
export type TraceRow = z.infer<typeof TraceRowSchema>;

export interface TraceRun {
  readonly runId: string;
  /** The run's latest candidate. Null: none was assembled. */
  readonly candidate: { readonly sha: string; readonly live: boolean; readonly recordId: string | null; readonly recordValid: boolean } | null;
  /** What the trusted verifier last said about each criterion, on that candidate. */
  readonly criteria: readonly { readonly criterionId: string; readonly state: string; readonly verified: boolean; readonly candidateSha: string | null }[];
  readonly pullRequest: { readonly prNumber: number; readonly url: string; readonly status: string; readonly mergeCommitSha: string | null } | null;
}

export interface TraceInput {
  /** The accepted requirements and criteria, with their text when known. */
  readonly requirements: readonly { readonly id: string; readonly text: string | null }[];
  /** The current plan's tasks. */
  readonly tasks: readonly { readonly taskId: string; readonly runId: string; readonly title: string | null; readonly status: string; readonly requirementIds: readonly string[] }[];
  readonly runs: readonly TraceRun[];
  readonly records: readonly ProductRecord[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const short = (sha: string): string => sha.slice(0, 12);
const ref = (r: ProductRecord): string => `${r.recordId}@r${r.revision}`;
const merged = (run: TraceRun | undefined): boolean => run?.pullRequest?.status === 'merged' && run.pullRequest.mergeCommitSha !== null;

const OUTCOME_LABEL: Readonly<Record<Exclude<OutcomeState, 'reviewed'>, string>> = { no_outcome_plan: 'No outcome plan', not_released: 'Not released', awaiting_observations: 'Awaiting observations', insufficient_data: 'Insufficient data' };

/**
 * Each accepted requirement traced from its problem brief and outcome plan through its tasks, candidate, verification record, pull request and merge to its release and outcome.
 * Every link has a state, and a missing link is reported as missing with a reason, never left out. Deterministic: the same input gives the same rows.
 */
export function buildProductTrace(input: TraceInput): TraceRow[] {
  const ids = new Map<string, string | null>();
  for (const r of input.requirements) ids.set(r.id, r.text ?? ids.get(r.id) ?? null);
  for (const t of input.tasks) for (const id of t.requirementIds) if (!ids.has(id)) ids.set(id, null);
  const runs = new Map(input.runs.map((r) => [r.runId, r]));
  const brief = briefState(input.records);
  const plans = ofKind(input.records, 'outcome_plan');
  const releases = ofKind(input.records, 'release_note');
  const reviews = ofKind(input.records, 'outcome_review');

  return [...ids.entries()].sort(([a], [b]) => byString(a, b)).map(([id, text]) => {
    const tasks = input.tasks.filter((t) => t.requirementIds.includes(id)).sort((a, b) => byString(a.taskId, b.taskId));
    const runIds = [...new Set(tasks.map((t) => t.runId))].sort(byString);
    const run = runIds.map((r) => runs.get(r)).find((r) => r !== undefined);
    const myPlans = plans.filter((p) => p.content.requirementIds.includes(id));
    const links: TraceLink[] = [];

    links.push(brief.confirmed
      ? { kind: 'problem_brief', state: 'present', label: `Confirmed brief, revision ${brief.confirmed.revision}`, ref: ref(brief.confirmed) }
      : brief.latest ? { kind: 'problem_brief', state: 'proposed', label: 'Only a proposed brief: no one has confirmed it', ref: ref(brief.latest) }
        : { kind: 'problem_brief', state: 'missing', label: 'No problem brief yet', ref: null });
    links.push(myPlans.length > 0
      ? { kind: 'outcome_plan', state: 'present', label: myPlans.map((p) => p.content.metric).join('; ').slice(0, 300), ref: myPlans.map(ref).join(', ') }
      : { kind: 'outcome_plan', state: 'missing', label: `No outcome plan names ${id}`, ref: null });
    links.push(tasks.length > 0
      ? { kind: 'task', state: 'present', label: tasks.map((t) => `${t.title ?? t.taskId} (${t.status})`).join('; ').slice(0, 300), ref: tasks.map((t) => t.taskId).join(', ') }
      : { kind: 'task', state: 'missing', label: `No plan task carries ${id}`, ref: null });

    const c = run?.candidate ?? null;
    links.push(c === null ? { kind: 'candidate', state: 'missing', label: 'No candidate assembled', ref: null }
      : c.live ? { kind: 'candidate', state: 'present', label: `Candidate ${short(c.sha)}`, ref: c.sha }
        : { kind: 'candidate', state: 'stale', label: `Candidate ${short(c.sha)} was replaced or rejected`, ref: c.sha });

    const crit = run?.criteria.find((x) => x.criterionId === id);
    const recordId = c?.recordId ?? null;
    if (!crit || crit.state === 'not_run') links.push({ kind: 'verification', state: 'missing', label: 'Not verified yet: no verification record judged it', ref: recordId });
    else if (crit.state === 'not_delivered') links.push({ kind: 'verification', state: 'missing', label: 'Not delivered: the work was stopped', ref: recordId });
    else if (crit.state === 'passed' && crit.verified) links.push({ kind: 'verification', state: 'present', label: `Passed on candidate ${short(crit.candidateSha ?? c?.sha ?? '')}${recordId ? `, record ${recordId}` : ''}`, ref: recordId });
    else if (crit.state === 'passed') links.push({ kind: 'verification', state: 'stale', label: 'Passed, but on a record or candidate that no longer counts', ref: recordId });
    else links.push({ kind: 'verification', state: 'failed', label: `Verification ${crit.state}`, ref: recordId });

    const pr = run?.pullRequest ?? null;
    links.push(pr ? { kind: 'pull_request', state: 'present', label: `Pull request #${pr.prNumber} (${pr.status})`, ref: `#${pr.prNumber}` } : { kind: 'pull_request', state: 'missing', label: 'No pull request opened', ref: null });
    links.push(merged(run) ? { kind: 'merge', state: 'present', label: `Merged by a person as ${short(pr!.mergeCommitSha!)}`, ref: pr!.mergeCommitSha } : { kind: 'merge', state: 'missing', label: 'Not merged: a person merges on GitHub', ref: null });

    const myReleases = releases.filter((r) => runIds.includes(r.content.runId) && merged(runs.get(r.content.runId)));
    const released = myReleases.length > 0;
    links.push(released
      ? { kind: 'release', state: 'present', label: myReleases.map((r) => `Released to ${r.content.environment} on ${r.content.releasedOn}`).join('; '), ref: myReleases.map(ref).join(', ') }
      : { kind: 'release', state: 'missing', label: merged(run) ? 'No release note: a merge alone is not a release' : 'Not released', ref: null });

    const relevant = reviews.filter((v) => myPlans.some((p) => p.recordId === v.content.planRecordId) && myReleases.some((r) => r.recordId === v.content.releaseRecordId)).sort((a, b) => b.seq - a.seq);
    const latest = relevant[0];
    links.push(latest ? { kind: 'outcome_review', state: 'present', label: `Decision: ${latest.content.decision}`, ref: ref(latest) } : { kind: 'outcome_review', state: 'missing', label: 'No outcome review yet', ref: null });

    let outcome: TraceRow['outcome'];
    if (myPlans.length === 0) outcome = { state: 'no_outcome_plan', label: OUTCOME_LABEL.no_outcome_plan, decision: null };
    else if (!released) outcome = { state: 'not_released', label: OUTCOME_LABEL.not_released, decision: null };
    else if (!latest) outcome = { state: 'awaiting_observations', label: OUTCOME_LABEL.awaiting_observations, decision: null };
    else if (latest.content.result.provenance === 'unavailable') outcome = { state: 'insufficient_data', label: OUTCOME_LABEL.insufficient_data, decision: latest.content.decision };
    else outcome = { state: 'reviewed', label: `Reviewed: ${latest.content.decision}`, decision: latest.content.decision };

    return { requirementId: id, text, runIds, links, release: released ? { state: 'released', label: 'Released' } : { state: 'not_released', label: 'Not released' }, outcome };
  });
}

// ---- milestone summary ----------------------------------------------------------------------------------------------

export const MilestoneSummarySchema = z.strictObject({
  runId: z.string(),
  requirementIds: z.array(z.string()),
  /** Requirements a task of this run carries. */
  covered: z.number().int().min(0),
  /** Requirements the trusted verifier passed on a live candidate, of `total`. */
  verified: z.number().int().min(0),
  total: z.number().int().min(0),
  release: ReleaseStateSchema,
  outcomes: z.array(z.strictObject({ state: z.enum(OUTCOME_STATES), label: z.string(), count: z.number().int().min(1) })),
  citations: z.array(z.strictObject({ kind: z.enum(['problem_brief', 'outcome_plan', 'verification_record', 'pull_request', 'release_note', 'outcome_review']), ref: z.string() })),
});
export type MilestoneSummary = z.infer<typeof MilestoneSummarySchema>;

/** Per run: the requirements it covers, its evidence, its release state and its outcome states, with citations. Derived from the trace; deterministic, no model. */
export function milestoneSummaries(input: TraceInput): MilestoneSummary[] {
  const rows = buildProductTrace(input);
  const runIds = [...new Set([...input.runs.map((r) => r.runId), ...input.tasks.map((t) => t.runId)])].sort(byString);
  return runIds.map((runId) => {
    const mine = rows.filter((r) => r.runIds.includes(runId));
    const run = input.runs.find((r) => r.runId === runId);
    const counts = new Map<string, { state: OutcomeState; label: string; count: number }>();
    for (const r of mine) {
      const k = `${r.outcome.state}:${r.outcome.label}`;
      counts.set(k, { state: r.outcome.state, label: r.outcome.label, count: (counts.get(k)?.count ?? 0) + 1 });
    }
    const citations: MilestoneSummary['citations'] = [];
    const cite = (kind: MilestoneSummary['citations'][number]['kind'], refs: (string | null)[]) => {
      for (const x of refs.flatMap((s) => (s ?? '').split(', ')).filter(Boolean)) if (!citations.some((c) => c.kind === kind && c.ref === x)) citations.push({ kind, ref: x });
    };
    const linkRefs = (kind: TraceLinkKind) => mine.flatMap((r) => r.links.filter((l) => l.kind === kind && l.state !== 'missing').map((l) => l.ref));
    cite('problem_brief', linkRefs('problem_brief'));
    cite('outcome_plan', linkRefs('outcome_plan'));
    cite('verification_record', run?.candidate?.recordId ? [run.candidate.recordId] : []);
    cite('pull_request', run?.pullRequest ? [`#${run.pullRequest.prNumber}`] : []);
    cite('release_note', linkRefs('release'));
    cite('outcome_review', linkRefs('outcome_review'));
    const released = mine.length > 0 && mine.every((r) => r.release.state === 'released');
    return {
      runId, requirementIds: mine.map((r) => r.requirementId), covered: mine.filter((r) => r.links.some((l) => l.kind === 'task' && l.state === 'present')).length,
      verified: mine.filter((r) => r.links.some((l) => l.kind === 'verification' && l.state === 'present')).length, total: mine.length,
      release: released ? { state: 'released', label: 'Released' } : { state: 'not_released', label: 'Not released' },
      outcomes: [...counts.values()].sort((a, b) => byString(a.state, b.state)), citations,
    };
  });
}

// ---- Project Brain sources --------------------------------------------------------------------------------------------

export interface ProductBrainSource {
  readonly sourceId: string;
  readonly title: string;
  readonly standing: 'accepted';
  readonly classification: BrainClassification;
  readonly recordedBy: string;
  readonly ref: string;
  readonly sections: BrainSection[];
}

const keyPart = (recordId: string): string => recordId.split(':')[1] ?? recordId;
const list = (xs: readonly string[]): string => (xs.length === 0 ? 'None recorded' : xs.join('; '));
const orUnknown = (s: string | null): string => s ?? 'Unknown';

/**
 * The records as Project Brain sources, so workers get product context as cited data. Only a confirmed brief is read: a proposal is not accepted and states nothing, as an
 * unconfirmed stack detection states nothing. Each record keeps its own label, so a restricted one is left out of a bundle that may leave the device. Unknowns are stated as
 * unknown. Text is data: nothing here is an instruction.
 */
export function productBrainSources(records: readonly ProductRecord[]): ProductBrainSource[] {
  const out: ProductBrainSource[] = [];
  const s = (anchor: string, heading: string, text: string, key: string): BrainSection => ({ anchor, heading, text: text.slice(0, 2000), key });
  const { confirmed } = briefState(records);
  if (confirmed) {
    const b = confirmed.content;
    out.push({
      sourceId: 'product:brief', title: 'Problem brief', standing: 'accepted', classification: confirmed.classification, recordedBy: confirmed.confirmedBy ?? confirmed.proposedBy.id, ref: ref(confirmed),
      sections: [
        s('brief/target-user', 'Target user or workflow', b.targetUser, 'brief:target_user'),
        s('brief/desired-change', 'Desired change', b.desiredChange, 'brief:desired_change'),
        s('brief/current-workaround', 'Current workaround', orUnknown(b.currentWorkaround), 'brief:current_workaround'),
        s('brief/assumptions', 'Assumptions', list(b.assumptions), 'brief:assumptions'),
        s('brief/non-goals', 'Non-goals', list(b.nonGoals), 'brief:non_goals'),
        s('brief/unknowns', 'Unknowns', list(b.unknowns), 'brief:unknowns'),
        s('brief/confidence', 'Confidence', `${b.confidence}${b.confidenceRationale ? `: ${b.confidenceRationale}` : ''}`, 'brief:confidence'),
        s('brief/evidence', 'Evidence', b.evidence.length === 0 ? 'None cited' : b.evidence.map((e) => `${e.sourceId}@${e.revision}#${e.anchor}`).join(', '), 'brief:evidence'),
        s('brief/permission', 'Permission scope', `${b.permissionScope} ${PRODUCT_NOTICE}`, 'brief:permission'),
      ],
    });
  }
  for (const p of ofKind(records, 'outcome_plan')) {
    const k = keyPart(p.recordId);
    const c = p.content;
    out.push({
      sourceId: `product:${p.recordId}`, title: `Outcome plan for ${c.requirementIds.join(', ')}`.slice(0, 200), standing: 'accepted', classification: p.classification, recordedBy: p.proposedBy.id, ref: ref(p),
      sections: [
        s(`plan/${k}/requirements`, 'Requirements', c.requirementIds.join(', '), `outcome:${k}:requirements`),
        s(`plan/${k}/metric`, 'Metric', c.metric, `outcome:${k}:metric`),
        s(`plan/${k}/baseline`, 'Baseline', measureText(c.baseline), `outcome:${k}:baseline`),
        s(`plan/${k}/target`, 'Target', measureText(c.target), `outcome:${k}:target`),
        s(`plan/${k}/learning-question`, 'Learning question', c.learningQuestion ?? 'None', `outcome:${k}:learning_question`),
        s(`plan/${k}/window`, 'Observation window', c.windowDays === null ? 'Unknown' : `${c.windowDays} days`, `outcome:${k}:window`),
        s(`plan/${k}/cohort`, 'Data source and cohort', `${orUnknown(c.dataSource)}; cohort ${orUnknown(c.cohort)}`, `outcome:${k}:cohort`),
        s(`plan/${k}/guardrails`, 'Guardrails', list(c.guardrails), `outcome:${k}:guardrails`),
      ],
    });
  }
  for (const r of ofKind(records, 'release_note')) {
    out.push({
      sourceId: `product:${r.recordId}`, title: `Release note for ${r.content.runId}`.slice(0, 200), standing: 'accepted', classification: r.classification, recordedBy: r.proposedBy.id, ref: ref(r),
      sections: [s(`release/${keyPart(r.recordId)}`, 'Release', `A person released run ${r.content.runId} to ${r.content.environment} on ${r.content.releasedOn}.`, `release:${keyPart(r.recordId)}`)],
    });
  }
  for (const v of ofKind(records, 'outcome_review')) {
    const c = v.content;
    out.push({
      sourceId: `product:${v.recordId}`, title: 'Outcome review', standing: 'accepted', classification: v.classification, recordedBy: v.proposedBy.id, ref: ref(v),
      sections: [
        s(`review/${keyPart(v.recordId)}/result`, 'Result', `${measureText(c.result)}. ${c.summary}`, `review:${keyPart(v.recordId)}:result`),
        s(`review/${keyPart(v.recordId)}/decision`, 'Decision', `${c.decision}. Unknowns: ${list(c.unknowns)}.`, `review:${keyPart(v.recordId)}:decision`),
      ],
    });
  }
  return out;
}

/** The strongest label of the given ones. Anything that is not a label is `secret`: fails closed. */
export function productLabel(...labels: unknown[]): BrainClassification {
  const rank = { public: 0, internal: 1, restricted: 2, secret: 3 } as const;
  let best: BrainClassification = 'public';
  for (const l of labels) {
    const p = BrainClassificationSchema.safeParse(l);
    if (!p.success) return 'secret';
    if (rank[p.data] > rank[best]) best = p.data;
  }
  return best;
}
