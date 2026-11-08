import { randomUUID } from 'node:crypto';
import { TaskSpecSchema, budgetUsed, readyTasks, transition, type StatusMap, type TaskSpec, type TaskState, type TaskStatus } from '@selarikru/domain';
import { evaluate, strongest, type Classification, type Source } from '@selarikru/policy';
import { schema, withTx, type Tx } from '@selarikru/persistence';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { hasCancelRequest } from './cancel.ts';
import { emit, SCHEDULER_ACTOR, type EventScope } from './events.ts';
import { leaseDeadline } from './lease.ts';
import { capacityForMode, isBlocked, place, PLACEMENT_MODES, type Blocked, type Capacity, type Placement, type PlacementMode } from './placement.ts';
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
  placement: { mode: string; cloudDestination: string | null } | null;
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
        runId: schema.taskRevisions.runId, spec: schema.taskRevisions.spec, placement: schema.runs.placement,
      })
      .from(schema.taskStatus)
      .innerJoin(schema.taskRevisions, and(
        eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
        eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision),
      ))
      .innerJoin(schema.runs, and(eq(schema.runs.tenantId, schema.taskRevisions.tenantId), eq(schema.runs.projectId, schema.taskRevisions.projectId), eq(schema.runs.runId, schema.taskRevisions.runId)))
      .where(and(eq(schema.taskStatus.tenantId, runner.tenantId), inArray(schema.taskStatus.status, CLAIMABLE_STATUSES), inArray(schema.runs.lifecycle, DISPATCHABLE_LIFECYCLES)))
      .orderBy(asc(schema.taskStatus.updatedAt), asc(schema.taskStatus.projectId), asc(schema.taskStatus.taskId));

    const counts = await runningCounts(tx, runner.tenantId);
    const skipped: SkippedCandidate[] = [];
    for (const c of candidates) {
      const r = await claimCandidate(ctx, tx, runner, c, limits, counts, now);
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

interface RunningCounts {
  readonly tenant: { local: number; cloud: number };
  readonly byRun: ReadonlyMap<string, { local: number; cloud: number }>;
}

/** Live leases per run and location, counted from attempt rows. A lease without a recorded location counts as local. */
async function runningCounts(tx: Tx, tenantId: string): Promise<RunningCounts> {
  const rows = await tx
    .select({ runId: schema.taskRevisions.runId, location: sql<string | null>`${schema.attempts.detail}->>'location'`, n: sql<number>`count(*)::int` })
    .from(schema.attempts)
    .innerJoin(schema.taskRevisions, and(
      eq(schema.taskRevisions.tenantId, schema.attempts.tenantId), eq(schema.taskRevisions.projectId, schema.attempts.projectId),
      eq(schema.taskRevisions.taskId, schema.attempts.taskId), eq(schema.taskRevisions.revision, schema.attempts.revision),
    ))
    .where(and(eq(schema.attempts.tenantId, tenantId), isNotNull(schema.attempts.leaseToken), isNull(schema.attempts.endedAt)))
    .groupBy(schema.taskRevisions.runId, sql`${schema.attempts.detail}->>'location'`);
  const tenant = { local: 0, cloud: 0 };
  const byRun = new Map<string, { local: number; cloud: number }>();
  for (const r of rows) {
    const side = r.location === 'cloud' ? 'cloud' : 'local';
    tenant[side] += r.n;
    const run = byRun.get(r.runId) ?? { local: 0, cloud: 0 };
    run[side] += r.n;
    byRun.set(r.runId, run);
  }
  return { tenant, byRun };
}

interface RunPlacement {
  readonly mode: PlacementMode;
  readonly cloudDestination: string | null;
}

/** The run's own validated mode wins; the deployment default is the fallback. An unknown stored mode name is an error, never a guess. */
function runPlacement(ctx: SchedulerContext, c: Candidate): RunPlacement | null | Blocked {
  if (c.placement !== null && c.placement !== undefined) {
    const name = c.placement.mode;
    if (typeof name !== 'string' || !Object.hasOwn(PLACEMENT_MODES, name)) return { blocked: true, reason: 'unknown_placement_mode', transient: false };
    const dest = c.placement.cloudDestination;
    return { mode: PLACEMENT_MODES[name as keyof typeof PLACEMENT_MODES], cloudDestination: typeof dest === 'string' && dest !== '' ? dest : null };
  }
  return ctx.placement ?? null;
}

function capacityFor(cfg: RunPlacement | null, limits: ClaimLimits, counts: RunningCounts, runId: string): Capacity {
  const totalRunning = counts.tenant.local + counts.tenant.cloud;
  // Without a mode the deployment is local-only: cloud is explicitly disabled (limit 0), local may use the whole total.
  if (cfg === null) return { maxConcurrentTotal: limits.maxConcurrentTotal, local: { limit: limits.maxConcurrentTotal, running: counts.tenant.local }, cloud: { limit: 0, running: counts.tenant.cloud }, totalRunning };
  return { ...capacityForMode(cfg.mode, { maxConcurrentTotal: limits.maxConcurrentTotal, running: counts.byRun.get(runId) ?? { local: 0, cloud: 0 } }), totalRunning };
}

interface ResolvedSources {
  readonly sources: Source[];
  /** The strongest label across the project, the task, its predecessors and every referenced artifact. */
  readonly classification: Classification;
}

/**
 * Source labels come from stored rows, never from the task's own claim: the project label, each contract artifact's stored
 * label (matched by id and sha256; no match is unlabelled, which the policy denies), and the labels feeding from predecessors.
 */
async function resolveSources(tx: Tx, key: TaskKey, spec: TaskSpec): Promise<ResolvedSources> {
  const project = (await tx.select({ c: schema.projects.classification }).from(schema.projects)
    .where(and(eq(schema.projects.tenantId, key.tenantId), eq(schema.projects.projectId, key.projectId))).limit(1))[0];
  let repo = strongest(spec.classification, (project?.c ?? 'secret') as Classification);

  const edgeRows = await tx
    .select({ taskId: schema.dependencies.dependsOnTaskId, revision: schema.dependencies.dependsOnRevision })
    .from(schema.dependencies)
    .where(and(eq(schema.dependencies.tenantId, key.tenantId), eq(schema.dependencies.projectId, key.projectId), eq(schema.dependencies.taskId, key.taskId), eq(schema.dependencies.revision, spec.revision)));
  const edges = [...spec.dependencies.map((d) => ({ taskId: d.taskId, revision: d.revision })), ...edgeRows];
  const preds: TaskSpec['contractRefs'][] = [];
  for (const e of edges) {
    const row = (await tx.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions)
      .where(and(eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), eq(schema.taskRevisions.taskId, e.taskId), eq(schema.taskRevisions.revision, e.revision))).limit(1))[0];
    const p = TaskSpecSchema.safeParse(row?.spec);
    // A predecessor that cannot be read is unlabelled data feeding this task: fail closed.
    if (!p.success) { repo = 'secret'; continue; }
    repo = strongest(repo, p.data.classification);
    preds.push(p.data.contractRefs);
  }

  const refs = [...spec.contractRefs, ...preds.flat()];
  const ids = [...new Set(refs.map((r) => r.artifactId))];
  const stored = ids.length === 0 ? [] : await tx
    .select({ id: schema.artifacts.artifactId, sha: schema.artifacts.sha256, label: schema.artifacts.classification })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.tenantId, key.tenantId), eq(schema.artifacts.projectId, key.projectId), inArray(schema.artifacts.artifactId, ids)));
  const labelOf = (r: { artifactId: string; sha256: string }): string | undefined => stored.find((a) => a.id === r.artifactId && a.sha === r.sha256)?.label;

  let classification = repo;
  const sources: Source[] = [];
  for (const r of spec.contractRefs) {
    const label = labelOf(r);
    sources.push({ id: `artifact:${r.artifactId}`, classification: label as Classification | undefined });
    if (label !== undefined) classification = strongest(classification, label as Classification);
  }
  for (const r of preds.flat()) {
    const label = labelOf(r);
    // A predecessor's artifact that cannot be labelled raises the whole task to the fail-closed label.
    repo = strongest(repo, (label ?? 'secret') as Classification);
  }
  classification = strongest(classification, repo);
  return { sources: [{ id: `repo:${spec.projectId}`, classification: repo }, ...sources], classification };
}

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

