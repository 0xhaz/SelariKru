import { createHash, randomUUID } from 'node:crypto';
import {
  checkpointDigest, err, HANDOVER_STOP_PREFIX, SUCCESSOR_RETRY_LIMIT, isHandoverReason, NO_HARNESS_CATALOG, ok, OPEN_HANDOVER_STATES, TaskSpecSchema, transition,
  type CheckpointDiff, type CheckpointExclusion, type CheckpointFile, type CheckpointRefusal, type HandoverIneligible, type HandoverMode, type HandoverState, type Result, type TaskState, type TaskSpec,
} from '@selarikru/domain';
import { strongest, type Classification } from '@selarikru/policy';
import { schema, withTx, type Executor, type Tx } from '@selarikru/persistence';
import { and, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { worstCaseHold } from './assignment.ts';
import { capacityFor, resolveLimits, resolveSources, runningCounts, runPlacement } from './claim.ts';
import { emit, SCHEDULER_ACTOR, SYSTEM_ACTOR, type EventScope } from './events.ts';
import { isBlocked, place } from './placement.ts';
import { checkFits, lockBudget, readBudget, remainingMicros, toMicros } from './reserve.ts';
import { gateFor, loadRunGates, loadRunnerGate } from './settings.ts';
import { lockStatusRow, setStatus, type AttemptRow, type TaskKey } from './taskstate.ts';
import type { Caps, Lease, SchedulerContext } from './types.ts';

/**
 * Checkpoint continuation (docs/architecture.md §4). The owner asks to continue a task's local attempt on an enrolled cloud-location runner. The order is the whole point:
 *
 *   1. the request records the handover (`stopping`) and opens a stop on the attempt through the existing cancel request, with a `handover:` reason;
 *   2. the runner, told on its next heartbeat, stops its worker, sends its checkpoint (checked and stored here, or refused with a reason) and acknowledges by publishing;
 *   3. the attempt ending, by that publish or by lease expiry, is the fence: its lease is revoked, the next fence is reserved, and only then is the task claimable, by a cloud
 *      runner only (`fenced`), or held for the owner's choice when no safe resume exists (`restart_offered`);
 *   4. the successor's claim is a new attempt of the same revision, recorded as a route change; its lease names the checkpoint, whose hashes it checks before its worker starts.
 *
 * A late publish by the fenced attempt fails its lease check (stale fence) and is recorded. The combined candidate is verified like any other: a completed successor goes to
 * `verifying`, and no earlier record can stand for a candidate it did not name.
 *
 * Lock order (see services/workflow/src/verification.ts): the request and the owner's decision take the scheduler lock, the task's status row, the run row (`lockBudget`), then
 * this table's row and the event sequence; the checkpoint upload, the fence (inside publish or expiry, after `settle` took the run row), the successor's claim and its first
 * heartbeat take the status row first and this row after it.
 */

export type CheckpointRow = typeof schema.checkpoints.$inferSelect;

/** An enrolled cloud runner is a candidate only if it reached the control plane this recently. */
export const CLOUD_RUNNER_FRESH_SECONDS = 120;

export interface HandoverFigure {
  readonly value: number | null;
  readonly provenance: 'estimated' | 'unavailable';
  readonly basis: string;
}

/** What a resume or restart is expected to cost. Estimates, always labelled: the hold is an upper bound, and time is what the local attempt had run. */
export interface HandoverEstimate {
  readonly costUsd: HandoverFigure;
  readonly timeSeconds: HandoverFigure;
}

export interface HandoverAssessment {
  readonly taskId: string;
  readonly revision: number | null;
  readonly status: string | null;
  readonly attempt: { readonly attemptId: string; readonly fence: number; readonly runnerId: string | null; readonly location: string; readonly startedAt: string | null } | null;
  /** The approved base: the task revision's base SHA. */
  readonly baseSha: string | null;
  readonly allowedPaths: readonly string[];
  readonly resume: { readonly eligible: boolean; readonly reasons: readonly HandoverIneligible[] };
  /** A restart from the persisted input: in cloud when cloud is allowed for this task, else on a local runner. Never claims to carry the attempt's work. */
  readonly restart: { readonly eligible: boolean; readonly target: 'cloud' | 'local' | null; readonly reasons: readonly HandoverIneligible[] };
  readonly estimate: HandoverEstimate;
}

/** What the runner route passes in: the protocol's validator, run against the revision read under the status lock. */
export type CheckpointCheck =
  | { readonly ok: true; readonly checkpoint: { readonly baseSha: string; readonly patchSha256: string; readonly files: readonly CheckpointFile[]; readonly content: Readonly<Record<string, string>>; readonly diffs?: Readonly<Record<string, CheckpointDiff>> }; readonly exclusions: readonly CheckpointExclusion[]; readonly totalBytes: number }
  | { readonly ok: false; readonly reason: CheckpointRefusal; readonly path?: string };

export interface HandoverRefusal {
  readonly reason: string;
  readonly status: 403 | 404 | 409 | 422;
}

const UNAVAILABLE = (basis: string): HandoverFigure => ({ value: null, provenance: 'unavailable', basis });

const rowKey = (key: TaskKey) => and(eq(schema.checkpoints.tenantId, key.tenantId), eq(schema.checkpoints.projectId, key.projectId), eq(schema.checkpoints.taskId, key.taskId));

/** The handover holding this task revision, if any: `stopping`, `fenced` or `restart_offered`. Read with the task's status row locked. */
export async function openHandover(tx: Executor, key: TaskKey, revision: number): Promise<CheckpointRow | undefined> {
  const rows = await tx.select().from(schema.checkpoints)
    .where(and(rowKey(key), eq(schema.checkpoints.revision, revision), inArray(schema.checkpoints.state, [...OPEN_HANDOVER_STATES]))).limit(1);
  return rows[0];
}

/** Closes this task's open handovers on any revision but `revision`: a row the plan left behind holds nothing, and never blocks a new one. Call with the status row held. */
async function closeStaleRows(tx: Tx, key: TaskKey, revision: number, now: Date): Promise<void> {
  await tx.update(schema.checkpoints).set({ state: 'closed', closedReason: 'stale_revision', content: null, diffs: null, contentDroppedAt: now, contentDroppedReason: 'stale_revision', updatedAt: now })
    .where(and(rowKey(key), ne(schema.checkpoints.revision, revision), inArray(schema.checkpoints.state, [...OPEN_HANDOVER_STATES])));
}

/**
 * Closes the open handovers of the given tasks (all of a run's when `taskIds` is null), with a recorded reason, and drops any stored checkpoint content. For a replan that moved
 * their revision, a run cancel that finished, or a task cancel. Call with the tasks' status rows held (the caller's lock order already has them before this table).
 */
export async function closeHandovers(tx: Tx, scope: { readonly tenantId: string; readonly projectId: string; readonly runId?: string; readonly taskIds?: readonly string[] }, reason: string, now: Date, keepRevision?: ReadonlyMap<string, number>): Promise<number> {
  const rows = await tx.select().from(schema.checkpoints).where(and(
    eq(schema.checkpoints.tenantId, scope.tenantId), eq(schema.checkpoints.projectId, scope.projectId), inArray(schema.checkpoints.state, [...OPEN_HANDOVER_STATES]),
    ...(scope.runId !== undefined ? [eq(schema.checkpoints.runId, scope.runId)] : []), ...(scope.taskIds !== undefined ? [inArray(schema.checkpoints.taskId, scope.taskIds.length > 0 ? [...scope.taskIds] : [''])] : [])));
  let n = 0;
  for (const r of rows) {
    if (keepRevision?.get(r.taskId) === r.revision) continue;
    await setRow(tx, r, { state: 'closed', closedReason: reason, content: null, diffs: null, ...(r.content !== null ? { contentDroppedAt: now, contentDroppedReason: reason } : {}), updatedAt: now });
    n += 1;
  }
  return n;
}

async function loadRow(tx: Executor, key: TaskKey, checkpointId: string): Promise<CheckpointRow | undefined> {
  return (await tx.select().from(schema.checkpoints).where(and(rowKey(key), eq(schema.checkpoints.checkpointId, checkpointId))).limit(1))[0];
}

async function setRow(tx: Tx, row: Pick<CheckpointRow, 'tenantId' | 'projectId' | 'checkpointId'>, patch: Partial<CheckpointRow>): Promise<void> {
  await tx.update(schema.checkpoints).set(patch)
    .where(and(eq(schema.checkpoints.tenantId, row.tenantId), eq(schema.checkpoints.projectId, row.projectId), eq(schema.checkpoints.checkpointId, row.checkpointId)));
}

async function specOf(tx: Executor, key: TaskKey, revision: number): Promise<{ spec: TaskSpec; runId: string } | null> {
  const [r] = await tx.select({ spec: schema.taskRevisions.spec, runId: schema.taskRevisions.runId }).from(schema.taskRevisions)
    .where(and(eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, revision)));
  const parsed = TaskSpecSchema.safeParse(r?.spec);
  return parsed.success ? { spec: parsed.data, runId: r!.runId } : null;
}

