import { z } from 'zod';
import { redactSecrets } from '@selarikru/protocol';
import {
  BenchmarkFileSchema, BenchmarkRecordSchema, allCriteriaPassed, reconcileSlots, slotViews,
  type BenchmarkCohort, type BenchmarkFile, type BenchmarkRecord, type ReconciledSlots, type SlotView,
} from '@selarikru/view-protocol';
import { canonicalSha256 } from './canonical.ts';
import { checkResults, cohortIdFor, manifestConfiguration, orderLabel } from './checks.ts';
import { BENCH_CODING_WORKERS, parseSlot, startIssues, TRACKS, type Manifest, type StartRecords, type Track } from './manifest.ts';

/**
 * Export and report. Export turns raw per-trial records into the results file the web panel reads
 * (fixtures/benchmarks/result.template.json is its record template), filling each record's configuration from the
 * manifest its track started under. The report computes every figure from those records alone, reconciled against the
 * frozen order: no summary is accepted as input, and simulated or fixture records are counted aside, never as
 * measurements.
 *
 * Rulings carried in the records and repeated in the report:
 * - One record per trial, and every trial fills one slot of the frozen order. A replacement is a new trial in the same
 *   slot with the next `slotAttempt`, allowed only after an infrastructure outcome (denied start, abandoned, not run).
 *   The last attempt represents the slot and drives times and pairs. Earlier attempts are superseded: kept, shown,
 *   and counted towards completion and spend. Completion counts every attempt that ran; a slot-level figure sits
 *   beside it, labelled as such. A slot with no record is missing.
 * - A permitted human action outside control mode is counted in `operations.permittedHumanActions` (minutes in
 *   `humanMinutes.permittedAction`). It keeps the trial in comparisons and is shown beside the mode and per pair; a
 *   difference within a pair is a confounder. Control mode (`humanIntervened`) takes a trial out of comparisons, and so
 *   does an unrecorded control mode or an unrecorded permitted-action count.
 * - Delivery times are on the server monotonic clock only.
 */

export { SERVER_CLOCK } from './checks.ts';

const shape = BenchmarkRecordSchema.shape;

/** What a runner writes per trial. The manifest supplies the rest of the configuration, the cohort and the hash. */
export const RawRecordSchema = BenchmarkRecordSchema.omit({
  protocolVersion: true, cohortId: true, configuration: true, resultSha256: true, publishedSha256: true, measuredResultsPresent: true,
}).extend({
  configuration: shape.configuration.pick({ candidateSha: true, inferenceDestination: true, providerAccountReference: true, credentialMode: true, accountTier: true, credentialPath: true, agentState: true, cacheCondition: true, localHost: true, cloudHost: true }),
});
export type RawRecord = z.infer<typeof RawRecordSchema>;

export class ExportError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`the results cannot be exported: ${issues.join('; ')}`);
    this.name = 'ExportError';
  }
}

export class ReportError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`the results cannot be reported: ${issues.join('; ')}`);
    this.name = 'ReportError';
  }
}

export interface ExportInput {
  readonly manifest: Manifest;
  /** The cohort-start files present, per track. A track with measured records must have started. */
  readonly starts: StartRecords;
  readonly records: readonly unknown[];
  readonly generatedAtUtc: string;
}

/** The hash a record is identified by: canonical JSON of the record with its hash fields left out. */
export function recordHash(record: Omit<BenchmarkRecord, 'resultSha256' | 'publishedSha256' | 'measuredResultsPresent'>): string {
  return canonicalSha256(record);
}

function parseRaw(records: readonly unknown[]): RawRecord[] {
  const issues: string[] = [];
  const raws: RawRecord[] = [];
  records.forEach((raw, i) => {
    const parsed = RawRecordSchema.safeParse(raw);
    if (parsed.success) raws.push(parsed.data);
    else issues.push(...parsed.error.issues.slice(0, 4).map((x) => `record ${i}: ${x.path.join('.') || 'record'}: ${x.message}`));
  });
  if (issues.length > 0) throw new ExportError(issues);
  return raws;
}