async function clearBlock(tx: Tx, key: TaskKey): Promise<void> {
  await tx.update(schema.taskStatus).set({ placementBlock: null })
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)));
}

/** Writes `placement.blocked` and the queryable field when the permanent reason changed. Does not touch `updatedAt`, which orders the queue. */
async function recordBlock(tx: Tx, key: TaskKey, c: Candidate, row: { placementBlock: string | null; rowRevision: number }, reason: string, modeId: string | null, now: Date): Promise<void> {
  if (row.placementBlock === reason) return;
  const aggregateRevision = row.rowRevision + 1;
  await tx.update(schema.taskStatus).set({ placementBlock: reason, rowRevision: aggregateRevision })
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)));
  await emit(tx, { projectId: c.projectId, runId: c.runId, taskId: c.taskId, aggregateRevision }, now, {
    type: 'placement.blocked', attemptId: null, actor: SCHEDULER_ACTOR, payload: { reason, mode: modeId },
  });
}

async function claimCandidate(ctx: SchedulerContext, tx: Tx, runner: Runner, c: Candidate, limits: ClaimLimits, counts: RunningCounts, now: Date): Promise<CandidateResult> {
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
  // A task the owner asked to cancel is never dispatched again.
  if (await hasCancelRequest(tx, key, spec.revision)) return { reason: 'cancel_requested' };

  if (!(await dependenciesReady(tx, key, spec))) return { reason: 'dependencies_unsatisfied' };
  if (await resourceConflict(tx, key, spec)) return { reason: 'resource_conflict' };

  // Placement decides the one location this task may run in; a runner elsewhere never receives it.
  const amountMicros = toMicros(spec.limits.maxCostUsd);
  const budgetScope = { tenantId: runner.tenantId, projectId: c.projectId, runId: c.runId };
  const position = await lockBudget(tx, budgetScope);
  const cfg = runPlacement(ctx, c);
  const resolved = await resolveSources(tx, key, spec);
  const capacity = cfg !== null && 'blocked' in cfg ? null : capacityFor(cfg as RunPlacement | null, limits, counts, c.runId);
  const placed = capacity === null ? (cfg as Blocked) : place({ ...spec, classification: resolved.classification }, capacity, ctx.policy, {
    sources: resolved.sources, destination: (cfg as RunPlacement | null)?.cloudDestination ?? null, estimatedCost: amountMicros, remainingBudget: remainingMicros(position),
  });
  if (isBlocked(placed)) {
    // A permanent block is recorded once per reason so the owner can see why the task never starts; a transient one is silent.
    if (!placed.transient) await recordBlock(tx, key, c, statusRow, placed.reason, cfg !== null && !('blocked' in cfg) ? cfg.mode.id : null, now);
    else if (statusRow.placementBlock !== null) await clearBlock(tx, key);
    return { reason: `placement_blocked:${placed.reason}` };
  }
  if (statusRow.placementBlock !== null) await clearBlock(tx, key);
  if (placed.target !== runner.location) return { reason: 'location_mismatch' };

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

  return { lease: await writeClaim(tx, runner, c, spec, statusRow.rowRevision, started.value, attemptId, amountMicros, position, promoted, placed, capacity?.modeId ?? null, (cfg as RunPlacement | null)?.cloudDestination ?? null, Math.min(spec.limits.timeoutSeconds, limits.attemptTimeoutSeconds), now) };
}

