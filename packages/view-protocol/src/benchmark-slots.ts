import type { BenchmarkRecord } from './benchmark.ts';

/**
 * Slot reconciliation, shared by the benchmark report and the web panel. Every trial fills one slot of the frozen
 * order and records `slotAttempt`. The last attempt represents its slot and drives times and pairs. Earlier attempts
 * are superseded: shown, and counted towards completion and cost, but never timed or paired. A replacement is allowed
 * only after an infrastructure outcome (`denied_start`, `abandoned`, `not_run`); the exporter's checks refuse any other.
 */

/** Outcomes a slot may be retried after. A completed, failed or timed-out attempt is final. */
export const REPLACEABLE_STATUSES: readonly BenchmarkRecord['status'][] = ['denied_start', 'abandoned', 'not_run'];

export interface SlotView {
  readonly slotId: string;
  /** The last attempt, or null when the slot has no record. */
  readonly representative: BenchmarkRecord | null;
  /** Earlier attempts, in attempt order. */
  readonly superseded: readonly BenchmarkRecord[];
}

export interface ReconciledSlots {
  readonly representatives: readonly BenchmarkRecord[];
  readonly superseded: readonly BenchmarkRecord[];
  /** Representatives and superseded attempts: every record, none dropped. */
  readonly all: readonly BenchmarkRecord[];
  readonly missingSlots: readonly string[];
  readonly planned: number;
}

const unslotted = (r: BenchmarkRecord): string => `trial:${r.trialId}`;
const keyOf = (r: BenchmarkRecord): string => r.slotId ?? unslotted(r);

/**
 * One view per slot. With `slotIds` (the frozen order) the views follow it and a slot with no record is kept, empty.
 * Without it, slots come from the records in first-seen order, and a record with no slot stands alone as its own.
 */
export function slotViews(records: readonly BenchmarkRecord[], slotIds?: readonly string[]): SlotView[] {
  const groups = new Map<string, BenchmarkRecord[]>();
  for (const r of records) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  const ids = slotIds ?? [...groups.keys()];
  return ids.map((slotId) => {
    const attempts = [...(groups.get(slotId) ?? [])].sort((x, y) => (x.slotAttempt ?? 1) - (y.slotAttempt ?? 1));
    return { slotId, representative: attempts.at(-1) ?? null, superseded: attempts.slice(0, -1) };
  });
}

export function reconcileSlots(views: readonly SlotView[]): ReconciledSlots {
  const representatives = views.flatMap((v) => (v.representative === null ? [] : [v.representative]));
  const superseded = views.flatMap((v) => v.superseded);
  return {
    representatives, superseded, all: [...representatives, ...superseded],
    missingSlots: views.filter((v) => v.representative === null).map((v) => v.slotId), planned: views.length,
  };
}

/** The attempt ids that a later attempt in the same slot, and of the same data kind, supersedes. A simulated attempt never replaces a measured one. */
export function supersededAttemptIds(records: readonly BenchmarkRecord[]): Set<string> {
  const kinds = [...new Set(records.map((r) => r.dataKind))];
  return new Set(kinds.flatMap((kind) => reconcileSlots(slotViews(records.filter((r) => r.dataKind === kind))).superseded.map((r) => r.attemptId)));
}
