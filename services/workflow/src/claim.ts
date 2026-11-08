import { randomUUID } from 'node:crypto';
import { TaskSpecSchema, budgetUsed, readyTasks, transition, type StatusMap, type TaskSpec, type TaskState, type TaskStatus } from '@selarikru/domain';
import { evaluate } from '@selarikru/policy';
import { schema, withTx, type Tx } from '@selarikru/persistence';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { emit, SCHEDULER_ACTOR, type EventScope } from './events.ts';
import { leaseDeadline } from './lease.ts';
import { checkFits, lockBudget, remainingMicros, reservationIdFor, reserve, toMicros, type BudgetPosition } from './reserve.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus, type AttemptRow, type TaskKey } from './taskstate.ts';
import type { Caps, ClaimOutcome, Lease, Runner, SchedulerContext, SkippedCandidate } from './types.ts';

/** Allowlist: unknown lifecycle values do not dispatch. */
const DISPATCHABLE_LIFECYCLES = ['planning', 'running', 'blocked'];
const CLAIMABLE_STATUSES = ['planned', 'ready'];

interface Candidate {
  projectId: string;
  taskId: string;
  currentRevision: number;
  runId: string;
  spec: Record<string, unknown>;
}

const validRunner = (r: Runner): boolean =>
  typeof r?.runnerId === 'string' && r.runnerId !== '' && typeof r.tenantId === 'string' && r.tenantId !== '' && (r.location === 'local' || r.location === 'cloud');

/** Limits read from configuration. Every one is required: a missing limit denies claiming. */
interface ClaimLimits {
  readonly maxConcurrentTotal: number;
  readonly attemptTimeoutSeconds: number;
  readonly maxInfraRetries: number;
  readonly infraRetryBackoffSeconds: number;
  readonly infraRetryBackoffMaxSeconds: number;
}

const isCount = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min;

function resolveLimits(caps: Caps): ClaimLimits | string {
  const required = [
    ['maxConcurrentTotal', 1], ['attemptTimeoutSeconds', 1], ['maxInfraRetries', 0], ['infraRetryBackoffSeconds', 1], ['infraRetryBackoffMaxSeconds', 1],
  ] as const;
  for (const [name, min] of required) {
    if (!isCount(caps?.[name], min)) return `missing_limit:${name}`;
  }
  return caps as ClaimLimits;
}

const isLeaseExpiry = (a: AttemptRow): boolean => a.outcome === 'interrupted' && a.exitReason === 'lease_expired';

/**
 * Infrastructure retries for this task revision, counted from attempt rows. They are separate from the repair count.
 * The earliest retry follows the last expiry by a delay that doubles per expiry, capped at the configured maximum.
 */
function infraRetryDecision(attempts: readonly AttemptRow[], limits: ClaimLimits, now: Date): 'allowed' | 'backoff' | 'exhausted' {
  const expiries = attempts.filter(isLeaseExpiry).length;
  if (expiries === 0) return 'allowed';
  if (expiries > limits.maxInfraRetries) return 'exhausted';
  const last = attempts[attempts.length - 1];
  if (!last || !isLeaseExpiry(last) || last.endedAt === null) return 'allowed';
  const delaySeconds = Math.min(limits.infraRetryBackoffMaxSeconds, limits.infraRetryBackoffSeconds * 2 ** (expiries - 1));
  return now.getTime() < last.endedAt.getTime() + delaySeconds * 1000 ? 'backoff' : 'allowed';
}

async function hasOpenAttempt(tx: Tx, key: TaskKey): Promise<boolean> {
  const rows = await tx
    .select({ attemptId: schema.attempts.attemptId })
    .from(schema.attempts)
    .where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.taskId, key.taskId), isNull(schema.attempts.endedAt)))
    .limit(1);
  return rows.length > 0;
}

