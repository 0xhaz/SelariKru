import { z } from 'zod';
import { ActorSchema, type ActorKind, Id, SchemaVersion, Timestamp } from './common.ts';
import { err, ok, type Result } from './result.ts';

export const EVENT_TYPES = [
  'run.created', 'plan.accepted', 'run.reduced_scope_accepted',
  'task.ready', 'placement.decided', 'placement.blocked', 'task.cancel_requested', 'task.cancelled', 'task.superseded', 'task.reopened', 'run.reverted', 'task.blocked',
  'attempt.started', 'attempt.heartbeat', 'attempt.completed', 'attempt.failed',
  'approval.requested', 'approval.granted', 'approval.denied',
  'verification.started', 'verification.passed', 'verification.failed',
  'change.proposed', 'change.merged',
  'candidate.assembled', 'candidate.failed',
  'attempt.human_intervened', 'terminal.control_ended',
  'settings.changed', 'settings.applied', 'run.cancel_requested', 'run.cancelled', 'placement.cleared',
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
  /** The owner accepted a budget-stopped run as delivered at reduced scope. Human only. It never marks stopped criteria verified. */
  'run.reduced_scope_accepted': [H],
  'task.ready': [S],
  /** Where a claimed task runs and why: a scheduler decision, recorded with the policy decision behind any cloud start. Never an approval. */
  'placement.decided': [S],
  /** A permanent placement block (restricted data, missing grant or limit, approval required), recorded once per reason change. */
  'placement.blocked': [S],
  /** A request to stop active attempts. Not confirmed termination: `task.cancelled` follows once the attempt is closed. */
  'task.cancel_requested': [H],
  'task.cancelled': [H, S, Y],
  'task.superseded': [S, Y],
  /** A verified task went back to `verifying` (or `blocked`) because the evidence for it was invalidated. */
  'task.reopened': [I],
  /** A run left `ready_for_review` because its evidence was invalidated, or because an accepted plan gave it unfinished work (the control plane, for the owner). */
  'run.reverted': [I, S, Y],
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
  /** The integration controller built (or failed to build) the exact candidate that verification will judge. */
  'candidate.assembled': [I],
  'candidate.failed': [I],
  /** A person entered control mode on this attempt and typed into its sandbox. Human only: nothing else can claim, or remove, this mark. */
  'attempt.human_intervened': [H],
  /** A control session ended. Human only, because the session was theirs even when a fence or timeout closed it. */
  'terminal.control_ended': [H],
  /** The owner changed a setting: old and new values and who. Human only. Values are closed shapes (booleans, numbers, plan paths, model ids), never agent text or secrets. */
  'settings.changed': [H],
  /** The component that enforces a setting acknowledged it (a runner's poll or heartbeat). Never a person: a save is not an acknowledgement. */
  'settings.applied': [S, Y],
  /** The owner asked to cancel a run. Not confirmed termination: `run.cancelled` follows once every active attempt has ended or its lease expired. */
  'run.cancel_requested': [H],
  'run.cancelled': [S, Y],
  /** A placement block cleared because the owner gave a grant back. The scheduler records it; who asked is in the payload. */
  'placement.cleared': [S],
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