const isRestrictedLabel = (c: Classification): boolean => c === 'restricted' || c === 'secret';

/** Whether an enrolled, enabled cloud runner that reports this model has checked in recently. */
async function cloudRunnerFor(tx: Executor, tenantId: string, provider: string | null, model: string | null, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - CLOUD_RUNNER_FRESH_SECONDS * 1000);
  const rows = await tx.select({ runnerId: schema.runners.runnerId, report: schema.runners.harnessReport }).from(schema.runners)
    .where(and(eq(schema.runners.tenantId, tenantId), eq(schema.runners.location, 'cloud'), isNull(schema.runners.revokedAt),
      or(gte(schema.runners.lastSeenAt, since), gte(schema.runners.lastPolledAt, since))));
  for (const r of rows) {
    const can = provider === null || (r.report ?? []).some((h) => h.provider === provider && (model === null || h.models.includes(model)));
    if (!can) continue;
    if ((await loadRunnerGate(tx as Tx, tenantId, r.runnerId)).enabled) return true;
  }
  return false;
}

/**
 * Whether this task's running attempt may continue in cloud, and why not. Read with the scheduler lock and the task's status row held (`requestHandover`), or on its own for a
 * view (`assessHandover`), in which case nothing is locked but the run row's budget position, which is read through `lockBudget` inside a transaction that only reads.
 */
