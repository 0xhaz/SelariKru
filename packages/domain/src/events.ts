import { z } from 'zod';
import { ActorSchema, type ActorKind, Id, SchemaVersion, Timestamp } from './common.ts';
import { err, ok, type Result } from './result.ts';

export const EVENT_TYPES = [
  'run.created', 'plan.accepted',
  'task.ready', 'task.cancel_requested', 'task.cancelled', 'task.superseded', 'task.blocked',
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

const { worker: W, verifier: V, human: H, scheduler: S, integration: I, system: Y } = {
  worker: 'worker', verifier: 'verifier', human: 'human', scheduler: 'scheduler', integration: 'integration', system: 'system',
} as const;

/** Event type -> actor kinds permitted to emit it. A type with no entry is denied for every actor. */
export const EVENT_ACTOR_ALLOWLIST: Readonly<Partial<Record<EventType, readonly ActorKind[]>>> = {
  'run.created': [H, S, Y],
  'plan.accepted': [S, Y],
  'task.ready': [S],
  /** A request to stop active attempts. Not confirmed termination: `task.cancelled` follows once the attempt is closed. */
  'task.cancel_requested': [H],
  'task.cancelled': [H, S, Y],
  'task.superseded': [S, Y],
  'task.blocked': [S, Y],
  'attempt.started': [W, S],
  'attempt.heartbeat': [W],
  'attempt.completed': [W],
  'attempt.failed': [W, S, Y],
  'approval.requested': [W, S, Y],
  'approval.granted': [H],
  'approval.denied': [H],
  'verification.started': [V, S],
  'verification.passed': [V],
  'verification.failed': [V],
  'change.proposed': [W, I],
  'change.merged': [I],
};

export interface ActorNotPermitted {
  readonly kind: 'actor_not_permitted';
  readonly eventType: EventType;
  readonly actorKind: ActorKind;
  readonly actorId: string;
}

/**
 * Allowlist check: may this actor kind emit this event type?
 * SECURITY: `event.actor` must be set by the API from the authenticated principal (runner identity,
 * user session, service credential), never copied from the submitted body. Otherwise the check is
 * meaningless because a caller can claim any kind.
 */
export function checkEventAuthority(event: EventEnvelope): Result<EventEnvelope, ActorNotPermitted> {
  const allowed = EVENT_ACTOR_ALLOWLIST[event.type];
  if (!allowed || !allowed.includes(event.actor.kind)) {
    return err({ kind: 'actor_not_permitted', eventType: event.type, actorKind: event.actor.kind, actorId: event.actor.id });
  }
  return ok(event);
}
