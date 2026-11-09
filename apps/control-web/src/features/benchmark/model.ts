import { EXECUTION_LABELS, MODEL_ROUTE_LABELS } from '@selarikru/view-protocol';
import type { Tone } from '@selarikru/ui';
import { ASSISTANT_EVIDENCE_IDS, WORKER_MODES, type BenchmarkCohort, type BenchmarkFile, type BenchmarkLoad, type BenchmarkRecord, type WorkerMode } from './schema.ts';

/** Minimum attempts per mode the plan allows for even an exploratory comparison. */
export const MIN_ATTEMPTS_PER_MODE = 3;
/** Fewer valid pairs than this is exploratory: no headline speed result (plan section 4). */
export const MIN_VALID_PAIRS = 3;

export type FigureProvenance = 'observed' | 'estimated' | 'unavailable' | 'simulated';
export interface Figure { readonly text: string; readonly detail: string | null; readonly provenance: FigureProvenance; readonly basis: string }

export interface Counts { readonly total: number; readonly passed: number; readonly failed: number; readonly timedOut: number; readonly cancelled: number; readonly abandoned: number; readonly deniedStart: number; readonly notRun: number; readonly humanIntervened: number; readonly notRecorded: number; readonly warmups: number }

export type DataKind = 'measured' | 'simulated';

export interface HostCell { readonly text: string; readonly detail: string | null }

export interface WorkerRow {
  readonly mode: WorkerMode;
  readonly workerCount: 1 | 2;
  readonly workerLabel: string;
  readonly executionHost: HostCell;
  readonly inference: HostCell;
  readonly cache: string;
  readonly counts: Counts;
  readonly completion: Figure;
  readonly time: Figure;
  readonly usage: Figure;
  readonly hours: readonly Figure[];
  readonly cost: readonly Figure[];
  readonly human: Figure;
}

export interface AssistantRow {
  readonly mode: string;
  readonly requested: string;
  readonly observedSource: string;
  readonly cache: string;
  readonly counts: Counts;
  readonly completion: Figure;
  readonly routing: Figure;
  readonly schema: Figure;
  readonly firstOutput: Figure;
  readonly complete: Figure;
  readonly usage: Figure;
  readonly cost: Figure;
  readonly review: Figure;
}

export interface AttemptRow {
  readonly attemptId: string;
  readonly mode: string;
  readonly statusLabel: string;
  readonly tone: Tone;
  readonly passed: boolean;
  readonly criteria: string;
  readonly time: Figure;
  readonly cost: Figure;
  readonly humanLabel: string;
  readonly candidate: string | null;
  readonly candidateFull: string | null;
  readonly evidence: readonly { readonly label: string; readonly href: string | null }[];
  readonly failure: string | null;
}

export interface Fact { readonly label: string; readonly value: string; readonly full: string }

export type Verdict =
  | { readonly kind: 'winner'; readonly mode: string; readonly basis: 'completion' | 'speed'; readonly statement: string }
  | { readonly kind: 'none'; readonly reasons: readonly string[] };

export interface Comparison { readonly id: string; readonly title: string; readonly scope: string; readonly capacityNote: string | null; readonly verdict: Verdict }

export interface CohortBase {
  readonly cohortId: string;
  readonly kind: DataKind;
  readonly planned: number;
  readonly facts: readonly Fact[];
  readonly attempts: readonly AttemptRow[];
  readonly exclusions: readonly string[];
  readonly confounders: readonly string[];
  readonly costExclusions: readonly string[];
}
export interface WorkerCohortView extends CohortBase { readonly rows: readonly WorkerRow[]; readonly comparisons: readonly Comparison[] }
export interface AssistantCohortView extends CohortBase { readonly rows: readonly AssistantRow[]; readonly comparison: { readonly verdict: Verdict } }

export interface Totals { readonly attempts: number; readonly passed: number; readonly failed: number; readonly timedOut: number; readonly cancelled: number; readonly abandoned: number; readonly deniedStart: number; readonly notRun: number; readonly humanIntervened: number; readonly warmups: number }

export interface EvidenceRow { readonly id: string; readonly label: string; readonly detail: string; readonly status: 'not_measured' | 'recorded' | 'failed' | 'simulated'; readonly references: readonly { readonly label: string; readonly href: string | null }[] }

export interface BenchmarkModel {
  readonly source: BenchmarkLoad['kind'];
  readonly issues: readonly string[];
  readonly detail: string | null;
  readonly generatedAt: string | null;
  readonly assistant: { readonly totals: Totals; readonly measured: readonly AssistantCohortView[]; readonly simulated: readonly AssistantCohortView[]; readonly placeholder: readonly AssistantRow[]; readonly evidence: readonly EvidenceRow[] };
  readonly workers: { readonly totals: Totals; readonly measured: readonly WorkerCohortView[]; readonly simulated: readonly WorkerCohortView[]; readonly placeholder: readonly WorkerRow[] };
}

const NOT_MEASURED = 'Not measured';
const BASIS = {
  completion: 'Delivery success; all attempts count',
  time: 'End-to-end verified, server clock',
  usage: 'Provider-reported tokens',
  hours: 'Measured process time, not billed',
  human: 'Logged human minutes',
  localCost: 'Local hardware and energy',
  routing: 'Requested route against SDK-reported source',
  schema: 'Shared output schema',
  firstOutput: 'First output, browser clock',
  complete: 'Complete and validated, browser clock',
  assistantUsage: 'Provider-reported tokens',
  assistantCost: 'Provider-billed, requests only',
  review: 'Route-blind human review',
};

