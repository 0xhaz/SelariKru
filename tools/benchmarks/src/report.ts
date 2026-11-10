import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redactSecrets } from '@selarikru/protocol';
import { BenchmarkFileSchema, BenchmarkRecordSchema, allCriteriaPassed, type BenchmarkCohort, type BenchmarkFile, type BenchmarkRecord } from '@selarikru/view-protocol';
import type { Manifest } from './manifest.ts';

/**
 * Export and report. Export turns raw per-trial records into the results file the web panel reads
 * (fixtures/benchmarks/result.template.json is its record template), filling each record's configuration from the
 * manifest. The report computes every figure from those records alone: no summary is accepted as input, and
 * simulated or fixture records are counted aside, never as measurements.
 *
 * Rulings carried in the records and repeated in the report:
 * - One record per trial. A replacement attempt is a new trial; none is overwritten or dropped.
 * - A permitted human action outside control mode is counted in `operations.permittedHumanActions` (minutes in
 *   `humanMinutes.permittedAction`). It keeps the trial in comparisons and is shown beside the mode. Control mode
 *   (`humanIntervened`) takes a trial out of comparisons; unrecorded control mode does too.
 * - Delivery times are on the server monotonic clock only.
 */

export const SERVER_CLOCK = 'server-monotonic';

const shape = BenchmarkRecordSchema.shape;

/** What a runner writes per trial. The manifest supplies the rest of the configuration, the cohort and the hash. */
export const RawRecordSchema = BenchmarkRecordSchema.omit({ protocolVersion: true, cohortId: true, configuration: true, resultSha256: true, measuredResultsPresent: true }).extend({
  configuration: shape.configuration.pick({ candidateSha: true, inferenceDestination: true, providerAccountReference: true, cacheCondition: true, localHost: true, cloudHost: true }),
});
export type RawRecord = z.infer<typeof RawRecordSchema>;

export class ExportError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`the results cannot be exported: ${issues.join('; ')}`);
    this.name = 'ExportError';
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** JSON with sorted keys, so a record's hash does not depend on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export interface ExportInput {
  readonly manifest: Manifest;
  readonly manifestSha256: string;
  readonly records: readonly unknown[];
  readonly generatedAtUtc: string;
}

const isDeviceRoute = (mode: string): boolean => mode === 'ONLY_ON_DEVICE' || mode === 'PREFER_ON_DEVICE';

