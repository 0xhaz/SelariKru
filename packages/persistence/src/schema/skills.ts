import { boolean, foreignKey, jsonb, pgTable, primaryKey, text, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { scope, tstz } from './common.ts';
import { projects } from './projects.ts';
import { settingColumns } from './settings.ts';

/**
 * The skill library's records (docs/architecture.md, owned skill library). First-party packs are code (the domain's `SKILL_LIBRARY`); only what a tenant adds lives here.
 * Metadata and content are separate tables: `skill_pack_files` holds a staged pack's text, read only to deliver it to a local worker; every other table is metadata.
 */

/** A third-party pack staged from a local directory: its immutable version metadata, the static scan, and the owner's review. Private to the project that staged it. */
export const skillStagedVersions = pgTable(
  'skill_staged_versions',
  {
    ...scope(),
    versionId: text('version_id').notNull(),
    skillId: text('skill_id').notNull(),
    /** A `SkillVersion`. Never rewritten: a changed pack is another version. */
    version: jsonb('version').$type<Record<string, unknown>>().notNull(),
    /** A `SkillScanReport`. */
    scan: jsonb('scan').$type<Record<string, unknown>>().notNull(),
    /** The scan blocked it: it can never be reviewed, bound or delivered. */
    blocked: boolean('blocked').notNull(),
    stagedBy: text('staged_by').notNull(),
    stagedAt: tstz('staged_at').notNull(),
    /** Set once, by an owner, for this exact version. Agents never set it. */
    reviewedBy: text('reviewed_by'),
    reviewedAt: tstz('reviewed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);

/** A staged pack's file text. Absent for a blocked pack: what can never be delivered is not kept. */
export const skillPackFiles = pgTable(
  'skill_pack_files',
  { tenantId: text('tenant_id').notNull(), versionId: text('version_id').notNull(), path: text('path').notNull(), content: text('content').notNull() },
  (t) => [primaryKey({ columns: [t.tenantId, t.versionId, t.path] })],
);

/** A revoked version, first or third party. It starts no new work in this tenant; an attempt already running keeps the version it was given. */
export const skillRevocations = pgTable(
  'skill_revocations',
  { tenantId: text('tenant_id').notNull(), versionId: text('version_id').notNull(), reason: text('reason').notNull(), revokedBy: text('revoked_by').notNull(), revokedAt: tstz('revoked_at').notNull() },
  (t) => [primaryKey({ columns: [t.tenantId, t.versionId] })],
);

/**
 * A project's binding of one skill to one version, as a T6.2 setting: `desired` is what the owner saved (a `SkillBinding`, or null for removed) at `desired_revision`, `effective`
 * what is in force. The server enforces bindings at claim, so it acknowledges each save in the save's own transaction.
 */
export const projectSkillBindings = pgTable(
  'project_skill_bindings',
  { ...scope(), skillId: text('skill_id').notNull(), ...settingColumns() },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.skillId] }),
    check('project_skill_bindings_field', sql`field = 'binding'`),
    check('project_skill_bindings_enforcer', sql`enforcer = 'server'`),
  ],
);

/** A recorded evaluation of one version in one project (a `SkillEvaluation`). The only source of Tested here. */
export const skillEvaluations = pgTable(
  'skill_evaluations',
  { ...scope(), evaluationId: text('evaluation_id').notNull(), versionId: text('version_id').notNull(), record: jsonb('record').$type<Record<string, unknown>>().notNull(), recordedAt: tstz('recorded_at').notNull() },
  (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.evaluationId] })],
);

/** What one attempt received (a `SkillExecutionRecord`), written in its claim's transaction. Metadata only: ids, versions and digests. */
export const skillExecutionRecords = pgTable(
  'skill_execution_records',
  { ...scope(), attemptId: text('attempt_id').notNull(), taskId: text('task_id').notNull(), record: jsonb('record').$type<Record<string, unknown>>().notNull(), recordedAt: tstz('recorded_at').notNull() },
  (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.attemptId] })],
);