const notMeasured = (basis: string): Figure => ({ text: NOT_MEASURED, detail: null, provenance: 'unavailable', basis });
const unavailable = (basis: string, detail: string | null = null): Figure => ({ text: 'Unavailable', detail, provenance: 'unavailable', basis });
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSeconds = Math.round(ms / 100) / 10;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
const usd = (n: number): string => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const tokens = (n: number): string => `${Math.round(n).toLocaleString('en-US')} tokens`;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface Spread { readonly min: number; readonly max: number; readonly median: number; readonly n: number }
const spreadOf = (values: readonly number[]): Spread => ({ min: Math.min(...values), max: Math.max(...values), median: median(values), n: values.length });

/** A figure from a small sample shows its spread and size, and never reads as a single precise number. */
function timingFigure(values: readonly number[], outOf: number, basis: string): Figure {
  if (values.length === 0) return notMeasured(basis);
  const s = spreadOf(values);
  if (s.n === 1) return { text: formatMs(s.min), detail: 'Single attempt, n=1. Exploratory.', provenance: 'observed', basis };
  const range = `Range ${formatMs(s.min)} to ${formatMs(s.max)}. n=${s.n} of ${outOf}.`;
  return { text: `${formatMs(s.median)} median`, detail: s.n < MIN_ATTEMPTS_PER_MODE ? `${range} Exploratory.` : range, provenance: 'observed', basis };
}

const stamp = (figure: Figure, kind: DataKind): Figure => (kind === 'simulated' && figure.provenance !== 'unavailable' ? { ...figure, provenance: 'simulated' } : figure);

const ran = (r: BenchmarkRecord): boolean => r.status !== 'not_run';
const warmup = (r: BenchmarkRecord): boolean => r.assistant?.warmup === true;
const comparable = (r: BenchmarkRecord): boolean => ran(r) && r.operations.humanIntervened === false && !warmup(r);

function workerPassed(r: BenchmarkRecord): boolean {
  return r.status === 'completed' && r.quality.allRequiredChecksPassed === true && r.quality.withinDeclaredLimits === true;
}
const routingOk = (r: BenchmarkRecord): boolean => r.assistant !== null && ((r.assistant.requestedMode?.includes('DEVICE') && r.assistant.observedInferenceSource === 'ON_DEVICE') || (r.assistant.requestedMode?.includes('CLOUD') && r.assistant.observedInferenceSource === 'IN_CLOUD') || false);
const assistantPassed = (r: BenchmarkRecord): boolean => r.status === 'completed' && routingOk(r) && r.assistant?.schemaValid === true;

function countRecords(records: readonly BenchmarkRecord[], passed: (r: BenchmarkRecord) => boolean): Counts {
  const ranRecords = records.filter(ran);
  let failed = 0;
  let timedOut = 0;
  let cancelled = 0;
  let abandoned = 0;
  let deniedStart = 0;
  let pass = 0;
  let humanIntervened = 0;
  let notRecorded = 0;
  let warmups = 0;
  for (const r of ranRecords) {
    if (warmup(r)) { warmups += 1; continue; }
    if (r.operations.humanIntervened === true) { humanIntervened += 1; continue; }
    if (r.operations.humanIntervened === null) { notRecorded += 1; continue; }
    if (passed(r)) pass += 1;
    else if (r.status === 'timed_out') timedOut += 1;
    else if (r.status === 'cancelled') cancelled += 1;
    else if (r.status === 'abandoned') abandoned += 1;
    else if (r.status === 'denied_start') deniedStart += 1;
    else failed += 1;
  }
  return { total: ranRecords.length, passed: pass, failed, timedOut, cancelled, abandoned, deniedStart, notRun: records.length - ranRecords.length, humanIntervened, notRecorded, warmups };
}

function exclusionNotes(c: Counts): string[] {
  const notes: string[] = [];
  if (c.humanIntervened > 0) notes.push(`${c.humanIntervened} human-intervened ${c.humanIntervened === 1 ? 'attempt' : 'attempts'} excluded`);
  if (c.notRecorded > 0) notes.push(`${plural(c.notRecorded, 'attempt')} with human intervention not recorded, excluded`);
  return notes;
}

function completionFigure(c: Counts, n: number, word: string): Figure {
  if (c.total === 0) return notMeasured(BASIS.completion);
  const notes = exclusionNotes(c);
  return { text: `${c.passed} of ${n} ${word}`, detail: notes.length > 0 ? `${notes.join('; ')}.` : null, provenance: 'observed', basis: BASIS.completion };
}

/** One total per provenance. Observed and estimated are never added, and an attempt with no figure is named, not treated as zero. */
function costFigures(records: readonly BenchmarkRecord[]): Figure[] {
  const all = records.filter(ran);
  const rateCards = [...new Set(all.map((r) => r.cost.rateCardVersion).filter((v): v is string => v !== null))];
  const settlements = [...new Set(all.map((r) => r.cost.settlementStatus))];
  const context = `rate card ${rateCards.length > 0 ? rateCards.join(', ') : 'not recorded'}, ${settlements.join(', ') || 'unavailable'}`;
  const total = (pick: (r: BenchmarkRecord) => number | null, provenance: 'observed' | 'estimated', label: string): Figure => {
    const known = all.map(pick).filter((v): v is number => v !== null);
    const basis = `${label}, ${context}`;
    if (all.length === 0) return notMeasured(basis);
    if (known.length === 0) return unavailable(basis, 'Not recorded for any attempt. Not zero.');
    const partial = known.length < all.length ? `Partial: ${known.length} of ${all.length} attempts, ${all.length - known.length} unavailable.` : `All ${plural(all.length, 'attempt')}.`;
    return { text: usd(known.reduce((sum, v) => sum + v, 0)), detail: partial, provenance, basis };
  };
  return [
    total((r) => r.cost.platformPaidActual, 'observed', 'Platform-paid actual'),
    total((r) => r.cost.platformPaidEstimated, 'estimated', 'Platform-paid estimate'),
    localCostFigure(all),
  ];
}

