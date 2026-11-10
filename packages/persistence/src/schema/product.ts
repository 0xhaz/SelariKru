import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { scope, tstz } from './common.ts';
import { projects } from './projects.ts';

/**
 * Product-learning records (docs/product-engineer-alignment.md §4): a problem brief, outcome plans, manual release notes and manual outcome reviews. Each row is one immutable
 * revision (a trigger refuses update and delete); an edit is a new revision. The head row is the project's product lock and its log position.
 */
export const productHeads = pgTable(
  'product_heads',
  {
    ...scope(),
    /** The last position written to the product log. */
    lastSeq: integer('last_seq').notNull().default(0),
    /** The last log position whose event is appended. Records written while the project had no run wait here and are appended, in order, once it has one. */
    eventedSeq: integer('evented_seq').notNull().default(0),
    /** Worker proposals dropped because newer ones passed the cap. */
    droppedProposals: integer('dropped_proposals').notNull().default(0),
    /** The last proposal position given. Proposals are ordered by it, newest last. */
    proposalSeq: integer('proposal_seq').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);

export const productRecords = pgTable(
  'product_records',
  {
    ...scope(),
    recordId: text('record_id').notNull(),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    classification: text('classification').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    proposedByKind: text('proposed_by_kind').notNull(),
    proposedBy: text('proposed_by').notNull(),
    /** Set only on a revision a person confirmed. */
    confirmedBy: text('confirmed_by'),
    /** What the write's event says (action and ids), kept with the revision so an event deferred for want of a run says the same. No text. */
    eventDetail: jsonb('event_detail').$type<Record<string, unknown>>().notNull().default({}),
    seq: integer('seq').notNull(),
    recordedAt: tstz('recorded_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.recordId, t.revision] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    uniqueIndex('product_records_seq').on(t.tenantId, t.projectId, t.seq),
    check('product_records_kind', sql`${t.kind} IN ('problem_brief', 'outcome_plan', 'release_note', 'outcome_review')`),
    check('product_records_status', sql`${t.status} IN ('proposed', 'confirmed', 'recorded')`),
    check('product_records_classification', sql`${t.classification} IN ('public', 'internal', 'restricted', 'secret')`),
    check('product_records_proposer', sql`${t.proposedByKind} IN ('human', 'worker')`),
    // Only a person confirms: a confirmed revision names who did, and a worker's revision is only ever a proposal.
    check('product_records_confirmed', sql`(${t.status} = 'confirmed') = (${t.confirmedBy} IS NOT NULL) AND (${t.proposedByKind} = 'human' OR ${t.status} = 'proposed')`),
  ],
);

/**
 * Workers' proposed briefs, kept apart from the brief's revision line so a proposal never moves the revision an owner saves against. Only the newest few are kept: a new
 * proposal past the cap drops the oldest, and the head counts how many were dropped. A proposal an owner used is removed; the owner's revision and its event name it.
 */
export const productBriefProposals = pgTable(
  'product_brief_proposals',
  {
    ...scope(),
    proposalId: text('proposal_id').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    classification: text('classification').notNull(),
    proposedBy: text('proposed_by').notNull(),
    attemptId: text('attempt_id').notNull(),
    seq: integer('seq').notNull(),
    proposedAt: tstz('proposed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.proposalId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    check('product_brief_proposals_classification', sql`${t.classification} IN ('public', 'internal', 'restricted', 'secret')`),
  ],
);

/**
 * What each worker proposal said, kept after the proposal itself is used or dropped: a sha256 of its canonical stored text and the text's length, never the text. `outcome`
 * moves from `pending` to `used` (an owner started from it, so its text became that owner's revision) or `dropped` (a newer one passed the cap).
 */
export const productProposalAudit = pgTable(
  'product_proposal_audit',
  {
    ...scope(),
    proposalId: text('proposal_id').notNull(),
    contentSha256: text('content_sha256').notNull(),
    contentLength: integer('content_length').notNull(),
    proposedBy: text('proposed_by').notNull(),
    attemptId: text('attempt_id').notNull(),
    proposedAt: tstz('proposed_at').notNull(),
    outcome: text('outcome').notNull(),
    settledAt: tstz('settled_at'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.proposalId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    check('product_proposal_audit_outcome', sql`${t.outcome} IN ('pending', 'used', 'dropped')`),
  ],
);
