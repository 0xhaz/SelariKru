import { randomUUID } from 'node:crypto';
import { checkEventAuthority, type Actor, type EventEnvelope, type EventType } from '@selarikru/domain';
import { appendEvent, type Tx } from '@selarikru/persistence';

export const SCHEDULER_ACTOR: Actor = { kind: 'scheduler', id: 'scheduler' };
export const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'lease_reaper' };

export interface EventScope {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly aggregateRevision: number;
}

/** Appends an event in `tx`, after checking the actor may emit its type. An unpermitted emission is a bug, so it throws. */
export async function emit(tx: Tx, scope: EventScope, now: Date, input: { type: EventType; attemptId: string | null; actor: Actor; payload: Record<string, unknown> }): Promise<void> {
  const at = now.toISOString();
  const envelope: EventEnvelope = {
    schemaVersion: 1,
    eventId: `evt_${randomUUID()}`,
    projectId: scope.projectId,
    runId: scope.runId,
    taskId: scope.taskId,
    attemptId: input.attemptId,
    type: input.type,
    sequence: 0,
    aggregateRevision: scope.aggregateRevision,
    actor: input.actor,
    occurredAt: at,
    receivedAt: at,
    causationId: null,
    traceId: `trace_${randomUUID()}`,
    payload: input.payload,
  };
  const authority = checkEventAuthority(envelope);
  if (!authority.ok) throw new Error(`scheduler emitted a forbidden event: ${JSON.stringify(authority.error)}`);
  await appendEvent(tx, envelope);
}