async function assessIn(ctx: SchedulerContext, tx: Tx, key: TaskKey, caps: Caps, lock = true): Promise<HandoverAssessment> {
  const now = ctx.now();
  const [status] = await tx.select().from(schema.taskStatus)
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)));
  const none: HandoverAssessment = {
    taskId: key.taskId, revision: status?.currentRevision ?? null, status: status?.status ?? null, attempt: null, baseSha: null, allowedPaths: [],
    resume: { eligible: false, reasons: ['task_not_running'] }, restart: { eligible: false, target: null, reasons: ['task_not_running'] },
    estimate: { costUsd: UNAVAILABLE('no running attempt'), timeSeconds: UNAVAILABLE('no running attempt') },
  };
  if (!status) return none;
  const loaded = await specOf(tx, key, status.currentRevision);
  if (!loaded) return none;
  const { spec, runId } = loaded;
  const withSpec = { ...none, baseSha: spec.baseSha, allowedPaths: spec.allowedPaths };
  const open = (await tx.select().from(schema.attempts).where(and(
    eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.taskId, key.taskId),
    eq(schema.attempts.revision, status.currentRevision), isNull(schema.attempts.endedAt))))[0];
  // A handover already in hand says so first, whatever the task's status is while it waits for its successor.
  if (await openHandover(tx, key, status.currentRevision)) return { ...withSpec, resume: { eligible: false, reasons: ['handover_open'] }, restart: { eligible: false, target: null, reasons: ['handover_open'] } };
  if (status.status !== 'running' || !open) return withSpec;

  const location = (open.detail as { location?: unknown }).location === 'cloud' ? 'cloud' : 'local';
  const attempt = { attemptId: open.attemptId, fence: open.leaseFence ?? 0, runnerId: open.runner, location, startedAt: open.startedAt?.toISOString() ?? null };
  const common: HandoverIneligible[] = [];
  if (location !== 'local') common.push('attempt_not_local');
  const cancelOpen = (await tx.select({ id: schema.taskCommands.operationId }).from(schema.taskCommands).where(and(
    eq(schema.taskCommands.tenantId, key.tenantId), eq(schema.taskCommands.projectId, key.projectId), eq(schema.taskCommands.taskId, key.taskId),
    eq(schema.taskCommands.command, 'cancel'), eq(schema.taskCommands.state, 'cancel_requested'), eq(schema.taskCommands.revision, status.currentRevision))).limit(1)).length > 0;
  if (cancelOpen) common.push('cancel_pending');

  const [run] = await tx.select({ placement: schema.runs.placement, trial: schema.runs.trial }).from(schema.runs)
    .where(and(eq(schema.runs.tenantId, key.tenantId), eq(schema.runs.projectId, key.projectId), eq(schema.runs.runId, runId)));
  if (run?.trial) common.push('trial_run');

  // The successor reserves its own worst-case hold, on the model this attempt runs. An upper bound, and labelled an estimate.
  const selection = open.modelProvider && open.modelId ? { provider: open.modelProvider, model: open.modelId } : null;
  const hold = selection ? worstCaseHold(toMicros(spec.limits.maxCostUsd), selection, ctx.catalog ?? NO_HARNESS_CATALOG, ctx.policy).amountMicros : toMicros(spec.limits.maxCostUsd);
  const elapsed = open.startedAt ? Math.max(0, Math.round((now.getTime() - open.startedAt.getTime()) / 1000)) : null;
  const estimate: HandoverEstimate = {
    costUsd: hold > 0 ? { value: hold / 1_000_000, provenance: 'estimated', basis: 'the worst-case hold one more attempt reserves: the task\'s cost limit on its model\'s rate' } : UNAVAILABLE('the task has no cost limit to hold against'),
    timeSeconds: elapsed !== null ? { value: elapsed, provenance: 'estimated', basis: 'how long the local attempt has run; a restart repeats that work' } : UNAVAILABLE('the attempt\'s start time is not recorded'),
  };

  // Restricted or secret work stays on the device, whatever placement says: the attempt's own record (decided at claim) and the labels of every source now.
  const resolved = await resolveSources(tx, key, spec);
  const restricted = (open.detail as { terminalStreamable?: unknown }).terminalStreamable !== true || isRestrictedLabel(strongest(resolved.classification, resolved.routeClassification));

  const cloud: HandoverIneligible[] = [];
  if (restricted) cloud.push('restricted_work');
  // A task whose plan pins it to local execution stays local: the owner's choice of location never overrides the plan's.
  else if (spec.execution === 'local') cloud.push('cloud_not_allowed');
  else {
    const limits = resolveLimits(caps);
    const gate = gateFor(await loadRunGates(tx, key.tenantId, [runId]), key.projectId, runId);
    const cfg = runPlacement(ctx, { placement: run?.placement ?? null });
    if (typeof limits === 'string' || cfg === null || 'blocked' in cfg || gate.cloudEligible === false) cloud.push('cloud_not_allowed');
    else {
      // The successor replaces this attempt, so its slot is counted free.
      const counts = await runningCounts(tx, key.tenantId);
      const mine = counts.byRun.get(runId) ?? { local: 0, cloud: 0 };
      const freed = { tenant: { ...counts.tenant, local: Math.max(0, counts.tenant.local - 1) }, byRun: new Map(counts.byRun).set(runId, { ...mine, local: Math.max(0, mine.local - 1) }) };
      const capacity = { ...capacityFor(cfg, limits, freed, runId), rolePlacement: undefined };
      const position = await (lock ? lockBudget : readBudget)(tx, { tenantId: key.tenantId, projectId: key.projectId, runId });
      const placed = place({ ...spec, execution: 'cloud', classification: resolved.classification }, capacity, ctx.policy, {
        sources: resolved.sources, destination: cfg.cloudDestination, estimatedCost: hold, remainingBudget: remainingMicros(position),
      });
      if (isBlocked(placed)) {
        const r = placed.reason;
        cloud.push(r.startsWith('location_disabled') || r.startsWith('missing_limit') || r.startsWith('classification') ? 'cloud_not_allowed'
          : r.includes('destination') ? 'no_cloud_destination' : r.includes('budget') ? 'budget_insufficient' : 'policy_denied');
      }
      if (!checkFits(position, hold).ok && !cloud.includes('budget_insufficient')) cloud.push('budget_insufficient');
      if (cloud.length === 0 && !(await cloudRunnerFor(tx, key.tenantId, open.modelProvider, open.modelId, now))) cloud.push('no_cloud_runner');
    }
  }
  const resumeReasons = [...common, ...cloud];
  const restartTarget = cloud.length === 0 ? 'cloud' : 'local';
  return {
    ...withSpec, attempt, estimate,
    resume: { eligible: resumeReasons.length === 0, reasons: resumeReasons },
    restart: { eligible: common.length === 0, target: common.length === 0 ? restartTarget : null, reasons: common },
  };
}

/** The handover's eligibility, for a view. A plain read: it locks nothing, not even the run row, and writes nothing. */
export async function assessHandover(ctx: SchedulerContext, key: TaskKey, caps: Caps): Promise<HandoverAssessment> {
  return assessIn(ctx, ctx.db as unknown as Tx, key, caps, false);
}

const schedulerLock = (tx: Tx, tenantId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${tenantId}`}, 0))`);

export interface HandoverReceipt {
  readonly checkpointId: string;
  readonly state: HandoverState;
  readonly mode: HandoverMode;
  readonly target: 'cloud' | 'local';
  readonly priorAttemptId: string;
  readonly aggregateRevision: number;
}

/**
 * The owner's request: record the handover and ask the attempt to stop. Nothing is fenced yet and no successor can claim, because the attempt is still open. `tx` joins the
 * caller's transaction (the route's idempotency receipt).
 */
