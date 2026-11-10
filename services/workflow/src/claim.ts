import { asClaimReason, type ClaimReason } from './claim-reasons.ts';
import { randomUUID } from 'node:crypto';
import { harnessForProvider, NO_HARNESS_CATALOG, TaskSpecSchema, budgetUsed, isTerminalStreamable, readyTasks, transition, type RecordedAssignment, type StatusMap, type TaskSpec, type TaskState, type TaskStatus } from '@selarikru/domain';
import { applyApproval, evaluate, strongest, type Classification, type Operation, type Source } from '@selarikru/policy';
import { schema, withTx, type Tx } from '@selarikru/persistence';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { policyRevokedReason } from '@selarikru/domain';
import { approvalScopeHash, consumeGrants, findUsableGrant, loadWorkerGrants, openApproval, type ApprovalGate } from './approval.ts';
import { hasCancelRequest } from './cancel.ts';
import { deferEvents, emit, flushEvents, SCHEDULER_ACTOR, type EventScope } from './events.ts';
import { resolveAssignment, routeRefusal, worstCaseHold, type WorstCaseHold } from './assignment.ts';
import { INFRASTRUCTURE_REASON_PREFIX, leaseDeadline } from './lease.ts';
import { capacityForMode, isBlocked, place, PLACEMENT_MODES, type Blocked, type Capacity, type Placement, type PlacementMode } from './placement.ts';
import { checkFits, lockBudget, remainingMicros, reservationIdFor, reserve, toMicros, type BudgetPosition } from './reserve.ts';
import { buildTaskState, loadAttempts, lockStatusRow, setStatus, type AttemptRow, type TaskKey } from './taskstate.ts';
import { gateFor, loadRunGates, loadRunnerGate, pathsRevoked, type RunGate } from './settings.ts';
import { resolveTaskSkills } from './skills.ts';
import { claimHold, heldTaskBlocked, placementRefused, startSuccessor, VISIBLE_HOLDS, type CheckpointRow } from './handover.ts';
import type { SkillResolution } from '@selarikru/domain';
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
  trial: boolean;
  pinnedModel: { provider: string; model: string } | null;
}

const validRunner = (r: Runner): boolean =>
  typeof r?.runnerId === 'string' && r.runnerId !== '' && typeof r.tenantId === 'string' && r.tenantId !== '' && (r.location === 'local' || r.location === 'cloud');

/** Limits read from configuration. Every one is required: a missing limit denies claiming. */
export interface ClaimLimits {
  readonly maxConcurrentTotal: number;
  readonly attemptTimeoutSeconds: number;
  readonly maxInfraRetries: number;
  readonly infraRetryBackoffSeconds: number;
  readonly infraRetryBackoffMaxSeconds: number;
}

const isCount = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min;

export function resolveLimits(caps: Caps): ClaimLimits | `missing_limit:${string}` {
  const required = [
    ['maxConcurrentTotal', 1], ['attemptTimeoutSeconds', 1], ['maxInfraRetries', 0], ['infraRetryBackoffSeconds', 1], ['infraRetryBackoffMaxSeconds', 1],
  ] as const;
  for (const [name, min] of required) {
    if (!isCount(caps?.[name], min)) return `missing_limit:${name}`;
  }
  return caps as ClaimLimits;
}

/** The attempts the infrastructure retry limit counts: a lapsed lease, or a sandbox that could not be made ready. */
const isInfraInterruption = (a: AttemptRow): boolean => a.outcome === 'interrupted' && (a.exitReason === 'lease_expired' || a.exitReason?.startsWith(INFRASTRUCTURE_REASON_PREFIX) === true);

/**
 * Infrastructure retries for this task revision, counted from attempt rows. They are separate from the repair count.
 * The earliest retry follows the last expiry by a delay that doubles per expiry, capped at the configured maximum.
 */
