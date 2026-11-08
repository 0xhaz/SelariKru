import { z } from 'zod';
import { ActorSchema, Id, SchemaVersion, Timestamp } from './common.ts';
import { err, ok, type Result } from './result.ts';

export const EVENT_TYPES = [
  'run.created', 'plan.accepted',
  'task.ready', 'task.cancelled', 'task.superseded', 'task.blocked',
  'attempt.started', 'attempt.heartbeat', 'attempt.completed', 'attempt.failed',
  'approval.requested', 'approval.granted', 'approval.denied',
  'verification.started', 'verification.passed', 'verification.failed',
  'change.proposed', 'change.merged',
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventEnvelopeSchema = z
  .object({
    schemaVersion: SchemaVersion,
    eventId: Id,
    projectId: Id,
    runId: Id,
    taskId: Id,
    attemptId: Id.nullable(),
    type: EventTypeSchema,
    sequence: z.number().int().min(0),
    aggregateRevision: z.number().int().min(0),
    actor: ActorSchema,
    occurredAt: Timestamp,
    receivedAt: Timestamp,
    causationId: Id.nullable(),
    traceId: Id,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** Event types a worker-kind actor can never emit as authoritative (architecture section 7). */
export const WORKER_FORBIDDEN_EVENT_TYPES: readonly EventType[] = ['approval.granted', 'change.merged', 'verification.passed'];

export interface WorkerNotAuthoritative {
  readonly kind: 'worker_not_authoritative';
  readonly eventType: EventType;
  readonly actorId: string;
}

/** Called by the API before accepting an event. Schemas alone can't express this cross-field rule. */
export function checkWorkerAuthority(event: EventEnvelope): Result<EventEnvelope, WorkerNotAuthoritative> {
  if (event.actor.kind === 'worker' && WORKER_FORBIDDEN_EVENT_TYPES.includes(event.type)) {
    return err({ kind: 'worker_not_authoritative', eventType: event.type, actorId: event.actor.id });
  }
  return ok(event);
}
