import { check, foreignKey, index, integer, numeric, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, detail, scope, tstz } from './common.ts';
import { attempts, taskRevisions } from './tasks.ts';
import { runs } from './projects.ts';

/**
 * The usage ledger. Append-only, enforced by a trigger: a row is written once and corrected by a new row that names it in `corrects_entry_id`.
 * `quantity` is null exactly when `provenance` is `unavailable`: unknown is never zero. A worker or harness figure can never be `observed`.
 */
export const usageEntries = pgTable(
  'usage_entries',
  {
    ...scope(),
    entryId: text('entry_id').notNull(),
    /** Retrying the same write finds this key and adds nothing. */
    dedupeKey: text('dedupe_key').notNull(),
    runId: text('run_id').notNull(),
    taskId: text('task_id'),
    revision: integer('revision'),
    attemptId: text('attempt_id'),
    /** The task role, or `integration` / `verification` for those workers. */
    role: text('role').notNull(),
    metric: text('metric').notNull(),
    quantity: numeric('quantity', { precision: 24, scale: 6 }),
    provenance: text('provenance').notNull(),
    /** Who produced the figure, for example `controller_clock` or `worker_report`. */
    source: text('source').notNull(),
    /** Worker time only: `setup`, `active`, `idle` or `abandoned`. */
    phase: text('phase'),
    /** Worker time only: `local` or `cloud`. Integration and verification rows sit under their host here. */
    host: text('host'),
    /** Worker time only: `measured` process time or `billed` instance time. Never summed together. */
    basis: text('basis'),
    rateCardVersion: text('rate_card_version'),
    correctsEntryId: text('corrects_entry_id'),
    recordedAt: tstz('recorded_at').notNull(),
    createdAt: createdAt(),
    detail: detail(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.entryId] }),
    uniqueIndex('usage_entries_dedupe_key').on(t.tenantId, t.projectId, t.dedupeKey),
    uniqueIndex('usage_entries_one_correction').on(t.tenantId, t.projectId, t.correctsEntryId).where(sql`corrects_entry_id IS NOT NULL`),
    index('usage_entries_run').on(t.tenantId, t.projectId, t.runId),
    foreignKey({ columns: [t.tenantId, t.projectId, t.runId], foreignColumns: [runs.tenantId, runs.projectId, runs.runId] }),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.taskId, t.revision],
      foreignColumns: [taskRevisions.tenantId, taskRevisions.projectId, taskRevisions.taskId, taskRevisions.revision],
    }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.attemptId], foreignColumns: [attempts.tenantId, attempts.projectId, attempts.attemptId] }),
    foreignKey({ name: 'usage_entries_corrects_fk', columns: [t.tenantId, t.projectId, t.correctsEntryId], foreignColumns: [t.tenantId, t.projectId, t.entryId] }),
    check('usage_entries_task_revision_paired', sql`(task_id IS NULL) = (revision IS NULL)`),
    check('usage_entries_provenance', sql`provenance IN ('observed', 'estimated', 'unavailable')`),
    check('usage_entries_unknown_is_null', sql`(quantity IS NULL) = (provenance = 'unavailable')`),
    check('usage_entries_quantity_nonnegative', sql`quantity IS NULL OR quantity >= 0`),
    check('usage_entries_self_report_not_observed', sql`NOT (provenance = 'observed' AND source IN ('worker_report', 'harness_report'))`),
    check('usage_entries_worker_time_dimensions', sql`(metric = 'worker_seconds') = (phase IS NOT NULL AND host IS NOT NULL AND basis IS NOT NULL)`),
  ],
);
