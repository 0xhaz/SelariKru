import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { scope, tstz } from './common.ts';
import { projects } from './projects.ts';

/**
 * Checkpoint continuation (docs/architecture.md §4): one row per owner request to continue a task's local attempt on a cloud-location runner. It is the persisted checkpoint (the
 * approved base SHA, the change set's patch hash, every file's path, change and hash, and what was excluded, by path and reason only) and the handover's state. The file bytes
 * are kept in `content` for the successor and are never shown, logged or put in an event. Restricted work never has a row with content: the request is refused first.
 *
 * Every write takes the task's status row first (`lockStatusRow`), then this row, so a claim, a publish, a lease expiry and the owner's decision see one order.
 */
export const checkpoints = pgTable(
  'checkpoints',
  {
    ...scope(),
    checkpointId: text('checkpoint_id').notNull(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    runId: text('run_id').notNull(),
    /** `resume`: base SHA plus the checkpoint. `restart`: the persisted input only. */
    mode: text('mode').notNull(),
    state: text('state').notNull(),
    target: text('target').notNull(),
    priorAttemptId: text('prior_attempt_id').notNull(),
    priorFence: integer('prior_fence').notNull(),
    priorRunnerId: text('prior_runner_id'),
    /** The approved base: the task revision's base SHA. A checkpoint made against anything else is refused. */
    baseSha: text('base_sha').notNull(),
    patchSha256: text('patch_sha256'),
    fileCount: integer('file_count'),
    totalBytes: integer('total_bytes'),
    /** Path, change, post-image sha256, size and mode per file. No content. */
    files: jsonb('files').$type<Record<string, unknown>[]>(),
    /** Path and reason per excluded file. No content, ever. */
    exclusions: jsonb('exclusions').$type<Record<string, unknown>[]>(),
    /** base64 bytes by path, for the successor only. Never read by a view. */
    content: jsonb('content').$type<Record<string, string>>(),
    /** Why a resume is not possible, when it is not: a code from CHECKPOINT_REFUSALS. */
    refusal: text('refusal'),
    /** The restart offer: estimated cost and time, each labelled `estimated`. */
    estimate: jsonb('estimate').$type<Record<string, unknown>>().notNull().default({}),
    /** The fence reserved for the successor: the prior fence plus one. A successor claim below it is impossible by construction (`writeClaim` takes max + 1). */
    nextFence: integer('next_fence'),
    successorAttemptId: text('successor_attempt_id'),
    successorFence: integer('successor_fence'),
    /** Publishes from the fenced prior attempt refused after the handover. */
    latePublishes: integer('late_publishes').notNull().default(0),
    requestedBy: text('requested_by').notNull(),
    requestedAt: tstz('requested_at').notNull(),
    capturedAt: tstz('captured_at'),
    fencedAt: tstz('fenced_at'),
    decidedAt: tstz('decided_at'),
    decidedBy: text('decided_by'),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.checkpointId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    // One open handover per task: a second request waits for the first to end.
    uniqueIndex('checkpoints_one_open').on(t.tenantId, t.projectId, t.taskId).where(sql`${t.state} IN ('stopping', 'fenced', 'restart_offered')`),
    check('checkpoints_mode', sql`${t.mode} IN ('resume', 'restart')`),
    check('checkpoints_state', sql`${t.state} IN ('stopping', 'fenced', 'starting', 'running', 'restart_offered', 'declined', 'closed')`),
    check('checkpoints_target', sql`${t.target} IN ('cloud', 'local')`),
  ],
);