function localCostFigure(all: readonly BenchmarkRecord[]): Figure {
  if (all.length === 0) return notMeasured(BASIS.localCost);
  const known = all.map((r) => r.cost.localHardwareEnergyCost).filter((v): v is number => v !== null);
  if (known.length === 0) return unavailable(BASIS.localCost, 'No collector recorded it. Not zero.');
  return { text: usd(known.reduce((s, v) => s + v, 0)), detail: `Local hardware and energy, ${known.length} of ${plural(all.length, 'attempt')}.`, provenance: 'estimated', basis: BASIS.localCost };
}

function usageRollup(r: BenchmarkRecord): { provenance: 'observed' | 'estimated' | 'unavailable'; total: number | null } {
  const roles = r.resources.providerUsageByRole;
  if (roles.length === 0) return { provenance: 'unavailable', total: null };
  if (roles.some((role) => role.provenance === 'unavailable' || (role.inputTokens === null && role.outputTokens === null))) return { provenance: 'unavailable', total: null };
  const total = roles.reduce((s, role) => s + (role.inputTokens ?? 0) + (role.outputTokens ?? 0) + (role.cacheTokens ?? 0), 0);
  return { provenance: roles.some((role) => role.provenance === 'estimated') ? 'estimated' : 'observed', total };
}

function usageFigure(rollups: readonly { provenance: 'observed' | 'estimated' | 'unavailable'; total: number | null }[], outOf: number, basis: string): Figure {
  if (rollups.length === 0) return notMeasured(basis);
  const observed = rollups.filter((r) => r.provenance === 'observed' && r.total !== null).map((r) => r.total!);
  const estimated = rollups.filter((r) => r.provenance === 'estimated' && r.total !== null).map((r) => r.total!);
  const missing = rollups.length - observed.length - estimated.length;
  const notes = [estimated.length > 0 && observed.length > 0 ? `${estimated.length} estimated` : null, missing > 0 ? `${missing} unavailable` : null].filter(Boolean).join(', ');
  if (observed.length > 0) return { text: `${tokens(median(observed))} median`, detail: `Median of ${observed.length} of ${plural(outOf, 'attempt')} with observed usage.${notes ? ` ${notes}.` : ''}`, provenance: 'observed', basis };
  if (estimated.length > 0) return { text: `${tokens(median(estimated))} median`, detail: `Median of ${estimated.length} of ${plural(outOf, 'attempt')} with estimated usage.${notes ? ` ${notes}.` : ''}`, provenance: 'estimated', basis };
  return unavailable(basis, 'Not reported for any attempt. Not zero.');
}

function sumFigure(values: readonly (number | null)[], total: number, unit: string, basis: string, what: string): Figure {
  if (total === 0) return notMeasured(basis);
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return unavailable(basis, `${what} not recorded.`);
  const sum = known.reduce((s, v) => s + v, 0);
  const shown = unit === 'h' ? `${sum.toFixed(2)} h` : `${Math.round(sum)} ${unit}`;
  return { text: shown, detail: known.length < total ? `${what}: ${known.length} of ${plural(total, 'attempt')}.` : `${what}, ${plural(total, 'attempt')}.`, provenance: 'observed', basis };
}

const cacheLabel = (records: readonly BenchmarkRecord[]): string => {
  const values = new Set(records.filter(ran).map((r) => r.configuration.cacheCondition));
  if (values.size === 0) return NOT_MEASURED;
  if (values.size > 1) return 'Mixed warm and cold';
  const [only] = values;
  return only === 'warm' ? 'Warm' : only === 'cold' ? 'Cold' : 'Not recorded';
};

const withheld = (basis: string): Figure => ({ text: 'Withheld', detail: 'Warm and cold attempts are mixed, so one median would mislead.', provenance: 'unavailable', basis });

const WORKER_COUNT: Readonly<Record<WorkerMode, 1 | 2>> = { L1: 1, C1: 1, H2: 2, L2: 2, C2: 2 };
const workerLabel = (mode: WorkerMode): string => (WORKER_COUNT[mode] === 1 ? 'One coding worker' : 'Two coding workers');
const EXECUTION: Readonly<Record<WorkerMode, string>> = {
  L1: EXECUTION_LABELS.local, C1: EXECUTION_LABELS.cloud,
  H2: `${EXECUTION_LABELS.local} and ${EXECUTION_LABELS.cloud}`,
  L2: EXECUTION_LABELS.local, C2: EXECUTION_LABELS.cloud,
};

const distinctText = (records: readonly BenchmarkRecord[], pick: (r: BenchmarkRecord) => string | null): string[] => [...new Set(records.filter(ran).map(pick).filter((v): v is string => v !== null))];

function hostCell(mode: WorkerMode, records: readonly BenchmarkRecord[]): HostCell {
  const hosts = distinctText(records, (r) => (mode === 'C1' || mode === 'C2' ? r.configuration.cloudHost : mode === 'H2' ? `${r.configuration.localHost ?? '?'} and ${r.configuration.cloudHost ?? '?'}` : r.configuration.localHost));
  return { text: EXECUTION[mode], detail: hosts.length > 0 ? hosts.join(', ') : null };
}

