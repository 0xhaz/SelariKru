import { transition, TaskSpecSchema, type TaskStatus } from '@selarikru/domain';
import { schema, withTx } from '@selarikru/persistence';
import { and, asc, eq, isNull, lte, isNotNull, or } from 'drizzle-orm';
import { cancelRequestReason, confirmCancel, hasCancelRequest, stoppedOutcome } from './cancel.ts';
import { emit, SCHEDULER_ACTOR, SYSTEM_ACTOR } from './events.ts';
import { closeLease, failAttempt } from './lease.ts';
import { heldTaskBlocked } from './handover.ts';
import { reservationIdFor, settle } from './reserve.ts';
import { recordAbandonedAttempt } from './usage.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus, type AttemptRow, type TaskKey } from './taskstate.ts';
import type { ExpiredLease, SchedulerContext } from './types.ts';

/**
 * Reaps every lease silent for the expiry window or past its hard deadline. Each lease is handled in its own transaction, in the same
 * lock order as the other paths (status row, then run row, then the event sequence), so one failure cannot strand the rest
 * and two paths cannot deadlock. State lives only in the database, so a restarted controller recovers by calling this.
 *
 * An expired attempt is `interrupted`: it does not consume the repair budget, and the task returns to `ready`. Its
 * reservation stays consumed at worst case, because the lost worker may still have spent up to it. An attempt that
 * ran out its deadline is a real failure, closed as `attempt_timeout`: it consumes the repair budget.
 */