/** A track with measured records must have started under this manifest. */
function startCheck(m: Manifest, starts: StartRecords, raws: readonly RawRecord[]): string[] {
  return TRACKS.flatMap((t) => {
    if (!raws.some((r) => r.track === t && r.dataKind === 'measured')) return [];
    if (m.starts[t] === null && starts[t] === null) return [`cohort_not_started: ${t}`];
    return startIssues(m, t, starts[t]).map((i) => `${t}: ${i}`);
  });
}

function toRecord(m: Manifest, r: RawRecord): BenchmarkRecord {
  const c = r.configuration;
  const fromManifest = manifestConfiguration(m, r);
  const record: Omit<BenchmarkRecord, 'resultSha256' | 'publishedSha256' | 'measuredResultsPresent'> = {
    protocolVersion: '0.1', dataKind: r.dataKind, status: r.status, track: r.track, cohortId: cohortIdFor(m, r.track),
    trialId: r.trialId, mode: r.mode, blockId: r.blockId, attemptId: r.attemptId, slotId: r.slotId, slotAttempt: r.slotAttempt,
    configuration: {
      manifestSha256: fromManifest.manifestSha256, starterSha: fromManifest.starterSha, contractSha256: fromManifest.contractSha256,
      verifierSha: fromManifest.verifierSha, candidateSha: c.candidateSha, harness: fromManifest.harness, harnessVersion: fromManifest.harnessVersion,
      codingModel: fromManifest.codingModel, inferenceDestination: c.inferenceDestination, providerAccountReference: c.providerAccountReference, credentialMode: c.credentialMode, accountTier: c.accountTier, credentialPath: c.credentialPath, agentState: c.agentState,
      cacheCondition: c.cacheCondition, localHost: c.localHost, cloudHost: c.cloudHost,
      // A worker trial runs Claude Code workers: recorded, since the hackathon build runs none (BENCH_CODING_WORKERS).
      codingWorkers: r.track === 'workers' ? BENCH_CODING_WORKERS : null,
    },
    assistant: r.assistant, timings: r.timings, resources: r.resources, cost: r.cost, humanMinutes: r.humanMinutes, quality: r.quality,
    operations: r.operations, failures: r.failures, confounders: r.confounders, artifactReferences: r.artifactReferences,
  };
  return { ...record, resultSha256: recordHash(record), publishedSha256: null, measuredResultsPresent: r.dataKind === 'measured' && r.status !== 'not_run' };
}