function infraRetryDecision(attempts: readonly AttemptRow[], limits: ClaimLimits, now: Date): 'allowed' | 'backoff' | 'exhausted' {
  const expiries = attempts.filter(isInfraInterruption).length;
  if (expiries === 0) return 'allowed';
  if (expiries > limits.maxInfraRetries) return 'exhausted';
  const last = attempts[attempts.length - 1];
  if (!last || !isInfraInterruption(last) || last.endedAt === null) return 'allowed';
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

    // The owner's settings for this worker, as saved: a disabled worker or one at its slot limit gets nothing, whether or not it has acknowledged the change.
    const own = await loadRunnerGate(tx, runner.tenantId, runner.runnerId);
    if (!own.enabled) return { ok: false, reason: 'runner_disabled', skipped: [] };
    if (own.slots !== null) {
      const held = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.attempts)
        .where(and(eq(schema.attempts.tenantId, runner.tenantId), eq(schema.attempts.runner, runner.runnerId), isNotNull(schema.attempts.leaseToken), isNull(schema.attempts.endedAt)));
      if ((held[0]?.n ?? 0) >= own.slots) return { ok: false, reason: 'runner_slots_full', skipped: [] };
    }

    const candidates: Candidate[] = await tx
      .select({
        projectId: schema.taskStatus.projectId, taskId: schema.taskStatus.taskId, currentRevision: schema.taskStatus.currentRevision,
        runId: schema.taskRevisions.runId, spec: schema.taskRevisions.spec, placement: schema.runs.placement, trial: schema.runs.trial, pinnedModel: schema.runs.pinnedModel,
      })
      .from(schema.taskStatus)
      .innerJoin(schema.taskRevisions, and(
        eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
        eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision),
      ))
      .innerJoin(schema.runs, and(eq(schema.runs.tenantId, schema.taskRevisions.tenantId), eq(schema.runs.projectId, schema.taskRevisions.projectId), eq(schema.runs.runId, schema.taskRevisions.runId)))
      // A run whose cancel was requested starts nothing more, while its running attempts are stopped.
      .where(and(eq(schema.taskStatus.tenantId, runner.tenantId), inArray(schema.taskStatus.status, CLAIMABLE_STATUSES), inArray(schema.runs.lifecycle, DISPATCHABLE_LIFECYCLES), isNull(schema.runs.cancelRequestedAt)))
      .orderBy(asc(schema.taskStatus.updatedAt), asc(schema.taskStatus.projectId), asc(schema.taskStatus.taskId));

    const counts = await runningCounts(tx, runner.tenantId);
    const gates = await loadRunGates(tx, runner.tenantId, candidates.map((c) => c.runId));
    const skipped: SkippedCandidate[] = [];
    // Every event a candidate emits (a recorded block or hold, a refused repair, an approval gate, the claim itself) waits until no status row is left to lock: appending
    // takes the project's event sequence, which the owner's immediate task cancel, an approval resolve and the handover sweep take after a claimable task's status row, with
    // no scheduler lock. (A publish or lease expiry never meets this: the claim locks only claimable candidates.) See verification.ts.
    deferEvents(tx);
    for (const c of candidates) {
      const r = await claimCandidate(ctx, tx, runner, c, limits, counts, now, gateFor(gates, c.projectId, c.runId));
      if ('lease' in r) {
        await flushEvents(tx);
        return { ok: true, lease: r.lease, skipped };
      }
      skipped.push({ taskId: c.taskId, reason: r.reason });
    }
    await flushEvents(tx);
    return { ok: false, reason: 'no_claimable_task', skipped };
  });
}

/** `Lease | null` form of `tryClaim`. */
export async function claimNext(ctx: SchedulerContext, runner: Runner, caps: Caps): Promise<Lease | null> {
  const outcome = await tryClaim(ctx, runner, caps);
  return outcome.ok ? outcome.lease : null;
}

type CandidateResult = { lease: Lease } | { reason: ClaimReason };

export interface RunningCounts {
  readonly tenant: { local: number; cloud: number };
  readonly byRun: ReadonlyMap<string, { local: number; cloud: number }>;
}