/** Executes the whole claim in one transaction and returns a stable, machine-readable outcome. */
export async function tryClaim(ctx: SchedulerContext, runner: Runner, caps: Caps): Promise<ClaimOutcome> {
  if (!validRunner(runner)) return { ok: false, reason: 'invalid_runner', skipped: [] };
  const limits = resolveLimits(caps);
  if (typeof limits === 'string') return { ok: false, reason: limits, skipped: [] };

  return withTx(ctx.db, async (tx) => {
    // The concurrency limit and exclusive claims span many rows that may not exist yet (phantom inserts), so row locks
    // alone cannot protect them. This tenant-wide lock makes claims serial. It is a separate statement: the queries
    // below then take their READ COMMITTED snapshots after it is held.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${runner.tenantId}`}, 0))`);
    const now = ctx.now();

    const active = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.attempts)
      .where(and(eq(schema.attempts.tenantId, runner.tenantId), isNotNull(schema.attempts.leaseToken), isNull(schema.attempts.endedAt)));
    // An expired lease not yet reaped still counts: its worker may be alive, so the slot is not free until reconciled.
    if ((active[0]?.n ?? 0) >= limits.maxConcurrentTotal) return { ok: false, reason: 'concurrency_limit_reached', skipped: [] };

    const candidates: Candidate[] = await tx
      .select({
        projectId: schema.taskStatus.projectId, taskId: schema.taskStatus.taskId, currentRevision: schema.taskStatus.currentRevision,
        runId: schema.taskRevisions.runId, spec: schema.taskRevisions.spec,
      })
      .from(schema.taskStatus)
      .innerJoin(schema.taskRevisions, and(
        eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
        eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision),
      ))
      .innerJoin(schema.runs, and(eq(schema.runs.tenantId, schema.taskRevisions.tenantId), eq(schema.runs.projectId, schema.taskRevisions.projectId), eq(schema.runs.runId, schema.taskRevisions.runId)))
      .where(and(eq(schema.taskStatus.tenantId, runner.tenantId), inArray(schema.taskStatus.status, CLAIMABLE_STATUSES), inArray(schema.runs.lifecycle, DISPATCHABLE_LIFECYCLES)))
      .orderBy(asc(schema.taskStatus.updatedAt), asc(schema.taskStatus.projectId), asc(schema.taskStatus.taskId));

    const skipped: SkippedCandidate[] = [];
    for (const c of candidates) {
      const r = await claimCandidate(ctx, tx, runner, c, limits, now);
      if ('lease' in r) return { ok: true, lease: r.lease, skipped };
      skipped.push({ taskId: c.taskId, reason: r.reason });
    }
    return { ok: false, reason: 'no_claimable_task', skipped };
  });
}

/** `Lease | null` form of `tryClaim`. */
export async function claimNext(ctx: SchedulerContext, runner: Runner, caps: Caps): Promise<Lease | null> {
  const outcome = await tryClaim(ctx, runner, caps);
  return outcome.ok ? outcome.lease : null;
}

type CandidateResult = { lease: Lease } | { reason: string };

const locationAllowed = (spec: TaskSpec, runner: Runner): boolean =>
  spec.execution === 'eligible_any' || spec.execution === runner.location;

/** Local copy of the cloud boundary until T4.4 owns placement: restricted and secret work stays on the device. */
const cloudEligible = (spec: TaskSpec, runner: Runner): boolean =>
  runner.location !== 'cloud' || (spec.classification !== 'restricted' && spec.classification !== 'secret');

async function latestRevision(tx: Tx, key: TaskKey): Promise<number | null> {
  const rows = await tx
    .select({ latest: sql<number | null>`max(${schema.taskRevisions.revision})` })
    .from(schema.taskRevisions)
    .where(and(eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, key.taskId)));
  return rows[0]?.latest ?? null;
}

async function dependenciesReady(tx: Tx, key: TaskKey, spec: TaskSpec): Promise<boolean> {
  const dependencyRows = await tx
    .select({ taskId: schema.dependencies.dependsOnTaskId, revision: schema.dependencies.dependsOnRevision, condition: schema.dependencies.condition })
    .from(schema.dependencies)
    .where(and(eq(schema.dependencies.tenantId, key.tenantId), eq(schema.dependencies.projectId, key.projectId), eq(schema.dependencies.taskId, key.taskId), eq(schema.dependencies.revision, spec.revision)));
  // The union of the spec and the relational rows: an edge in either place must hold, so a mismatch fails closed.
  const edges = [...spec.dependencies, ...dependencyRows] as TaskSpec['dependencies'];
  if (edges.length === 0) return true;
  const predecessors = await tx
    .select({ taskId: schema.taskStatus.taskId, status: schema.taskStatus.status, revision: schema.taskStatus.currentRevision })
    .from(schema.taskStatus)
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), inArray(schema.taskStatus.taskId, [...new Set(edges.map((e) => e.taskId))])));
  const statuses: StatusMap = new Map(predecessors.map((p) => [p.taskId, { status: p.status as TaskStatus, revision: p.revision }]));
  // `readyTasks` holds the edge rules. It only reports `planned` tasks, so a ready task is presented as planned here.
  const withSelf = new Map(statuses).set(spec.taskId, { status: 'planned', revision: spec.revision });
  const plan = { projectId: spec.projectId, runId: spec.runId, revision: 0, tasks: [{ ...spec, dependencies: edges }] };
  return readyTasks(plan, withSelf).includes(spec.taskId);
}