function inferenceCell(records: readonly BenchmarkRecord[]): HostCell {
  const destinations = new Set(records.filter(ran).map((r) => r.configuration.inferenceDestination));
  if (destinations.size === 0) return { text: NOT_MEASURED, detail: null };
  const models = distinctText(records, (r) => r.configuration.codingModel);
  const detail = models.length > 0 ? models.join(', ') : null;
  if (destinations.size > 1) return { text: 'Mixed destinations', detail };
  const [only] = destinations;
  return { text: only === null || only === undefined ? 'Not recorded' : MODEL_ROUTE_LABELS[only], detail };
}

function workerRow(mode: WorkerMode, records: readonly BenchmarkRecord[], kind: DataKind): WorkerRow {
  const counts = countRecords(records, workerPassed);
  const N = records.filter(comparable).length;
  const all = records.filter(ran);
  const passing = records.filter((r) => comparable(r) && workerPassed(r) && r.timings.endToEndVerifiedMs !== null);
  const mixed = new Set(records.filter(comparable).map((r) => r.configuration.cacheCondition)).size > 1;
  const row: WorkerRow = {
    mode, workerCount: WORKER_COUNT[mode], workerLabel: workerLabel(mode), executionHost: hostCell(mode, records), inference: inferenceCell(records), cache: cacheLabel(records), counts,
    completion: completionFigure(counts, N, 'passed'),
    time: mixed ? withheld(BASIS.time) : timingFigure(passing.map((r) => r.timings.endToEndVerifiedMs!), N, BASIS.time),
    usage: usageFigure(all.map(usageRollup), all.length, BASIS.usage),
    // A mode only has hours on the hosts it uses: L1 has no cloud hours to be unavailable.
    hours: [
      ...(mode === 'C1' || mode === 'C2' ? [] : [sumFigure(all.map((r) => r.resources.localWorkerHours), all.length, 'h', BASIS.hours, 'Local worker-hours')]),
      ...(mode === 'L1' || mode === 'L2' ? [] : [sumFigure(all.map((r) => r.resources.cloudWorkerHours), all.length, 'h', BASIS.hours, 'Cloud worker-hours')]),
    ],
    cost: costFigures(records),
    human: sumFigure(all.map((r) => (r.humanMinutes.intervention === null && r.humanMinutes.correction === null && r.humanMinutes.review === null ? null : (r.humanMinutes.intervention ?? 0) + (r.humanMinutes.correction ?? 0) + (r.humanMinutes.review ?? 0))), all.length, 'min', BASIS.human, 'Human minutes'),
  };
  return kind === 'simulated' ? { ...row, completion: stamp(row.completion, kind), time: stamp(row.time, kind), usage: stamp(row.usage, kind), hours: row.hours.map((f) => stamp(f, kind)), cost: row.cost.map((f) => stamp(f, kind)), human: stamp(row.human, kind) } : row;
}

const POLICY: Readonly<Record<string, string>> = { ONLY_ON_DEVICE: 'Device only', PREFER_ON_DEVICE: 'Device preferred', ONLY_IN_CLOUD: 'Cloud only', PREFER_IN_CLOUD: 'Cloud preferred' };

function assistantRow(mode: string, records: readonly BenchmarkRecord[], kind: DataKind): AssistantRow {
  const counts = countRecords(records, assistantPassed);
  const measured = records.filter(comparable);
  const correct = measured.filter(routingOk);
  const timed = measured.filter(assistantPassed);
  const mixed = new Set(measured.map((r) => r.configuration.cacheCondition)).size > 1;
  const sources = [...new Set(measured.map((r) => (r.assistant?.observedInferenceSource === 'ON_DEVICE' ? 'On device' : r.assistant?.observedInferenceSource === 'IN_CLOUD' ? 'In cloud' : 'Unknown')))];
  const usageRollups = measured.map((r) => {
    const input = r.assistant?.providerInputTokens ?? null;
    const output = r.assistant?.providerOutputTokens ?? null;
    return input === null && output === null ? { provenance: 'unavailable' as const, total: null } : { provenance: 'observed' as const, total: (input ?? 0) + (output ?? 0) };
  });
  const valid = measured.filter((r) => r.assistant?.schemaValid === true);
  const reviews = measured.filter((r) => r.assistant?.semanticReview.retainedFacts !== null);
  const assistantCost = costFigures(records)[0]!;
  const row: AssistantRow = {
    mode, requested: POLICY[mode] ?? mode, observedSource: sources.length > 0 ? sources.join(', ') : NOT_MEASURED, cache: cacheLabel(records), counts,
    completion: completionFigure(counts, measured.length, 'passed'),
    routing: measured.length === 0 ? notMeasured(BASIS.routing) : { text: `${correct.length} of ${measured.length} correct`, detail: null, provenance: 'observed', basis: BASIS.routing },
    schema: measured.length === 0 ? notMeasured(BASIS.schema) : { text: `${valid.length} of ${measured.length} valid`, detail: null, provenance: 'observed', basis: BASIS.schema },
    firstOutput: mixed ? withheld(BASIS.firstOutput) : timingFigure(timed.map((r) => r.timings.firstOutputMs).filter((v): v is number => v !== null), measured.length, BASIS.firstOutput),
    complete: mixed ? withheld(BASIS.complete) : timingFigure(timed.map((r) => r.timings.generationCompleteMs).filter((v): v is number => v !== null), measured.length, BASIS.complete),
    usage: usageFigure(usageRollups, measured.length, BASIS.assistantUsage),
    cost: assistantCost.text === NOT_MEASURED ? notMeasured(BASIS.assistantCost) : { ...assistantCost, basis: `${BASIS.assistantCost}. ${assistantCost.basis}` },
    review: measured.length === 0 ? notMeasured(BASIS.review) : reviews.length === 0 ? unavailable(BASIS.review, 'Not reviewed yet.') : { text: `${reviews.length} of ${measured.length} reviewed`, detail: `${reviews.reduce((s, r) => s + (r.assistant?.semanticReview.inventedRequirements ?? 0), 0)} invented requirements found.`, provenance: 'observed', basis: BASIS.review },
  };
  return kind === 'simulated' ? { ...row, completion: stamp(row.completion, kind), routing: stamp(row.routing, kind), schema: stamp(row.schema, kind), firstOutput: stamp(row.firstOutput, kind), complete: stamp(row.complete, kind), usage: stamp(row.usage, kind), cost: stamp(row.cost, kind), review: stamp(row.review, kind) } : row;
}