export function exportResults(input: ExportInput): BenchmarkFile {
  const { manifest: m } = input;
  if (m.cohortId === null) throw new ExportError(['the manifest cohortId is unresolved']);
  const raws = parseRaw(input.records);
  const notStarted = startCheck(m, input.starts, raws);
  if (notStarted.length > 0) throw new ExportError(notStarted);

  const order = orderLabel(m);
  const workers: BenchmarkCohort = {
    cohortId: cohortIdFor(m, 'workers'), track: 'workers', order,
    plannedPerMode: m.workers.attemptsPerRequiredMode, requiredModes: m.workers.requiredModes.map((r) => r.id),
  };
  const assistant: BenchmarkCohort = {
    cohortId: cohortIdFor(m, 'assistant'), track: 'assistant', order,
    plannedPerMode: m.assistant.fixtureIds.length * m.assistant.repetitionsPerFixture, requiredModes: [...m.assistant.requestedModes],
  };
  const cohorts = [workers, assistant];
  const draft = { protocolVersion: '0.1', generatedAtUtc: input.generatedAtUtc, cohorts, records: raws.map((r) => toRecord(m, r)), assistantEvidence: [] };
  // The manifest checks first: they name the trial, where the schema's refinements only name an index.
  const issues = checkResults(draft as BenchmarkFile, m);
  if (issues.length > 0) throw new ExportError(issues);
  const parsed = BenchmarkFileSchema.safeParse(draft);
  if (!parsed.success) throw new ExportError(parsed.error.issues.slice(0, 8).map((x) => `${x.path.join('.') || 'file'}: ${x.message}`));
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------------------------
// Report

export type Provenance = 'observed' | 'estimated' | 'unavailable';

export interface Completion { readonly passed: number; readonly of: number }

/** A timing, always with the completion rate it was taken from. */
export interface Timing {
  readonly n: number;
  readonly median: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly provenance: Provenance;
  readonly completion: Completion;
}

/** Money: null when not known, never zero for unknown. `knownSubtotal` is a lower bound, never a total. */
export interface Money {
  readonly value: number | null;
  readonly provenance: Provenance;
  readonly text: string;
  readonly knownSubtotal: number | null;
  readonly reason: string | null;
}

/** Slots by their representative (last) attempt; every record is either a representative or superseded. */
export interface Accounting {
  readonly planned: number;
  readonly recorded: number;
  readonly superseded: number;
  readonly passed: number;
  readonly completedFailing: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly cancelled: number;
  readonly deniedStart: number;
  readonly abandoned: number;
  readonly notRun: number;
  /** Planned slots with no record at all. Shown, never hidden. */
  readonly missing: number;
}

export interface SupersededAttempt {
  readonly trialId: string;
  readonly slotId: string;
  readonly slotAttempt: number;
  readonly status: BenchmarkRecord['status'];
}

export interface WorkerModeReport {
  readonly mode: string;
  readonly required: boolean;
  readonly supported: boolean;
  readonly status: 'Measured' | 'Not measured';
  readonly reason: string | null;
  readonly attempts: Accounting;
  readonly missingSlots: readonly string[];
  readonly superseded: readonly SupersededAttempt[];
  /** Every attempt that ran, superseded ones included. This is the completion rate; `deliveryTime.completion` repeats it. */
  readonly completion: Completion;
  /** Slots by their last attempt. Shown beside `completion`, labelled as slots, never in its place. */
  readonly slotCompletion: Completion;
  readonly deliveryTime: Timing;
  readonly providerInputTokensMedian: { readonly value: number | null; readonly provenance: Provenance; readonly n: number };
  readonly spend: Money;
  readonly costPerDeliveredChange: Money;
  readonly humanMinutes: { readonly value: number | null; readonly provenance: Provenance; readonly knownSubtotal: number | null };
  /** Permitted human actions outside control mode, summed. Null when none of the attempts recorded it. */
  readonly permittedHumanActions: number | null;
  readonly controlModeTrials: number;
  readonly failureCategories: Readonly<Record<string, number>>;
  readonly confounders: readonly string[];
  readonly claim: string;
}

export interface Pair {
  readonly blockId: string;
  readonly valid: boolean;
  readonly reason: string | null;
  readonly ratio: number | null;
  readonly permittedActions: { readonly a: number | null; readonly b: number | null };
}

export interface Comparison {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly pairs: readonly Pair[];
  readonly validPairs: number;
  readonly excludedPairs: readonly { readonly blockId: string; readonly reason: string }[];
  readonly exploratory: boolean;
  /** Median over valid pairs of a's delivery time over b's. Null below three valid pairs. */
  readonly headlineRatio: number | null;
  readonly completion: { readonly a: Completion; readonly b: Completion };
  /** Differences within a pair that could explain a difference in time, such as permitted human actions. */
  readonly confounders: readonly string[];
}

export interface AssistantRouteReport {
  readonly mode: string;
  readonly status: 'Measured' | 'Not measured';
  readonly attempts: Accounting;
  readonly missingSlots: readonly string[];
  readonly superseded: readonly SupersededAttempt[];
  readonly completion: Completion;
  readonly slotCompletion: Completion;
  readonly warmups: number;
  readonly routing: { readonly correct: number; readonly of: number };
  readonly schema: { readonly valid: number; readonly of: number };
  readonly generationComplete: Timing;
  readonly firstOutput: Timing;
  readonly spend: Money;
  readonly claim: string;
}

export interface Report {
  readonly generatedAtUtc: string;
  readonly excluded: { readonly simulated: number; readonly fixture: number };
  readonly workers: { readonly modes: readonly WorkerModeReport[]; readonly comparisons: readonly Comparison[] };
  readonly assistant: { readonly routes: readonly AssistantRouteReport[] };
  readonly notes: readonly string[];
}

export const MIN_VALID_PAIRS = 3;

const NOTES = [
  'Figures are computed from the raw records only, reconciled against the frozen order. Simulated and fixture records are never measurements.',
  'One record per trial. Each slot counts once, by its last attempt; earlier attempts are superseded and shown, and a slot with no record is missing.',
  'A permitted human action outside control mode is counted beside its mode and per pair and keeps the trial in comparisons. Control mode, or a control mode or permitted-action count not recorded, keeps it out.',
  'Fewer than three valid pairs is exploratory: no headline ratio.',
  'Unknown spend and unknown human minutes are unavailable, never zero. Account, host and failure text are not reported.',
];

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const usd = (n: number): string => `$${n.toFixed(2)}`;
const sum = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0);

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h > 0 ? `${h}h` : null, m > 0 || h > 0 ? `${m}m` : null, s > 0 ? `${s}s` : null].filter(Boolean).join(' ');
}

