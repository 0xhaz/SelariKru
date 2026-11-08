import { EventEnvelopeSchema, type EventEnvelope } from '@selarikru/domain';
import { sql } from 'drizzle-orm';
import type { Executor } from './db.ts';
import { events, outbox } from './schema/index.ts';

export type NewEvent = Omit<EventEnvelope, 'sequence'> & { sequence?: number };

/**
 * Appends an event and its outbox row in the caller's transaction.
 *
 * `sequence` is assigned here, per project, gapless, from a counter row (`project_sequences`) that is
 * locked by the upsert until the transaction ends. Concurrent appenders for one project therefore
 * serialise on that row; a rollback restores the counter, so no number is ever consumed without a
 * committed event. A caller-supplied `sequence` is ignored. Do not call this outside a transaction
 * that also carries the state change, or the atomicity guarantee is lost.
 */
export async function appendEvent(tx: Executor, input: NewEvent): Promise<EventEnvelope> {
  const parsed = EventEnvelopeSchema.parse({ ...input, sequence: 0 });

  const rows = await tx.execute(sql`
    INSERT INTO project_sequences (tenant_id, project_id, last_sequence)
    SELECT tenant_id, project_id, 1 FROM projects WHERE project_id = ${parsed.projectId}
    ON CONFLICT (tenant_id, project_id) DO UPDATE SET last_sequence = project_sequences.last_sequence + 1
    RETURNING tenant_id, last_sequence`);
  const row = rows[0];
  if (!row) throw new Error(`unknown project: ${parsed.projectId}`);
  const tenantId = String(row['tenant_id']);
  const sequence = Number(row['last_sequence']);

  await tx.insert(events).values({
    tenantId,
    projectId: parsed.projectId,
    sequence,
    schemaVersion: parsed.schemaVersion,
    eventId: parsed.eventId,
    runId: parsed.runId,
    taskId: parsed.taskId,
    attemptId: parsed.attemptId,
    type: parsed.type,
    aggregateRevision: parsed.aggregateRevision,
    actorKind: parsed.actor.kind,
    actorId: parsed.actor.id,
    occurredAt: new Date(parsed.occurredAt),
    receivedAt: new Date(parsed.receivedAt),
    causationId: parsed.causationId,
    traceId: parsed.traceId,
    payload: parsed.payload,
  });
  await tx.insert(outbox).values({ tenantId, projectId: parsed.projectId, sequence, eventId: parsed.eventId });
  return { ...parsed, sequence };
}

export function rowToEnvelope(r: Record<string, unknown>): EventEnvelope {
  const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
  return EventEnvelopeSchema.parse({
    schemaVersion: r['schema_version'],
    eventId: r['event_id'],
    projectId: r['project_id'],
    runId: r['run_id'],
    taskId: r['task_id'],
    attemptId: r['attempt_id'],
    type: r['type'],
    sequence: Number(r['sequence']),
    aggregateRevision: r['aggregate_revision'],
    actor: { kind: r['actor_kind'], id: r['actor_id'] },
    occurredAt: iso(r['occurred_at']),
    receivedAt: iso(r['received_at']),
    causationId: r['causation_id'],
    traceId: r['trace_id'],
    payload: r['payload'],
  });
}

/** Events with sequence > `after`, ascending. For cursor-based readers and projection rebuilds. */
export async function readEventsAfter(db: Executor, tenantId: string, projectId: string, after: number, limit: number): Promise<EventEnvelope[]> {
  const rows = await db.execute(sql`
    SELECT * FROM events WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND sequence > ${after}
    ORDER BY sequence LIMIT ${limit}`);
  return rows.map(rowToEnvelope);
}