function evidenceLinks(references: readonly string[]): { label: string; href: string | null }[] {
  return references.map((ref) => {
    if (ref.startsWith('#/')) return { label: 'Evidence record', href: ref };
    if (ref.startsWith('https://')) return { label: 'External artifact', href: ref };
    return { label: ref, href: null };
  });
}

function statusOf(record: BenchmarkRecord, passed: boolean): { label: string; tone: Tone } {
  if (record.status === 'not_run') return { label: 'Not run', tone: 'neutral' };
  if (passed) return { label: 'Passed', tone: 'success' };
  if (record.status === 'completed') return record.track === 'workers' ? (record.quality.allRequiredChecksPassed === false ? { label: 'Failed checks', tone: 'danger' } : { label: 'Checks not recorded', tone: 'warning' }) : { label: 'Failed', tone: 'danger' };
  const labels: Readonly<Record<string, { label: string; tone: Tone }>> = {
    failed: { label: 'Failed', tone: 'danger' }, timed_out: { label: 'Timed out', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'warning' }, denied_start: { label: 'Denied at start', tone: 'warning' }, abandoned: { label: 'Abandoned', tone: 'warning' },
  };
  return labels[record.status]!;
}

function humanLabelOf(record: BenchmarkRecord): string {
  if (!ran(record)) return 'No';
  if (record.operations.humanIntervened === true) return 'Human-intervened, excluded';
  if (record.operations.humanIntervened === null) return 'Not recorded, excluded';
  return 'No';
}

function criteriaText(record: BenchmarkRecord): string {
  if (!ran(record)) return NOT_MEASURED;
  if (record.track === 'assistant') {
    const schema = record.assistant?.schemaValid === true ? 'Schema valid' : record.assistant?.schemaValid === false ? 'Schema invalid' : 'Schema not recorded';
    return `${schema}, routing ${routingOk(record) ? 'correct' : 'failed'}`;
  }
  const criteria = record.quality.criteria;
  if (criteria.length === 0) return 'Not recorded';
  if (criteria.every((c) => c.status === 'not_run')) return 'Checks did not run';
  const passed = criteria.filter((c) => c.status === 'passed').length;
  const failed = criteria.filter((c) => c.status === 'failed' || c.status === 'error').map((c) => c.id);
  return `${passed} of ${criteria.length} passed${failed.length > 0 ? `. Failed: ${failed.join(', ')}` : ''}`;
}

function attemptRow(record: BenchmarkRecord, kind: DataKind): AttemptRow {
  const passed = record.track === 'workers' ? workerPassed(record) : assistantPassed(record);
  const status = statusOf(record, passed);
  const ms = record.track === 'workers' ? record.timings.endToEndVerifiedMs : record.timings.generationCompleteMs;
  const timeBasis = record.track === 'workers' ? BASIS.time : BASIS.complete;
  const costValue = record.cost.platformPaidActual ?? record.cost.platformPaidEstimated;
  const costProvenance: FigureProvenance = record.cost.platformPaidActual !== null ? 'observed' : record.cost.platformPaidEstimated !== null ? 'estimated' : 'unavailable';
  const failure = record.failures.length > 0 ? record.failures.map((f) => (f.detail !== null ? `${f.category}: ${f.detail}` : f.category)).join('; ') : null;
  const prefix = ran(record) ? 'Unavailable' : NOT_MEASURED;
  return {
    attemptId: record.attemptId, mode: POLICY[record.mode] ?? record.mode, statusLabel: status.label, tone: status.tone, passed, criteria: criteriaText(record),
    time: stamp(ms !== null ? { text: formatMs(ms), detail: record.track === 'workers' && !passed ? 'Not a passing run, so not in the median.' : null, provenance: 'observed', basis: timeBasis } : { text: prefix, detail: null, provenance: 'unavailable', basis: timeBasis }, kind),
    cost: stamp(costValue !== null ? { text: usd(costValue), detail: null, provenance: costProvenance, basis: `Platform-paid. Rate card ${record.cost.rateCardVersion ?? 'not recorded'}.` } : { text: prefix, detail: null, provenance: 'unavailable', basis: 'Platform-paid.' }, kind),
    humanLabel: humanLabelOf(record), candidate: record.configuration.candidateSha?.slice(0, 12) ?? null, candidateFull: record.configuration.candidateSha, evidence: evidenceLinks(record.artifactReferences), failure,
  };
}

const short = (value: string): string => (/^[0-9a-f]{16,}$/i.test(value) ? value.slice(0, 12) : value);

function factOf(label: string, records: readonly BenchmarkRecord[], pick: (r: BenchmarkRecord) => string | null): Fact {
  const values = [...new Set(records.map(pick))];
  if (values.length === 0) return { label, value: NOT_MEASURED, full: NOT_MEASURED };
  const nonNull = values.filter((v): v is string => v !== null);
  if (nonNull.length === 0) return { label, value: 'Not recorded', full: 'Not recorded' };
  return { label, value: nonNull.map(short).join(', ') + (values.length > nonNull.length ? ', not recorded' : ''), full: nonNull.join(', ') };
}