export function exportResults(input: ExportInput): BenchmarkFile {
  const { manifest: m } = input;
  if (m.cohortId === null) throw new ExportError(['the manifest cohortId is unresolved']);
  const issues: string[] = [];
  const raws: RawRecord[] = [];
  input.records.forEach((raw, i) => {
    const parsed = RawRecordSchema.safeParse(raw);
    if (!parsed.success) issues.push(...parsed.error.issues.slice(0, 4).map((x) => `record ${i}: ${x.path.join('.') || 'record'}: ${x.message}`));
    else raws.push(parsed.data);
  });
  if (issues.length > 0) throw new ExportError(issues);

  const workerModes = m.workers.requiredModes.map((r) => r.id as string);
  const routes = m.assistant.requestedModes as readonly string[];
  const trials = new Set<string>();
  for (const r of raws) {
    const planned = r.track === 'workers' ? workerModes.includes(r.mode) : routes.includes(r.mode);
    if (!planned) issues.push(`trial ${r.trialId}: mode ${r.mode} is not planned in the manifest`);
    const key = `${r.track}\0${r.trialId}`;
    if (trials.has(key)) issues.push(`one record per trial: trial ${r.trialId} has two records`);
    trials.add(key);
    if (r.track === 'workers' && r.timings.endToEndVerifiedMs !== null && r.timings.clockDomain !== SERVER_CLOCK) issues.push(`trial ${r.trialId}: a delivery time must be on the ${SERVER_CLOCK} clock`);
  }
  if (issues.length > 0) throw new ExportError(issues);

  const records = raws.map((r): BenchmarkRecord => {
    const c = r.configuration;
    const codingModel = r.track === 'workers' ? m.environment.codingModel : isDeviceRoute(r.mode) ? m.assistant.deviceModel : m.assistant.cloudModel;
    const record: Omit<BenchmarkRecord, 'resultSha256' | 'measuredResultsPresent'> = {
      protocolVersion: '0.1', dataKind: r.dataKind, status: r.status, track: r.track, cohortId: `${m.cohortId}-${r.track}`, trialId: r.trialId, mode: r.mode, blockId: r.blockId, attemptId: r.attemptId,
      configuration: {
        manifestSha256: input.manifestSha256, starterSha: m.repository.starterSha, contractSha256: m.repository.contractSha256, verifierSha: m.repository.verifierSha, candidateSha: c.candidateSha,
        harness: m.environment.harness, harnessVersion: m.environment.harnessVersion, codingModel, inferenceDestination: c.inferenceDestination, providerAccountReference: c.providerAccountReference,
        cacheCondition: c.cacheCondition, localHost: c.localHost, cloudHost: c.cloudHost,
      },
      assistant: r.assistant, timings: r.timings, resources: r.resources, cost: r.cost, humanMinutes: r.humanMinutes, quality: r.quality, operations: r.operations,
      failures: r.failures, confounders: r.confounders, artifactReferences: r.artifactReferences,
    };
    return { ...record, resultSha256: sha256(canonical(record)), measuredResultsPresent: r.dataKind === 'measured' && r.status !== 'not_run' };
  });

  const r = m.randomization;
  const order = r.seed !== null && r.orderSha256 !== null ? `seed ${r.seed}; order sha256 ${r.orderSha256}` : null;
  const cohorts: BenchmarkCohort[] = [
    { cohortId: `${m.cohortId}-workers`, track: 'workers', plannedPerMode: m.workers.attemptsPerRequiredMode, requiredModes: workerModes, order },
    { cohortId: `${m.cohortId}-assistant`, track: 'assistant', plannedPerMode: m.assistant.fixtureIds.length * m.assistant.repetitionsPerFixture, requiredModes: [...routes], order },
  ];
  const parsed = BenchmarkFileSchema.safeParse({ protocolVersion: '0.1', generatedAtUtc: input.generatedAtUtc, cohorts, records, assistantEvidence: [] });
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

export interface Accounting {
  readonly planned: number;
  readonly recorded: number;
  readonly passed: number;
  readonly completedFailing: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly cancelled: number;
  readonly deniedStart: number;
  readonly abandoned: number;
  readonly notRun: number;
  /** Planned attempts with no record at all. Shown, never hidden. */
  readonly missing: number;
}

export interface WorkerModeReport {
  readonly mode: string;
  readonly required: boolean;
  readonly supported: boolean;
  readonly status: 'Measured' | 'Not measured';
  readonly reason: string | null;
  readonly attempts: Accounting;
  readonly deliveryTime: Timing;
  readonly providerInputTokensMedian: { readonly value: number | null; readonly provenance: Provenance; readonly n: number };
  readonly spend: Money;
  readonly costPerDeliveredChange: Money;
  readonly humanMinutes: { readonly value: number | null; readonly provenance: Provenance };
  /** Permitted human actions outside control mode, summed. Null when none of the attempts recorded it. */
  readonly permittedHumanActions: number | null;
  readonly controlModeTrials: number;
  readonly failureCategories: Readonly<Record<string, number>>;
  readonly confounders: readonly string[];
  readonly claim: string;
}

export interface Comparison {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly validPairs: number;
  readonly excludedPairs: readonly { readonly blockId: string; readonly reason: string }[];
  readonly exploratory: boolean;
  /** Median over valid pairs of a's delivery time over b's. Null below three valid pairs. */
  readonly headlineRatio: number | null;
  readonly completion: { readonly a: Completion; readonly b: Completion };
}

export interface AssistantRouteReport {
  readonly mode: string;
  readonly status: 'Measured' | 'Not measured';
  readonly attempts: Accounting;
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
  'Figures are computed from the raw records only. Simulated and fixture records are never measurements.',
  'One record per trial; every attempt is accounted for as passed, failed, timed out, cancelled, denied, abandoned, not run, or missing.',
  'A permitted human action outside control mode is counted beside its mode and keeps the trial in comparisons; control mode, or control mode not recorded, keeps it out.',
  'Fewer than three valid pairs is exploratory: no headline ratio.',
  'Unknown spend is unavailable, never zero. Account, host and failure text are not reported.',
];

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const usd = (n: number): string => `$${n.toFixed(2)}`;

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
  return { n: values.length, median: median(values), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null, provenance: values.length ? 'observed' : 'unavailable', completion };
}

const unavailableMoney = (reason: string, knownSubtotal: number | null = null): Money => ({ value: null, provenance: 'unavailable', text: 'Unavailable', knownSubtotal, reason });