/** Live leases per run and location, counted from attempt rows. A lease without a recorded location counts as local. */
export async function runningCounts(tx: Tx, tenantId: string): Promise<RunningCounts> {
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

export interface RunPlacement {
  readonly mode: PlacementMode;
  readonly cloudDestination: string | null;
}

/** The run's own validated mode wins; the deployment default is the fallback. An unknown stored mode name is an error, never a guess. */
export function runPlacement(ctx: SchedulerContext, c: Pick<Candidate, 'placement'>): RunPlacement | null | Blocked {
  if (c.placement !== null && c.placement !== undefined) {
    const name = c.placement.mode;
    if (typeof name !== 'string' || !Object.hasOwn(PLACEMENT_MODES, name)) return { blocked: true, reason: 'unknown_placement_mode', transient: false };
    const dest = c.placement.cloudDestination;
    return { mode: PLACEMENT_MODES[name as keyof typeof PLACEMENT_MODES], cloudDestination: typeof dest === 'string' && dest !== '' ? dest : null };
  }
  return ctx.placement ?? null;
}

export function capacityFor(cfg: RunPlacement | null, limits: ClaimLimits, counts: RunningCounts, runId: string): Capacity {
  const totalRunning = counts.tenant.local + counts.tenant.cloud;
  // Without a mode the deployment is local-only: cloud is explicitly disabled (limit 0), local may use the whole total.
  if (cfg === null) return { maxConcurrentTotal: limits.maxConcurrentTotal, local: { limit: limits.maxConcurrentTotal, running: counts.tenant.local }, cloud: { limit: 0, running: counts.tenant.cloud }, totalRunning };
  return { ...capacityForMode(cfg.mode, { maxConcurrentTotal: limits.maxConcurrentTotal, running: counts.byRun.get(runId) ?? { local: 0, cloud: 0 } }), totalRunning };
}

interface ResolvedSources {
  readonly sources: Source[];
  /** The strongest label across the project, the task, its predecessors and every referenced artifact. */
  readonly classification: Classification;
  /** The same, but a contract reference that cannot be labelled counts as `secret`: whether a model may read it cannot wait for a label nobody can give. */
  readonly routeClassification: Classification;
}

const MAX_PREDECESSORS = 500;

/** Relational dependency edges for the given task revisions, in one query. */
async function edgeRowsFor(tx: Tx, key: TaskKey, nodes: readonly { taskId: string; revision: number }[]): Promise<{ taskId: string; revision: number }[]> {
  if (nodes.length === 0) return [];
  const rows = await tx
    .select({ owner: schema.dependencies.taskId, ownerRevision: schema.dependencies.revision, taskId: schema.dependencies.dependsOnTaskId, revision: schema.dependencies.dependsOnRevision })
    .from(schema.dependencies)
    .where(and(eq(schema.dependencies.tenantId, key.tenantId), eq(schema.dependencies.projectId, key.projectId), inArray(schema.dependencies.taskId, [...new Set(nodes.map((n) => n.taskId))])));
  return rows.filter((r) => nodes.some((n) => n.taskId === r.owner && n.revision === r.ownerRevision)).map((r) => ({ taskId: r.taskId, revision: r.revision }));
}

/**
 * Source labels come from stored rows, never from the task's own claim: the project label, each contract artifact's stored
 * label (matched by id and sha256; no match is unlabelled, which the policy denies), and the labels feeding from predecessors.
 */
export async function resolveSources(tx: Tx, key: TaskKey, spec: TaskSpec): Promise<ResolvedSources> {
  const project = (await tx.select({ c: schema.projects.classification }).from(schema.projects)
    .where(and(eq(schema.projects.tenantId, key.tenantId), eq(schema.projects.projectId, key.projectId))).limit(1))[0];
  let repo = strongest(spec.classification, (project?.c ?? 'secret') as Classification);

  // Walk every transitive predecessor, level by level, so a label cannot be laundered through a middle task.
  // A visited set guards cycles, and the walk is bounded: exceeding the bound or an unreadable predecessor fails closed.
  const preds: TaskSpec['contractRefs'][] = [];
  const visited = new Set<string>([`${spec.taskId}`]);
  let frontier = [
    ...spec.dependencies.map((d) => ({ taskId: d.taskId, revision: d.revision })),
    ...(await edgeRowsFor(tx, key, [{ taskId: spec.taskId, revision: spec.revision }])),
  ];
  while (frontier.length > 0) {
    const level = frontier.filter((e, i) => frontier.findIndex((o) => o.taskId === e.taskId && o.revision === e.revision) === i && !visited.has(`${e.taskId}@${e.revision}`));
    frontier = [];
    if (level.length === 0) break;
    for (const e of level) visited.add(`${e.taskId}@${e.revision}`);
    if (visited.size > MAX_PREDECESSORS) { repo = 'secret'; break; }
    const rows = await tx.select({ taskId: schema.taskRevisions.taskId, revision: schema.taskRevisions.revision, spec: schema.taskRevisions.spec }).from(schema.taskRevisions)
      .where(and(eq(schema.taskRevisions.tenantId, key.tenantId), eq(schema.taskRevisions.projectId, key.projectId), inArray(schema.taskRevisions.taskId, [...new Set(level.map((e) => e.taskId))])));
    const found: TaskSpec[] = [];
    for (const e of level) {
      const row = rows.find((r) => r.taskId === e.taskId && r.revision === e.revision);
      const p = TaskSpecSchema.safeParse(row?.spec);
      // A predecessor that cannot be read is unlabelled data feeding this task: fail closed.
      if (!p.success) { repo = 'secret'; continue; }
      found.push(p.data);
      repo = strongest(repo, p.data.classification);
      preds.push(p.data.contractRefs);
      frontier.push(...p.data.dependencies.map((d) => ({ taskId: d.taskId, revision: d.revision })));
    }
    frontier.push(...(await edgeRowsFor(tx, key, found.map((f) => ({ taskId: f.taskId, revision: f.revision })))));
  }

  const refs = [...spec.contractRefs, ...preds.flat()];
  const ids = [...new Set(refs.map((r) => r.artifactId))];
  const stored = ids.length === 0 ? [] : await tx
    .select({ id: schema.artifacts.artifactId, sha: schema.artifacts.sha256, label: schema.artifacts.classification })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.tenantId, key.tenantId), eq(schema.artifacts.projectId, key.projectId), inArray(schema.artifacts.artifactId, ids)));
  const labelOf = (r: { artifactId: string; sha256: string }): string | undefined => stored.find((a) => a.id === r.artifactId && a.sha === r.sha256)?.label;

  let classification = repo;
  let unlabelled = false;
  const sources: Source[] = [];
  for (const r of spec.contractRefs) {
    const label = labelOf(r);
    sources.push({ id: `artifact:${r.artifactId}`, classification: label as Classification | undefined });
    if (label !== undefined) classification = strongest(classification, label as Classification);
    else unlabelled = true;
  }
  for (const r of preds.flat()) {
    const label = labelOf(r);
    // A predecessor's artifact that cannot be labelled raises the whole task to the fail-closed label.
    repo = strongest(repo, (label ?? 'secret') as Classification);
  }
  classification = strongest(classification, repo);
  return { sources: [{ id: `repo:${spec.projectId}`, classification: repo }, ...sources], classification, routeClassification: unlabelled ? 'secret' : classification };
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

