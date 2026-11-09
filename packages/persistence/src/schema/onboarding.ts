import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, scope, tstz } from './common.ts';

/**
 * A project being set up. It starts before the `projects` row exists, because a repository is only known at the connections step, so `project_id` has no foreign key to `projects`.
 * The deterministic controller is the only writer of `state`.
 */
export const projectOnboardings = pgTable(
  'project_onboardings',
  {
    ...scope(),
    name: text('name').notNull(),
    /** Normalised name. Two live setups in a tenant cannot share one, so a repeated submit cannot make a second project. */
    nameKey: text('name_key').notNull(),
    state: text('state').notNull(),
    conditionKind: text('condition_kind'),
    conditionReason: text('condition_reason'),
    /** Compare-and-set for every owner write. */
    revision: integer('revision').notNull().default(1),
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull().default({}),
    currentBlueprintVersion: integer('current_blueprint_version'),
    acceptedBlueprintVersion: integer('accepted_blueprint_version'),
    /** What the owner entered. The ledgers are computed from this on every read. */
    costInputs: jsonb('cost_inputs').$type<Record<string, unknown>>(),
    /** The blueprint version the cost plan was last confirmed against. Null means it needs review. */
    costConfirmedForVersion: integer('cost_confirmed_for_version'),
    execution: jsonb('execution').$type<Record<string, unknown>>(),
    connection: jsonb('connection').$type<Record<string, unknown>>(),
    /** Set once the real `projects` row exists, so a resume never inserts it twice. */
    projectCreated: boolean('project_created').notNull().default(false),
    /** The latest readiness pass that still applies. Cleared by anything that invalidates readiness. */
    currentReadinessPass: integer('current_readiness_pass'),
    firstRunId: text('first_run_id'),
    cancelledAt: tstz('cancelled_at'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId] }),
    uniqueIndex('project_onboardings_live_name').on(t.tenantId, t.nameKey).where(sql`cancelled_at IS NULL`),
    check('project_onboardings_state', sql`${t.state} IN ('draft', 'discovering', 'blueprint_ready', 'configuring', 'readiness_check', 'ready', 'activated')`),
    check('project_onboardings_condition', sql`${t.conditionKind} IS NULL OR ${t.conditionKind} IN ('needs_input', 'blocked', 'failed')`),
  ],
);

/** Immutable, one row per version: a trigger refuses update and delete. An edit is a new row. */
export const projectBlueprints = pgTable(
  'project_blueprints',
  {
    ...scope(),
    version: integer('version').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    contentSha256: text('content_sha256').notNull(),
    /** `controller` when generated from the answers, `owner` when the owner edited it. */
    origin: text('origin').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.version] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projectOnboardings.tenantId, projectOnboardings.projectId] }),
    check('project_blueprints_origin', sql`${t.origin} IN ('controller', 'owner')`),
  ],
);

/** One row for each time the readiness checks ran. Written only by trusted server code; results are never taken from a request. */
export const onboardingReadinessPasses = pgTable(
  'onboarding_readiness_passes',
  {
    ...scope(),
    pass: integer('pass').notNull(),
    blueprintVersion: integer('blueprint_version').notNull(),
    outcome: text('outcome').notNull(),
    checks: jsonb('checks').$type<unknown[]>().notNull(),
    /** The commit the base-commit check resolved, when it resolved one. */
    baseSha: text('base_sha'),
    checkedAt: tstz('checked_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.pass] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projectOnboardings.tenantId, projectOnboardings.projectId] }),
    check('onboarding_readiness_outcome', sql`${t.outcome} IN ('ready', 'blocked')`),
  ],
);

/** Receipts for onboarding writes. Separate from `operation_receipts`, which needs a `projects` row that does not exist yet. */
export const onboardingReceipts = pgTable(
  'onboarding_receipts',
  {
    tenantId: text('tenant_id').notNull(),
    /** The setup's project id, or `_create` for the first submit. */
    scopeKey: text('scope_key').notNull(),
    operationKey: text('operation_key').notNull(),
    receipt: jsonb('receipt').$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.scopeKey, t.operationKey] })],
);
