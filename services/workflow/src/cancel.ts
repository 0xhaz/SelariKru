import { isPolicyRevokedReason, transition, type TaskState, type TaskStatus } from '@selarikru/domain';
import { schema, type Tx } from '@selarikru/persistence';
import { and, eq } from 'drizzle-orm';
import { emit, SCHEDULER_ACTOR, SYSTEM_ACTOR, type EventScope } from './events.ts';
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

/** Why the open cancel request was made: `budget_exhausted`, a `policy_revoked:` reason, or null for an owner's cancel or when there is none. */
export async function cancelRequestReason(tx: Tx, key: TaskKey, revision: number): Promise<string | null> {
  const request = await tx.select({ detail: schema.taskCommands.detail }).from(schema.taskCommands).where(requested(key, revision)).limit(1);
  const reason = request[0]?.detail['reason'];
  return typeof reason === 'string' ? reason : null;
}

/** The outcome to close a stopped attempt with: a policy stop interrupts it, so the repair budget is kept; anything else cancels it. */
export const stoppedOutcome = (reason: string | null): 'interrupted' | 'cancelled' => (isPolicyRevokedReason(reason) ? 'interrupted' : 'cancelled');

/**
 * Confirms a requested cancel once the attempt has ended: the task becomes `cancelled`, the request row is closed and
 * `task.cancelled` is recorded. The caller has locked the status row and has already closed the attempt's lease.
 *
 * A stop the owner caused by narrowing a grant is not a cancel: the task goes back to `ready` with the revoke as its placement block, so the owner
 * can see why it does not start and it runs again once the grant returns. Nothing is cancelled and no repair is spent.
 */
export async function confirmCancel(
  tx: Tx, key: TaskKey, state: TaskState, rowRevision: number, scope: Omit<EventScope, 'aggregateRevision'>, now: Date, attemptId: string | null, cause: Record<string, unknown>,
): Promise<{ readonly aggregateRevision: number; readonly status: TaskStatus }> {
  const stored = await cancelRequestReason(tx, key, state.revision);
  if (isPolicyRevokedReason(stored)) {
    const blocked = transition(state, { type: 'blocked', reason: stored! });
    const back = blocked.ok ? transition(blocked.value, { type: 'unblocked' }) : blocked;
    if (!back.ok) throw new Error(`illegal policy stop transition: ${JSON.stringify(back.error)}`);
    const aggregateRevision = await setStatus(tx, key, rowRevision, back.value.status, now);
    await tx.update(schema.taskStatus).set({ placementBlock: stored })
      .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)));
    await tx.update(schema.taskCommands).set({ state: 'applied' }).where(requested(key, state.revision));
    const at = { ...scope, aggregateRevision };
    await emit(tx, at, now, { type: 'attempt.failed', attemptId, actor: SYSTEM_ACTOR, payload: { reason: stored, outcome: 'interrupted', ...cause } });
    await emit(tx, at, now, { type: 'task.ready', attemptId, actor: SCHEDULER_ACTOR, payload: { reason: stored } });
    await emit(tx, at, now, { type: 'placement.blocked', attemptId: null, actor: SCHEDULER_ACTOR, payload: { reason: stored, mode: null } });
    return { aggregateRevision, status: back.value.status };
  }
  const moved = transition(state, { type: 'cancel' });
  if (!moved.ok) throw new Error(`illegal cancel transition: ${JSON.stringify(moved.error)}`);
  const aggregateRevision = await setStatus(tx, key, rowRevision, moved.value.status, now);
  // `task.cancel_requested` is human-only, so a budget stop is first named here: it must not read as an owner's cancel.
  const reason = stored === 'budget_exhausted' ? 'budget_exhausted' : 'cancel_requested';
  await tx.update(schema.taskCommands).set({ state: 'cancelled' }).where(requested(key, state.revision));
  await emit(tx, { ...scope, aggregateRevision }, now, { type: 'task.cancelled', attemptId, actor: SYSTEM_ACTOR, payload: { reason, ...(stored === 'run_cancelled' ? { runCancelled: true } : {}), ...cause } });
  return { aggregateRevision, status: moved.value.status };
}