async function blockedDependency(tx: Tx, key: TaskKey, spec: TaskSpec): Promise<string | null> {
  const ids = spec.dependencies.map((d) => d.taskId);
  if (ids.length === 0) return null;
  const rows = await tx.select({ taskId: schema.taskStatus.taskId }).from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), inArray(schema.taskStatus.taskId, ids), eq(schema.taskStatus.status, 'blocked'))).orderBy(asc(schema.taskStatus.taskId)).limit(1);
  return rows[0]?.taskId ?? null;
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
  // A handover holding this task now waits on nothing that can happen: the owner is asked, with the same reason the task gives.
  await heldTaskBlocked(tx, key, state.revision, reason, now);
  return { reason: asClaimReason(reason) };
}

async function clearBlock(tx: Tx, key: TaskKey): Promise<void> {
  await tx.update(schema.taskStatus).set({ placementBlock: null })
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)));
}

/** Writes `placement.blocked` and the queryable field when the permanent reason changed. Does not touch `updatedAt`, which orders the queue. */
async function recordBlock(tx: Tx, key: TaskKey, c: Candidate, row: { placementBlock: string | null; rowRevision: number }, reason: string, modeId: string | null, now: Date): Promise<void> {
  if (row.placementBlock === reason) return;
  // An increment of the stored revision, as `setStatus` does: never the read one plus one, which an earlier write in this transaction may already have used.
  const [moved] = await tx.update(schema.taskStatus).set({ placementBlock: reason, rowRevision: sql`${schema.taskStatus.rowRevision} + 1` })
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId)))
    .returning({ rowRevision: schema.taskStatus.rowRevision });
  const aggregateRevision = moved!.rowRevision;
  await emit(tx, { projectId: c.projectId, runId: c.runId, taskId: c.taskId, aggregateRevision }, now, {
    type: 'placement.blocked', attemptId: null, actor: SCHEDULER_ACTOR, payload: { reason, mode: modeId },
  });
}