async function resourceConflict(tx: Tx, key: TaskKey, spec: TaskSpec): Promise<boolean> {
  if (spec.resourceClaims.length === 0) return false;
  const active = await tx
    .select({ resourceKey: schema.resourceClaims.resourceKey, mode: schema.resourceClaims.mode })
    .from(schema.resourceClaims)
    .where(and(
      eq(schema.resourceClaims.tenantId, key.tenantId), eq(schema.resourceClaims.projectId, key.projectId),
      inArray(schema.resourceClaims.resourceKey, spec.resourceClaims.map((c) => c.key)), isNull(schema.resourceClaims.releasedAt),
    ));
  return spec.resourceClaims.some((want) => active.some((have) => have.resourceKey === want.key && (want.mode === 'exclusive' || have.mode === 'exclusive')));
}

/** Blocks a task that cannot get another attempt. Written with the task's status lock held. */
async function refuseRepair(tx: Tx, key: TaskKey, c: Candidate, state: TaskState, rowRevision: number, reason: string, now: Date): Promise<CandidateResult> {
  const refused = transition(state, { type: 'repair_refused', reason });
  if (!refused.ok) return { reason: 'illegal_transition' };
  const aggregateRevision = await setStatus(tx, key, rowRevision, refused.value.status, now);
  const scope: EventScope = { projectId: c.projectId, runId: c.runId, taskId: c.taskId, aggregateRevision };
  await emit(tx, scope, now, { type: 'task.blocked', attemptId: null, actor: SCHEDULER_ACTOR, payload: { reason } });
  return { reason };
}

async function claimCandidate(ctx: SchedulerContext, tx: Tx, runner: Runner, c: Candidate, limits: ClaimLimits, now: Date): Promise<CandidateResult> {
  const key: TaskKey = { tenantId: runner.tenantId, projectId: c.projectId, taskId: c.taskId };
  const statusRow = await lockStatusRow(tx, key);
  if (!statusRow || statusRow.currentRevision !== c.currentRevision || !CLAIMABLE_STATUSES.includes(statusRow.status)) return { reason: 'status_changed' };

  const parsed = TaskSpecSchema.safeParse(c.spec);
  if (!parsed.success) return { reason: 'invalid_spec' };
  const spec = parsed.data;
  if (spec.tenantId !== runner.tenantId || spec.projectId !== c.projectId || spec.runId !== c.runId || spec.taskId !== c.taskId) return { reason: 'invalid_spec' };
  if (spec.revision !== statusRow.currentRevision || (await latestRevision(tx, key)) !== statusRow.currentRevision) return { reason: 'stale_status' };
  // Any revision: a lease on a prior revision still holds the task, and its worker may still be running.
  if (await hasOpenAttempt(tx, key)) return { reason: 'previous_attempt_active' };

  if (!locationAllowed(spec, runner)) return { reason: 'location_mismatch' };
  if (!cloudEligible(spec, runner)) return { reason: 'classification_not_cloud_eligible' };
  if (!(await dependenciesReady(tx, key, spec))) return { reason: 'dependencies_unsatisfied' };
  if (await resourceConflict(tx, key, spec)) return { reason: 'resource_conflict' };

  const attempts = await loadAttempts(tx, key, spec.revision);
  let state = buildTaskState(spec, statusRow.status as TaskStatus, attempts);
  if (!state) return { reason: 'invalid_spec' };
  const infra = infraRetryDecision(attempts, limits, now);
  if (infra === 'exhausted') return refuseRepair(tx, key, c, state, statusRow.rowRevision, 'infra_retry_limit_exhausted', now);
  if (infra === 'backoff') return { reason: 'infra_retry_backoff' };
  const promoted = statusRow.status === 'planned';
  if (promoted) {
    const p = transition(state, { type: 'dependencies_satisfied' });
    if (!p.ok) return { reason: 'illegal_transition' };
    state = p.value;
  }

  const attemptId = `att_${randomUUID()}`;
  const started = transition(state, { type: 'attempt_started', attemptId });
  if (!started.ok) {
    return budgetUsed(state.attempts) >= state.maxAttempts
      ? refuseRepair(tx, key, c, state, statusRow.rowRevision, 'repair_budget_exhausted', now)
      : { reason: 'illegal_transition' };
  }

  const amountMicros = toMicros(spec.limits.maxCostUsd);
  const scope = { tenantId: runner.tenantId, projectId: c.projectId, runId: c.runId };
  const position = await lockBudget(tx, scope);

  const repairNumber = budgetUsed(state.attempts);
  if (repairNumber > 0) {
    const decision = evaluate({ kind: 'repair_within_limits', attempt: repairNumber, estimatedCost: amountMicros, remainingBudget: remainingMicros(position) }, ctx.policy);
    if (decision.decision !== 'allow') {
      // Budget denials are transient, so the task stays ready. Any other denial stops this repair.
      if (decision.reason.startsWith('budget:')) return { reason: decision.reason };
      return refuseRepair(tx, key, c, state, statusRow.rowRevision, decision.reason, now);
    }
  }

  const fits = checkFits(position, amountMicros);
  if (!fits.ok) return { reason: fits.reason };

  return { lease: await writeClaim(tx, runner, c, spec, statusRow.rowRevision, started.value, attemptId, amountMicros, position, promoted, Math.min(spec.limits.timeoutSeconds, limits.attemptTimeoutSeconds), now) };
}