const WORKER_FACTS: readonly [string, (r: BenchmarkRecord) => string | null][] = [
  ['Starter', (r) => r.configuration.starterSha], ['Contract', (r) => r.configuration.contractSha256], ['Verifier', (r) => r.configuration.verifierSha],
  ['Harness', (r) => r.configuration.harness], ['Harness version', (r) => r.configuration.harnessVersion], ['Model', (r) => r.configuration.codingModel], ['Account', (r) => r.configuration.providerAccountReference],
];

type Dim = { readonly label: string; readonly pick: (r: BenchmarkRecord) => string | null; readonly mixMessage?: string };
const MATCH_DIMS: readonly Dim[] = [
  { label: 'starter', pick: (r) => r.configuration.starterSha },
  { label: 'contract', pick: (r) => r.configuration.contractSha256 },
  { label: 'verifier', pick: (r) => r.configuration.verifierSha },
  { label: 'harness', pick: (r) => r.configuration.harness },
  { label: 'harness version', pick: (r) => r.configuration.harnessVersion },
  { label: 'model', pick: (r) => r.configuration.codingModel },
  { label: 'account', pick: (r) => r.configuration.providerAccountReference },
  { label: 'inference destination', pick: (r) => r.configuration.inferenceDestination },
  { label: 'cache condition', pick: (r) => r.configuration.cacheCondition, mixMessage: 'Warm and cold attempts are mixed, so this is not a like-for-like comparison.' },
];

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function sideReasons(mode: string, records: readonly BenchmarkRecord[], planned: number, counts: Counts): string[] {
  if (counts.total === 0) return [`${mode}: Not measured.`];
  const reasons: string[] = [];
  const comparableCount = records.filter(comparable).length;
  if (comparableCount < planned) reasons.push(`${mode}: ${comparableCount} of ${planned} planned attempts can be compared.`);
  if (counts.notRun > 0) reasons.push(`${mode}: ${plural(counts.notRun, 'attempt')} not run.`);
  if (comparableCount < MIN_ATTEMPTS_PER_MODE) reasons.push(`${mode}: below the minimum of ${MIN_ATTEMPTS_PER_MODE} attempts per mode.`);
  for (const note of exclusionNotes(counts)) reasons.push(`${mode}: ${note}.`);
  return reasons;
}

function dimensionReasons(records: readonly BenchmarkRecord[]): string[] {
  const reasons: string[] = [];
  for (const dim of MATCH_DIMS) {
    const values = new Set(records.map(dim.pick));
    if (values.size > 1 && [...values].every((v) => v !== null) && dim.mixMessage) { reasons.push(dim.mixMessage); continue; }
    if (values.has(null)) { reasons.push(`${capitalize(dim.label)} not recorded.`); continue; }
    if (values.size > 1) reasons.push(`Not the same ${dim.label}: ${values.size} values recorded.`);
  }
  return reasons;
}

interface Side { readonly mode: string; readonly records: readonly BenchmarkRecord[]; readonly passedN: number; readonly N: number; readonly spread: Spread | null }

function toSide(mode: string, records: readonly BenchmarkRecord[]): Side {
  const usable = records.filter(comparable);
  const passing = usable.filter((r) => workerPassed(r) && r.timings.endToEndVerifiedMs !== null).map((r) => r.timings.endToEndVerifiedMs!);
  return { mode, records, passedN: usable.filter(workerPassed).length, N: usable.length, spread: passing.length > 0 ? spreadOf(passing) : null };
}

function validPairs(a: readonly BenchmarkRecord[], b: readonly BenchmarkRecord[]): number {
  const blocks = (rows: readonly BenchmarkRecord[]) => {
    const map = new Map<string, BenchmarkRecord[]>();
    for (const r of rows.filter((x) => comparable(x) && x.blockId !== null)) map.set(r.blockId!, [...(map.get(r.blockId!) ?? []), r]);
    return map;
  };
  const left = blocks(a);
  const right = blocks(b);
  let count = 0;
  for (const [block, rows] of left) {
    const other = right.get(block);
    if (!other || rows.length !== 1 || other.length !== 1) continue;
    const pair = [rows[0]!, other[0]!];
    if (pair.every((r) => workerPassed(r) && r.timings.endToEndVerifiedMs !== null)) count += 1;
  }
  return count;
}

function verdictFor(a: Side, b: Side, planned: number, kind: DataKind, aCounts: Counts, bCounts: Counts): Verdict {
  if (kind !== 'measured') return { kind: 'none', reasons: ['Simulated data never produces a comparison result. This shows the layout only.'] };
  const reasons = [...sideReasons(a.mode, a.records, planned, aCounts), ...sideReasons(b.mode, b.records, planned, bCounts)];
  if (aCounts.total > 0 && bCounts.total > 0) reasons.push(...dimensionReasons([...a.records, ...b.records].filter(comparable)));
  if (reasons.length > 0) return { kind: 'none', reasons };

  const statement = (s: Side): string => `On this fixture and configuration, ${s.passedN} of ${s.N} attempts passed; passing runs had median ${formatMs(s.spread!.median)}, range ${formatMs(s.spread!.min)} to ${formatMs(s.spread!.max)}.`;
  if (a.passedN === 0 && b.passedN === 0) return { kind: 'none', reasons: ['No attempt passed in either mode.'] };
  const left = a.passedN * b.N;
  const right = b.passedN * a.N;
  if (left !== right) {
    const winner = left > right ? a : b;
    return winner.spread ? { kind: 'winner', mode: winner.mode, basis: 'completion', statement: statement(winner) } : { kind: 'none', reasons: ['Passing runs have no recorded times.'] };
  }
  const pairs = validPairs(a.records, b.records);
  if (pairs < MIN_VALID_PAIRS) return { kind: 'none', reasons: [`Only ${plural(pairs, 'valid pair')} with both attempts passing. Under ${MIN_VALID_PAIRS} is exploratory, with no headline speed result.`] };
  if (!a.spread || !b.spread) return { kind: 'none', reasons: ['Passing runs have no recorded times.'] };
  if (a.spread.min <= b.spread.max && b.spread.min <= a.spread.max) return { kind: 'none', reasons: [`Delivery-time ranges overlap (${formatMs(a.spread.min)} to ${formatMs(a.spread.max)} and ${formatMs(b.spread.min)} to ${formatMs(b.spread.max)}), so neither is clearly faster on this cohort.`] };
  const winner = a.spread.median <= b.spread.median ? a : b;
  return { kind: 'winner', mode: winner.mode, basis: 'speed', statement: statement(winner) };
}

