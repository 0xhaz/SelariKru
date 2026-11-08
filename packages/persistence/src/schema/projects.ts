import { jsonb, bigint, pgTable, primaryKey, text, unique, foreignKey, integer } from 'drizzle-orm/pg-core';
import { createdAt, scope } from './common.ts';

export const projects = pgTable(
  'projects',
  {
    ...scope(),
    repository: text('repository').notNull(),
    defaultBranch: text('default_branch').notNull(),
    classification: text('classification').notNull(),
    policy: jsonb('policy').$type<Record<string, unknown>>().notNull().default({}),
    integrationIds: jsonb('integration_ids').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.projectId] }), unique('projects_project_id_key').on(t.projectId)],
);

/** Per-project gapless event counter. Updated under row lock in the appending transaction. */
export const projectSequences = pgTable(
  'project_sequences',
  {
    ...scope(),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);

export const runs = pgTable(
  'runs',
  {
    ...scope(),
    runId: text('run_id').notNull(),
    requestRevision: integer('request_revision').notNull().default(1),
    planRevision: integer('plan_revision'),
    lifecycle: text('lifecycle').notNull(),
    budget: jsonb('budget').$type<Record<string, unknown>>().notNull().default({}),
    workflowOwner: text('workflow_owner'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.runId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);
