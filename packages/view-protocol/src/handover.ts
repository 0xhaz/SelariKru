import { CHECKPOINT_REFUSALS, EXCLUSION_REASONS, HANDOVER_INELIGIBLE, HANDOVER_STATES } from '@selarikru/domain';
import { z } from 'zod';

/**
 * Checkpoint continuation as the server reports it (docs/architecture.md §4): for each task with a running local attempt, whether it may continue on a cloud runner and why
 * not, what would be carried and the estimated cost; and each handover's record and state. "Cloud runner" means an enrolled runner whose location is cloud. Read on demand.
 * No file content is ever part of this view: the checkpoint is shown by path, change, size and hash.
 */
const Figure = z.object({ value: z.number().nullable(), provenance: z.enum(['estimated', 'unavailable']), basis: z.string() });
/** `spentUsd`: what was held for successors that were lost, once any were. */
export const HandoverEstimateSchema = z.object({ costUsd: Figure, timeSeconds: Figure, spentUsd: Figure.optional() });
export type HandoverEstimateView = z.infer<typeof HandoverEstimateSchema>;

const Verdict = z.object({ eligible: z.boolean(), reasons: z.array(z.enum(HANDOVER_INELIGIBLE)), reasonText: z.array(z.string()) });

export const HandoverRecordViewSchema = z.object({
  checkpointId: z.string(),
  taskId: z.string(),
  revision: z.number().int(),
  runId: z.string(),
  mode: z.enum(['resume', 'restart']),
  state: z.enum(HANDOVER_STATES),
  stateLabel: z.string(),
  target: z.enum(['cloud', 'local']),
  priorAttemptId: z.string(),
  priorFence: z.number().int(),
  nextFence: z.number().int().nullable(),
  successorAttemptId: z.string().nullable(),
  successorFence: z.number().int().nullable(),
  baseSha: z.string(),
  patch: z.object({
    sha256: z.string(),
    fileCount: z.number().int(),
    totalBytes: z.number().int(),
    files: z.array(z.object({
      path: z.string(), status: z.enum(['added', 'modified', 'deleted']), size: z.number().int().nullable(), sha256: z.string().nullable(),
      /** Lines added and removed, from the checked review diff. Null: no line diff (binary, too large, or the content was dropped). */
      added: z.number().int().nullable().default(null), removed: z.number().int().nullable().default(null), hasDiff: z.boolean().default(false), binary: z.boolean().default(false),
    })),
    stat: z.object({ added: z.number().int(), removed: z.number().int() }).nullable().default(null),
  }).nullable(),
  exclusions: z.array(z.object({ path: z.string(), reason: z.enum(EXCLUSION_REASONS) })),
  refusal: z.object({ code: z.enum(CHECKPOINT_REFUSALS), text: z.string() }).nullable(),
  estimate: HandoverEstimateSchema.nullable(),
  latePublishes: z.number().int().min(0),
  requestedAt: z.string(),
  fencedAt: z.string().nullable(),
  updatedAt: z.string(),
  releasedAt: z.string().nullable().default(null),
  releasedBy: z.string().nullable().default(null),
  successorRetries: z.number().int().min(0).default(0),
  /** The stored checkpoint content was dropped: when and why. */
  contentDropped: z.object({ at: z.string(), reason: z.string(), text: z.string() }).nullable().default(null),
  /** Why the handover was closed or declined. */
  closed: z.object({ reason: z.string(), text: z.string() }).nullable().default(null),
});
export type HandoverRecordView = z.infer<typeof HandoverRecordViewSchema>;

export const HandoverTaskViewSchema = z.object({
  taskId: z.string(),
  status: z.string().nullable(),
  attempt: z.object({ attemptId: z.string(), fence: z.number().int(), runnerId: z.string().nullable(), location: z.string(), startedAt: z.string().nullable() }).nullable(),
  baseSha: z.string().nullable(),
  allowedPaths: z.array(z.string()),
  resume: Verdict,
  restart: Verdict.extend({ target: z.enum(['cloud', 'local']).nullable() }),
  estimate: HandoverEstimateSchema,
  /** What a checkpoint leaves out, as a rule the owner reads before confirming. */
  excludes: z.array(z.string()),
  current: HandoverRecordViewSchema.nullable(),
});
export type HandoverTaskView = z.infer<typeof HandoverTaskViewSchema>;

export const HandoversViewSchema = z.object({
  projectId: z.string(),
  observedAt: z.string(),
  /** What "cloud runner" means here, and what a handover never claims. */
  notice: z.string(),
  tasks: z.array(HandoverTaskViewSchema),
  /** Every handover of the project, newest first, bounded. */
  records: z.array(HandoverRecordViewSchema),
});
export type HandoversView = z.infer<typeof HandoversViewSchema>;

export const HandoverActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), taskId: z.string(), mode: z.enum(['resume', 'restart']), idempotencyKey: z.string().min(1) }),
  z.object({ kind: z.literal('decide'), taskId: z.string(), checkpointId: z.string(), choice: z.enum(['release', 'restart', 'decline']), idempotencyKey: z.string().min(1) }),
]);

/** One file's review diff, as the owner reads it. Owner only, every line through the secret detector; `redacted` says whether any line was changed by it. */
export const HandoverDiffViewSchema = z.object({
  checkpointId: z.string(), path: z.string(), status: z.string(), size: z.number().int().nullable(), sha256: z.string().nullable(), binary: z.boolean(),
  added: z.number().int().nullable(), removed: z.number().int().nullable(), lines: z.array(z.tuple([z.enum([' ', '+', '-']), z.string()])).nullable(), redacted: z.boolean(),
});
export type HandoverDiffView = z.infer<typeof HandoverDiffViewSchema>;
export type HandoverAction = z.infer<typeof HandoverActionSchema>;