export async function requestHandover(ctx: SchedulerContext, key: TaskKey, req: { readonly mode: HandoverMode; readonly requestedBy: string; readonly caps?: Caps }, tx?: Tx): Promise<Result<HandoverReceipt, HandoverRefusal>> {
  const run = async (t: Tx): Promise<Result<HandoverReceipt, HandoverRefusal>> => {
    await schedulerLock(t, key.tenantId);
    const statusRow = await lockStatusRow(t, key);
    if (!statusRow) return err({ reason: 'task_not_found', status: 404 });
    // A row a replan left open on an earlier revision holds nothing: it is closed here, so it can never collide with this one.
    await closeStaleRows(t, key, statusRow.currentRevision, ctx.now());
    const a = await assessIn(ctx, t, key, req.caps ?? {});
    const verdict = req.mode === 'resume' ? a.resume : a.restart;
    if (!verdict.eligible || a.attempt === null) return err({ reason: verdict.reasons[0] ?? 'task_not_running', status: 403 });
    const target = req.mode === 'resume' ? 'cloud' : a.restart.target!;
    const now = ctx.now();
    const checkpointId = `ckpt_${randomUUID()}`;
    const loaded = (await specOf(t, key, statusRow.currentRevision))!;
    // One open handover per task is the index's rule too: a collision is that rule, never a server error.
    const inserted = await t.insert(schema.checkpoints).values({
      tenantId: key.tenantId, projectId: key.projectId, checkpointId, taskId: key.taskId, revision: statusRow.currentRevision, runId: loaded.runId,
      mode: req.mode, state: 'stopping', target, priorAttemptId: a.attempt.attemptId, priorFence: a.attempt.fence, priorRunnerId: a.attempt.runnerId,
      baseSha: loaded.spec.baseSha, estimate: a.estimate as unknown as Record<string, unknown>, requestedBy: req.requestedBy, requestedAt: now, updatedAt: now,
    }).onConflictDoNothing().returning({ id: schema.checkpoints.checkpointId });
    if (inserted.length === 0) return err({ reason: 'handover_open', status: 409 });
    // The stop goes through the cancel request the runner already reads on its heartbeat; the reason says it is a handover, so the attempt ends interrupted, not cancelled.
    await t.insert(schema.taskCommands).values({
      tenantId: key.tenantId, projectId: key.projectId, operationId: `op_${randomUUID()}`, taskId: key.taskId, revision: statusRow.currentRevision,
      command: 'cancel', state: 'cancel_requested', requestedBy: req.requestedBy, requestedAt: now, detail: { reason: `${HANDOVER_STOP_PREFIX}${checkpointId}`, attemptIds: [a.attempt.attemptId] },
    });
    // The status is unchanged; the revision moves so a client following snapshot + cursor learns of the request.
    const aggregateRevision = await setStatus(t, key, statusRow.rowRevision, statusRow.status as TaskState['status'], now);
    await emit(t, { projectId: key.projectId, runId: loaded.runId, taskId: key.taskId, aggregateRevision }, now, {
      type: 'handover.requested', attemptId: a.attempt.attemptId, actor: { kind: 'human', id: req.requestedBy },
      payload: { checkpointId, mode: req.mode, target, priorAttemptId: a.attempt.attemptId, priorFence: a.attempt.fence, baseSha: loaded.spec.baseSha },
    });
    return ok({ checkpointId, state: 'stopping', mode: req.mode, target, priorAttemptId: a.attempt.attemptId, aggregateRevision });
  };
  return tx ? run(tx) : withTx(ctx.db, run);
}

/** The handover a heartbeat names: a stop that is a handover, and whether the runner should send a checkpoint. */
export async function handoverStopFor(tx: Executor, key: TaskKey, revision: number, attemptId: string): Promise<{ readonly checkpointId: string; readonly mode: HandoverMode } | null> {
  const rows = await tx.select({ checkpointId: schema.checkpoints.checkpointId, mode: schema.checkpoints.mode }).from(schema.checkpoints)
    .where(and(rowKey(key), eq(schema.checkpoints.revision, revision), eq(schema.checkpoints.priorAttemptId, attemptId), eq(schema.checkpoints.state, 'stopping'))).limit(1);
  return rows[0] ? { checkpointId: rows[0].checkpointId, mode: rows[0].mode as HandoverMode } : null;
}

export interface CheckpointReceipt {
  readonly checkpointId: string;
  readonly patchSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly excluded: number;
}

/**
 * The prior attempt's checkpoint, from the runner holding its current lease. The lease is checked under the status lock, so a checkpoint after the fence is refused (stale
 * fence). A refusal is recorded on the handover row with its reason and no content; the fence then offers a restart.
 */