function timing(values: readonly number[], completion: Completion): Timing {
  return {
    n: values.length, median: median(values), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null,
    provenance: values.length ? 'observed' : 'unavailable', completion,
  };
}

const unavailableMoney = (reason: string, knownSubtotal: number | null = null): Money => ({ value: null, provenance: 'unavailable', text: 'Unavailable', knownSubtotal, reason });

/** All spend across the attempts that ran. Observed when every one has an actual charge; estimated when every one has at least an estimate; otherwise unavailable. */
function spendOf(ran: readonly BenchmarkRecord[]): Money {
  if (ran.length === 0) return unavailableMoney('No attempt ran.');
  const actual = ran.map((r) => r.cost.platformPaidActual);
  const best = ran.map((r) => r.cost.platformPaidActual ?? r.cost.platformPaidEstimated);
  const known = best.filter((v): v is number => v !== null);
  const subtotal = known.length > 0 ? round(sum(known)) : null;
  if (actual.every((v) => v !== null)) {
    const v = round(sum(actual as number[]));
    return { value: v, provenance: 'observed', text: usd(v), knownSubtotal: v, reason: null };
  }
  if (best.every((v) => v !== null)) {
    return { value: subtotal, provenance: 'estimated', text: `${usd(subtotal!)} estimated`, knownSubtotal: subtotal, reason: 'At least one attempt has only an estimate.' };
  }
  return unavailableMoney(`Spend is unknown for ${best.length - known.length} of ${ran.length} attempts.`, subtotal);
}

function perChange(spend: Money, passed: number): Money {
  if (spend.value === null) return unavailableMoney(spend.reason ?? 'Spend is unknown.', null);
  if (passed === 0) return unavailableMoney('No delivered change to divide by.');
  const v = round(spend.value / passed);
  return { value: v, provenance: spend.provenance, text: spend.provenance === 'estimated' ? `${usd(v)} estimated` : usd(v), knownSubtotal: null, reason: null };
}

const workerPassed = (r: BenchmarkRecord): boolean => r.status === 'completed' && allCriteriaPassed(r) && r.quality.withinDeclaredLimits === true;
const EXPECTED_SOURCE: Readonly<Record<string, string>> = { ONLY_ON_DEVICE: 'ON_DEVICE', PREFER_ON_DEVICE: 'ON_DEVICE', ONLY_IN_CLOUD: 'IN_CLOUD', PREFER_IN_CLOUD: 'IN_CLOUD' };
const routedCorrectly = (r: BenchmarkRecord): boolean => r.assistant?.observedInferenceSource === EXPECTED_SOURCE[r.mode];
const assistantPassed = (r: BenchmarkRecord): boolean => r.status === 'completed' && r.assistant?.schemaValid === true && routedCorrectly(r);
const ran = (rs: readonly BenchmarkRecord[]): BenchmarkRecord[] => rs.filter((r) => r.status !== 'not_run');

function account(r: ReconciledSlots, passed: (x: BenchmarkRecord) => boolean): Accounting {
  const reps = r.representatives;
  const count = (s: BenchmarkRecord['status']): number => reps.filter((x) => x.status === s).length;
  const p = reps.filter(passed).length;
  return {
    planned: r.planned, recorded: r.all.length, superseded: r.superseded.length, passed: p, completedFailing: count('completed') - p,
    failed: count('failed'), timedOut: count('timed_out'), cancelled: count('cancelled'), deniedStart: count('denied_start'),
    abandoned: count('abandoned'), notRun: count('not_run'), missing: r.missingSlots.length,
  };
}

const supersededList = (rs: readonly BenchmarkRecord[]): SupersededAttempt[] =>
  rs.map((r) => ({ trialId: r.trialId, slotId: r.slotId!, slotAttempt: r.slotAttempt!, status: r.status }));

