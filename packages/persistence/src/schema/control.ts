import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, detail, scope, tstz } from './common.ts';
import { attempts } from './tasks.ts';

/**
 * One person-in-the-shell session on one attempt, from the mint of its ticket to its end. Append-and-update only by the control API. The ticket is held as a hash, never as itself;
 * `state` moves `minted` to `active` at most once, in the single statement that consumes the ticket.
 */
export const controlSessions = pgTable(
  'control_sessions',
  {
    ...scope(),
    sessionId: text('session_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    runId: text('run_id').notNull(),
    taskId: text('task_id').notNull(),
    revision: integer('revision').notNull(),
    runner: text('runner').notNull(),
    leaseFence: integer('lease_fence').notNull(),
    ownerUid: text('owner_uid').notNull(),
    origin: text('origin').notNull(),
    ticketHash: text('ticket_hash').notNull(),
    ticketExpiresAt: tstz('ticket_expires_at').notNull(),
    state: text('state').notNull(),
    enteredAt: tstz('entered_at'),
    endedAt: tstz('ended_at'),
    endReason: text('end_reason'),
    inputCount: bigint('input_count', { mode: 'number' }).notNull().default(0),
    withheldCount: bigint('withheld_count', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    detail: detail(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.sessionId] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.attemptId], foreignColumns: [attempts.tenantId, attempts.projectId, attempts.attemptId] }),
    // One person in the shell per attempt: a second ticket cannot exist while the first is unspent or in use.
    uniqueIndex('control_sessions_one_open').on(t.tenantId, t.projectId, t.attemptId).where(sql`state IN ('minted', 'active')`),
    uniqueIndex('control_sessions_ticket_key').on(t.ticketHash),
    check('control_sessions_state', sql`state IN ('minted', 'active', 'ended', 'expired')`),
  ],
);

/**
 * Every line a person sent. The row is written before the line reaches the shell, without its text. The text is added only after the runner reports the shell was echoing when the line arrived,
 * so a password typed at a no-echo prompt is never stored, and a crash mid-way leaves a row that says only that something was sent.
 */
export const controlInputs = pgTable(
  'control_inputs',
  {
    ...scope(),
    sessionId: text('session_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    receivedAt: tstz('received_at').notNull(),
    charCount: integer('char_count').notNull(),
    disposition: text('disposition').notNull(),
    text: text('text'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.sessionId, t.seq] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.sessionId], foreignColumns: [controlSessions.tenantId, controlSessions.projectId, controlSessions.sessionId] }),
    check('control_inputs_disposition', sql`disposition IN ('pending', 'recorded', 'withheld_echo_off', 'withheld_unconfirmed', 'interrupt')`),
    check('control_inputs_text_only_recorded', sql`text IS NULL OR disposition = 'recorded'`),
  ],
);