/** Writes every claim record. The attempt row comes first: the events FK to attempts is immediate. */
async function writeClaim(tx: Tx, runner: Runner, c: Candidate, spec: TaskSpec, rowRevision: number, state: TaskState, attemptId: string, amountMicros: number, position: BudgetPosition, promoted: boolean, timeoutSeconds: number, now: Date): Promise<Lease> {
  const key: TaskKey = { tenantId: runner.tenantId, projectId: c.projectId, taskId: c.taskId };
  const fenceRows = await tx
    .select({ top: sql<number | null>`max(${schema.attempts.leaseFence})` })
    .from(schema.attempts)
    .where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.taskId, key.taskId), eq(schema.attempts.revision, spec.revision)));
  const fence = (fenceRows[0]?.top ?? 0) + 1;
  const attemptNumber = state.attempts.length;
  const leaseToken = randomUUID();
  const reservationId = reservationIdFor(attemptId);
  const expiresAt = leaseDeadline(now);
  const deadlineAt = new Date(now.getTime() + timeoutSeconds * 1000);

  await tx.insert(schema.attempts).values({
    tenantId: key.tenantId, projectId: key.projectId, attemptId, taskId: key.taskId, revision: spec.revision, attemptNumber,
    runner: runner.runnerId, leaseFence: fence, leaseToken, lastHeartbeatAt: now, leaseExpiresAt: expiresAt, deadlineAt,
    baseSha: spec.baseSha, startedAt: now, outcome: 'running', detail: { location: runner.location },
  });
  const claimed = new Map<string, 'shared' | 'exclusive'>();
  for (const claim of spec.resourceClaims) {
    if (claimed.get(claim.key) !== 'exclusive') claimed.set(claim.key, claim.mode);
  }
  for (const [resourceKey, mode] of claimed) {
    await tx.insert(schema.resourceClaims).values({
      tenantId: key.tenantId, projectId: key.projectId, claimId: `clm_${randomUUID()}`, taskId: key.taskId, revision: spec.revision, resourceKey, mode, attemptId,
    });
  }
  await reserve(tx, position, { reservationId, taskId: key.taskId, revision: spec.revision, attemptId, fence, amountMicros });

  const aggregateRevision = await setStatus(tx, key, rowRevision, state.status, now);
  const scope: EventScope = { projectId: c.projectId, runId: c.runId, taskId: c.taskId, aggregateRevision };
  if (promoted) await emit(tx, scope, now, { type: 'task.ready', attemptId: null, actor: SCHEDULER_ACTOR, payload: { reason: 'dependencies_satisfied' } });
  await emit(tx, scope, now, {
    type: 'attempt.started', attemptId, actor: SCHEDULER_ACTOR,
    payload: { fence, attemptNumber, runnerId: runner.runnerId, location: runner.location, reservationId, amountUsd: spec.limits.maxCostUsd },
  });

  return {
    tenantId: key.tenantId, projectId: key.projectId, runId: c.runId, taskId: key.taskId, revision: spec.revision,
    attemptId, attemptNumber, fence, leaseToken, runnerId: runner.runnerId, location: runner.location, reservationId,
    acquiredAt: now.toISOString(), lastHeartbeatAt: now.toISOString(), expiresAt: expiresAt.toISOString(), deadlineAt: deadlineAt.toISOString(),
  };
}
