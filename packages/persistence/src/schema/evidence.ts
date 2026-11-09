import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, detail, scope, tstz } from './common.ts';
import { projects, runs } from './projects.ts';
import { attempts, taskRevisions } from './tasks.ts';

/** Immutable artifact metadata; bytes live in content-addressed storage. */
export const artifacts = pgTable(
  'artifacts',
  {
    ...scope(),
    artifactId: text('artifact_id').notNull(),
    runId: text('run_id'),
    type: text('type').notNull(),
    sha256: text('sha256').notNull(),
    sourceRevision: text('source_revision'),
    classification: text('classification').notNull(),
    acl: jsonb('acl').$type<Record<string, unknown>>().notNull().default({}),
    locator: jsonb('locator').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.artifactId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.runId], foreignColumns: [runs.tenantId, runs.projectId, runs.runId] }),
  ],
);

export const checkRuns = pgTable(
  'check_runs',
  {
    ...scope(),
    checkRunId: text('check_run_id').notNull(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    attemptId: text('attempt_id'),
    checkId: text('check_id').notNull(),
    checkVersion: text('check_version').notNull(),
    candidateSha: text('candidate_sha').notNull(),
    result: text('result').notNull(),
    logRefs: jsonb('log_refs').$type<unknown[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.checkRunId] }),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.taskId, t.revision],
      foreignColumns: [taskRevisions.tenantId, taskRevisions.projectId, taskRevisions.taskId, taskRevisions.revision],
    }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.attemptId], foreignColumns: [attempts.tenantId, attempts.projectId, attempts.attemptId] }),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    ...scope(),
    approvalId: text('approval_id').notNull(),
    runId: text('run_id'),
    taskId: text('task_id'),
    revision: integer('revision'),
    requester: text('requester').notNull(),
    approver: text('approver'),
    actionHash: text('action_hash').notNull(),
    scopeHash: text('scope_hash').notNull(),
    expectedRevisions: jsonb('expected_revisions').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: tstz('expires_at'),
    policy: text('policy'),
    outcome: text('outcome').notNull(),
    /** What is being approved: the operation, the request reason and the policy decision. Identifiers and codes only, never secrets. */
    detail: detail(),
    /** Set when the attempt this grant released starts. A grant releases work once; a later attempt needs a new approval. */
    consumedAt: tstz('consumed_at'),
    consumedBy: text('consumed_by'),
    /** When the outcome left `pending`: granted, denied, expired or superseded. Null on rows closed before this column existed. */
    resolvedAt: tstz('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.approvalId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.runId], foreignColumns: [runs.tenantId, runs.projectId, runs.runId] }),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.taskId, t.revision],
      foreignColumns: [taskRevisions.tenantId, taskRevisions.projectId, taskRevisions.taskId, taskRevisions.revision],
    }),
    check('approvals_task_revision_paired', sql`(task_id IS NULL) = (revision IS NULL)`),
    // One open request per task revision and scope: a retried request can never queue a second approvable row.
    uniqueIndex('approvals_one_pending_key').on(t.tenantId, t.projectId, t.taskId, t.revision, t.scopeHash).where(sql`outcome = 'pending' AND task_id IS NOT NULL`),
  ],
);

export const decisions = pgTable(
  'decisions',
  {
    ...scope(),
    decisionId: text('decision_id').notNull(),
    context: text('context').notNull(),
    options: jsonb('options').$type<unknown[]>().notNull().default([]),
    rationale: text('rationale').notNull(),
    author: text('author').notNull(),
    affected: jsonb('affected').$type<unknown[]>().notNull().default([]),
    supersededBy: text('superseded_by'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.decisionId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.supersededBy], foreignColumns: [t.tenantId, t.projectId, t.decisionId] }),
  ],
);

export const knowledgeNodes = pgTable(
  'knowledge_nodes',
  {
    ...scope(),
    nodeId: text('node_id').notNull(),
    kind: text('kind').notNull(),
    source: text('source').notNull(),
    version: text('version').notNull(),
    acl: jsonb('acl').$type<Record<string, unknown>>().notNull().default({}),
    freshness: text('freshness').notNull(),
    detail: detail(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.nodeId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);

export const knowledgeEdges = pgTable(
  'knowledge_edges',
  {
    ...scope(),
    edgeId: text('edge_id').notNull(),
    fromNodeId: text('from_node_id').notNull(),
    toNodeId: text('to_node_id').notNull(),
    relation: text('relation').notNull(),
    status: text('status').notNull(), // observed | inferred
    acl: jsonb('acl').$type<Record<string, unknown>>().notNull().default({}),
    freshness: text('freshness').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.edgeId] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.fromNodeId], foreignColumns: [knowledgeNodes.tenantId, knowledgeNodes.projectId, knowledgeNodes.nodeId] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.toNodeId], foreignColumns: [knowledgeNodes.tenantId, knowledgeNodes.projectId, knowledgeNodes.nodeId] }),
  ],
);
