import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { scope, tstz } from './common.ts';
import { projects } from './projects.ts';

/**
 * AI step checkpoints (H12): where a browser AI step stopped, so it can continue later from that stage (offline, too large for the device, a local result that failed
 * its checks, waiting on the owner, a changed route, the budget). Owner only and project scoped: every read and write names the tenant, the project and the owner.
 *
 * Only public and internal checkpoints are kept here. A restricted, secret or locked one stays in the owner's browser (IndexedDB) and is never sent; the route refuses
 * one that says otherwise, and these checks refuse it again at the table, whatever wrote it. `body` is the domain `AiCheckpoint`: ids, hashes, sizes, codes and
 * labelled PM turns, never a prompt, a bundle, file contents or a model's answer. `escalated_at` is set once (a conditional update), so a step escalates at most once.
 */
export const aiCheckpoints = pgTable(
  'ai_checkpoints',
  {
    ...scope(),
    checkpointId: text('checkpoint_id').notNull(),
    ownerUid: text('owner_uid').notNull(),
    taskId: text('task_id').notNull(),
    status: text('status').notNull(),
    stopReason: text('stop_reason'),
    escalatedAt: tstz('escalated_at'),
    /** Fix round 2 (N4): the claim token of the tab sending this row, while it is `sending`. */
    claimToken: text('claim_token'),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.checkpointId] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
    index('ai_checkpoints_owner_idx').on(t.tenantId, t.projectId, t.ownerUid, t.updatedAt),
    check('ai_checkpoints_status', sql`${t.status} IN ('running', 'waiting', 'sending', 'done', 'sent', 'escalated', 'moved_to_device', 'dropped', 'abandoned')`),
    // The storage split, again at the table: nothing locked, restricted or secret is ever stored here.
    check('ai_checkpoints_not_locked', sql`(${t.body} ->> 'locked') = 'false'`),
    check('ai_checkpoints_no_restricted_labels', sql`NOT (${t.body} -> 'labels' ?| array['restricted', 'secret'])`),
    check('ai_checkpoints_no_restricted_texts', sql`NOT jsonb_path_exists(${t.body}, '$.partial.texts[*] ? (@.classification == "restricted" || @.classification == "secret")')`),
  ],
);
