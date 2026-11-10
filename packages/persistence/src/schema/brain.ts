import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { scope, tstz } from './common.ts';
import { projects } from './projects.ts';
import { attempts } from './tasks.ts';

/**
 * The Project Brain (docs/second-brain.md §3, §4). Sources and compilations are immutable: triggers refuse update and delete. A revocation is a row of its own, so
 * revoking never deletes history. The head row is the project's brain lock and its source log position.
 */
export const brainHeads = pgTable(
  'brain_heads',
  {
    ...scope(),
    /** The last position written to the source log (a source revision or a revocation). */
    lastSeq: integer('last_seq').notNull().default(0),
    /** The latest compilation. 0: none yet. */
    compiledVersion: integer('compiled_version').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);

/** One immutable revision of one source. `sections` are the structured, anchored text a compilation reads. */
export const brainSources = pgTable(
  'brain_sources',
  {
    ...scope(),
    sourceId: text('source_id').notNull(),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    standing: text('standing').notNull(),
    classification: text('classification').notNull(),
    allowedUse: jsonb('allowed_use').$type<string[]>().notNull(),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull(),
    derivedFrom: jsonb('derived_from').$type<unknown[]>().notNull().default([]),
    taskId: text('task_id'),
    sections: jsonb('sections').$type<unknown[]>().notNull(),
    contentSha256: text('content_sha256').notNull(),
    seq: integer('seq').notNull(),
    recordedAt: tstz('recorded_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.sourceId, t.revision] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    uniqueIndex('brain_sources_seq').on(t.tenantId, t.projectId, t.seq),
    check('brain_sources_kind', sql`${t.kind} IN ('brief', 'criteria', 'plan', 'decision', 'verification', 'repo_manifest', 'note')`),
    check('brain_sources_standing', sql`${t.standing} IN ('accepted', 'proposed')`),
    check('brain_sources_classification', sql`${t.classification} IN ('public', 'internal', 'restricted', 'secret')`),
  ],
);

/** A source taken out of use. Its revisions stay; every claim resting on it stops being served. */
export const brainRevocations = pgTable(
  'brain_revocations',
  {
    ...scope(),
    sourceId: text('source_id').notNull(),
    reason: text('reason').notNull(),
    revokedBy: text('revoked_by').notNull(),
    revokedAt: tstz('revoked_at').notNull(),
    seq: integer('seq').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.sourceId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);

/** One published version of the derived pages, with what it read (the watermark) and what made it (the generator). */
export const brainCompilations = pgTable(
  'brain_compilations',
  {
    ...scope(),
    version: integer('version').notNull(),
    generatorId: text('generator_id').notNull(),
    generatorVersion: text('generator_version').notNull(),
    generatedAt: tstz('generated_at').notNull(),
    watermark: integer('watermark').notNull(),
    pages: jsonb('pages').$type<unknown[]>().notNull(),
    conflicts: jsonb('conflicts').$type<unknown[]>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.version] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);

/**
 * The support graph of one compilation: a claim `cites` a source revision at an anchor, `rests_on` each independent root (transitively), and is `disputed_by` a
 * conflicting one. Queried to find every claim a source holds up.
 */
export const brainClaimSupports = pgTable(
  'brain_claim_supports',
  {
    ...scope(),
    version: integer('version').notNull(),
    claimId: text('claim_id').notNull(),
    relation: text('relation').notNull(),
    sourceId: text('source_id').notNull(),
    /** 0 for a root, which is a source rather than one revision of it. */
    revision: integer('revision').notNull(),
    /** Empty for a root. */
    anchor: text('anchor').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.version, t.claimId, t.relation, t.sourceId, t.revision, t.anchor] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.version], foreignColumns: [brainCompilations.tenantId, brainCompilations.projectId, brainCompilations.version] }),
    check('brain_claim_supports_relation', sql`${t.relation} IN ('cites', 'rests_on', 'disputed_by')`),
  ],
);

/** A person settled a conflict. The only outcome is keeping the accepted value: changing accepted scope goes through its own workflow (a new blueprint or a replan). */
export const brainConflictResolutions = pgTable(
  'brain_conflict_resolutions',
  {
    ...scope(),
    conflictId: text('conflict_id').notNull(),
    outcome: text('outcome').notNull(),
    resolvedBy: text('resolved_by').notNull(),
    resolvedAt: tstz('resolved_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.conflictId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    check('brain_conflict_resolutions_outcome', sql`${t.outcome} IN ('kept_accepted')`),
  ],
);

/** The context bundle one attempt received at claim, exactly as sent, so the screen can show what the worker was given. */
export const brainBundles = pgTable(
  'brain_bundles',
  {
    ...scope(),
    attemptId: text('attempt_id').notNull(),
    taskId: text('task_id').notNull(),
    destination: text('destination').notNull(),
    compilationVersion: integer('compilation_version'),
    bundle: jsonb('bundle').$type<Record<string, unknown>>().notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.attemptId] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.attemptId], foreignColumns: [attempts.tenantId, attempts.projectId, attempts.attemptId] }),
    check('brain_bundles_destination', sql`${t.destination} IN ('local', 'cloud')`),
  ],
);
