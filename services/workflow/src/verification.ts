import { TaskSpecSchema, transition, type Actor, type TaskState, type TaskStatus } from '@selarikru/domain';
import { schema, withTx, type Db, type Tx } from '@selarikru/persistence';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { emit, SCHEDULER_ACTOR, type EventScope } from './events.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus, type TaskKey } from './taskstate.ts';

export type VerificationVerdict = 'passed' | 'failed' | 'error' | 'skipped';

export interface VerificationApplication {
  /** True when the task changed state. False for a non-verdict (`error`, `skipped`) and for a task that is no longer `verifying`. */
  readonly applied: boolean;
  readonly taskStatus: string;
  readonly reason: string;
  readonly repair?: 'scheduled' | 'refused';
}

/** Releases every claim a task revision still holds. Claims are held through verification and released on its outcome. */
export async function releaseTaskClaims(tx: Tx, key: TaskKey, revision: number, now: Date): Promise<void> {
  await tx.update(schema.resourceClaims).set({ releasedAt: now }).where(and(
    eq(schema.resourceClaims.tenantId, key.tenantId), eq(schema.resourceClaims.projectId, key.projectId), eq(schema.resourceClaims.taskId, key.taskId),
    eq(schema.resourceClaims.revision, revision), isNull(schema.resourceClaims.releasedAt)));
}

/**
 * Applies a verifier verdict to one task in the caller's transaction (or its own).
 *
 * Only a real `verifier` principal may call this; the event allowlist enforces it again at emission. A task that is no longer
 * `verifying` (cancelled, superseded, ...) keeps its state: the late verdict is history only. `error` and `skipped` are not
 * verdicts: the task stays `verifying` with its claims held until the verification driver's reaper closes it (`closeVerificationWithoutVerdict`).
 *
 * passed -> `verified`, claims released. (Readiness of the run is decided by `markRunReadyForReview`, which needs live evidence.)
 * failed -> `failed`, claims released, then a bounded repair through the retry transition (`ready`), or `blocked` when the
 *           attempt budget is spent. The trusted suite is never touched.
 */
