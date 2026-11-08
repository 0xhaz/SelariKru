import { transition, TaskSpecSchema, type TaskStatus } from '@selarikru/domain';
import { schema, withTx } from '@selarikru/persistence';
import { and, asc, eq, isNull, lte, isNotNull } from 'drizzle-orm';
import { emit, SCHEDULER_ACTOR, SYSTEM_ACTOR } from './events.ts';
import { closeLease } from './lease.ts';
import { reservationIdFor, settle } from './reserve.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus, type TaskKey } from './taskstate.ts';
import type { ExpiredLease, SchedulerContext } from './types.ts';

/**
 * Reaps every lease silent for the expiry window. Each lease is handled in its own transaction, in the same
 * lock order as the other paths (status row, then run row, then the event sequence), so one failure cannot strand the rest
 * and two paths cannot deadlock. State lives only in the database, so a restarted controller recovers by calling this.
 *
 * An expired attempt is `interrupted`: it does not consume the repair budget, and the task returns to `ready`. Its
 * reservation stays consumed at worst case, because the lost worker may still have spent up to it.
 */
export async function expireLeases(ctx: SchedulerContext, now: Date): Promise<readonly ExpiredLease[]> {
  const candidates = await ctx.db
    .select({
      tenantId: schema.attempts.tenantId, projectId: schema.attempts.projectId, taskId: schema.attempts.taskId,
      attemptId: schema.attempts.attemptId, fence: schema.attempts.leaseFence,
    })
    .from(schema.attempts)
    .where(and(isNotNull(schema.attempts.leaseToken), isNull(schema.attempts.endedAt), lte(schema.attempts.leaseExpiresAt, now)))
    .orderBy(asc(schema.attempts.leaseExpiresAt), asc(schema.attempts.attemptId));

  const expired: ExpiredLease[] = [];
  for (const c of candidates) {
    if (await expireOne(ctx, c.attemptId, c, now)) {
      expired.push({ tenantId: c.tenantId, projectId: c.projectId, taskId: c.taskId, attemptId: c.attemptId, fence: c.fence ?? 0, reason: 'lease_expired' });
    }
  }
  return expired;
}

async function expireOne(ctx: SchedulerContext, attemptId: string, key: TaskKey, now: Date): Promise<boolean> {
  return withTx(ctx.db, async (tx) => {
    const statusRow = await lockStatusRow(tx, key);
    if (!statusRow) return false;
    const rows = await tx
      .select()
      .from(schema.attempts)
      .where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.attemptId, attemptId)));
    const attempt = rows[0];
    // Recheck under the lock: a heartbeat or publish may have landed since the scan.
    if (!attempt || attempt.endedAt !== null || !attempt.leaseExpiresAt || attempt.leaseExpiresAt.getTime() > now.getTime()) return false;

    const revisionRows = await tx
      .select({ spec: schema.taskRevisions.spec, runId: schema.taskRevisions.runId })
      .from(schema.taskRevisions)
      .where(and(eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, attempt.revision)));
    const revisionRow = revisionRows[0]!;
    const scope = { tenantId: key.tenantId, projectId: key.projectId, runId: revisionRow.runId };
    await settle(tx, scope, reservationIdFor(attempt.attemptId), 'expired', null);

    const running = statusRow.status === 'running' && statusRow.currentRevision === attempt.revision;
    if (!running) {
      // The task has moved on without this attempt closing. Free the lease and resources; leave the status alone.
      await closeLease(tx, key, attemptId, now, { outcome: 'interrupted', exitReason: 'lease_expired' });
      return true;
    }

    const parsed = TaskSpecSchema.safeParse(revisionRow.spec);
    const state = parsed.success ? buildTaskState(parsed.data, statusRow.status as TaskStatus, await loadAttempts(tx, key, attempt.revision)) : null;
    if (!state) throw new Error(`task ${key.taskId}: stored spec no longer valid`);
    const blocked = transition(state, { type: 'blocked', reason: 'lease_expired' });
    if (!blocked.ok) throw new Error(`illegal reap transition: ${JSON.stringify(blocked.error)}`);
    const ready = transition(blocked.value, { type: 'unblocked' });
    if (!ready.ok) throw new Error(`illegal reap transition: ${JSON.stringify(ready.error)}`);

    await closeLease(tx, key, attemptId, now, { outcome: 'interrupted', exitReason: 'lease_expired' });
    const aggregateRevision = await setStatus(tx, key, statusRow.rowRevision, ready.value.status, now);
    const eventScope = { projectId: key.projectId, runId: revisionRow.runId, taskId: key.taskId, aggregateRevision };
    await emit(tx, eventScope, now, { type: 'attempt.failed', attemptId, actor: SYSTEM_ACTOR, payload: { fence: attempt.leaseFence, reason: 'lease_expired', outcome: 'interrupted' } });
    await emit(tx, eventScope, now, { type: 'task.ready', attemptId, actor: SCHEDULER_ACTOR, payload: { reason: 'lease_expired' } });
    return true;
  });
}
