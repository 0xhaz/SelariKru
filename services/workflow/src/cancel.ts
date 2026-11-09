import { transition, type TaskState } from '@selarikru/domain';
import { schema, type Tx } from '@selarikru/persistence';
import { and, eq } from 'drizzle-orm';
import { emit, SYSTEM_ACTOR, type EventScope } from './events.ts';
import { setStatus, type TaskKey } from './taskstate.ts';

const requested = (key: TaskKey, revision: number) =>
  and(
    eq(schema.taskCommands.tenantId, key.tenantId), eq(schema.taskCommands.projectId, key.projectId), eq(schema.taskCommands.taskId, key.taskId),
    eq(schema.taskCommands.command, 'cancel'), eq(schema.taskCommands.state, 'cancel_requested'), eq(schema.taskCommands.revision, revision),
  );

/** True when the owner asked to cancel this task revision and termination has not been confirmed yet. */
export async function hasCancelRequest(tx: Tx, key: TaskKey, revision: number): Promise<boolean> {
  const rows = await tx.select({ id: schema.taskCommands.operationId }).from(schema.taskCommands).where(requested(key, revision)).limit(1);
  return rows.length > 0;
}

/**
 * Confirms a requested cancel once the attempt has ended: the task becomes `cancelled`, the request row is closed and
 * `task.cancelled` is recorded. The caller has locked the status row and has already closed the attempt's lease.
 */
export async function confirmCancel(
  tx: Tx, key: TaskKey, state: TaskState, rowRevision: number, scope: Omit<EventScope, 'aggregateRevision'>, now: Date, attemptId: string | null, cause: Record<string, unknown>,
): Promise<number> {
  const moved = transition(state, { type: 'cancel' });
  if (!moved.ok) throw new Error(`illegal cancel transition: ${JSON.stringify(moved.error)}`);
  const aggregateRevision = await setStatus(tx, key, rowRevision, moved.value.status, now);
  // `task.cancel_requested` is human-only, so a budget stop is first named here: it must not read as an owner's cancel.
  const request = await tx.select({ detail: schema.taskCommands.detail }).from(schema.taskCommands).where(requested(key, state.revision)).limit(1);
  const reason = request[0]?.detail['reason'] === 'budget_exhausted' ? 'budget_exhausted' : 'cancel_requested';
  await tx.update(schema.taskCommands).set({ state: 'cancelled' }).where(requested(key, state.revision));
  await emit(tx, { ...scope, aggregateRevision }, now, { type: 'task.cancelled', attemptId, actor: SYSTEM_ACTOR, payload: { reason, ...cause } });
  return aggregateRevision;
}
