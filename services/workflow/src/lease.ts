import { transition, TaskSpecSchema, type Result, type TaskEvent, type TaskState, type TaskStatus, err, ok } from '@selarikru/domain';
import { recordOperation, schema, withTx, type Tx } from '@selarikru/persistence';
import { and, eq, isNull } from 'drizzle-orm';
import { confirmCancel, hasCancelRequest } from './cancel.ts';
import { emit, SCHEDULER_ACTOR, type EventScope } from './events.ts';
import { reservationIdFor, settle } from './reserve.ts';
import { recordAttemptUsage } from './usage.ts';
import { buildTaskState, lockStatusRow, loadAttempts, setStatus, type AttemptRow, type TaskKey } from './taskstate.ts';
import type { HeartbeatReceipt, Lease, LeaseConflict, LeaseConflictReason, PublishReceipt, PublishResult, SchedulerContext } from './types.ts';

export const LEASE_EXPIRY_SECONDS = 60;
export const LEASE_SUSPECT_SECONDS = 30;
export const HEARTBEAT_INTERVAL_SECONDS = 10;

export const leaseDeadline = (from: Date): Date => new Date(from.getTime() + LEASE_EXPIRY_SECONDS * 1000);

export type LeaseHealth = 'healthy' | 'suspect' | 'expired';

/** Display-side health. Authority over expiry stays with `expireLeases` and the fence check. */
export function leaseHealth(lastHeartbeatAt: string, now: Date): LeaseHealth {
  const silent = now.getTime() - new Date(lastHeartbeatAt).getTime();
  if (silent >= LEASE_EXPIRY_SECONDS * 1000) return 'expired';
  return silent >= LEASE_SUSPECT_SECONDS * 1000 ? 'suspect' : 'healthy';
}

/** Thrown inside a `recordOperation` savepoint so that a fenced publish writes no receipt at all. */
class FencedPublish extends Error {
  constructor(readonly conflict: LeaseConflict) {
    super(conflict.reason);
  }
}

function conflict(lease: Lease, reason: LeaseConflictReason): LeaseConflict {
  return { kind: 'lease_conflict', httpStatus: 409, reason, taskId: lease.taskId, attemptId: lease.attemptId, fence: lease.fence };
}

async function loadAttempt(tx: Tx, lease: Lease): Promise<AttemptRow | undefined> {
  const rows = await tx
    .select()
    .from(schema.attempts)
    .where(and(eq(schema.attempts.tenantId, lease.tenantId), eq(schema.attempts.projectId, lease.projectId), eq(schema.attempts.attemptId, lease.attemptId)));
  return rows[0];
}

/** Checks a presented lease against the database, trusting nothing but the row. Call with the status row locked. */
function checkLease(attempt: AttemptRow | undefined, statusRow: { status: string; currentRevision: number }, lease: Lease, now: Date): LeaseConflictReason | null {
  if (
    !attempt || attempt.taskId !== lease.taskId || attempt.revision !== lease.revision ||
    attempt.leaseFence !== lease.fence || attempt.leaseToken !== lease.leaseToken ||
    attempt.endedAt !== null || statusRow.currentRevision !== lease.revision || statusRow.status !== 'running'
  ) return 'stale_fence';
  if (attempt.deadlineAt === null || now.getTime() >= attempt.deadlineAt.getTime()) return 'attempt_timeout';
  if (attempt.leaseExpiresAt === null || now.getTime() >= attempt.leaseExpiresAt.getTime()) return 'lease_expired';
  return null;
}

/** Renews only the active, unexpired fence. Heartbeats are not events. */
export async function heartbeat(ctx: SchedulerContext, lease: Lease): Promise<Result<HeartbeatReceipt, LeaseConflict>> {
  return withTx(ctx.db, async (tx) => {
    const statusRow = await lockStatusRow(tx, lease);
    if (!statusRow) return err(conflict(lease, 'stale_fence'));
    const now = ctx.now();
    const reason = checkLease(await loadAttempt(tx, lease), statusRow, lease, now);
    if (reason) return err(conflict(lease, reason));
    const expiresAt = leaseDeadline(now);
    await tx
      .update(schema.attempts)
      .set({ lastHeartbeatAt: now, leaseExpiresAt: expiresAt })
      .where(and(eq(schema.attempts.tenantId, lease.tenantId), eq(schema.attempts.projectId, lease.projectId), eq(schema.attempts.attemptId, lease.attemptId)));
    const cancelRequested = await hasCancelRequest(tx, lease, lease.revision);
    return ok({ attemptId: lease.attemptId, fence: lease.fence, lastHeartbeatAt: now.toISOString(), expiresAt: expiresAt.toISOString(), cancelRequested });
  });
}

