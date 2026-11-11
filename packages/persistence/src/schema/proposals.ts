import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { scope, tstz } from './common.ts';
import { projects } from './projects.ts';

/**
 * Accepted patch proposals (H5, plan.md §3 Option A). One row per proposal the owner accepted for a task revision: the checked results the no-model apply worker writes,
 * the diff for review, and the ids and hashes that tie them to the browser's route record. Restricted work never has a row: the route refuses before the body is read.
 *
 * `results` holds the contents for the apply attempt and for the owner's review read; it is never put in an event or a log. `state`: `accepted` until an apply attempt
 * claims it (`applying`, with that attempt's id); then `applied` when that attempt
 * completed, or `failed` when it ended any other way (failed, blocked, lost, interrupted), with its reason; `superseded` when a later accept for the same task replaced it
 * first. A `failed` or `superseded` proposal may be accepted again, which queues it for a new apply attempt (`round` + 1).
 *
 * Every write takes the scheduler lock, then the task's status row, then this row, then the event sequence: the claim's order (see services/workflow verification.ts).
 */
export const acceptedProposals = pgTable(
  'accepted_proposals',
  {
    ...scope(),
    proposalId: text('proposal_id').notNull(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    runId: text('run_id').notNull(),
    baseSha: text('base_sha').notNull(),
    /** The browser's route record for the call that produced it (its request id). */
    routeRecordId: text('route_record_id').notNull(),
    /** `acceptedProposalDigest`: base and each result's path and hash. */
    digest: text('digest').notNull(),
    fileCount: integer('file_count').notNull(),
    /** Path, sha256 and full contents (null for a delete) per file. */
    results: jsonb('results').$type<{ path: string; sha256: string | null; content: string | null }[]>().notNull(),
    diff: text('diff').notNull(),
    state: text('state').notNull(),
    attemptId: text('attempt_id'),
    /** Why the last apply attempt did not stand (its exit reason), when the row is `failed`. */
    failureReason: text('failure_reason'),
    /** The idempotency key of the accept that last queued this proposal. The same key again reads the current state; a new key re-queues a failed one. */
    acceptKey: text('accept_key'),
    /** How many times this proposal was queued for an apply attempt. */
    round: integer('round').notNull().default(1),
    acceptedBy: text('accepted_by').notNull(),
    acceptedAt: tstz('accepted_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.proposalId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    // One proposal waiting for an apply attempt per task.
    uniqueIndex('accepted_proposals_one_waiting').on(t.tenantId, t.projectId, t.taskId).where(sql`${t.state} = 'accepted'`),
    check('accepted_proposals_state', sql`${t.state} IN ('accepted', 'applying', 'applied', 'failed', 'superseded')`),
  ],
);

/**
 * What the server served one browser agent call to read (H5 fix round 4): the strongest label in the task context it handed out (the task's own label and every
 * served claim's), keyed by the context id the browser sent and later reports with its route record. Ids and a label only. Insert-only, no lock: an accept, an agent
 * criteria revision and an agent-written PR body read it to refuse output built from restricted context, whatever the browser says about its own lock.
 */
export const agentContexts = pgTable(
  'agent_contexts',
  {
    ...scope(),
    contextId: text('context_id').notNull(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    destination: text('destination').notNull(),
    contentLabel: text('content_label').notNull(),
    servedAt: tstz('served_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.contextId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    check('agent_contexts_destination', sql`${t.destination} IN ('local', 'cloud')`),
  ],
);
