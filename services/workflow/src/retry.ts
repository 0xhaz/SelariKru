import { TaskSpecSchema, err, ok, transition, type AttemptRecord, type Result, type TaskStatus } from '@selarikru/domain';
import { schema, withTx, type Tx } from '@selarikru/persistence';
import { and, eq } from 'drizzle-orm';
import { emit, SCHEDULER_ACTOR } from './events.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus, type TaskKey } from './taskstate.ts';
import type { RetryReceipt, RetryRefusal, SchedulerContext } from './types.ts';

/**
 * Owner-requested retry of a failed task: `failed` -> `ready` when the attempt budget allows. The scheduler emits
 * `task.ready` under its own actor and names who asked in the payload. Pass `tx` to join the caller's transaction
 * (the control API wraps it with its idempotency receipt); otherwise it opens its own.
 */
export async function retryTask(ctx: SchedulerContext, key: TaskKey, requestedBy: string, operationId: string | null, tx?: Tx): Promise<Result<RetryReceipt, RetryRefusal>> {
  const run = async (t: Tx): Promise<Result<RetryReceipt, RetryRefusal>> => {
    const row = await lockStatusRow(t, key);
    if (!row) return err({ kind: 'retry_refused', reason: 'task_not_found' });
    const revisions = await t
      .select({ spec: schema.taskRevisions.spec, runId: schema.taskRevisions.runId })
      .from(schema.taskRevisions)
      .where(and(eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, row.currentRevision)));
    const parsed = TaskSpecSchema.safeParse(revisions[0]?.spec);
    const attempts = await loadAttempts(t, key, row.currentRevision);
    const state = parsed.success ? buildTaskState(parsed.data, row.status as TaskStatus, attempts) : null;
    if (!state) return err({ kind: 'retry_refused', reason: 'invalid_spec' });
    const moved = transition(state, { type: 'retry_requested' });
    if (!moved.ok) {
      const used = state.attempts.filter((a: AttemptRecord) => a.outcome !== 'interrupted').length;
      return err({ kind: 'retry_refused', reason: moved.error.reason, status: row.status, attemptsUsed: used });
    }
    const now = ctx.now();
    const aggregateRevision = await setStatus(t, key, row.rowRevision, moved.value.status, now);
    await emit(t, { projectId: key.projectId, runId: revisions[0]!.runId, taskId: key.taskId, aggregateRevision }, now, {
      type: 'task.ready', attemptId: null, actor: SCHEDULER_ACTOR, payload: { reason: 'retry_requested', requestedBy, ...(operationId ? { operationId } : {}) },
    });
    return ok({ taskId: key.taskId, taskStatus: moved.value.status, aggregateRevision });
  };
  return tx ? run(tx) : withTx(ctx.db, run);
}