/** The cloud gate for a placement, without the fields that change between claim passes (running count, remaining budget). */
function cloudGate(op: Operation, estimatedCost: number, reason: string): ApprovalGate {
  const o = op as Extract<Operation, { kind: 'start_cloud_worker' }>;
  const sources = [...o.sources].map((s) => ({ id: s.id, classification: s.classification ?? null })).sort((a, b) => a.id.localeCompare(b.id));
  return { op, requester: 'scheduler', reason, detail: { destination: o.destination, sources, estimatedCostMicros: estimatedCost } };
}

function repairGate(op: Operation, attempt: number, estimatedCost: number, reason: string): ApprovalGate {
  return { op, requester: 'scheduler', reason, detail: { repairAttempt: attempt, estimatedCostMicros: estimatedCost } };
}

/**
 * Parks a ready task behind a human decision: one approval row, `awaiting_approval`, `approval.requested`, and no attempt. If `evaluate` no longer says
 * `require_approval` (it re-runs here), the task is left unchanged for the next pass.
 */
async function requestGate(ctx: SchedulerContext, tx: Tx, key: TaskKey, c: Candidate, spec: TaskSpec, state: TaskState, row: { placementBlock: string | null; rowRevision: number }, gate: ApprovalGate, promoted: boolean, now: Date): Promise<CandidateResult> {
  const moved = transition(state, { type: 'approval_requested' });
  if (!moved.ok) return { reason: 'illegal_transition' };
  const opened = await openApproval(ctx, tx, key, c.runId, spec.revision, gate, now);
  if (!opened.approval) return { reason: asClaimReason(opened.decision.reason) };
  if (row.placementBlock !== null) await clearBlock(tx, key);
  const aggregateRevision = await setStatus(tx, key, row.rowRevision, moved.value.status, now);
  const scope: EventScope = { projectId: c.projectId, runId: c.runId, taskId: c.taskId, aggregateRevision };
  if (promoted) await emit(tx, scope, now, { type: 'task.ready', attemptId: null, actor: SCHEDULER_ACTOR, payload: { reason: 'dependencies_satisfied' } });
  await emit(tx, scope, now, {
    type: 'approval.requested', attemptId: null, actor: SCHEDULER_ACTOR,
    payload: { reason: gate.reason, operation: gate.op.kind, approvalId: opened.approval.approvalId, scopeHash: opened.approval.scopeHash, expiresAt: opened.approval.expiresAt },
  });
  return { reason: `awaiting_approval:${gate.op.kind}` };
}