const costExclusionsOf = (records: readonly BenchmarkRecord[]): string[] => [...new Set(records.flatMap((r) => r.cost.exclusions))];

function workerCohort(cohort: BenchmarkCohort, records: readonly BenchmarkRecord[], kind: DataKind): WorkerCohortView {
  const present = WORKER_MODES.filter((m) => records.some((r) => r.mode === m));
  const modes = WORKER_MODES.filter((m) => cohort.requiredModes.includes(m) || present.includes(m));
  const byMode = new Map(modes.map((mode) => [mode, records.filter((r) => r.mode === mode)]));
  const rows = modes.map((mode) => workerRow(mode, byMode.get(mode)!, kind));
  const countsOf = new Map(rows.map((r) => [r.mode, r.counts]));
  const pair = (first: WorkerMode, second: WorkerMode): Comparison | null => {
    if (!countsOf.has(first) || !countsOf.has(second)) return null;
    const mixedCapacity = WORKER_COUNT[first] !== WORKER_COUNT[second];
    const twoWorker = WORKER_COUNT[first] === 2 ? first : second;
    const oneWorker = WORKER_COUNT[first] === 2 ? second : first;
    return {
      id: `${first}-${second}`,
      title: `${first} vs ${second}`,
      scope: mixedCapacity ? `Capacity and workflow: ${twoWorker} has two coding workers, ${oneWorker} has one.` : 'Placement: the same number of coding workers on each side.',
      capacityNote: mixedCapacity ? `${twoWorker} has two coding workers, ${oneWorker} has one. This compares capacity and workflow, not placement alone.` : null,
      verdict: verdictFor(toSide(first, byMode.get(first)!), toSide(second, byMode.get(second)!), cohort.plannedPerMode, kind, countsOf.get(first)!, countsOf.get(second)!),
    };
  };
  const comparisons = [pair('L1', 'C1'), pair('H2', 'L1'), pair('H2', 'C1'), pair('L2', 'C2')].filter((c): c is Comparison => c !== null);
  const confounders = [...new Set(records.flatMap((r) => r.confounders))];
  const facts = [...WORKER_FACTS.map(([label, pick]) => factOf(label, records.filter(ran), pick)), { label: 'Order', value: cohort.order ?? 'Not recorded', full: cohort.order ?? 'Not recorded' }];
  const exclusions = rows.flatMap((r) => exclusionNotes(r.counts).map((n) => `${r.mode}: ${n}.`));
  return { cohortId: cohort.cohortId, kind, planned: cohort.plannedPerMode, facts, attempts: records.map((r) => attemptRow(r, kind)), rows, comparisons, exclusions, confounders, costExclusions: costExclusionsOf(records) };
}

function assistantCohortView(cohort: BenchmarkCohort, records: readonly BenchmarkRecord[], kind: DataKind): AssistantCohortView {
  const modes = [...cohort.requiredModes, ...new Set(records.map((r) => r.mode).filter((m) => !cohort.requiredModes.includes(m)))];
  const rows = modes.map((mode) => assistantRow(mode, records.filter((r) => r.mode === mode), kind));
  const reasons = kind === 'measured' ? ['Device and cloud run different models, so this compares routes. A winner needs the same model.'] : ['Simulated data never produces a comparison result. This shows the layout only.'];
  const facts: Fact[] = [factOf('SDK', records.filter(ran), (r) => r.assistant?.sdkVersion ?? null), factOf('Models', records.filter(ran), (r) => r.configuration.codingModel), { label: 'Order', value: cohort.order ?? 'Not recorded', full: cohort.order ?? 'Not recorded' }];
  const exclusions = rows.flatMap((r) => [...exclusionNotes(r.counts), ...(r.counts.warmups > 0 ? [`${plural(r.counts.warmups, 'warm-up request')} not timed`] : [])].map((n) => `${r.requested}: ${n}.`));
  return { cohortId: cohort.cohortId, kind, planned: cohort.plannedPerMode, facts, attempts: records.map((r) => attemptRow(r, kind)), rows, comparison: { verdict: { kind: 'none', reasons } }, exclusions, confounders: [...new Set(records.flatMap((r) => r.confounders))], costExclusions: costExclusionsOf(records) };
}

const EMPTY_COUNTS: Counts = { total: 0, passed: 0, failed: 0, timedOut: 0, cancelled: 0, abandoned: 0, deniedStart: 0, notRun: 0, humanIntervened: 0, notRecorded: 0, warmups: 0 };
const addCounts = (t: Totals, c: Counts): Totals => ({ attempts: t.attempts + c.total, passed: t.passed + c.passed, failed: t.failed + c.failed, timedOut: t.timedOut + c.timedOut, cancelled: t.cancelled + c.cancelled, abandoned: t.abandoned + c.abandoned, deniedStart: t.deniedStart + c.deniedStart, notRun: t.notRun + c.notRun, humanIntervened: t.humanIntervened + c.humanIntervened, warmups: t.warmups + c.warmups });
const ZERO_TOTALS: Totals = { attempts: 0, passed: 0, failed: 0, timedOut: 0, cancelled: 0, abandoned: 0, deniedStart: 0, notRun: 0, humanIntervened: 0, warmups: 0 };