function claimOf(c: Completion, t: Timing): string {
  if (c.of === 0) return 'Not measured.';
  const head = `On this fixture/configuration, ${c.passed} of ${c.of} attempts passed`;
  return t.median === null ? `${head}.` : `${head}; successful runs had median ${formatMs(t.median)}.`;
}

const HUMAN_FIELDS = ['initialSetup', 'scoping', 'intervention', 'correction', 'review', 'permittedAction'] as const;

/** The total only when every attempt recorded every category; otherwise unavailable, with what is known as a lower bound. */
function humanMinutesOf(attempts: readonly BenchmarkRecord[]): WorkerModeReport['humanMinutes'] {
  const values = attempts.flatMap((r) => HUMAN_FIELDS.map((f) => r.humanMinutes[f]));
  const known = values.filter((v): v is number => v !== null);
  const knownSubtotal = known.length > 0 ? round(sum(known)) : null;
  const complete = attempts.length > 0 && values.every((v) => v !== null) && attempts.every((r) => r.humanMinutes.provenance !== 'unavailable');
  if (!complete) return { value: null, provenance: 'unavailable', knownSubtotal };
  const estimated = attempts.some((r) => r.humanMinutes.provenance === 'estimated');
  return { value: knownSubtotal, provenance: estimated ? 'estimated' : 'observed', knownSubtotal };
}

function inputTokens(attempts: readonly BenchmarkRecord[]): WorkerModeReport['providerInputTokensMedian'] {
  const totals = attempts.flatMap((r) => {
    const roles = r.resources.providerUsageByRole;
    if (roles.length === 0 || roles.some((u) => u.provenance !== 'observed' || u.inputTokens === null)) return [];
    return [sum(roles.map((u) => u.inputTokens!))];
  });
  return { value: median(totals), provenance: totals.length > 0 ? 'observed' : 'unavailable', n: totals.length };
}

const clean = (s: string): string => redactSecrets(s);

interface ModePlan { readonly id: string; readonly supported: boolean; readonly reason: string | null }

function workerMode(plan: ModePlan, views: readonly SlotView[]): WorkerModeReport {
  const r = reconcileSlots(views);
  const ranReps = ran(r.representatives);
  const ranAll = ran(r.all);
  const passing = r.representatives.filter(workerPassed);
  // Every attempt that ran is in the denominator; superseded attempts ended in an infrastructure outcome, so never pass.
  const completion = { passed: ranAll.filter(workerPassed).length, of: ranAll.length };
  const slotCompletion = { passed: passing.length, of: ranReps.length };
  const times = passing.flatMap((x) => (x.timings.endToEndVerifiedMs === null ? [] : [x.timings.endToEndVerifiedMs]));
  const deliveryTime = timing(times, completion);
  // Spend counts every attempt that ran, superseded ones included: it was spent.
  const spend = spendOf(ranAll);
  const permitted = ranAll.map((x) => x.operations.permittedHumanActions).filter((v): v is number => v !== null);
  const failureCategories: Record<string, number> = {};
  for (const f of r.all.flatMap((x) => x.failures)) failureCategories[clean(f.category)] = (failureCategories[clean(f.category)] ?? 0) + 1;
  const measured = ranAll.length > 0;
  return {
    mode: plan.id, required: true, supported: plan.supported, status: measured ? 'Measured' : 'Not measured',
    reason: measured ? null : plan.reason ?? (plan.supported ? null : 'Not supported.'),
    attempts: account(r, workerPassed), missingSlots: r.missingSlots, superseded: supersededList(r.superseded), completion, slotCompletion,
    deliveryTime, providerInputTokensMedian: inputTokens(ranReps), spend, costPerDeliveredChange: perChange(spend, passing.length),
    humanMinutes: humanMinutesOf(ranAll), permittedHumanActions: permitted.length > 0 ? sum(permitted) : null,
    controlModeTrials: ranReps.filter((x) => x.operations.humanIntervened === true).length, failureCategories,
    confounders: [...new Set(r.all.flatMap((x) => x.confounders).map(clean))], claim: claimOf(completion, deliveryTime),
  };
}

