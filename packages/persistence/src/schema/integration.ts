import { foreignKey, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, scope, tstz } from './common.ts';
import { runs } from './projects.ts';

/**
 * One row per (project, target branch): the single integration lease. Taking it is an INSERT ... ON CONFLICT that only
 * succeeds when the row is absent or expired, so a second concurrent assembly cannot proceed.
 */
export const integrationLeases = pgTable(
  'integration_leases',
  {
    ...scope(),
    target: text('target').notNull(),
    holder: text('holder').notNull(),
    acquiredAt: tstz('acquired_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.target] })],
);

/** The assembled (or failed) integration candidate. `sha` is the exact commit verification judges; null when assembly failed. */
export const candidates = pgTable(
  'candidates',
  {
    ...scope(),
    candidateId: text('candidate_id').notNull(),
    runId: text('run_id').notNull(),
    target: text('target').notNull(),
    sha: text('sha'),
    baseSha: text('base_sha').notNull(),
    treeSha: text('tree_sha'),
    parts: jsonb('parts').$type<unknown[]>().notNull().default([]),
    /** assembled | failed | conflicted | invalidated */
    status: text('status').notNull(),
    reason: text('reason'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.candidateId] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.runId], foreignColumns: [runs.tenantId, runs.projectId, runs.runId] }),
    uniqueIndex('candidates_run_sha_key').on(t.tenantId, t.projectId, t.runId, t.sha).where(sql`sha IS NOT NULL`),
  ],
);

/** A plan revision proposed by the system (not yet accepted). A human or the scheduler accepts it through the plan path. */
export const planProposals = pgTable(
  'plan_proposals',
  {
    ...scope(),
    proposalId: text('proposal_id').notNull(),
    runId: text('run_id').notNull(),
    basedOnPlanRevision: integer('based_on_plan_revision').notNull(),
    /** proposed | accepted | rejected */
    status: text('status').notNull(),
    source: text('source').notNull(),
    reason: text('reason').notNull(),
    candidateId: text('candidate_id'),
    tasks: jsonb('tasks').$type<unknown[]>().notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.proposalId] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.runId], foreignColumns: [runs.tenantId, runs.projectId, runs.runId] }),
  ],
);

/**
 * The reviewable change (pull request) opened for a run's verified candidate. One per run. `status` is what the last authoritative read of the
 * provider said (`open`, `closed`, `merged`) or `merged_sha_mismatch` when the merged head is not the candidate; it is never set from a webhook body.
 */
export const changeRequests = pgTable(
  'change_requests',
  {
    ...scope(),
    runId: text('run_id').notNull(),
    repository: text('repository').notNull(),
    candidateSha: text('candidate_sha').notNull(),
    branch: text('branch').notNull(),
    prNumber: integer('pr_number').notNull(),
    url: text('url').notNull(),
    status: text('status').notNull(),
    observedHeadSha: text('observed_head_sha'),
    mergeCommitSha: text('merge_commit_sha'),
    observedAt: tstz('observed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.runId] }),
    uniqueIndex('change_requests_pr_key').on(t.tenantId, t.projectId, t.prNumber),
    foreignKey({ columns: [t.tenantId, t.projectId, t.runId], foreignColumns: [runs.tenantId, runs.projectId, runs.runId] }),
  ],
);