/** Ends an attempt's lease: records its outcome and releases its resource claims (except when it completed into verification). */
export async function closeLease(tx: Tx, key: TaskKey, attemptId: string, now: Date, close: { outcome: string; exitReason: string; headSha?: string | undefined; keepClaims?: boolean }): Promise<void> {
  await tx
    .update(schema.attempts)
    .set({ endedAt: now, outcome: close.outcome, exitReason: close.exitReason, ...(close.headSha ? { headSha: close.headSha } : {}) })
    .where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.attemptId, attemptId)));
  // A completed attempt moves to `verifying` and keeps its exclusive claims: verification releases them (applyVerification).
  if (close.keepClaims) return;
  await tx
    .update(schema.resourceClaims)
    .set({ releasedAt: now })
    .where(and(eq(schema.resourceClaims.tenantId, key.tenantId), eq(schema.resourceClaims.projectId, key.projectId), eq(schema.resourceClaims.attemptId, attemptId), isNull(schema.resourceClaims.releasedAt)));
}

const attemptOutcome = (state: TaskState, attemptId: string): string => state.attempts.find((a) => a.attemptId === attemptId)!.outcome;

function must(state: TaskState, event: TaskEvent): TaskState {
  const r = transition(state, event);
  if (!r.ok) throw new Error(`illegal scheduler transition: ${JSON.stringify(r.error)}`);
  return r.value;
}

export interface FailureOutcome {
  readonly state: TaskState;
  readonly repair: 'scheduled' | 'refused';
  readonly follow: { readonly type: 'task.ready' | 'task.blocked'; readonly reason: string };
}

/** Fails the running attempt, then schedules a repair if the domain's budget allows or stops the task at `blocked`. */
export function failAttempt(state: TaskState, reason: string): FailureOutcome {
  const failed = must(state, { type: 'attempt_failed', reason });
  const retry = transition(failed, { type: 'retry_requested' });
  if (retry.ok) return { state: retry.value, repair: 'scheduled', follow: { type: 'task.ready', reason: 'repair_scheduled' } };
  return {
    state: must(failed, { type: 'repair_refused', reason: 'repair_budget_exhausted' }),
    repair: 'refused',
    follow: { type: 'task.blocked', reason: 'repair_budget_exhausted' },
  };
}

/** Applies a worker's result in one transaction, gated by fence, token and expiry. */
export async function publishResult(ctx: SchedulerContext, lease: Lease, result: PublishResult): Promise<Result<PublishReceipt, LeaseConflict>> {
  return withTx(ctx.db, async (tx) => {
    const statusRow = await lockStatusRow(tx, lease);
    if (!statusRow) return err(conflict(lease, 'stale_fence'));
    // Identity is checked before the receipt lookup, so a wrong token can never read back another holder's receipt.
    const held = await loadAttempt(tx, lease);
    if (!held || held.taskId !== lease.taskId || held.revision !== lease.revision || held.leaseFence !== lease.fence || held.leaseToken !== lease.leaseToken) {
      return err(conflict(lease, 'stale_fence'));
    }
    // The key names the attempt and fence only: the token is a credential and stays out of the receipts table.
    const operation = { tenantId: lease.tenantId, projectId: lease.projectId, key: `publish:${lease.attemptId}:${lease.fence}` };
    try {
      const receipt = await recordOperation<PublishReceipt>(tx, operation, () => applyResult(ctx, tx, lease, result, statusRow));
      return ok(receipt);
    } catch (e) {
      if (e instanceof FencedPublish) return err(e.conflict);
      throw e;
    }
  });
}

