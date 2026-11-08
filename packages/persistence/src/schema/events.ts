import { bigint, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, detail, scope, tstz } from './common.ts';
import { sql } from 'drizzle-orm';
import { projects, runs } from './projects.ts';

/** Append-only. `sequence` is server-assigned, per project, gapless, starting at 1. */
export const events = pgTable(
  'events',
  {
    ...scope(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    eventId: text('event_id').notNull(),
    runId: text('run_id').notNull(),
    taskId: text('task_id').notNull(),
    attemptId: text('attempt_id'),
    type: text('type').notNull(),
    aggregateRevision: integer('aggregate_revision').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    receivedAt: tstz('received_at').notNull(),
    causationId: text('causation_id'),
    traceId: text('trace_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.sequence] }),
    unique('events_event_id_key').on(t.eventId),
    foreignKey({ columns: [t.tenantId, t.projectId, t.runId], foreignColumns: [runs.tenantId, runs.projectId, runs.runId] }),
  ],
);

/** One row per event, written in the same transaction as the event. Delivery is at-least-once. */
export const outbox = pgTable(
  'outbox',
  {
    ...scope(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    eventId: text('event_id').notNull(),
    createdAt: createdAt(),
    claimedBy: text('claimed_by'),
    claimExpiresAt: tstz('claim_expires_at'),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    deliveredAt: tstz('delivered_at'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.sequence] }),
    foreignKey({ columns: [t.tenantId, t.projectId, t.sequence], foreignColumns: [events.tenantId, events.projectId, events.sequence] }),
    index('outbox_undelivered_idx').on(t.projectId, t.sequence).where(sql`delivered_at IS NULL`),
  ],
);

export const consumerCursors = pgTable(
  'consumer_cursors',
  {
    ...scope(),
    consumer: text('consumer').notNull(),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull().default(0),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.consumer] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);

export const integrationDeliveries = pgTable(
  'integration_deliveries',
  {
    ...scope(),
    deliveryId: text('delivery_id').notNull(),
    integration: text('integration').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    detail: detail(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.deliveryId] }),
    unique('integration_deliveries_dedupe').on(t.tenantId, t.projectId, t.integration, t.sequence),
    foreignKey({ columns: [t.tenantId, t.projectId, t.sequence], foreignColumns: [events.tenantId, events.projectId, events.sequence] }),
  ],
);

export const operationReceipts = pgTable(
  'operation_receipts',
  {
    ...scope(),
    operationKey: text('operation_key').notNull(),
    receipt: jsonb('receipt').$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.operationKey] }),
    foreignKey({ columns: [t.tenantId, t.projectId], foreignColumns: [projects.tenantId, projects.projectId] }),
  ],
);