async function claimCandidate(ctx: SchedulerContext, tx: Tx, runner: Runner, c: Candidate, limits: ClaimLimits, counts: RunningCounts, now: Date, settings: RunGate): Promise<CandidateResult> {
  // Paused scheduling stops new assignments and nothing else: no event, no block, and the task keeps its place in the queue.
  if (settings.paused) return { reason: 'run_paused' };
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
  // A handover holds the task: until its prior attempt is fenced, while the owner decides a restart offer, and for any runner but the location it hands to.
  const handoverHold = await claimHold(tx, key, spec.revision, runner.location);
  if (handoverHold.kind === 'wait') {
    // Said on the task, once per reason, so a runner the hold skipped is never silent: the row and the attention queue read it.
    if (VISIBLE_HOLDS.includes(handoverHold.reason)) await recordBlock(tx, key, c, statusRow, handoverHold.reason, null, now);
    return { reason: asClaimReason(handoverHold.reason) };
  }
  const handover = handoverHold.kind === 'start' ? handoverHold.row : null;
  // The owner chose this location for this task, explicitly: the role pin and the eligible-any preference give way, and every other placement rule still holds.
  const toCloud = handover !== null && handover.target === 'cloud';
  if (toCloud && spec.execution === 'local') return { reason: 'handover_execution_local' };
  // A path the owner took away blocks every task that needs it, visibly and at once; the block clears when the path is given back and the task is placed.
  if (pathsRevoked(spec, settings).length > 0) {
    const reason = policyRevokedReason('allowed_paths');
    await recordBlock(tx, key, c, statusRow, reason, null, now);
    return { reason: `placement_blocked:${reason}` };
  }

  if (!(await dependenciesReady(tx, key, spec))) {
    // Waiting on something that will not finish by itself is a stop, not a wait: say so once, instead of never being claimable with no reason shown.
    const stuck = await blockedDependency(tx, key, spec);
    if (stuck !== null) await recordBlock(tx, key, c, statusRow, `dependency_blocked:${stuck}`, null, now);
    return { reason: 'dependencies_unsatisfied' };
  }
  if (await resourceConflict(tx, key, spec)) return { reason: 'resource_conflict' };

  // Which model this attempt runs is decided here, once. A refusal blocks the claim: no attempt, no reservation, no sandbox. The hold then follows the assigned model.
  const assigned = await resolveAssignment(ctx, tx, key, spec, { trial: c.trial, pinnedModel: c.pinnedModel }, runner.harnesses ?? []);
  if (!assigned.ok) {
    // Only a fact about the task is recorded. "This runner lacks it" while another has it is about the poller, and recording it would grow the log at poll rate.
    if (!assigned.runnerOnly) await recordBlock(tx, key, c, statusRow, assigned.reason, null, now);
    return { reason: `model_blocked:${assigned.reason}` };
  }
  const hold = worstCaseHold(toMicros(spec.limits.maxCostUsd), assigned.assignment, ctx.catalog ?? NO_HARNESS_CATALOG, ctx.policy);
  const amountMicros = hold.amountMicros;

  // Placement decides the one location this task may run in; a runner elsewhere never receives it.
  const budgetScope = { tenantId: runner.tenantId, projectId: c.projectId, runId: c.runId };
  const position = await lockBudget(tx, budgetScope);
  const cfg = runPlacement(ctx, c);
  const resolved = await resolveSources(tx, key, spec);
  // Placement decides where the worker runs; this decides where its model calls may go. The two are judged separately, and a local sandbox does not make a cloud model local.
  const refusedRoute = routeRefusal(assigned.assignment, resolved.routeClassification);
  if (refusedRoute !== null) {
    await recordBlock(tx, key, c, statusRow, refusedRoute, null, now);
    return { reason: `model_blocked:${refusedRoute}` };
  }
  // Knowledge packs: the bound, reviewed, unrevoked versions whose triggers match this task, within what policy grants. A relevant pack that cannot start new work (revoked,
  // unreviewed, blocked or unknown) refuses the claim visibly, before placement can clear a block, rather than starting the task without it.
  // Where pack content would go: a cloud runner, or a model that runs in the cloud, is a cloud destination whatever the runner's location.
  const contentDestination = runner.location === 'cloud' || assigned.assignment.route !== 'device' ? 'cloud' : 'local';
  const skills = await resolveTaskSkills(tx, key, spec, contentDestination, assigned.assignment.provider);
  const refusedSkill = skills.refused[0];
  if (refusedSkill !== undefined) {
    const reason = `${refusedSkill.reason}:${refusedSkill.skillId}`;
    await recordBlock(tx, key, c, statusRow, reason, null, now);
    return { reason: `skill_blocked:${reason}` };
  }
  // A runner that cannot deliver packs would start the task without them. This is a fact about the poller, not the task, so nothing is recorded: a runner that can still takes it.
  if (skills.delivered.length > 0 && runner.skillDelivery !== true) return { reason: 'skill_runner_update_required' };
  const configured = cfg !== null && 'blocked' in cfg ? null : capacityFor(cfg as RunPlacement | null, limits, counts, c.runId);
  // Cloud the owner took away is a disabled location, exactly as a mode without cloud slots: placement says so and never moves the task elsewhere silently.
  const capacity = configured !== null && settings.cloudEligible === false ? { ...configured, cloud: { ...configured.cloud, limit: 0 } } : configured;
  const placeWith = (approved: boolean) => place({ ...spec, classification: resolved.classification, ...(toCloud ? { execution: 'cloud' as const } : {}) }, toCloud ? { ...capacity!, rolePlacement: undefined } : capacity!, ctx.policy, {
    sources: resolved.sources, destination: (cfg as RunPlacement | null)?.cloudDestination ?? null, estimatedCost: amountMicros, remainingBudget: remainingMicros(position), approved,
  });
  let placed = capacity === null ? (cfg as Blocked) : placeWith(false);
  // A configured require_approval: an unused human grant for exactly this start lets it through; `evaluate` still denies what it denies.
  let gate: ApprovalGate | null = null;
  if (isBlocked(placed) && placed.approval) {
    gate = cloudGate(placed.approval.op, amountMicros, placed.reason);
    if (await findUsableGrant(tx, key, spec.revision, approvalScopeHash(key, c.runId, spec.revision, gate, ctx.policy), now)) {
      gate = null;
      placed = placeWith(true);
    }
  }
  if (isBlocked(placed) && gate === null) {
    // A permanent block is recorded once per reason so the owner can see why the task never starts. A transient one is silent and
    // leaves the field alone, so a wait cannot make the same permanent reason write a new event.
    if (!placed.transient) await recordBlock(tx, key, c, statusRow, placed.reason, cfg !== null && !('blocked' in cfg) ? cfg.mode.id : null, now);
    // A handover the placement now refuses for good is offered back to the owner, rather than held for a start that cannot happen.
    if (!placed.transient && handover !== null) await placementRefused(tx, key, handover, placed.reason, now);
    return { reason: `placement_blocked:${placed.reason}` };
  }
  if (!isBlocked(placed)) {
    // A budget refusal is judged below on the same pass. Clearing it here would make `recordBlock` write it again on every other poll.
    if (statusRow.placementBlock !== null && !statusRow.placementBlock.startsWith('budget:')) await clearBlock(tx, key);
    if (placed.target !== runner.location) return { reason: 'location_mismatch' };
  }

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

  // A gate waits for a person only after the checks that could refuse the attempt anyway, and never starts it.
  if (gate !== null) return requestGate(ctx, tx, key, c, spec, state, statusRow, gate, promoted, now);

  const repairNumber = budgetUsed(state.attempts);
  if (repairNumber > 0) {
    const op = { kind: 'repair_within_limits', attempt: repairNumber, estimatedCost: amountMicros, remainingBudget: remainingMicros(position) } as const;
    let decision = evaluate(op, ctx.policy);
    if (decision.decision === 'require_approval') {
      const repair = repairGate(op, repairNumber, amountMicros, `approval_required:${decision.reason}`);
      if (await findUsableGrant(tx, key, spec.revision, approvalScopeHash(key, c.runId, spec.revision, repair, ctx.policy), now)) decision = applyApproval(decision, true);
      else return requestGate(ctx, tx, key, c, spec, state, statusRow, repair, promoted, now);
    }
    if (decision.decision !== 'allow') {
      // Budget denials are transient, so the task stays ready. Any other denial stops this repair.
      if (decision.reason.startsWith('budget:')) {
        await recordBlock(tx, key, c, statusRow, decision.reason, null, now);
        return { reason: asClaimReason(decision.reason) };
      }
      return refuseRepair(tx, key, c, state, statusRow.rowRevision, decision.reason, now);
    }
  }

  const fits = checkFits(position, amountMicros);
  if (!fits.ok) {
    // Holds are never handed back, so this will not clear by itself: the owner has to see it. Recorded once per reason, not per poll.
    await recordBlock(tx, key, c, statusRow, fits.reason, null, now);
    return { reason: asClaimReason(fits.reason) };
  }
  if (statusRow.placementBlock?.startsWith('budget:')) await clearBlock(tx, key);

  const lease = await writeClaim(tx, runner, c, spec, statusRow.rowRevision, started.value, attemptId, amountMicros, position, promoted, placed as Placement, capacity?.modeId ?? null, (cfg as RunPlacement | null)?.cloudDestination ?? null, Math.min(spec.limits.timeoutSeconds, limits.attemptTimeoutSeconds), now, assigned.assignment, hold, isTerminalStreamable(resolved.routeClassification), skills, handover);
  // Every grant waiting on this revision is spent on this attempt: a grant releases work once. The attempt receives what it is granted with its lease.
  const grants = await loadWorkerGrants(tx, key, spec.revision, now);
  await consumeGrants(tx, key, spec.revision, lease.attemptId, now);
  return { lease: { ...lease, grants } };
}