export async function applyVerification(
  ctx: { readonly db: Db; readonly now: () => Date }, key: TaskKey,
  input: {
    readonly actor: Actor; readonly outcome: VerificationVerdict; readonly detail: Record<string, unknown>;
    /** The revision and attempt the verified candidate part carried. A verdict on anything else is stale and changes nothing. */
    readonly expect?: { readonly revision: number; readonly attemptId: string };
  }, tx?: Tx,
): Promise<VerificationApplication> {
  if (input.actor.kind !== 'verifier') throw new Error('only the verifier identity may apply a verification outcome');
  const run = async (t: Tx): Promise<VerificationApplication> => {
    const row = await lockStatusRow(t, key);
    if (!row) return { applied: false, taskStatus: 'unknown', reason: 'task_not_found' };
    if (row.status !== 'verifying') return { applied: false, taskStatus: row.status, reason: 'not_verifying' };
    if (input.expect) {
      const latest = (await loadAttempts(t, key, row.currentRevision)).at(-1);
      if (row.currentRevision !== input.expect.revision || latest?.attemptId !== input.expect.attemptId) return { applied: false, taskStatus: row.status, reason: 'stale_candidate' };
    }
    if (input.outcome === 'error' || input.outcome === 'skipped') return { applied: false, taskStatus: row.status, reason: `no_verdict:${input.outcome}` };

    const revisions = await t.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions).where(and(
      eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, row.currentRevision)));
    const spec = TaskSpecSchema.parse(revisions[0]!.spec);
    const attempts = await loadAttempts(t, key, row.currentRevision);
    const initial = buildTaskState(spec, row.status as TaskStatus, attempts);
    if (!initial) throw new Error(`task ${key.taskId}: stored spec no longer valid`);
    const attemptId = attempts[attempts.length - 1]?.attemptId ?? null;
    const now = ctx.now();
    const move = (state: TaskState, event: Parameters<typeof transition>[1]): TaskState => {
      const r = transition(state, event);
      if (!r.ok) throw new Error(`illegal verification transition: ${JSON.stringify(r.error)}`);
      return r.value;
    };

    let state: TaskState;
    let repair: 'scheduled' | 'refused' | undefined;
    let follow: { type: 'task.ready' | 'task.blocked'; reason: string } | undefined;
    if (input.outcome === 'passed') {
      state = move(initial, { type: 'verification_passed' });
    } else {
      const failed = move(initial, { type: 'verification_failed', reason: 'verification_failed' });
      const retry = transition(failed, { type: 'retry_requested' });
      if (retry.ok) { state = retry.value; repair = 'scheduled'; follow = { type: 'task.ready', reason: 'repair_scheduled' }; }
      else { state = move(failed, { type: 'repair_refused', reason: 'repair_budget_exhausted' }); repair = 'refused'; follow = { type: 'task.blocked', reason: 'repair_budget_exhausted' }; }
    }

    // The attempt that was verified gets its real outcome (it stayed `running` while it waited for the verdict).
    for (const rec of state.attempts) {
      const stored = attempts.find((a) => a.attemptId === rec.attemptId);
      if (stored && stored.outcome !== rec.outcome) {
        await t.update(schema.attempts).set({ outcome: rec.outcome }).where(and(
          eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.attemptId, rec.attemptId)));
      }
    }
    await releaseTaskClaims(t, key, row.currentRevision, now);
    const aggregateRevision = await setStatus(t, key, row.rowRevision, state.status, now);
    const scope: EventScope = { projectId: key.projectId, runId: spec.runId, taskId: key.taskId, aggregateRevision };
    await emit(t, scope, now, {
      type: input.outcome === 'passed' ? 'verification.passed' : 'verification.failed', attemptId, actor: input.actor, payload: { ...input.detail },
    });
    if (follow) await emit(t, scope, now, { type: follow.type, attemptId, actor: SCHEDULER_ACTOR, payload: { reason: follow.reason } });
    return { applied: true, taskStatus: state.status, reason: input.outcome, ...(repair ? { repair } : {}) };
  };
  return tx ? run(tx) : withTx(ctx.db, run);
}

/**
 * Closes a task whose candidate got no verdict (`error`, `skipped`): it stops at `blocked` with its claims released, so nothing waits on it forever.
 * The attempt ends `interrupted`, so no repair is spent. The caller holds the candidate lock and passes the part's revision and attempt: a task that
 * moved on is left alone. Returns whether this task was closed.
 */
export async function closeVerificationWithoutVerdict(
  ctx: { readonly now: () => Date }, tx: Tx, key: TaskKey,
  input: { readonly reason: string; readonly candidateSha?: string; readonly expect: { readonly revision: number; readonly attemptId: string } },
): Promise<boolean> {
  const row = await lockStatusRow(tx, key);
  if (!row || row.status !== 'verifying' || row.currentRevision !== input.expect.revision) return false;
  const attempts = await loadAttempts(tx, key, row.currentRevision);
  if (attempts.at(-1)?.attemptId !== input.expect.attemptId) return false;
  const revisions = await tx.select({ spec: schema.taskRevisions.spec, runId: schema.taskRevisions.runId }).from(schema.taskRevisions).where(and(
    eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId), eq(schema.taskRevisions.revision, row.currentRevision)));
  const spec = TaskSpecSchema.parse(revisions[0]!.spec);
  const state = buildTaskState(spec, 'verifying', attempts);
  if (!state) throw new Error(`task ${key.taskId}: stored spec no longer valid`);
  const moved = transition(state, { type: 'verification_unavailable', reason: input.reason });
  if (!moved.ok) throw new Error(`illegal verification transition: ${JSON.stringify(moved.error)}`);
  const now = ctx.now();
  await tx.update(schema.attempts).set({ outcome: 'interrupted', exitReason: input.reason }).where(and(
    eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.attemptId, input.expect.attemptId)));
  await releaseTaskClaims(tx, key, row.currentRevision, now);
  const aggregateRevision = await setStatus(tx, key, row.rowRevision, moved.value.status, now);
  await emit(tx, { projectId: key.projectId, runId: revisions[0]!.runId, taskId: key.taskId, aggregateRevision }, now, {
    type: 'task.blocked', attemptId: input.expect.attemptId, actor: SCHEDULER_ACTOR, payload: { reason: input.reason, ...(input.candidateSha !== undefined ? { candidateSha: input.candidateSha } : {}) },
  });
  return true;
}