/** Writes every claim record. The attempt row comes first: the events FK to attempts is immediate. */
async function writeClaim(tx: Tx, runner: Runner, c: Candidate, spec: TaskSpec, rowRevision: number, state: TaskState, attemptId: string, amountMicros: number, position: BudgetPosition, promoted: boolean, placed: Placement, modeId: string | null, cloudDestination: string | null, timeoutSeconds: number, now: Date): Promise<Lease> {
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

  // Why the task is here. A cloud start carries the policy decision (a policy record, never an approval).
  await emit(tx, scope, now, {
    type: 'placement.decided', attemptId, actor: SCHEDULER_ACTOR,
    payload: {
      target: placed.target, reason: placed.reason, mode: modeId, runnerId: runner.runnerId,
      ...(placed.target === 'cloud' ? { destination: cloudDestination } : {}),
      ...(placed.policy ? { policyDecision: placed.policy } : {}),
    },
  });

  return {
    tenantId: key.tenantId, projectId: key.projectId, runId: c.runId, taskId: key.taskId, revision: spec.revision,
    attemptId, attemptNumber, fence, leaseToken, runnerId: runner.runnerId, location: runner.location, reservationId,
    acquiredAt: now.toISOString(), lastHeartbeatAt: now.toISOString(), expiresAt: expiresAt.toISOString(), deadlineAt: deadlineAt.toISOString(),
  };
}