export async function expireLeases(ctx: SchedulerContext, now: Date): Promise<readonly ExpiredLease[]> {
  const candidates = await ctx.db
    .select({
      tenantId: schema.attempts.tenantId, projectId: schema.attempts.projectId, taskId: schema.attempts.taskId,
      attemptId: schema.attempts.attemptId, fence: schema.attempts.leaseFence,
    })
    .from(schema.attempts)
    .where(and(isNotNull(schema.attempts.leaseToken), isNull(schema.attempts.endedAt), or(lte(schema.attempts.leaseExpiresAt, now), lte(schema.attempts.deadlineAt, now))))
    .orderBy(asc(schema.attempts.leaseExpiresAt), asc(schema.attempts.attemptId));

  const expired: ExpiredLease[] = [];
  const failures: unknown[] = [];
  for (const c of candidates) {
    // One lease's failure is that lease's alone: a stored spec that no longer parses must not strand every lease behind it.
    try {
      const reason = await expireOne(ctx, c.attemptId, c, now);
      if (reason) expired.push({ tenantId: c.tenantId, projectId: c.projectId, taskId: c.taskId, attemptId: c.attemptId, fence: c.fence ?? 0, reason });
    } catch (e) {
      failures.push(e);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} lease expiry row(s) failed (${expired.length} expired)`);
  return expired;
}

/** Why this attempt is due, if it is. If both have passed, whichever happened first decides; a tie is a timeout. */
function closeReason(attempt: AttemptRow, now: Date): ExpiredLease['reason'] | null {
  const leaseAt = attempt.leaseExpiresAt?.getTime() ?? null;
  const deadlineAt = attempt.deadlineAt?.getTime() ?? null;
  const leaseDue = leaseAt !== null && leaseAt <= now.getTime();
  const deadlineDue = deadlineAt !== null && deadlineAt <= now.getTime();
  if (deadlineDue && (!leaseDue || deadlineAt <= leaseAt)) return 'attempt_timeout';
  return leaseDue ? 'lease_expired' : null;
}

async function expireOne(ctx: SchedulerContext, attemptId: string, key: TaskKey, now: Date): Promise<ExpiredLease['reason'] | null> {
  return withTx(ctx.db, async (tx) => {
    const statusRow = await lockStatusRow(tx, key);
    if (!statusRow) return null;
    const rows = await tx
      .select()
      .from(schema.attempts)
      .where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.attemptId, attemptId)));
    const attempt = rows[0];
    // Recheck under the lock: a heartbeat or publish may have landed since the scan.
    if (!attempt || attempt.endedAt !== null) return null;
    const reason = closeReason(attempt, now);
    if (!reason) return null;

    const revisionRows = await tx
      .select({ spec: schema.taskRevisions.spec, runId: schema.taskRevisions.runId })
      .from(schema.taskRevisions)
      .where(and(eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, attempt.revision)));
    const revisionRow = revisionRows[0]!;
    const runScope = { tenantId: key.tenantId, projectId: key.projectId, runId: revisionRow.runId };
    await settle(tx, runScope, reservationIdFor(attempt.attemptId), 'expired');
    const role = (revisionRow.spec as { role?: unknown }).role;
    await recordAbandonedAttempt(tx, { scope: runScope, role: typeof role === 'string' ? role : 'unknown', attempt, now });

    const running = statusRow.status === 'running' && statusRow.currentRevision === attempt.revision;
    if (!running) {
      // The task has moved on without this attempt closing. Free the lease and resources; leave the status alone.
      await closeLease(tx, key, attemptId, now, { outcome: 'interrupted', exitReason: reason });
      return reason;
    }

    const parsed = TaskSpecSchema.safeParse(revisionRow.spec);
    const state = parsed.success ? buildTaskState(parsed.data, statusRow.status as TaskStatus, await loadAttempts(tx, key, attempt.revision)) : null;
    if (!state) throw new Error(`task ${key.taskId}: stored spec no longer valid`);
    const eventScope = { projectId: key.projectId, runId: revisionRow.runId, taskId: key.taskId };

    // An open cancel request makes the end of this attempt final: the task is cancelled, never re-dispatched.
    if (await hasCancelRequest(tx, key, attempt.revision)) {
      const stopReason = await cancelRequestReason(tx, key, attempt.revision);
      const outcome = stoppedOutcome(stopReason);
      await closeLease(tx, key, attemptId, now, { outcome, exitReason: outcome === 'interrupted' ? stopReason! : reason });
      await confirmCancel(tx, key, state, statusRow.rowRevision, eventScope, now, attemptId, { attemptId, cause: reason });
      return reason;
    }

    if (reason === 'attempt_timeout') {
      const failure = failAttempt(state, reason);
      await closeLease(tx, key, attemptId, now, { outcome: 'failed', exitReason: reason });
      const aggregateRevision = await setStatus(tx, key, statusRow.rowRevision, failure.state.status, now);
      const scope = { ...eventScope, aggregateRevision };
      await emit(tx, scope, now, { type: 'attempt.failed', attemptId, actor: SYSTEM_ACTOR, payload: { fence: attempt.leaseFence, reason, outcome: 'failed' } });
      await emit(tx, scope, now, { type: failure.follow.type, attemptId, actor: SCHEDULER_ACTOR, payload: { reason: failure.follow.reason } });
      if (failure.state.status === 'blocked') await heldTaskBlocked(tx, key, attempt.revision, failure.follow.reason, now);
      return reason;
    }

    const blocked = transition(state, { type: 'blocked', reason });
    if (!blocked.ok) throw new Error(`illegal reap transition: ${JSON.stringify(blocked.error)}`);
    const ready = transition(blocked.value, { type: 'unblocked' });
    if (!ready.ok) throw new Error(`illegal reap transition: ${JSON.stringify(ready.error)}`);

    await closeLease(tx, key, attemptId, now, { outcome: 'interrupted', exitReason: reason });
    const aggregateRevision = await setStatus(tx, key, statusRow.rowRevision, ready.value.status, now);
    const scope = { ...eventScope, aggregateRevision };
    await emit(tx, scope, now, { type: 'attempt.failed', attemptId, actor: SYSTEM_ACTOR, payload: { fence: attempt.leaseFence, reason, outcome: 'interrupted' } });
    await emit(tx, scope, now, { type: 'task.ready', attemptId, actor: SCHEDULER_ACTOR, payload: { reason } });
    return reason;
  });
}