/** All spend across the attempts that ran. Observed when every one has an actual charge; estimated when every one has at least an estimate; otherwise unavailable. */
function spendOf(ran: readonly BenchmarkRecord[]): Money {
  if (ran.length === 0) return unavailableMoney('No attempt ran.');
  const actual = ran.map((r) => r.cost.platformPaidActual);
  const best = ran.map((r) => r.cost.platformPaidActual ?? r.cost.platformPaidEstimated);
  const known = best.filter((v): v is number => v !== null);
  const subtotal = known.length > 0 ? round(known.reduce((s, v) => s + v, 0)) : null;
  if (actual.every((v) => v !== null)) { const v = round(actual.reduce((s, x) => s + x!, 0)); return { value: v, provenance: 'observed', text: usd(v), knownSubtotal: v, reason: null }; }
  if (best.every((v) => v !== null)) return { value: subtotal, provenance: 'estimated', text: `${usd(subtotal!)} estimated`, knownSubtotal: subtotal, reason: 'At least one attempt has only an estimate.' };
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

function account(records: readonly BenchmarkRecord[], planned: number, passed: (r: BenchmarkRecord) => boolean): Accounting {
  const count = (s: BenchmarkRecord['status']): number => records.filter((r) => r.status === s).length;
  const p = records.filter(passed).length;
  return {
    planned, recorded: records.length, passed: p, completedFailing: count('completed') - p, failed: count('failed'), timedOut: count('timed_out'), cancelled: count('cancelled'),
    deniedStart: count('denied_start'), abandoned: count('abandoned'), notRun: count('not_run'), missing: Math.max(0, planned - records.length),
  };
}

function claimOf(c: Completion, t: Timing): string {
  if (c.of === 0) return 'Not measured.';
  const head = `On this fixture/configuration, ${c.passed} of ${c.of} attempts passed`;
  return t.median === null ? `${head}.` : `${head}; successful runs had median ${formatMs(t.median)}.`;
}

function humanMinutesOf(ran: readonly BenchmarkRecord[]): { value: number | null; provenance: Provenance } {
  if (ran.length === 0 || ran.some((r) => r.humanMinutes.provenance === 'unavailable')) return { value: null, provenance: 'unavailable' };
  const h = (r: BenchmarkRecord): number => [r.humanMinutes.initialSetup, r.humanMinutes.scoping, r.humanMinutes.intervention, r.humanMinutes.correction, r.humanMinutes.review, r.humanMinutes.permittedAction].reduce<number>((s, v) => s + (v ?? 0), 0);
  return { value: round(ran.reduce((s, r) => s + h(r), 0)), provenance: ran.some((r) => r.humanMinutes.provenance === 'estimated') ? 'estimated' : 'observed' };
}

function inputTokens(ran: readonly BenchmarkRecord[]): WorkerModeReport['providerInputTokensMedian'] {
  const totals = ran.flatMap((r) => {
    const roles = r.resources.providerUsageByRole;
    if (roles.length === 0 || roles.some((u) => u.provenance !== 'observed' || u.inputTokens === null)) return [];
    return [roles.reduce((s, u) => s + u.inputTokens!, 0)];
  });
  return { value: median(totals), provenance: totals.length > 0 ? 'observed' : 'unavailable', n: totals.length };
}

const clean = (s: string): string => redactSecrets(s);

function workerMode(mode: string, records: readonly BenchmarkRecord[], planned: number, required: boolean, supported: boolean, reason: string | null): WorkerModeReport {
  const ran = records.filter((r) => r.status !== 'not_run');
  const passing = records.filter(workerPassed);
  const completion = { passed: passing.length, of: ran.length };
  const deliveryTime = timing(passing.flatMap((r) => (r.timings.endToEndVerifiedMs === null ? [] : [r.timings.endToEndVerifiedMs])), completion);
  const spend = spendOf(ran);
  const permitted = ran.map((r) => r.operations.permittedHumanActions).filter((v): v is number => v !== null);
  const failureCategories: Record<string, number> = {};
  for (const f of records.flatMap((r) => r.failures)) failureCategories[clean(f.category)] = (failureCategories[clean(f.category)] ?? 0) + 1;
  return {
    mode, required, supported, status: ran.length > 0 ? 'Measured' : 'Not measured', reason: ran.length > 0 ? null : reason,
    attempts: account(records, planned, workerPassed), deliveryTime, providerInputTokensMedian: inputTokens(ran), spend, costPerDeliveredChange: perChange(spend, passing.length),
    humanMinutes: humanMinutesOf(ran), permittedHumanActions: permitted.length > 0 ? permitted.reduce((s, v) => s + v, 0) : null,
    controlModeTrials: ran.filter((r) => r.operations.humanIntervened === true).length, failureCategories,
    confounders: [...new Set(records.flatMap((r) => r.confounders).map(clean))], claim: claimOf(completion, deliveryTime),
  };
}

function compare(a: string, b: string, byMode: ReadonlyMap<string, readonly BenchmarkRecord[]>): Comparison {
  const as = byMode.get(a) ?? [];
  const bs = byMode.get(b) ?? [];
  const blocks = [...new Set([...as, ...bs].map((r) => r.blockId).filter((x): x is string => x !== null))].sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
  const ratios: number[] = [];
  const excludedPairs: { blockId: string; reason: string }[] = [];
  const problem = (mode: string, r: BenchmarkRecord | undefined): string | null => {
    if (r === undefined) return `${mode} has no record`;
    if (!workerPassed(r) || r.timings.endToEndVerifiedMs === null) return `${mode} did not pass`;
    if (r.operations.humanIntervened === true) return `${mode} used control mode`;
    if (r.operations.humanIntervened === null) return `${mode} did not record control mode`;
    return null;
  };
  for (const blockId of blocks) {
    const ra = as.find((r) => r.blockId === blockId);
    const rb = bs.find((r) => r.blockId === blockId);
    const reason = problem(a, ra) ?? problem(b, rb);
    if (reason !== null) excludedPairs.push({ blockId, reason });
    else ratios.push(ra!.timings.endToEndVerifiedMs! / rb!.timings.endToEndVerifiedMs!);
  }
  const completion = (rs: readonly BenchmarkRecord[]): Completion => { const ran = rs.filter((r) => r.status !== 'not_run'); return { passed: ran.filter(workerPassed).length, of: ran.length }; };
  const exploratory = ratios.length < MIN_VALID_PAIRS;
  return { id: `${a}-${b}`, a, b, validPairs: ratios.length, excludedPairs, exploratory, headlineRatio: exploratory ? null : round(median(ratios)!), completion: { a: completion(as), b: completion(bs) } };
}

function assistantRoute(mode: string, records: readonly BenchmarkRecord[], planned: number): AssistantRouteReport {
  const measured = records.filter((r) => !r.assistant?.warmup);
  const ran = measured.filter((r) => r.status !== 'not_run');
  const passing = measured.filter(assistantPassed);
  const completion = { passed: passing.length, of: ran.length };
  const generationComplete = timing(passing.flatMap((r) => (r.timings.generationCompleteMs === null ? [] : [r.timings.generationCompleteMs])), completion);
  return {
    mode, status: ran.length > 0 ? 'Measured' : 'Not measured', attempts: account(measured, planned, assistantPassed), warmups: records.length - measured.length,
    routing: { correct: ran.filter(routedCorrectly).length, of: ran.length }, schema: { valid: ran.filter((r) => r.assistant?.schemaValid === true).length, of: ran.length },
    generationComplete, firstOutput: timing(passing.flatMap((r) => (r.timings.firstOutputMs === null ? [] : [r.timings.firstOutputMs])), completion),
    // Warm-up charges are part of the cohort's spend even though warm-ups are never timed.
    spend: spendOf(records.filter((r) => r.status !== 'not_run')), claim: claimOf(completion, generationComplete),
  };
}

/** Builds the report from the records in a results file. The manifest, when given, says which modes are supported and why not. */
export function buildReport(input: BenchmarkFile, manifest: Manifest | null = null): Report {
  const file = BenchmarkFileSchema.parse(input);
  const measured = file.records.filter((r) => r.dataKind === 'measured');
  const byMode = new Map<string, BenchmarkRecord[]>();
  for (const r of measured) byMode.set(`${r.track}/${r.mode}`, [...(byMode.get(`${r.track}/${r.mode}`) ?? []), r]);
  const workersOnly = new Map([...byMode].filter(([k]) => k.startsWith('workers/')).map(([k, v]) => [k.slice('workers/'.length), v]));
  const cohort = (track: 'workers' | 'assistant'): BenchmarkCohort | undefined => file.cohorts.find((c) => c.track === track);
  const workerPlanned = cohort('workers')?.plannedPerMode ?? manifest?.workers.attemptsPerRequiredMode ?? 0;
  const requiredWorkers = manifest?.workers.requiredModes.map((r) => ({ id: r.id as string, supported: r.availability === 'supported', reason: r.unavailableReason })) ?? (cohort('workers')?.requiredModes ?? []).map((id) => ({ id, supported: true, reason: null }));
  const extra = [...workersOnly.keys()].filter((id) => !requiredWorkers.some((r) => r.id === id));
  const modes = [
    ...requiredWorkers.map((r) => workerMode(r.id, workersOnly.get(r.id) ?? [], workerPlanned, true, r.supported, r.reason ?? (r.supported ? null : 'Not supported.'))),
    ...extra.map((id) => workerMode(id, workersOnly.get(id) ?? [], 0, false, true, null)),
  ];
  const assistantPlanned = cohort('assistant')?.plannedPerMode ?? 0;
  const routes = (cohort('assistant')?.requiredModes ?? ['ONLY_ON_DEVICE', 'ONLY_IN_CLOUD']).map((mode) => assistantRoute(mode, byMode.get(`assistant/${mode}`) ?? [], assistantPlanned));
  return {
    generatedAtUtc: file.generatedAtUtc,
    excluded: { simulated: file.records.filter((r) => r.dataKind === 'simulated').length, fixture: file.records.filter((r) => r.dataKind === 'fixture').length },
    workers: { modes, comparisons: [compare('L1', 'C1', workersOnly), compare('L1', 'H2', workersOnly)] },
    assistant: { routes },
    notes: NOTES,
  };
}

const rate = (c: Completion): string => `${c.passed} of ${c.of} attempts passed`;

export function renderReport(report: Report): string {
  const lines = [`Benchmark report, generated ${report.generatedAtUtc}`, ''];
  if (report.excluded.simulated + report.excluded.fixture > 0) lines.push(`Excluded, never evidence: ${report.excluded.simulated} simulated and ${report.excluded.fixture} fixture records.`, '');
  lines.push('Workers:');
  for (const m of report.workers.modes) {
    const a = m.attempts;
    if (m.status === 'Not measured') {
      lines.push(`  ${m.mode}: Not measured.${m.reason ? ` ${m.reason}` : ''}${a.missing > 0 ? ` ${a.missing} planned attempts have no record.` : ''}`);
      continue;
    }
    const t = m.deliveryTime;
    const parts = [
      `${rate(t.completion)}${t.median !== null ? `; median ${formatMs(t.median)} (min ${formatMs(t.min!)}, max ${formatMs(t.max!)}, n=${t.n})` : ''}.`,
      `Attempts: ${a.passed} passed, ${a.completedFailing} completed failing, ${a.failed} failed, ${a.timedOut} timed out, ${a.cancelled} cancelled, ${a.deniedStart} denied, ${a.abandoned} abandoned, ${a.notRun} not run.`,
      a.missing > 0 ? `${a.missing} planned attempts have no record.` : null,
      `Spend: ${m.spend.text}${m.spend.provenance === 'unavailable' && m.spend.knownSubtotal !== null ? ` (known subtotal ${usd(m.spend.knownSubtotal)})` : ''}. Cost per delivered change: ${m.costPerDeliveredChange.text}.`,
      m.permittedHumanActions !== null && m.permittedHumanActions > 0 ? `${m.permittedHumanActions} permitted human actions outside control mode.` : null,
      m.controlModeTrials > 0 ? `${m.controlModeTrials} trials used control mode.` : null,
      m.confounders.length > 0 ? `Confounders: ${m.confounders.join('; ')}.` : null,
    ];
    lines.push(`  ${m.mode}: ${parts.filter(Boolean).join(' ')}`);
  }
  lines.push('', 'Comparisons:');
  for (const c of report.workers.comparisons) {
    const head = c.exploratory ? `exploratory, ${c.validPairs} valid pairs (fewer than ${MIN_VALID_PAIRS}); no headline ratio` : `median ${c.a}/${c.b} delivery-time ratio ${c.headlineRatio!.toFixed(2)} over ${c.validPairs} valid pairs`;
    const excluded = c.excludedPairs.length > 0 ? ` Excluded: ${c.excludedPairs.map((p) => `${p.blockId} (${p.reason})`).join(', ')}.` : '';
    lines.push(`  ${c.id}: ${head}. ${c.a} ${rate(c.completion.a)}; ${c.b} ${rate(c.completion.b)}.${excluded}`);
  }
  lines.push('', 'Assistant:');
  for (const r of report.assistant.routes) {
    if (r.status === 'Not measured') { lines.push(`  ${r.mode}: Not measured.${r.attempts.missing > 0 ? ` ${r.attempts.missing} planned requests have no record.` : ''}`); continue; }
    const g = r.generationComplete;
    const f = r.firstOutput;
    lines.push(`  ${r.mode}: ${rate(g.completion)}${g.median !== null ? `; complete response median ${formatMs(g.median)} (n=${g.n})` : ''}. First output: ${f.median !== null ? `median ${formatMs(f.median)} (n=${f.n})` : 'not available'}. Routing ${r.routing.correct} of ${r.routing.of} correct; schema ${r.schema.valid} of ${r.schema.of} valid; ${r.warmups} warm-ups excluded from timing. Spend: ${r.spend.text}.`);
  }
  lines.push('', 'Notes:', ...report.notes.map((n) => `  - ${n}`));
  return clean(lines.join('\n'));
}
