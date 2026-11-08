import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, detail, scope, tstz } from './common.ts';
import { runs } from './projects.ts';

/** Immutable task spec revisions. `spec` is a validated TaskSpec document. */
export const taskRevisions = pgTable(
  'task_revisions',
  {
    ...scope(),
    runId: text('run_id').notNull(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    boardId: text('board_id').notNull(),
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.taskId, t.revision] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.runId], foreignColumns: [runs.tenantId, runs.projectId, runs.runId] }),
  ],
);

/** Mutable current projection. */
export const taskStatus = pgTable(
  'task_status',
  {
    ...scope(),
    taskId: text('task_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    status: text('status').notNull(),
    rowRevision: integer('row_revision').notNull().default(0),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.taskId] }),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.taskId, t.currentRevision],
      foreignColumns: [taskRevisions.tenantId, taskRevisions.projectId, taskRevisions.taskId, taskRevisions.revision],
    }),
  ],
);

export const dependencies = pgTable(
  'dependencies',
  {
    ...scope(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    dependsOnTaskId: text('depends_on_task_id').notNull(),
    dependsOnRevision: integer('depends_on_revision').notNull(),
    condition: text('condition').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.taskId, t.revision, t.dependsOnTaskId, t.dependsOnRevision] }),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.taskId, t.revision],
      foreignColumns: [taskRevisions.tenantId, taskRevisions.projectId, taskRevisions.taskId, taskRevisions.revision],
    }),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.dependsOnTaskId, t.dependsOnRevision],
      foreignColumns: [taskRevisions.tenantId, taskRevisions.projectId, taskRevisions.taskId, taskRevisions.revision],
    }),
  ],
);

export const attempts = pgTable(
  'attempts',
  {
    ...scope(),
    attemptId: text('attempt_id').notNull(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    runner: text('runner'),
    harness: text('harness'),
    leaseFence: integer('lease_fence'),
    /** Credential the holder presents with its fence. Never copied into events. */
    leaseToken: text('lease_token'),
    lastHeartbeatAt: tstz('last_heartbeat_at'),
    leaseExpiresAt: tstz('lease_expires_at'),
    modelRoute: text('model_route'),
    baseSha: text('base_sha'),
    headSha: text('head_sha'),
    /** Domain AttemptRecord outcome. Null only for rows written before the scheduler owned attempts. */
    outcome: text('outcome'),
    exitReason: text('exit_reason'),
    startedAt: tstz('started_at'),
    endedAt: tstz('ended_at'),
    detail: detail(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.attemptId] }),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.taskId, t.revision],
      foreignColumns: [taskRevisions.tenantId, taskRevisions.projectId, taskRevisions.taskId, taskRevisions.revision],
    }),
    // Database-level backstops for the scheduler's locking: fences never repeat, one live lease per task.
    uniqueIndex('attempts_task_revision_fence_key').on(t.tenantId, t.projectId, t.taskId, t.revision, t.leaseFence).where(sql`lease_fence IS NOT NULL`),
    uniqueIndex('attempts_one_active_lease').on(t.tenantId, t.projectId, t.taskId).where(sql`lease_token IS NOT NULL AND ended_at IS NULL`),
  ],
);

export const resourceClaims = pgTable(
  'resource_claims',
  {
    ...scope(),
    claimId: text('claim_id').notNull(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    resourceKey: text('resource_key').notNull(),
    mode: text('mode').notNull(),
    attemptId: text('attempt_id'),
    releasedAt: tstz('released_at'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.claimId] }),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.taskId, t.revision],
      foreignColumns: [taskRevisions.tenantId, taskRevisions.projectId, taskRevisions.taskId, taskRevisions.revision],
    }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.attemptId], foreignColumns: [attempts.tenantId, attempts.projectId, attempts.attemptId] }),
    uniqueIndex('resource_claims_one_active_exclusive').on(t.tenantId, t.projectId, t.resourceKey).where(sql`mode = 'exclusive' AND released_at IS NULL`),
  ],
);

export const budgetReservations = pgTable(
  'budget_reservations',
  {
    ...scope(),
    reservationId: text('reservation_id').notNull(),
    runId: text('run_id').notNull(),
    taskId: text('task_id'),
    revision: integer('revision'),
    amountUsd: text('amount_usd'), // decimal string; null means unknown, never zero
    state: text('state').notNull(),
    createdAt: createdAt(),
    detail: detail(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.reservationId] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.runId], foreignColumns: [runs.tenantId, runs.projectId, runs.runId] }),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.taskId, t.revision],
      foreignColumns: [taskRevisions.tenantId, taskRevisions.projectId, taskRevisions.taskId, taskRevisions.revision],
    }),
    check('budget_reservations_task_revision_paired', sql`(task_id IS NULL) = (revision IS NULL)`),
  ],
);