function pairProblem(mode: string, r: BenchmarkRecord | null): string | null {
  if (r === null) return `${mode} has no record`;
  if (!workerPassed(r) || r.timings.endToEndVerifiedMs === null) return `${mode} did not pass`;
  if (r.operations.humanIntervened === true) return `${mode} used control mode`;
  if (r.operations.humanIntervened === null) return `${mode} did not record control mode`;
  if (r.operations.permittedHumanActions === null) return `${mode} did not record permitted human actions`;
  return null;
}

/**
 * D6: the credential mode and account tier each side ran under. When they differ between the two modes, the comparison
 * is not an isolated placement experiment, and the report says so. Only modes and tiers are named, never an account.
 * The tier is what the manifest declares (`environment.accountTier`), not something the run observed.
 */
function accountConfounder(a: string, b: string, blocks: readonly string[], slots: ReadonlyMap<string, SlotView>): string[] {
  const accounts = (mode: string): string[] => [...new Set(ran(blocks.flatMap((blk) => {
    const v = slots.get(`workers/${blk}/${mode}`);
    return v === undefined ? [] : [...v.superseded, ...(v.representative === null ? [] : [v.representative])];
  })).map((r) => `${r.configuration.credentialMode ?? 'unrecorded'}|${r.configuration.accountTier ?? 'unrecorded'}`))].sort();
  const sa = accounts(a);
  const sb = accounts(b);
  if (sa.length === 0 || sb.length === 0 || (sa.length === 1 && sb.length === 1 && sa[0] === sb[0])) return [];
  const side = (mode: string, s: readonly string[]): string => `${mode} ran with ${s.map((x) => {
    const [credential, tier] = x.split('|');
    return `credential mode ${credential} (declared) on account tier ${tier} (declared)`;
  }).join(' and ')}`;
  return [`account confounder: ${side(a, sa)}; ${side(b, sb)}. Not an isolated placement comparison.`];
}

/** Pairs are the frozen order's blocks, each side represented by its slot's last attempt. File order plays no part. */
function compare(a: string, b: string, blocks: readonly string[], slots: ReadonlyMap<string, SlotView>): Comparison {
  const rep = (mode: string, block: string): BenchmarkRecord | null => slots.get(`workers/${block}/${mode}`)?.representative ?? null;
  const pairs: Pair[] = blocks.map((blockId) => {
    const ra = rep(a, blockId);
    const rb = rep(b, blockId);
    const reason = pairProblem(a, ra) ?? pairProblem(b, rb);
    const ratio = reason === null ? ra!.timings.endToEndVerifiedMs! / rb!.timings.endToEndVerifiedMs! : null;
    const permittedActions = { a: ra?.operations.permittedHumanActions ?? null, b: rb?.operations.permittedHumanActions ?? null };
    return { blockId, valid: reason === null, reason, ratio, permittedActions };
  });
  const valid = pairs.filter((p) => p.valid);
  const confounders = pairs
    .filter((p) => p.permittedActions.a !== null && p.permittedActions.b !== null && p.permittedActions.a !== p.permittedActions.b)
    .map((p) => `${p.blockId}: ${a} had ${p.permittedActions.a} permitted human actions outside control mode, ${b} had ${p.permittedActions.b}.`);
  confounders.push(...accountConfounder(a, b, blocks, slots));
  // Completion counts every attempt that ran in these blocks, superseded ones included.
  const completion = (mode: string): Completion => {
    const attempts = ran(blocks.flatMap((blk) => {
      const v = slots.get(`workers/${blk}/${mode}`);
      return v === undefined ? [] : [...v.superseded, ...(v.representative === null ? [] : [v.representative])];
    }));
    return { passed: attempts.filter(workerPassed).length, of: attempts.length };
  };
  const exploratory = valid.length < MIN_VALID_PAIRS;
  return {
    id: `${a}-${b}`, a, b, pairs, validPairs: valid.length,
    excludedPairs: pairs.filter((p) => !p.valid).map((p) => ({ blockId: p.blockId, reason: p.reason! })),
    exploratory, headlineRatio: exploratory ? null : round(median(valid.map((p) => p.ratio!))!),
    completion: { a: completion(a), b: completion(b) }, confounders,
  };
}

