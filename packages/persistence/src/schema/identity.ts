import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, detail, scope, tstz } from './common.ts';
import { projects } from './projects.ts';

/**
 * One-time runner pairing codes. Only the SHA-256 of the code is stored; the code itself is shown once, to the owner.
 * `used_at` is set by the same statement that consumes the code, so a code can enrol at most one runner.
 */
export const runnerPairingCodes = pgTable(
  'runner_pairing_codes',
  {
    tenantId: text('tenant_id').notNull(),
    codeHash: text('code_hash').primaryKey(),
    location: text('location').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    runnerId: text('runner_id'),
  },
  (t) => [check('runner_pairing_codes_location', sql`${t.location} IN ('local', 'cloud')`)],
);

/** Enrolled runners. The scoped token is stored only as a SHA-256 hash. Tenant and location come from here, never from a request. */
export const runners = pgTable(
  'runners',
  {
    tenantId: text('tenant_id').notNull(),
    runnerId: text('runner_id').notNull(),
    location: text('location').notNull(),
    label: text('label'),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    revokedAt: tstz('revoked_at'),
    /** What this runner last said it can launch. Identifiers and a version only. Null: it has not said. */
    harnessReport: jsonb('harness_report').$type<{ provider: string; harnessVersion: string | null; models: string[] }[]>(),
    /** Project ids this runner says it has a source checkout for. Ids only, never paths. Null: it has not said. */
    configuredProjects: jsonb('configured_projects').$type<string[]>(),
    /** The runner said it materializes knowledge packs and confirms their digests. Null: it never said, so it gets no task that has packs. */
    skillDelivery: boolean('skill_delivery'),
    /** When this runner last reached the control plane, from any authenticated runner call. Null: not since this column existed. */
    lastSeenAt: tstz('last_seen_at'),
    /** When this runner last made an authenticated call (a claim poll, heartbeat or result). Null: never, so a runner only just enrolled. Settings wait only on runners with one. */
    lastPolledAt: tstz('last_polled_at'),
    /** The runner config revision this runner last said it applied, the slots it says it runs, and when. Null: it has not acknowledged any. */
    configAckRevision: integer('config_ack_revision'),
    configAckSlots: integer('config_ack_slots'),
    configAckAt: tstz('config_ack_at'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.runnerId] }),
    unique('runners_token_hash_key').on(t.tokenHash),
    check('runners_location', sql`${t.location} IN ('local', 'cloud')`),
  ],
);

/** Owner commands against tasks. `cancel_requested` is not confirmed termination: that arrives with the runner signal. */
export const taskCommands = pgTable(
  'task_commands',
  {
    ...scope(),
    operationId: text('operation_id').notNull(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    command: text('command').notNull(),
    state: text('state').notNull(),
    requestedBy: text('requested_by').notNull(),
    requestedAt: tstz('requested_at').notNull(),
    detail: detail(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.operationId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);

/** Browser-reported metadata. Always untrusted: nothing reads this table to decide task state, policy or verification. */
export const clientReports = pgTable(
  'client_reports',
  {
    ...scope(),
    reportId: text('report_id').notNull(),
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull(),
    kind: text('kind').notNull(),
    trust: text('trust').notNull().default('untrusted'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    reportedBy: text('reported_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.reportId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    check('client_reports_untrusted', sql`${t.trust} = 'untrusted'`),
    /** A task's route history and its latest route record, without a scan of the project's reports. */
    index('client_reports_route_lookup').on(t.tenantId, t.projectId, t.kind, t.subjectId, t.createdAt),
  ],
);