export async function recordCheckpoint(ctx: SchedulerContext, lease: Lease, check: (task: { readonly baseSha: string; readonly allowedPaths: readonly string[] }) => CheckpointCheck): Promise<Result<CheckpointReceipt, HandoverRefusal>> {
  return withTx(ctx.db, async (tx) => {
    const statusRow = await lockStatusRow(tx, lease);
    const now = ctx.now();
    const [a] = await tx.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, lease.tenantId), eq(schema.attempts.projectId, lease.projectId), eq(schema.attempts.attemptId, lease.attemptId)));
    if (!statusRow || !a || a.taskId !== lease.taskId || a.leaseFence !== lease.fence || a.leaseToken !== lease.leaseToken || a.endedAt !== null
      || a.leaseExpiresAt === null || a.leaseExpiresAt.getTime() <= now.getTime() || statusRow.status !== 'running' || statusRow.currentRevision !== a.revision) {
      return err({ reason: 'stale_fence', status: 409 });
    }
    const row = (await tx.select().from(schema.checkpoints).where(and(rowKey(lease), eq(schema.checkpoints.priorAttemptId, a.attemptId), eq(schema.checkpoints.state, 'stopping'))).limit(1))[0];
    if (!row) return err({ reason: 'no_handover', status: 409 });
    if (row.mode !== 'resume') return err({ reason: 'restart_needs_no_checkpoint', status: 409 });
    // Restricted output stays on the device: no checkpoint of restricted work is ever read, whatever a runner sends. Recorded by code only.
    if ((a.detail as { terminalStreamable?: unknown }).terminalStreamable !== true) {
      await setRow(tx, row, { refusal: 'restricted_work', updatedAt: now });
      return err({ reason: 'restricted_work', status: 403 });
    }
    const loaded = await specOf(tx, lease, a.revision);
    if (!loaded) return err({ reason: 'stale_fence', status: 409 });
    // The labels as they stand now, as eligibility reads them: a source reclassified to restricted since the request refuses the checkpoint, and nothing of it is kept.
    const labels = await resolveSources(tx, lease, loaded.spec);
    if (isRestrictedLabel(strongest(labels.classification, labels.routeClassification))) {
      await setRow(tx, row, { refusal: 'restricted_work', content: null, diffs: null, files: null, patchSha256: null, updatedAt: now });
      return err({ reason: 'restricted_work', status: 403 });
    }
    const verdict = check({ baseSha: row.baseSha, allowedPaths: loaded.spec.allowedPaths });
    if (!verdict.ok) {
      await setRow(tx, row, { refusal: verdict.reason, content: null, diffs: null, files: null, patchSha256: null, updatedAt: now });
      return err({ reason: verdict.reason, status: 422 });
    }
    const c = verdict.checkpoint;
    await setRow(tx, row, {
      patchSha256: c.patchSha256, fileCount: c.files.length, totalBytes: verdict.totalBytes, files: c.files as unknown as Record<string, unknown>[],
      exclusions: verdict.exclusions as unknown as Record<string, unknown>[], content: { ...c.content }, diffs: { ...(c.diffs ?? {}) } as Record<string, unknown>, refusal: null, capturedAt: now, updatedAt: now,
    });
    await emit(tx, { projectId: lease.projectId, runId: loaded.runId, taskId: lease.taskId, aggregateRevision: statusRow.rowRevision }, now, {
      type: 'checkpoint.recorded', attemptId: a.attemptId, actor: SCHEDULER_ACTOR,
      payload: { checkpointId: row.checkpointId, patchSha256: c.patchSha256, fileCount: c.files.length, totalBytes: verdict.totalBytes, excluded: verdict.exclusions.length, baseSha: c.baseSha },
    });
    return ok({ checkpointId: row.checkpointId, patchSha256: c.patchSha256, fileCount: c.files.length, totalBytes: verdict.totalBytes, excluded: verdict.exclusions.length });
  });
}

/**
 * The fence, from `confirmCancel` once the prior attempt has ended (its publish or its lease expiry closed the lease). Revokes the lease, reserves the next fence and moves the
 * task back to `ready`, held for a cloud runner (`fenced`) or for the owner's choice (`restart_offered`). The caller holds the status row and has settled the run row.
 */
export async function fenceHandover(tx: Tx, key: TaskKey, state: TaskState, rowRevision: number, scope: Omit<EventScope, 'aggregateRevision'>, now: Date, attemptId: string | null, cause: Record<string, unknown>, stopReason: string): Promise<{ readonly aggregateRevision: number; readonly status: TaskState['status'] }> {
  const checkpointId = stopReason.slice(HANDOVER_STOP_PREFIX.length);
  const row = await loadRow(tx, key, checkpointId);
  const blocked = transition(state, { type: 'blocked', reason: 'handover' });
  const back = blocked.ok ? transition(blocked.value, { type: 'unblocked' }) : blocked;
  if (!back.ok) throw new Error(`illegal handover transition: ${JSON.stringify(back.error)}`);
  const aggregateRevision = await setStatus(tx, key, rowRevision, back.value.status, now);
  await tx.update(schema.taskCommands).set({ state: 'applied' }).where(and(
    eq(schema.taskCommands.tenantId, key.tenantId), eq(schema.taskCommands.projectId, key.projectId), eq(schema.taskCommands.taskId, key.taskId),
    eq(schema.taskCommands.command, 'cancel'), eq(schema.taskCommands.state, 'cancel_requested'), eq(schema.taskCommands.revision, state.revision)));
  const at: EventScope = { ...scope, aggregateRevision };
  if (attemptId !== null) {
    // Revoked: its expiry is now, whatever its last heartbeat earned. Its fence and token stay on the row, so a late publish is recognised and refused by the lease check.
    await tx.update(schema.attempts).set({ leaseExpiresAt: now })
      .where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.attemptId, attemptId)));
  }
  await emit(tx, at, now, { type: 'attempt.failed', attemptId, actor: SYSTEM_ACTOR, payload: { reason: 'handover', outcome: 'interrupted', ...cause } });
  if (!row || row.state !== 'stopping') {
    await emit(tx, at, now, { type: 'task.ready', attemptId, actor: SCHEDULER_ACTOR, payload: { reason: 'handover' } });
    return { aggregateRevision, status: back.value.status };
  }
  const resumable = row.mode === 'restart' || (row.patchSha256 !== null && row.refusal === null);
  // A checked checkpoint waits for the owner's review; only the release lets a successor claim. A restart carries nothing to review.
  const next: HandoverState = !resumable ? 'restart_offered' : row.mode === 'resume' ? 'awaiting_review' : 'fenced';
  const refusal = resumable ? null : (row.refusal ?? 'no_checkpoint');
  await setRow(tx, row, { state: next, refusal, nextFence: row.priorFence + 1, fencedAt: now, updatedAt: now });
  await emit(tx, at, now, {
    type: 'attempt.fenced', attemptId, actor: SYSTEM_ACTOR,
    payload: { checkpointId: row.checkpointId, priorAttemptId: row.priorAttemptId, priorFence: row.priorFence, nextFence: row.priorFence + 1, cause: typeof cause['cause'] === 'string' ? cause['cause'] : 'acknowledged' },
  });
  await emit(tx, at, now, { type: 'task.ready', attemptId, actor: SCHEDULER_ACTOR, payload: { reason: 'handover' } });
  if (!resumable) await emit(tx, at, now, { type: 'checkpoint.refused', attemptId, actor: SYSTEM_ACTOR, payload: { checkpointId: row.checkpointId, reason: refusal, restart: row.estimate } });
  return { aggregateRevision, status: back.value.status };
}

/** The handover a claim honours, and what it says about where and how the task may start. */
export type ClaimHold =
  | { readonly kind: 'none' }
  | { readonly kind: 'wait'; readonly reason: string }
  | { readonly kind: 'start'; readonly row: CheckpointRow };

