import { z } from 'zod';

export const USAGE_PROVENANCE = ['observed', 'estimated', 'unavailable'] as const;
export const UsageProvenanceSchema = z.enum(USAGE_PROVENANCE);
export type UsageProvenance = z.infer<typeof UsageProvenanceSchema>;

export const USAGE_METRICS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'worker_seconds', 'cost_usd'] as const;
export const UsageMetricSchema = z.enum(USAGE_METRICS);
export type UsageMetric = z.infer<typeof UsageMetricSchema>;

const DECIMAL = /^\d{1,18}(\.\d{1,6})?$/;

/** A decimal string, or null when the figure is unavailable. Unknown is null, never zero. */
export const UsageFigureSchema = z
  .object({
    metric: UsageMetricSchema,
    quantity: z.string().regex(DECIMAL).nullable(),
    provenance: UsageProvenanceSchema,
    source: z.string().min(1),
  })
  .strict()
  .refine((f) => (f.provenance === 'unavailable') === (f.quantity === null), {
    message: 'an unavailable figure has a null quantity, and only an unavailable figure does',
  });
export type UsageFigure = z.infer<typeof UsageFigureSchema>;

export const UsageEntrySchema = z
  .object({
    entryId: z.string().min(1),
    runId: z.string().min(1),
    taskId: z.string().min(1).nullable(),
    attemptId: z.string().min(1).nullable(),
    figure: UsageFigureSchema,
  })
  .strict();
export type UsageEntry = z.infer<typeof UsageEntrySchema>;

const SCALE = 1_000_000n;
function toMicros(q: string): bigint {
  const [whole = '0', frac = ''] = q.split('.');
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(6, '0'));
}
function fromMicros(m: bigint): string {
  const whole = m / SCALE;
  const frac = (m % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

export interface UsageTotal {
  /** The exact total. Null whenever any contributing figure is unavailable, or when there are none: an incomplete sum is not a total. */
  readonly total: string | null;
  /** `observed` only when every figure is observed; `estimated` when all are known and any is estimated; `unavailable` when `total` is null. */
  readonly provenance: UsageProvenance;
  /** The sum of the known figures only. A lower bound for display ("at least"), never a total. Null when nothing is known. */
  readonly knownSubtotal: string | null;
  readonly unavailableCount: number;
  readonly figureCount: number;
}

/**
 * Sums figures of one metric. Unavailable figures are never counted as 0: they make the total unknown and are counted separately.
 */
export function sumUsage(figures: readonly UsageFigure[]): UsageTotal {
  let known = 0n;
  let knownCount = 0;
  let unavailable = 0;
  let anyEstimated = false;
  for (const f of figures) {
    if (f.provenance === 'unavailable' || f.quantity === null) {
      unavailable += 1;
      continue;
    }
    known += toMicros(f.quantity);
    knownCount += 1;
    if (f.provenance === 'estimated') anyEstimated = true;
  }
  const complete = figures.length > 0 && unavailable === 0;
  return {
    total: complete ? fromMicros(known) : null,
    provenance: !complete ? 'unavailable' : anyEstimated ? 'estimated' : 'observed',
    knownSubtotal: knownCount > 0 ? fromMicros(known) : null,
    unavailableCount: unavailable,
    figureCount: figures.length,
  };
}

/** Filters entries by scope and sums one metric. Entries superseded by nothing are all that a snapshot carries. */
export function usageFor(entries: readonly UsageEntry[], metric: UsageMetric, scope: { runId?: string; taskId?: string; attemptId?: string } = {}): UsageTotal {
  return sumUsage(
    entries
      .filter((e) => e.figure.metric === metric)
      .filter((e) => scope.runId === undefined || e.runId === scope.runId)
      .filter((e) => scope.taskId === undefined || e.taskId === scope.taskId)
      .filter((e) => scope.attemptId === undefined || e.attemptId === scope.attemptId)
      .map((e) => e.figure),
  );
}