/** Writes every claim record. The attempt row comes first: the events FK to attempts is immediate. */
async function writeClaim(tx: Tx, runner: Runner, c: Candidate, spec: TaskSpec, rowRevision: number, state: TaskState, attemptId: string, amountMicros: number, position: BudgetPosition, promoted: boolean, placed: Placement, modeId: string | null, cloudDestination: string | null, timeoutSeconds: number, now: Date, assignment: RecordedAssignment, hold: WorstCaseHold, streamable: boolean, skills: SkillResolution, handover: CheckpointRow | null): Promise<Lease> {
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

  // The settings revision this attempt starts under. It keeps them: a later change applies from the next attempt, except a revoke, which stops it.
  const [config] = await tx.select({ revision: schema.runnerConfig.revision }).from(schema.runnerConfig).where(eq(schema.runnerConfig.tenantId, key.tenantId));
  await tx.insert(schema.attempts).values({
    tenantId: key.tenantId, projectId: key.projectId, attemptId, taskId: key.taskId, revision: spec.revision, attemptNumber,
    runner: runner.runnerId, leaseFence: fence, leaseToken, lastHeartbeatAt: now, leaseExpiresAt: expiresAt, deadlineAt,
    baseSha: spec.baseSha, startedAt: now, outcome: 'running', detail: { location: runner.location, terminalStreamable: streamable, configRevision: config?.revision ?? 0, ...(handover ? { handover: { checkpointId: handover.checkpointId, mode: handover.mode, priorAttemptId: handover.priorAttemptId } } : {}) },
    modelRoute: assignment.route, modelProvider: assignment.provider, modelId: assignment.model, assignmentSource: assignment.source,
  });
  // What this attempt receives, by version and digest, in the claim's own transaction: provenance for the attempt and its evidence. Metadata only.
  await tx.insert(schema.skillExecutionRecords).values({
    tenantId: key.tenantId, projectId: key.projectId, attemptId, taskId: key.taskId, recordedAt: now,
    record: { attemptId, taskId: key.taskId, revision: spec.revision, destination: skills.destination, harness: harnessForProvider(assignment.provider), delivered: skills.delivered, omitted: skills.omitted, context: skills.context, recordedAt: now.toISOString() },
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
  await reserve(tx, position, { reservationId, taskId: key.taskId, revision: spec.revision, attemptId, fence, amountMicros, rateBasis: hold.basis, rateSource: hold.rateSource });

  const aggregateRevision = await setStatus(tx, key, rowRevision, state.status, now);
  const scope: EventScope = { projectId: c.projectId, runId: c.runId, taskId: c.taskId, aggregateRevision };
  if (promoted) await emit(tx, scope, now, { type: 'task.ready', attemptId: null, actor: SCHEDULER_ACTOR, payload: { reason: 'dependencies_satisfied' } });
  await emit(tx, scope, now, {
    type: 'attempt.started', attemptId, actor: SCHEDULER_ACTOR,
    payload: { fence, attemptNumber, runnerId: runner.runnerId, location: runner.location, reservationId, amountUsd: amountMicros / 1_000_000, modelRoute: assignment.route, assignment: { provider: assignment.provider, model: assignment.model, source: assignment.source } },
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
  // A handover's successor: the same task revision on the location the owner chose, after the prior attempt's fence. Recorded as a route change.
  const handed = handover ? await startSuccessor(tx, handover, scope, now, { attemptId, fence, location: runner.location, runnerId: runner.runnerId }) : null;

  return {
    tenantId: key.tenantId, projectId: key.projectId, runId: c.runId, taskId: key.taskId, revision: spec.revision,
    attemptId, attemptNumber, fence, leaseToken, runnerId: runner.runnerId, location: runner.location, reservationId, assignment, streamable, controllable: streamable && !c.trial, skills: skills.delivered, ...(handed ? { handover: handed } : {}),
    acquiredAt: now.toISOString(), lastHeartbeatAt: now.toISOString(), expiresAt: expiresAt.toISOString(), deadlineAt: deadlineAt.toISOString(),
  };
}