export async function claimHold(tx: Tx, key: TaskKey, revision: number, location: 'local' | 'cloud'): Promise<ClaimHold> {
  const row = await openHandover(tx, key, revision);
  if (!row) return { kind: 'none' };
  // Each wait a runner meets is said on the task (`recordBlock`, once per reason), so a runner skipped by the hold is never silent.
  if (row.state === 'stopping') return { kind: 'wait', reason: 'handover_stopping' };
  if (row.state === 'awaiting_review') return { kind: 'wait', reason: 'handover_awaiting_review' };
  if (row.state === 'restart_offered') return { kind: 'wait', reason: 'handover_decision_pending' };
  // A successor holds it, or is being replaced: the row moves on in the same transaction that ends it, so this is never a gap a local runner could fall through.
  if (row.state === 'starting' || row.state === 'running') return { kind: 'wait', reason: 'handover_successor_active' };
  if (row.target !== location) return { kind: 'wait', reason: `handover_held_for_${row.target}` };
  return { kind: 'start', row };
}

/** The waits a claim records on the task, so the owner sees why it does not start. */
export const VISIBLE_HOLDS: readonly string[] = ['handover_awaiting_review', 'handover_decision_pending', 'handover_held_for_cloud', 'handover_held_for_local'];

/**
 * A fenced handover whose placement now refuses it for good (no cloud slot, a policy denial, a classification): offered back to the owner with the reason. Called inside the
 * claim, with the status row held.
 */
export async function placementRefused(tx: Tx, row: CheckpointRow, reason: string, scope: EventScope, now: Date): Promise<void> {
  const code = reason.startsWith('location_disabled') || reason.startsWith('missing_limit') || reason.startsWith('classification') ? 'cloud_not_allowed' : reason.startsWith('budget:') ? 'budget_insufficient' : 'placement_blocked';
  await offerRestart(tx, row, code, scope, now, null);
}

async function offerRestart(tx: Tx, row: CheckpointRow, code: string, scope: EventScope, now: Date, attemptId: string | null): Promise<void> {
  await setRow(tx, row, { state: 'restart_offered', refusal: code, successorAttemptId: null, successorFence: null, updatedAt: now });
  await emit(tx, scope, now, { type: 'checkpoint.refused', attemptId, actor: SYSTEM_ACTOR, payload: { checkpointId: row.checkpointId, reason: code, restart: row.estimate } });
}

/** What the successor's lease says about its start. Ids and hashes only. */
export interface LeaseHandover {
  readonly checkpointId: string;
  readonly mode: HandoverMode;
  readonly priorAttemptId: string;
  readonly baseSha: string;
  readonly patchSha256: string | null;
  readonly fileCount: number | null;
}

/** Records the successor on the handover row and the route change, in the claim's transaction, after its attempt row and `attempt.started`. */
export async function startSuccessor(tx: Tx, row: CheckpointRow, scope: EventScope, now: Date, successor: { readonly attemptId: string; readonly fence: number; readonly location: 'local' | 'cloud'; readonly runnerId: string }): Promise<LeaseHandover> {
  if (row.nextFence !== null && successor.fence < row.nextFence) throw new Error(`successor fence ${successor.fence} is below the reserved ${row.nextFence}`);
  await setRow(tx, row, { state: 'starting', successorAttemptId: successor.attemptId, successorFence: successor.fence, updatedAt: now });
  await emit(tx, scope, now, {
    type: 'attempt.route_changed', attemptId: successor.attemptId, actor: SCHEDULER_ACTOR,
    payload: { checkpointId: row.checkpointId, mode: row.mode, fromAttemptId: row.priorAttemptId, toAttemptId: successor.attemptId, from: 'local', to: successor.location, priorFence: row.priorFence, fence: successor.fence, runnerId: successor.runnerId },
  });
  const resume = row.mode === 'resume';
  return { checkpointId: row.checkpointId, mode: row.mode as HandoverMode, priorAttemptId: row.priorAttemptId, baseSha: row.baseSha, patchSha256: resume ? row.patchSha256 : null, fileCount: resume ? row.fileCount : null };
}

/** The successor's worker started (its setup-complete heartbeat): the handover reads Running. Called with the status row held. */
export async function markSuccessorRunning(tx: Tx, key: TaskKey, attemptId: string, now: Date): Promise<void> {
  // The successor has applied its own copy and checked it: the stored one is dropped, with when and why.
  await tx.update(schema.checkpoints).set({ state: 'running', content: null, diffs: null, contentDroppedAt: now, contentDroppedReason: 'successor_running', updatedAt: now })
    .where(and(rowKey(key), eq(schema.checkpoints.successorAttemptId, attemptId), eq(schema.checkpoints.state, 'starting')));
}

/** Refusal codes a successor may report, which turn its handover straight into a restart offer: the same checkpoint would fail the same way. */
const SUCCESSOR_REFUSALS = new Set<string>(['checkpoint_tampered', 'checkpoint_apply_failed', 'checkpoint_hash_mismatch', 'no_checkpoint']);

/**
 * A successor's attempt ended (`closeLease`, inside its publish or its lease expiry, with the status row held and the run row settled). Lost before its worker started (lease
 * expiry or a setup failure): offered again to the target location at a new fence, up to `SUCCESSOR_RETRY_LIMIT` times, then to the owner. Lost after it started: its stored copy
 * was dropped, so the owner is asked. A checkpoint it could not apply: the owner is asked at once. Any other end (completed, failed, cancelled, a stop): the handover closes.
 * It never falls back to a local claim from the base: that is the owner's choice.
 */
