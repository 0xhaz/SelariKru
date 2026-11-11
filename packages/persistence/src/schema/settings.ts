import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { scope, tstz } from './common.ts';
import { projects } from './projects.ts';

/**
 * Columns shared by run and runner settings. `desired` is what the owner saved, at `desired_revision`; `effective` is what the enforcer has acknowledged,
 * at `effective_revision`. They differ until the enforcer says so: the server sets both in the save's transaction for policy it enforces itself, a runner
 * advances a runner-acknowledged field through its config acknowledgement. `config_revision` is the runner config revision that carries a runner-acknowledged change.
 * Values are closed shapes (a boolean, a number, plan paths), never free text.
 */
export const settingColumns = () => ({
  field: text('field').notNull(),
  desired: jsonb('desired').$type<unknown>().notNull(),
  desiredRevision: integer('desired_revision').notNull(),
  /** Null: nothing has been in force since the field was first saved, so the configured default applies. */
  effective: jsonb('effective').$type<unknown>(),
  effectiveRevision: integer('effective_revision').notNull().default(0),
  enforcer: text('enforcer').notNull(),
  configRevision: integer('config_revision'),
  updatedBy: text('updated_by').notNull(),
  updatedAt: tstz('updated_at').notNull(),
  appliedAt: tstz('applied_at'),
});

export const runSettings = pgTable(
  'run_settings',
  { ...scope(), runId: text('run_id').notNull(), ...settingColumns() },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.runId, t.field] }),
    check('run_settings_field', sql`field IN ('paused', 'budget_limit_usd', 'allowed_paths', 'cloud_eligible', 'route_policy')`),
    check('run_settings_enforcer', sql`enforcer IN ('server', 'runner')`),
  ],
);

/** A runner is tenant-wide, so its settings are too. `event_project_id`/`event_run_id` name where its change was recorded, for the acknowledgement's event. */
export const runnerSettings = pgTable(
  'runner_settings',
  {
    tenantId: text('tenant_id').notNull(), runnerId: text('runner_id').notNull(), ...settingColumns(),
    eventProjectId: text('event_project_id').notNull(), eventRunId: text('event_run_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runnerId, t.field] }),
    check('runner_settings_field', sql`field IN ('enabled', 'slots')`),
    check('runner_settings_enforcer', sql`enforcer IN ('server', 'runner')`),
  ],
);

/**
 * A task's own settings: today only its route policy override. The server enforces it (it serves the effective policy to the browser adapter), so `effective` follows
 * `desired` in the save. `run_id` is the run the task belonged to at the save, for the change's event. A value is a mode or null (cleared), never text.
 */
export const taskSettings = pgTable(
  'task_settings',
  { ...scope(), taskId: text('task_id').notNull(), runId: text('run_id').notNull(), ...settingColumns() },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.taskId, t.field] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    check('task_settings_field', sql`field IN ('route_override')`),
    check('task_settings_enforcer', sql`enforcer IN ('server', 'runner')`),
  ],
);

/** The tenant's runner config revision. Every runner-acknowledged change bumps it; a runner acknowledges the revision it has applied. */
export const runnerConfig = pgTable('runner_config', { tenantId: text('tenant_id').primaryKey(), revision: integer('revision').notNull() });
