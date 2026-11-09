import { boolean, jsonb, bigint, pgTable, primaryKey, text, unique, foreignKey, integer } from 'drizzle-orm/pg-core';
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
    /** Run-level placement: `{ mode: 'L1'|'L2'|'C1'|'C2'|'H2', cloudDestination: string|null }`. Null: local-only defaults. Validated at run acceptance. */
    placement: jsonb('placement').$type<{ mode: string; cloudDestination: string | null }>(),
    /** A benchmark trial: it never opens an external pull request. Set when the run is created. */
    trial: boolean('trial').notNull().default(false),
    /** A trial's one model, fixed at creation. Every attempt in the trial uses it and no assignment can change it. */
    pinnedModel: jsonb('pinned_model').$type<{ provider: string; model: string }>(),
    /** For a run started from onboarding: the execution, inference, budget and connection that authorised it, frozen at activation. Null for any other run. */
    setupSnapshot: jsonb('setup_snapshot').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.runId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);