export async function successorEnded(tx: Tx, key: TaskKey, attemptId: string, outcome: string, exitReason: string, now: Date): Promise<void> {
  const [row] = await tx.select().from(schema.checkpoints).where(and(rowKey(key), eq(schema.checkpoints.successorAttemptId, attemptId), inArray(schema.checkpoints.state, ['starting', 'running']))).limit(1);
  if (!row) return;
  const [status] = await tx.select({ rowRevision: schema.taskStatus.rowRevision }).from(schema.taskStatus)
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)));
  const scope: EventScope = { projectId: key.projectId, runId: row.runId, taskId: key.taskId, aggregateRevision: status?.rowRevision ?? 0 };
  const infra = exitReason.startsWith(INFRA_PREFIX);
  const lost = outcome === 'interrupted' && (exitReason === 'lease_expired' || infra);
  if (!lost) {
    const reason = outcome === 'succeeded' || outcome === 'running' ? 'successor_completed' : outcome === 'failed' ? 'successor_failed' : 'successor_ended';
    await setRow(tx, row, { state: 'closed', closedReason: reason, content: null, diffs: null, ...(row.content !== null ? { contentDroppedAt: now, contentDroppedReason: reason } : {}), updatedAt: now });
    return;
  }
  const code = (infra ? exitReason.slice(INFRA_PREFIX.length) : exitReason).split(':')[0]!.trim();
  if (SUCCESSOR_REFUSALS.has(code)) return offerRestart(tx, row, code === 'checkpoint_hash_mismatch' ? 'checkpoint_tampered' : code, scope, now, attemptId);
  if (row.state === 'running' || (row.mode === 'resume' && row.content === null)) return offerRestart(tx, row, 'successor_lost', scope, now, attemptId);
  if (row.successorRetries >= SUCCESSOR_RETRY_LIMIT) return offerRestart(tx, row, 'successor_failed', scope, now, attemptId);
  const fence = (row.successorFence ?? row.priorFence) + 1;
  await setRow(tx, row, { state: 'fenced', successorRetries: row.successorRetries + 1, successorAttemptId: null, successorFence: null, nextFence: fence, updatedAt: now });
  await emit(tx, scope, now, { type: 'attempt.fenced', attemptId, actor: SYSTEM_ACTOR, payload: { checkpointId: row.checkpointId, priorAttemptId: attemptId, priorFence: row.successorFence, nextFence: fence, cause: 'successor_lost', retry: row.successorRetries + 1 } });
}

const INFRA_PREFIX = 'infrastructure:';

/** A publish refused because its attempt was fenced by a handover: counted on the row, and recorded once as an event. Called with the status row held. */
export async function recordLatePublish(tx: Tx, key: TaskKey, attempt: AttemptRow, fence: number, now: Date): Promise<void> {
  if (attempt.endedAt === null || !isHandoverReason(attempt.exitReason)) return;
  const [row] = await tx.select().from(schema.checkpoints).where(and(rowKey(key), eq(schema.checkpoints.priorAttemptId, attempt.attemptId))).limit(1);
  if (!row) return;
  await setRow(tx, row, { latePublishes: row.latePublishes + 1, updatedAt: now });
  if (row.latePublishes > 0) return;
  const [status] = await tx.select({ rowRevision: schema.taskStatus.rowRevision }).from(schema.taskStatus)
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)));
  await emit(tx, { projectId: key.projectId, runId: row.runId, taskId: key.taskId, aggregateRevision: status?.rowRevision ?? 0 }, now, {
    type: 'attempt.publish_refused', attemptId: attempt.attemptId, actor: SCHEDULER_ACTOR, payload: { checkpointId: row.checkpointId, fence, reason: 'stale_fence' },
  });
}

/** Task statuses after which a handover's answer means nothing. */
const TERMINAL_TASK = ['cancelled', 'superseded', 'merged', 'verified', 'failed'];

/** Which owner answers each state takes. */
const CHOICES: Readonly<Record<string, readonly HandoverState[]>> = {
  release: ['awaiting_review'],
  restart: ['awaiting_review', 'restart_offered'],
  decline: ['awaiting_review', 'fenced', 'restart_offered'],
};

/**
 * The owner's answer. `release`: a reviewed checkpoint may now be claimed at the target location. `restart`: start from the persisted input instead; nothing of the prior
 * attempt is carried. `decline`: keep the task where policy places it; the hold is released and the checkpoint discarded. A row on another revision, or of a task that has
 * ended, is refused (409): its answer would change nothing true.
 */
export async function decideHandover(ctx: SchedulerContext, key: TaskKey, checkpointId: string, choice: 'release' | 'restart' | 'decline', by: string, tx?: Tx): Promise<Result<{ readonly checkpointId: string; readonly state: HandoverState; readonly mode: HandoverMode; readonly aggregateRevision: number }, HandoverRefusal>> {
  const run = async (t: Tx) => {
    await schedulerLock(t, key.tenantId);
    const statusRow = await lockStatusRow(t, key);
    if (!statusRow) return err<HandoverRefusal>({ reason: 'task_not_found', status: 404 });
    const row = await loadRow(t, key, checkpointId);
    if (!row) return err<HandoverRefusal>({ reason: 'handover_not_found', status: 404 });
    if (row.revision !== statusRow.currentRevision || TERMINAL_TASK.includes(statusRow.status)) return err<HandoverRefusal>({ reason: 'handover_stale', status: 409 });
    if (!(CHOICES[choice] ?? []).includes(row.state as HandoverState)) return err<HandoverRefusal>({ reason: choice === 'release' ? 'nothing_to_release' : 'no_restart_offered', status: 409 });
    const now = ctx.now();
    const state: HandoverState = choice === 'decline' ? 'declined' : 'fenced';
    const mode: HandoverMode = choice === 'restart' ? 'restart' : (row.mode as HandoverMode);
    const drop = choice === 'release' ? null : choice === 'restart' ? 'restart_chosen' : 'declined';
    await setRow(t, row, {
      state, mode, decidedAt: now, decidedBy: by, updatedAt: now,
      ...(choice === 'release' ? { releasedAt: now, releasedBy: by } : {}),
      ...(drop !== null ? { content: null, diffs: null, ...(row.content !== null ? { contentDroppedAt: now, contentDroppedReason: drop } : {}) } : {}),
      ...(choice === 'decline' ? { closedReason: 'declined' } : {}),
    });
    // The wait the hold put on the task goes with it: a released or restarted handover says its own wait on the next poll, a declined one none.
    const held = statusRow.placementBlock !== null && statusRow.placementBlock.startsWith('handover_');
    if (held) await t.update(schema.taskStatus).set({ placementBlock: null }).where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)));
    const aggregateRevision = await setStatus(t, key, statusRow.rowRevision, statusRow.status as TaskState['status'], now);
    const scope = { projectId: key.projectId, runId: row.runId, taskId: key.taskId, aggregateRevision };
    await emit(t, scope, now, { type: 'handover.decided', attemptId: null, actor: { kind: 'human', id: by }, payload: { checkpointId, choice, target: row.target } });
    if (held) await emit(t, scope, now, { type: 'placement.cleared', attemptId: null, actor: SCHEDULER_ACTOR, payload: { reason: statusRow.placementBlock, by } });
    return ok({ checkpointId, state, mode, aggregateRevision });
  };
  return tx ? run(tx) : withTx(ctx.db, run);
}