function assistantRoute(mode: string, measuredSlots: readonly SlotView[], warmupSlots: readonly SlotView[]): AssistantRouteReport {
  const r = reconcileSlots(measuredSlots);
  const warm = reconcileSlots(warmupSlots);
  const ranReps = ran(r.representatives);
  const ranAll = ran(r.all);
  const passing = r.representatives.filter(assistantPassed);
  const completion = { passed: ranAll.filter(assistantPassed).length, of: ranAll.length };
  const slotCompletion = { passed: passing.length, of: ranReps.length };
  const pick = (f: (x: BenchmarkRecord) => number | null): number[] => passing.flatMap((x) => { const v = f(x); return v === null ? [] : [v]; });
  const generationComplete = timing(pick((x) => x.timings.generationCompleteMs), completion);
  return {
    mode, status: ranReps.length > 0 ? 'Measured' : 'Not measured', attempts: account(r, assistantPassed),
    missingSlots: r.missingSlots, superseded: supersededList(r.superseded), completion, slotCompletion, warmups: warm.all.length,
    routing: { correct: ranReps.filter(routedCorrectly).length, of: ranReps.length },
    schema: { valid: ranReps.filter((x) => x.assistant?.schemaValid === true).length, of: ranReps.length },
    generationComplete, firstOutput: timing(pick((x) => x.timings.firstOutputMs), completion),
    // Warm-up and superseded charges are part of the cohort's spend even though they are never timed.
    spend: spendOf(ran([...r.all, ...warm.all])), claim: claimOf(completion, generationComplete),
  };
}

/** Builds the report from a results file, after the same checks export runs, reconciled against the manifest's frozen order. */
export function buildReport(input: BenchmarkFile, manifest: Manifest): Report {
  const parsed = BenchmarkFileSchema.safeParse(input);
  if (!parsed.success) throw new ReportError(parsed.error.issues.slice(0, 8).map((x) => `${x.path.join('.') || 'file'}: ${x.message}`));
  const file = parsed.data;
  const issues = checkResults(file, manifest);
  if (issues.length > 0) throw new ReportError(issues);

  const measured = file.records.filter((r) => r.dataKind === 'measured');
  const order = manifest.randomization.order;
  const views = new Map(slotViews(measured, order).map((v) => [v.slotId, v]));
  const slotsWhere = (test: (s: NonNullable<ReturnType<typeof parseSlot>>) => boolean): SlotView[] =>
    order.flatMap((id) => { const s = parseSlot(id); return s !== null && test(s) ? [views.get(id)!] : []; });

  const modes = manifest.workers.requiredModes.map((r) =>
    workerMode({ id: r.id, supported: r.availability === 'supported', reason: r.unavailableReason }, slotsWhere((s) => s.track === 'workers' && s.mode === r.id)));
  const blocks = [...new Set(order.flatMap((id) => { const s = parseSlot(id); return s?.track === 'workers' ? [s.block] : []; }))];
  const routes = manifest.assistant.requestedModes.map((mode) => assistantRoute(
    mode,
    slotsWhere((s) => s.track === 'assistant' && !s.warmup && s.mode === mode),
    slotsWhere((s) => s.track === 'assistant' && s.warmup && s.mode === mode),
  ));
  return {
    generatedAtUtc: file.generatedAtUtc,
    excluded: { simulated: file.records.filter((r) => r.dataKind === 'simulated').length, fixture: file.records.filter((r) => r.dataKind === 'fixture').length },
    workers: { modes, comparisons: [compare('L1', 'C1', blocks, views), compare('L1', 'H2', blocks, views)] },
    assistant: { routes },
    notes: NOTES,
  };
}

const rate = (c: Completion): string => `${c.passed} of ${c.of} attempts passed`;

function missingText(a: Accounting, slots: readonly string[]): string | null {
  return a.missing > 0 ? `${a.missing} planned attempts have no record (${slots.join(', ')}).` : null;
}

function supersededText(list: readonly SupersededAttempt[]): string | null {
  if (list.length === 0) return null;
  return `Superseded: ${list.map((s) => `${s.trialId} (${s.status}, attempt ${s.slotAttempt} of ${s.slotId})`).join(', ')}.`;
}

