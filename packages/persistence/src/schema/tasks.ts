import { check, foreignKey, integer, jsonb, numeric, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
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
    /** Reason code of a permanent placement block (null when none); the last `placement.blocked` event's reason, for dedupe and the snapshot. */
    placementBlock: text('placement_block'),
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
    /** The tool the worker last started, from its heartbeat. A tool name only, never arguments or output. Null: not reported. */
    lastTool: text('last_tool'),
    lastToolAt: tstz('last_tool_at'),
    leaseExpiresAt: tstz('lease_expires_at'),
    /** Hard stop fixed at claim. Heartbeats renew the lease, never this. */
    deadlineAt: tstz('deadline_at'),
    /** The attempt's recorded inference route: `device`, `cloud`, or `unknown`. Null only on attempts from before assignments. */
    modelRoute: text('model_route'),
    /** What the harness was told to run. Fixed at claim; an assignment changed later never rewrites it. */
    modelProvider: text('model_provider'),
    modelId: text('model_id'),
    assignmentSource: text('assignment_source'),
    baseSha: text('base_sha'),
    headSha: text('head_sha'),
    /** When a person first entered control mode here. Set in the transaction that consumes the ticket, before any shell exists, and never cleared. */
    humanIntervenedAt: tstz('human_intervened_at'),
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

/**
 * Append-only: the highest revision per scope and key is the current assignment, and a row with a null model removes it. The history is the audit of who changed what.
 * Never a credential: provider and model identifiers only.
 */
export const modelAssignments = pgTable(
  'model_assignments',
  {
    ...scope(),
    /** `role` or `task`. */
    scopeKind: text('scope_kind').notNull(),
    scopeKey: text('scope_key').notNull(),
    revision: integer('revision').notNull(),
    provider: text('provider'),
    model: text('model'),
    updatedBy: text('updated_by').notNull(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.scopeKind, t.scopeKey, t.revision] }),
    check('model_assignments_scope_kind', sql`scope_kind IN ('role', 'task')`),
    check('model_assignments_provider_model_paired', sql`(provider IS NULL) = (model IS NULL)`),
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
    /** Null means unknown, never zero. Read back as a decimal string; never converted through a float. */
    amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }),
    /** `estimated` for a worst-case hold, `observed` once reconciled from a trusted figure, `unavailable` when the amount is unknown. */
    amountProvenance: text('amount_provenance').notNull().default('unavailable'),
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
    check('budget_reservations_amount_provenance', sql`amount_provenance IN ('observed', 'estimated', 'unavailable')`),
    check('budget_reservations_unknown_is_null', sql`(amount_usd IS NULL) = (amount_provenance = 'unavailable')`),
  ],
);