/** Owner-requested re-verifications per task revision. Bounded, so a broken verifier cannot be retried for ever by hand either. */
export const REVERIFY_LIMIT = 3;

/** Why an owner may send a run's finished work back for another verdict: the verifier or the assembly failed, and nothing was concluded about the work. */
export const isReverifiableBlock = (reason: string | null): boolean => reason === 'verification_error' || (reason !== null && reason.startsWith('assembly_infrastructure:'));

export type ReverifyRefusal = 'nothing_to_reverify' | 'reverify_limit_reached' | 'resource_conflict';

/**
 * Sends a run's work that was blocked by a verifier or assembly failure back to `verifying`, with the worker's attempt waiting for a verdict again. No attempt
 * starts: the assembly driver picks the parts up, because they are verifying and in no live candidate, and the same commit is built and judged again. Claims go
 * back under the scheduler's lock. The caller holds the transaction and has recorded the owner's idempotency key.
 */
export async function reopenBlockedVerification(
  ctx: { readonly now: () => Date }, tx: Tx, run: { readonly tenantId: string; readonly projectId: string; readonly runId: string }, requestedBy: string, operationId: string,
): Promise<{ readonly ok: true; readonly reopened: readonly string[] } | { readonly ok: false; readonly reason: ReverifyRefusal; readonly taskId?: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${run.tenantId}`}, 0))`);
  const blocked = await tx.execute(sql`
    SELECT s.task_id, s.current_revision AS revision, s.row_revision, r.spec, e.reason, e.by_scheduler
    FROM task_status s JOIN task_revisions r ON r.tenant_id = s.tenant_id AND r.project_id = s.project_id AND r.task_id = s.task_id AND r.revision = s.current_revision
    LEFT JOIN LATERAL (SELECT payload ->> 'reason' AS reason, (actor_kind = ${SCHEDULER_ACTOR.kind} AND actor_id = ${SCHEDULER_ACTOR.id} AND payload -> 'fence' IS NULL) AS by_scheduler FROM events x WHERE x.tenant_id = s.tenant_id AND x.project_id = s.project_id AND x.task_id = s.task_id AND x.type = 'task.blocked' ORDER BY sequence DESC LIMIT 1) e ON true
    WHERE s.tenant_id = ${run.tenantId} AND s.project_id = ${run.projectId} AND s.status = 'blocked' AND r.run_id = ${run.runId}
    ORDER BY s.task_id`);
  // The reason must come from the control plane's own verification close. A worker's reported `blocked` reason is free text (the scheduler records it
  // under its own actor, with the lease `fence` in the payload), so a worker that reports `verification_error` must not earn a re-verification.
  const eligible = blocked.filter((b) => b['by_scheduler'] === true && isReverifiableBlock(b['reason'] as string | null));
  if (eligible.length === 0) return { ok: false, reason: 'nothing_to_reverify' };
  const now = ctx.now();
  const reopened: string[] = [];
  for (const b of eligible) {
    const taskId = String(b['task_id']);
    const revision = Number(b['revision']);
    const key: TaskKey = { tenantId: run.tenantId, projectId: run.projectId, taskId };
    const row = await lockStatusRow(tx, key);
    if (!row || row.status !== 'blocked' || row.currentRevision !== revision) continue;
    const used = await tx.select({ id: schema.taskCommands.operationId }).from(schema.taskCommands).where(and(
      eq(schema.taskCommands.tenantId, key.tenantId), eq(schema.taskCommands.projectId, key.projectId), eq(schema.taskCommands.taskId, taskId), eq(schema.taskCommands.command, 'reverify'), eq(schema.taskCommands.revision, revision)));
    if (used.length >= REVERIFY_LIMIT) return { ok: false, reason: 'reverify_limit_reached', taskId };

    const spec = TaskSpecSchema.parse(b['spec']);
    const attempts = await loadAttempts(tx, key, revision);
    const state = buildTaskState(spec, 'blocked', attempts);
    if (!state) throw new Error(`task ${taskId}: stored spec no longer valid`);
    const moved = transition(state, { type: 'reverify_requested' });
    if (!moved.ok) return { ok: false, reason: 'nothing_to_reverify', taskId };
    const attemptId = moved.value.attempts.at(-1)!.attemptId;

    const want = new Map<string, 'shared' | 'exclusive'>();
    for (const c of spec.resourceClaims) if (want.get(c.key) !== 'exclusive') want.set(c.key, c.mode);
    if (want.size > 0) {
      const live = await tx.select({ key: schema.resourceClaims.resourceKey, mode: schema.resourceClaims.mode }).from(schema.resourceClaims).where(and(
        eq(schema.resourceClaims.tenantId, key.tenantId), eq(schema.resourceClaims.projectId, key.projectId), inArray(schema.resourceClaims.resourceKey, [...want.keys()]), isNull(schema.resourceClaims.releasedAt)));
      if ([...want].some(([k, m]) => live.some((h) => h.key === k && (m === 'exclusive' || h.mode === 'exclusive')))) return { ok: false, reason: 'resource_conflict', taskId };
      for (const [resourceKey, mode] of want) {
        await tx.insert(schema.resourceClaims).values({ tenantId: key.tenantId, projectId: key.projectId, claimId: `clm_${randomUUID()}`, taskId, revision, resourceKey, mode, attemptId });
      }
    }
    await tx.update(schema.attempts).set({ outcome: 'running', exitReason: null }).where(and(
      eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.attemptId, attemptId)));
    const aggregateRevision = await setStatus(tx, key, row.rowRevision, moved.value.status, now);
    await tx.insert(schema.taskCommands).values({ tenantId: key.tenantId, projectId: key.projectId, operationId: `${operationId}_${taskId}`, taskId, revision, command: 'reverify', state: 'applied', requestedBy, requestedAt: now });
    // The control plane acting for the owner, as with `plan.accepted`: `task.reopened` is not a human event, and the owner is named in the payload.
    await emit(tx, { projectId: run.projectId, runId: run.runId, taskId, aggregateRevision }, now, { type: 'task.reopened', attemptId, actor: { kind: 'integration', id: 'reverify' }, payload: { reason: 'owner_reverify', status: 'verifying', requestedBy } });
    reopened.push(taskId);
  }
  return reopened.length > 0 ? { ok: true, reopened } : { ok: false, reason: 'nothing_to_reverify' };
}

