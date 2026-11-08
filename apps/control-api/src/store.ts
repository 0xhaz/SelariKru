import { createHash, randomUUID } from 'node:crypto';
import { checkEventAuthority, type Actor, type EventEnvelope, type EventType } from '@selarikru/domain';
import { appendEvent, recordOperation, schema, type Executor, type Tx } from '@selarikru/persistence';
import { and, eq } from 'drizzle-orm';
import { AppError } from './errors.ts';

export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;

export async function requireProject(db: Executor, tenantId: string, projectId: string) {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.tenantId, tenantId), eq(schema.projects.projectId, projectId)));
  const row = rows[0];
  if (!row) throw new AppError(404, 'project_not_found', 'no such project');
  return row;
}

function single<T>(rows: readonly T[], notFound: AppError): T {
  if (rows.length === 0) throw notFound;
  if (rows.length > 1) throw new AppError(409, 'ambiguous_id', 'the id exists in more than one project');
  return rows[0]!;
}

export async function requireRun(db: Executor, tenantId: string, runId: string, lock = false) {
  const q = db.select().from(schema.runs).where(and(eq(schema.runs.tenantId, tenantId), eq(schema.runs.runId, runId)));
  return single(await (lock ? q.for('update') : q), new AppError(404, 'run_not_found', 'no such run'));
}

export async function requireTaskStatus(db: Executor, tenantId: string, taskId: string, lock = false) {
  const q = db.select().from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, tenantId), eq(schema.taskStatus.taskId, taskId)));
  return single(await (lock ? q.for('update') : q), new AppError(404, 'task_not_found', 'no such task'));
}

export async function loadSpecRow(db: Executor, key: { tenantId: string; projectId: string; taskId: string; revision: number }) {
  const rows = await db
    .select()
    .from(schema.taskRevisions)
    .where(and(
      eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId),
      eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, key.revision),
    ));
  return rows[0];
}

export async function bumpStatus(tx: Tx, key: { tenantId: string; projectId: string; taskId: string }, rowRevision: number, status: string, now: Date): Promise<number> {
  const next = rowRevision + 1;
  await tx
    .update(schema.taskStatus)
    .set({ status, rowRevision: next, updatedAt: now })
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)));
  return next;
}

export interface EventSpec {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly aggregateRevision: number;
  readonly type: EventType;
  /** Derived from the authenticated principal by the route, never from a request body. */
  readonly actor: Actor;
  readonly payload: Record<string, unknown>;
}

/** Checks the actor's authority for the event type, then appends it with its outbox row in `tx`. */
export async function writeEvent(tx: Tx, now: Date, spec: EventSpec): Promise<EventEnvelope> {
  const at = now.toISOString();
  const envelope: EventEnvelope = {
    schemaVersion: 1,
    eventId: newId('evt'),
    projectId: spec.projectId,
    runId: spec.runId,
    taskId: spec.taskId,
    attemptId: null,
    type: spec.type,
    sequence: 0,
    aggregateRevision: spec.aggregateRevision,
    actor: spec.actor,
    occurredAt: at,
    receivedAt: at,
    causationId: null,
    traceId: newId('trace'),
    payload: spec.payload,
  };
  const authority = checkEventAuthority(envelope);
  if (!authority.ok) {
    throw new AppError(403, 'actor_not_permitted', `${authority.error.actorKind} may not emit ${authority.error.eventType}`);
  }
  return appendEvent(tx, envelope);
}

export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface Stored<T> {
  fingerprint: string;
  result: T;
}

/**
 * `recordOperation` plus a request fingerprint: replaying a key returns the first result, and reusing a key for a
 * different request is a 422 instead of a silent replay of someone else's answer.
 */
export async function idempotent<T>(tx: Tx, scope: { tenantId: string; projectId: string; key: string }, print: string, fn: () => Promise<T>): Promise<T> {
  const stored = await recordOperation<Stored<T>>(tx, scope, async () => ({ fingerprint: print, result: await fn() }));
  if (stored.fingerprint !== print) {
    throw new AppError(422, 'idempotency_key_conflict', 'this idempotency key was used for a different request');
  }
  return stored.result;
}