async function applyResult(ctx: SchedulerContext, tx: Tx, lease: Lease, result: PublishResult, statusRow: { status: string; currentRevision: number; rowRevision: number }): Promise<PublishReceipt> {
  const now = ctx.now();
  const attempts = await loadAttempts(tx, lease, lease.revision);
  const attempt = attempts.find((a) => a.attemptId === lease.attemptId);
  const reason = checkLease(attempt, statusRow, lease, now);
  if (reason) throw new FencedPublish(conflict(lease, reason));
  const live = attempt!;

  const revisions = await tx
    .select({ spec: schema.taskRevisions.spec })
    .from(schema.taskRevisions)
    .where(and(eq(schema.taskRevisions.tenantId, lease.tenantId), eq(schema.taskRevisions.projectId, lease.projectId), eq(schema.taskRevisions.taskId, lease.taskId), eq(schema.taskRevisions.revision, lease.revision)));
  const spec = TaskSpecSchema.parse(revisions[0]!.spec);
  // Run scope and reservation come from stored rows, never from the presented lease.
  const runScope = { tenantId: lease.tenantId, projectId: lease.projectId, runId: spec.runId };
  let state = buildTaskState(spec, statusRow.status as TaskStatus, attempts);
  if (!state) throw new Error(`task ${lease.taskId}: stored spec no longer valid`);

  const runner = { kind: 'worker', id: live.runner ?? lease.runnerId } as const;
  const key: TaskKey = lease;

  // An open cancel request wins over whatever the worker reports: the attempt ends, the task is cancelled.
  if (await hasCancelRequest(tx, key, lease.revision)) {
    await settle(tx, runScope, reservationIdFor(lease.attemptId), 'settled');
    await recordAttemptUsage(tx, { scope: runScope, role: spec.role, attempt: live, now }, result);
    // History is kept: the reported head commit (the only pointer to pushed work), the worker's own reason and its cost.
    const reportedReason = result.outcome === 'completed' ? null : result.reason;
    await closeLease(tx, key, lease.attemptId, now, {
      outcome: 'cancelled', exitReason: reportedReason ?? 'completed', headSha: result.outcome === 'completed' ? result.headSha : undefined,
    });
    await tx.update(schema.attempts)
      .set({ detail: { ...(live.detail ?? {}), cancelRequested: true, reportedOutcome: result.outcome, reportedReason, reportedCostUsd: result.reportedCostUsd ?? null } })
      .where(and(eq(schema.attempts.tenantId, lease.tenantId), eq(schema.attempts.projectId, lease.projectId), eq(schema.attempts.attemptId, lease.attemptId)));
    await confirmCancel(tx, key, state, statusRow.rowRevision, { projectId: lease.projectId, runId: spec.runId, taskId: lease.taskId }, now, lease.attemptId, { attemptId: lease.attemptId, reportedOutcome: result.outcome });
    return { attemptId: lease.attemptId, taskId: lease.taskId, fence: lease.fence, outcome: result.outcome, taskStatus: 'cancelled' };
  }
  let event: { type: 'attempt.completed' | 'attempt.failed' | 'task.blocked' | 'approval.requested'; actor: typeof runner | typeof SCHEDULER_ACTOR; payload: Record<string, unknown> };
  let exitReason: string;
  let repair: PublishReceipt['repair'];
  let follow: { type: 'task.ready' | 'task.blocked'; reason: string } | undefined;

  switch (result.outcome) {
    case 'completed':
      state = must(state, { type: 'attempt_completed' });
      exitReason = 'completed';
      event = { type: 'attempt.completed', actor: runner, payload: { fence: lease.fence, headSha: result.headSha ?? null, changeManifestSha256: result.changeManifestSha256 ?? null } };
      break;
    case 'failed': {
      const failure = failAttempt(state, result.reason);
      state = failure.state;
      repair = failure.repair;
      follow = failure.follow;
      exitReason = result.reason;
      event = { type: 'attempt.failed', actor: SCHEDULER_ACTOR, payload: { fence: lease.fence, reason: result.reason, outcome: 'failed' } };
      break;
    }
    case 'blocked':
      state = must(state, { type: 'blocked', reason: result.reason });
      exitReason = result.reason;
      event = { type: 'task.blocked', actor: SCHEDULER_ACTOR, payload: { fence: lease.fence, reason: result.reason } };
      break;
    case 'approval_requested':
      state = must(state, { type: 'approval_requested' });
      exitReason = result.reason;
      event = { type: 'approval.requested', actor: SCHEDULER_ACTOR, payload: { fence: lease.fence, reason: result.reason } };
      break;
  }

  await settle(tx, runScope, reservationIdFor(lease.attemptId), 'settled');
  await recordAttemptUsage(tx, { scope: runScope, role: spec.role, attempt: live, now }, result);
  await closeLease(tx, key, lease.attemptId, now, { outcome: attemptOutcome(state, lease.attemptId), exitReason, headSha: result.outcome === 'completed' ? result.headSha : undefined, keepClaims: result.outcome === 'completed' });
  if (result.outcome === 'completed' && result.changeManifestSha256) {
    await tx.update(schema.attempts)
      .set({ detail: { ...(live.detail ?? {}), changeManifestSha256: result.changeManifestSha256 } })
      .where(and(eq(schema.attempts.tenantId, lease.tenantId), eq(schema.attempts.projectId, lease.projectId), eq(schema.attempts.attemptId, lease.attemptId)));
  }
  const aggregateRevision = await setStatus(tx, key, statusRow.rowRevision, state.status, now);
  const scope: EventScope = { projectId: lease.projectId, runId: spec.runId, taskId: lease.taskId, aggregateRevision };
  await emit(tx, scope, now, { type: event.type, attemptId: lease.attemptId, actor: event.actor, payload: event.payload });
  if (follow) await emit(tx, scope, now, { type: follow.type, attemptId: lease.attemptId, actor: SCHEDULER_ACTOR, payload: { reason: follow.reason } });

  return { attemptId: lease.attemptId, taskId: lease.taskId, fence: lease.fence, outcome: result.outcome, taskStatus: state.status, ...(repair ? { repair } : {}) };
}