/**
 * Sets the run `ready_for_review` only when the tasks covered by one live passing verdict are exactly the run's live tasks (current
 * revisions that are not cancelled or superseded) and every one of them is verified or merged. Returns whether the run is ready.
 */
export async function markRunReadyForReview(tx: Tx, key: TaskKey, runId: string, coveredTaskIds: readonly string[]): Promise<boolean> {
  const tasks = await tx
    .select({ taskId: schema.taskStatus.taskId, status: schema.taskStatus.status })
    .from(schema.taskStatus)
    .innerJoin(schema.taskRevisions, and(
      eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
      eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision)))
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskRevisions.runId, runId),
      ne(schema.taskStatus.status, 'cancelled'), ne(schema.taskStatus.status, 'superseded')));
  const covered = new Set(coveredTaskIds);
  const exact = tasks.length > 0 && tasks.length === covered.size && tasks.every((t) => covered.has(t.taskId) && (t.status === 'verified' || t.status === 'merged'));
  if (!exact) return false;
  await tx.update(schema.runs).set({ lifecycle: 'ready_for_review' }).where(and(
    eq(schema.runs.tenantId, key.tenantId), eq(schema.runs.projectId, key.projectId), eq(schema.runs.runId, runId), inArray(schema.runs.lifecycle, ['running', 'blocked'])));
  return true;
}