const EVIDENCE_LABELS: Readonly<Record<(typeof ASSISTANT_EVIDENCE_IDS)[number], [string, string]>> = {
  pinned_configuration: ['Pinned configuration', 'SDK, model, machine, browser and origin recorded.'],
  device_only_response: ['Device-only response', 'A real response the SDK reported as on device.'],
  approved_cloud_response: ['Approved cloud response', 'A real response the SDK reported as in cloud.'],
  live_fallback: ['Live fallback', 'A permitted fallback, when the device route was actually unavailable.'],
  blocked_restricted_fallback: ['Blocked restricted fallback', 'The same condition on device-only input blocks the request.'],
  schema_validation: ['Schema validation', 'Structured output checked against the shared schema.'],
  accepted_handoff: ['Accepted handoff', 'The proposal accepted through the existing workflow.'],
};

function evidenceRows(items: BenchmarkFile['assistantEvidence']): EvidenceRow[] {
  return ASSISTANT_EVIDENCE_IDS.map((id) => {
    const [label, detail] = EVIDENCE_LABELS[id];
    const item = items.find((i) => i.id === id);
    const status = !item ? 'not_measured' : item.dataKind !== 'measured' ? 'simulated' : item.status === 'recorded' ? 'recorded' : item.status === 'failed' ? 'failed' : 'not_measured';
    return { id, label, detail, status, references: status === 'simulated' ? [] : evidenceLinks(item?.references ?? []) };
  });
}

const placeholderWorker = (mode: WorkerMode): WorkerRow => ({
  mode, workerCount: WORKER_COUNT[mode], workerLabel: workerLabel(mode), executionHost: { text: EXECUTION[mode], detail: null }, inference: { text: NOT_MEASURED, detail: null }, cache: NOT_MEASURED, counts: EMPTY_COUNTS,
  completion: notMeasured(BASIS.completion), time: notMeasured(BASIS.time), usage: notMeasured(BASIS.usage), hours: [notMeasured(BASIS.hours)], cost: [notMeasured('Platform-paid actual, rate card recorded with results')], human: notMeasured(BASIS.human),
});

const placeholderAssistant = (mode: string): AssistantRow => ({
  mode, requested: POLICY[mode] ?? mode, observedSource: NOT_MEASURED, cache: NOT_MEASURED, counts: EMPTY_COUNTS,
  completion: notMeasured(BASIS.completion), routing: notMeasured(BASIS.routing), schema: notMeasured(BASIS.schema), firstOutput: notMeasured(BASIS.firstOutput), complete: notMeasured(BASIS.complete), usage: notMeasured(BASIS.assistantUsage), cost: notMeasured(BASIS.assistantCost), review: notMeasured(BASIS.review),
});

/** Turns a results file into everything the panel shows. Only the record's own `dataKind` decides which side of the wall it lands on, and simulated records can never reach `measured` or `totals`. */
export function buildBenchmark(load: BenchmarkLoad): BenchmarkModel {
  const placeholders = { workers: (['L1', 'C1', 'H2'] as const).map(placeholderWorker), assistant: ['ONLY_ON_DEVICE', 'ONLY_IN_CLOUD'].map(placeholderAssistant) };
  if (load.kind !== 'ok') {
    return {
      source: load.kind, issues: load.kind === 'invalid' ? load.issues : [], detail: load.kind === 'unreachable' ? load.detail : null, generatedAt: null,
      assistant: { totals: ZERO_TOTALS, measured: [], simulated: [], placeholder: placeholders.assistant, evidence: evidenceRows([]) },
      workers: { totals: ZERO_TOTALS, measured: [], simulated: [], placeholder: placeholders.workers },
    };
  }
  const { file } = load;
  const groupOf = (kind: DataKind) => {
    const inKind = file.records.filter((r) => (kind === 'measured' ? r.dataKind === 'measured' : r.dataKind !== 'measured'));
    return file.cohorts.map((cohort) => ({ cohort, records: inKind.filter((r) => r.cohortId === cohort.cohortId) })).filter((g) => g.records.length > 0);
  };
  const workerViews = (kind: DataKind) => groupOf(kind).filter((g) => g.cohort.track === 'workers').map((g) => workerCohort(g.cohort, g.records, kind));
  const assistantViews = (kind: DataKind) => groupOf(kind).filter((g) => g.cohort.track === 'assistant').map((g) => assistantCohortView(g.cohort, g.records, kind));
  const measuredWorkers = workerViews('measured');
  const measuredAssistant = assistantViews('measured');
  return {
    source: 'ok', issues: [], detail: null, generatedAt: file.generatedAtUtc,
    assistant: { totals: measuredAssistant.flatMap((c) => c.rows.map((r) => r.counts)).reduce(addCounts, ZERO_TOTALS), measured: measuredAssistant, simulated: assistantViews('simulated'), placeholder: placeholders.assistant, evidence: evidenceRows(file.assistantEvidence) },
    workers: { totals: measuredWorkers.flatMap((c) => c.rows.map((r) => r.counts)).reduce(addCounts, ZERO_TOTALS), measured: measuredWorkers, simulated: workerViews('simulated'), placeholder: placeholders.workers },
  };
}