/**
 * The fenced handovers that can no longer run where they were sent, offered back to the owner with the reason: no enabled cloud runner seen within the threshold, cloud taken
 * away from the run, or a budget that no longer holds the estimate. A row is judged only after the same threshold since it became fenced, so a runner between polls is not
 * mistaken for a lost one. Each row in its own transaction: the task's status row, then (read only) the run row, then this row and the event sequence. Returns the rows moved.
 */
export async function reviewHandovers(ctx: SchedulerContext, caps: Caps, now: Date): Promise<readonly string[]> {
  const since = new Date(now.getTime() - CLOUD_RUNNER_FRESH_SECONDS * 1000);
  const due = await ctx.db.select({ tenantId: schema.checkpoints.tenantId, projectId: schema.checkpoints.projectId, taskId: schema.checkpoints.taskId, checkpointId: schema.checkpoints.checkpointId })
    .from(schema.checkpoints).where(and(eq(schema.checkpoints.state, 'fenced'), eq(schema.checkpoints.target, 'cloud'), lte(schema.checkpoints.updatedAt, since)));
  const moved: string[] = [];
  for (const d of due) {
    const done = await withTx(ctx.db, async (tx) => {
      const key: TaskKey = { tenantId: d.tenantId, projectId: d.projectId, taskId: d.taskId };
      const statusRow = await lockStatusRow(tx, key);
      const row = await loadRow(tx, key, d.checkpointId);
      if (!statusRow || !row || row.state !== 'fenced' || row.updatedAt.getTime() > since.getTime()) return false;
      const loaded = await specOf(tx, key, row.revision);
      if (!loaded) return false;
      const [prior] = await tx.select({ provider: schema.attempts.modelProvider, model: schema.attempts.modelId }).from(schema.attempts)
        .where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.attemptId, row.priorAttemptId)));
      const gate = gateFor(await loadRunGates(tx, key.tenantId, [loaded.runId]), key.projectId, loaded.runId);
      const [run] = await tx.select({ placement: schema.runs.placement }).from(schema.runs).where(and(eq(schema.runs.tenantId, key.tenantId), eq(schema.runs.projectId, key.projectId), eq(schema.runs.runId, loaded.runId)));
      const cfg = runPlacement(ctx, { placement: run?.placement ?? null });
      const limits = resolveLimits(caps);
      const position = await readBudget(tx, { tenantId: key.tenantId, projectId: key.projectId, runId: loaded.runId });
      const hold = (row.estimate as { costUsd?: { value?: unknown } }).costUsd?.value;
      const reason = gate.cloudEligible === false || cfg === null || 'blocked' in cfg || typeof limits === 'string' || cfg.mode.cloudSlots === 0 ? 'cloud_not_allowed'
        : typeof hold === 'number' && !checkFits(position, toMicros(hold)).ok ? 'budget_insufficient'
        : !(await cloudRunnerFor(tx, key.tenantId, prior?.provider ?? null, prior?.model ?? null, now)) ? 'no_cloud_runner'
        : null;
      if (reason === null) return false;
      await offerRestart(tx, row, reason, { projectId: key.projectId, runId: row.runId, taskId: key.taskId, aggregateRevision: statusRow.rowRevision }, now, null);
      return true;
    });
    if (done) moved.push(d.checkpointId);
  }
  return moved;
}

/** Every stored file still hashes to its recorded sha256, and the file list still gives the recorded patch hash. */
function storedIntact(c: { readonly baseSha: string; readonly patchSha256: string; readonly files: readonly CheckpointFile[]; readonly content: Readonly<Record<string, string>> }): boolean {
  for (const f of c.files) {
    if (f.status === 'deleted') continue;
    const b64 = c.content[f.path];
    if (b64 === undefined || f.sha256 === null || createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex') !== f.sha256) return false;
  }
  return checkpointDigest(c.baseSha, c.files) === c.patchSha256;
}

/** The checkpoint a successor's lease names, with its bytes, after checking every stored hash again. A row changed after it was checked is refused, never served. */
export async function successorCheckpoint(ctx: SchedulerContext, lease: Lease): Promise<Result<{ readonly checkpointId: string; readonly baseSha: string; readonly patchSha256: string; readonly files: readonly (CheckpointFile & { readonly content: string | null })[] }, HandoverRefusal>> {
  const now = ctx.now();
  const [a] = await ctx.db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, lease.tenantId), eq(schema.attempts.projectId, lease.projectId), eq(schema.attempts.attemptId, lease.attemptId)));
  if (!a || a.leaseFence !== lease.fence || a.leaseToken !== lease.leaseToken || a.endedAt !== null || a.leaseExpiresAt === null || a.leaseExpiresAt.getTime() <= now.getTime()) return err({ reason: 'stale_fence', status: 409 });
  const [row] = await ctx.db.select().from(schema.checkpoints).where(and(rowKey(lease), eq(schema.checkpoints.successorAttemptId, a.attemptId))).limit(1);
  if (!row || row.mode !== 'resume' || row.patchSha256 === null || row.files === null || row.content === null) return err({ reason: 'no_checkpoint', status: 404 });
  const files = row.files as unknown as CheckpointFile[];
  const content = row.content;
  const stored = { baseSha: row.baseSha, patchSha256: row.patchSha256, files, content };
  if (!storedIntact(stored)) return err({ reason: 'checkpoint_tampered', status: 409 });
  return ok({ checkpointId: row.checkpointId, baseSha: row.baseSha, patchSha256: row.patchSha256, files: files.map((f) => ({ ...f, content: f.status === 'deleted' ? null : content[f.path] ?? null })) });
}
