import { measureText, type Measure, type OutcomePlanContent, type ProductDecision, type TraceRow } from '@selarikru/domain';
import type { Tone } from '@selarikru/ui';

/** One entry per non-empty line, trimmed. */
export const lines = (s: string): string[] => s.split('\n').map((x) => x.trim()).filter((x) => x.length > 0);
const orNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/**
 * A figure from a form. A blank or unreadable value is unknown whatever provenance was picked: `Number('')` is 0, and an unknown must never become a number.
 */
export function measureFrom(value: string, unit: string | null, provenance: Measure['provenance']): Measure {
  const t = value.trim();
  const n = t === '' ? Number.NaN : Number(t);
  const u = unit === null ? null : orNull(unit);
  if (!Number.isFinite(n) || provenance === 'unavailable') return { value: null, unit: u, provenance: 'unavailable', basis: null };
  return { value: n, unit: u, provenance, basis: null };
}

/** How a figure reads: its value with observed or estimated, or Unknown. */
export const measureLabel = (m: Measure): string => measureText(m);

export interface PlanForm {
  readonly requirementIds: readonly string[];
  readonly milestone: string;
  readonly metric: string;
  readonly baselineValue: string;
  readonly baselineUnit: string;
  readonly baselineProvenance: Measure['provenance'];
  readonly targetValue: string;
  readonly targetUnit: string;
  readonly targetProvenance: Measure['provenance'];
  readonly learningQuestion: string;
  readonly windowDays: string;
  readonly dataSource: string;
  readonly cohort: string;
  readonly guardrails: string;
  readonly reviewOwner: string;
  readonly reviewDate: string;
  readonly decisionOptions: readonly ProductDecision[];
  readonly reportLabel: string;
  readonly reportUrl: string;
  readonly confidence: OutcomePlanContent['confidence'];
}

/** The plan a form describes. Every blank optional field is unknown (null), never a default. */
export function planFrom(f: PlanForm): OutcomePlanContent {
  const days = f.windowDays.trim() === '' ? null : Number(f.windowDays.trim());
  return {
    schemaVersion: 1, requirementIds: [...f.requirementIds], milestone: orNull(f.milestone), metric: f.metric.trim(),
    baseline: measureFrom(f.baselineValue, f.baselineUnit, f.baselineProvenance), target: measureFrom(f.targetValue, f.targetUnit, f.targetProvenance),
    learningQuestion: orNull(f.learningQuestion), windowDays: days !== null && Number.isInteger(days) && days > 0 ? days : null, dataSource: orNull(f.dataSource), cohort: orNull(f.cohort),
    guardrails: lines(f.guardrails), reviewOwner: f.reviewOwner.trim(), reviewDate: orNull(f.reviewDate), decisionOptions: [...f.decisionOptions],
    reportLinks: f.reportUrl.trim() !== '' && f.reportLabel.trim() !== '' ? [{ kind: 'prototype_report', label: f.reportLabel.trim(), url: f.reportUrl.trim() }] : [],
    confidence: f.confidence,
  };
}

export const LINK_NAMES: Readonly<Record<TraceRow['links'][number]['kind'], string>> = {
  problem_brief: 'Problem brief', outcome_plan: 'Outcome plan', task: 'Task', candidate: 'Candidate', verification: 'Verification record', pull_request: 'Pull request', merge: 'Merge', release: 'Release', outcome_review: 'Outcome review',
};
const STATE: Readonly<Record<TraceRow['links'][number]['state'], { label: string; tone: Tone }>> = {
  present: { label: 'Present', tone: 'success' }, proposed: { label: 'Proposed only', tone: 'warning' }, failed: { label: 'Failed', tone: 'danger' }, stale: { label: 'No longer counts', tone: 'warning' }, missing: { label: 'Missing', tone: 'warning' },
};
const OUTCOME_TONE: Readonly<Record<TraceRow['outcome']['state'], Tone>> = { no_outcome_plan: 'neutral', not_released: 'neutral', awaiting_observations: 'active', insufficient_data: 'warning', reviewed: 'success' };

export interface TraceTableRow {
  readonly id: string;
  readonly text: string | null;
  readonly release: string;
  readonly outcome: { readonly label: string; readonly tone: Tone };
  readonly links: readonly { readonly kind: string; readonly name: string; readonly state: string; readonly tone: Tone; readonly label: string; readonly ref: string | null }[];
}

/** The trace as rows to show: every link named, with its state in words beside its colour. */
export function traceTable(rows: readonly TraceRow[]): TraceTableRow[] {
  return rows.map((r) => ({
    id: r.requirementId, text: r.text, release: r.release.label, outcome: { label: r.outcome.label, tone: OUTCOME_TONE[r.outcome.state] },
    links: r.links.map((l) => ({ kind: l.kind, name: LINK_NAMES[l.kind], state: STATE[l.state].label, tone: STATE[l.state].tone, label: l.label, ref: l.ref })),
  }));
}