function workerLine(m: WorkerModeReport): string {
  const a = m.attempts;
  if (m.status === 'Not measured') {
    const missing = a.missing > 0 ? ` ${a.missing} planned attempts have no record.` : '';
    return `  ${m.mode}: Not measured.${m.reason ? ` ${m.reason}` : ''}${missing}`;
  }
  const t = m.deliveryTime;
  const median = t.median !== null ? `; median ${formatMs(t.median)} (min ${formatMs(t.min!)}, max ${formatMs(t.max!)}, n=${t.n})` : '';
  const spendNote = m.spend.provenance === 'unavailable' && m.spend.knownSubtotal !== null ? ` (known subtotal ${usd(m.spend.knownSubtotal)})` : '';
  const slots = `(slots: ${m.slotCompletion.passed} of ${m.slotCompletion.of} passed)`;
  const parts = [
    `${rate(m.completion)}${median}. ${slots}`,
    `Attempts: ${a.passed} passed, ${a.completedFailing} completed failing, ${a.failed} failed, ${a.timedOut} timed out, ${a.cancelled} cancelled, `
      + `${a.deniedStart} denied, ${a.abandoned} abandoned, ${a.notRun} not run, ${a.superseded} superseded.`,
    missingText(a, m.missingSlots),
    supersededText(m.superseded),
    `Spend: ${m.spend.text}${spendNote}. Cost per delivered change: ${m.costPerDeliveredChange.text}.`,
    m.permittedHumanActions !== null && m.permittedHumanActions > 0 ? `${m.permittedHumanActions} permitted human actions outside control mode.` : null,
    m.controlModeTrials > 0 ? `${m.controlModeTrials} trials used control mode.` : null,
    m.confounders.length > 0 ? `Confounders: ${m.confounders.join('; ')}.` : null,
  ];
  return `  ${m.mode}: ${parts.filter(Boolean).join(' ')}`;
}

function comparisonLine(c: Comparison): string {
  const head = c.exploratory
    ? `exploratory, ${c.validPairs} valid pairs (fewer than ${MIN_VALID_PAIRS}); no headline ratio`
    : `median ${c.a}/${c.b} delivery-time ratio ${c.headlineRatio!.toFixed(2)} over ${c.validPairs} valid pairs`;
  const excluded = c.excludedPairs.length > 0 ? ` Excluded: ${c.excludedPairs.map((p) => `${p.blockId} (${p.reason})`).join(', ')}.` : '';
  const confounders = c.confounders.length > 0 ? ` Confounders: ${c.confounders.join(' ')}` : '';
  return `  ${c.id}: ${head}. ${c.a} ${rate(c.completion.a)}; ${c.b} ${rate(c.completion.b)}.${excluded}${confounders}`;
}

function routeLine(r: AssistantRouteReport): string {
  if (r.status === 'Not measured') {
    return `  ${r.mode}: Not measured.${r.attempts.missing > 0 ? ` ${r.attempts.missing} planned requests have no record.` : ''}`;
  }
  const g = r.generationComplete;
  const f = r.firstOutput;
  const parts = [
    `${rate(r.completion)}${g.median !== null ? `; complete response median ${formatMs(g.median)} (n=${g.n})` : ''}. (slots: ${r.slotCompletion.passed} of ${r.slotCompletion.of} passed)`,
    `First output: ${f.median !== null ? `median ${formatMs(f.median)} (n=${f.n})` : 'not available'}.`,
    `Routing ${r.routing.correct} of ${r.routing.of} correct; schema ${r.schema.valid} of ${r.schema.of} valid; ${r.warmups} warm-ups excluded from timing.`,
    supersededText(r.superseded),
    `Spend: ${r.spend.text}.`,
  ];
  return `  ${r.mode}: ${parts.filter(Boolean).join(' ')}`;
}

export function renderReport(report: Report): string {
  const lines = [`Benchmark report, generated ${report.generatedAtUtc}`, ''];
  const { simulated, fixture } = report.excluded;
  if (simulated + fixture > 0) lines.push(`Excluded, never evidence: ${simulated} simulated and ${fixture} fixture records.`, '');
  lines.push('Workers:', ...report.workers.modes.map(workerLine));
  lines.push('', 'Comparisons:', ...report.workers.comparisons.map(comparisonLine));
  lines.push('', 'Assistant:', ...report.assistant.routes.map(routeLine));
  lines.push('', 'Notes:', ...report.notes.map((n) => `  - ${n}`));
  return clean(lines.join('\n'));
}
