import { ASSIGNMENT_SOURCES, EVENT_TYPES, RouteRecordSchema, RUN_STATUSES, type EventType, type RunStatus, type TaskStatus } from '@selarikru/domain';
import { cursorToSequence, sequenceToCursor } from './common.ts';
import type { ProjectViewEvent } from './events.ts';
import {
  WORKER_ACTIVITY,
  NotDeliveredSchema,
  type ApprovalView, type AttemptView, type EvidenceRef, type ProjectViewSnapshot, type ReducedScopeView, type TaskView, type WorkerActivity, type WorkerView,
} from './snapshot.ts';

/**
 * Projection reducers. Pure: no clock, randomness or I/O; the same events always give the same state. Event times come from the
 * events themselves. Payload fields are read defensively: an absent or malformed field leaves the projection unknown, it is never guessed.
 *
 * What events cannot tell the projection (task identity and revision, dependencies, titles, approval ids, plan revisions on a run
 * that already has tasks) comes from a snapshot. When an event needs such data and it is missing, the reducer returns `resync`.
 * Liveness (heartbeats) is not an event: it is merged from snapshots by `mergeLiveness`.
 */

export const RECENT_EVENT_IDS = 512;

export interface ProjectionState {
  readonly snapshot: ProjectViewSnapshot;
  /** The last event ids applied, newest last. */
  readonly recentEventIds: readonly string[];
}

export type ResyncReason = 'gap' | 'wrong_project' | 'provenance_mismatch' | 'unknown_task' | 'unknown_revision' | 'missing_approval_id' | 'plan_revision' | 'unreadable_reduced_scope' | 'settings_changed' | 'run_cancel';
export type ApplyResult =
  | { readonly outcome: 'applied' | 'ignored' | 'duplicate'; readonly state: ProjectionState }
  | { readonly outcome: 'resync'; readonly reason: ResyncReason; readonly state: ProjectionState };

export function projectionFromSnapshot(snapshot: ProjectViewSnapshot): ProjectionState {
  return { snapshot, recentEventIds: [] };
}

/** Every domain event type is handled by `project` below; a test keeps this list equal to `EVENT_TYPES`. */
export const PROJECTED_EVENT_TYPES: readonly EventType[] = EVENT_TYPES;

const LEASE_LOSS_REASONS: readonly string[] = ['lease_expired', 'runner_lost'];
/** A task in one of these states takes no further events at its revision; a new revision arrives by snapshot. */
const TERMINAL: readonly TaskStatus[] = ['cancelled', 'merged', 'superseded'];

// ---- payload readers ----------------------------------------------------------------------------------------------------------
type Payload = Record<string, unknown>;
const str = (p: Payload, k: string): string | null => (typeof p[k] === 'string' && (p[k] as string).length > 0 ? (p[k] as string) : null);
const int = (p: Payload, k: string, min: number): number | null => (Number.isInteger(p[k]) && (p[k] as number) >= min ? (p[k] as number) : null);
const iso = (p: Payload, k: string): string | null => {
  const v = str(p, k);
  return v !== null && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v ? v : null;
};
const oneOf = <T extends string>(p: Payload, k: string, allowed: readonly T[]): T | null => {
  const v = str(p, k);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : null;
};

const selection = (v: unknown): { provider: string; model: string } | null => {
  const o = v as Payload | null | undefined;
  return o !== null && typeof o === 'object' && str(o, 'provider') !== null && str(o, 'model') !== null ? { provider: str(o, 'provider')!, model: str(o, 'model')! } : null;
};
/** The recorded model from an event. Anything unreadable leaves it null: unknown, never guessed. */
const recordedModel = (v: unknown): AttemptView['assignment'] => {
  const s = selection(v);
  if (s === null) return null;
  const source = oneOf(v as Payload, 'source', ASSIGNMENT_SOURCES);
  return source !== null ? { ...s, source } : null;
};

// ---- helpers --------------------------------------------------------------------------------------------------------------------
const put = <T>(rec: Readonly<Record<string, T>>, key: string, value: NoInfer<T>): Record<string, T> => ({ ...rec, [key]: value });
const evidence = (kind: string, ref: string, at: string): EvidenceRef => ({ kind, ref, at });

function moveTask(t: TaskView, status: TaskStatus, reason: string | null, at: string): TaskView {
  return { ...t, status, statusReason: reason, enteredStatusAt: t.status === status ? t.enteredStatusAt : at };
}

function workerFor(snap: ProjectViewSnapshot, attemptId: string | null): WorkerView | null {
  if (attemptId === null) return null;
  return Object.values(snap.workers).find((w) => w.attemptId === attemptId) ?? null;
}

function idleWorker(w: WorkerView, at: string, over: Partial<WorkerView> = {}): WorkerView {
  return {
    ...w, availability: 'idle', activity: null, taskId: null, taskRevision: null, attemptId: null, blockedByApprovalId: null, blockedByTaskIds: [],
    stateReason: null, enteredStateAt: at, ...over,
  };
}

type Projected = ProjectViewSnapshot | null | { readonly resync: ResyncReason };
const needs = (reason: ResyncReason): Projected => ({ resync: reason });

// ---- run-level events (taskId is the run id, or the event is about the run itself) ----------------------------------------------
function projectRun(snap0: ProjectViewSnapshot, e: ProjectViewEvent): Projected {
  const p = e.payload;
  const at = e.occurredAt;
  const existingRun = snap0.runs[e.runId];
  const run = existingRun ?? { runId: e.runId, lifecycle: 'planning' as RunStatus, planRevision: 0, latestEvidence: null, criteria: null, evidence: null, reducedScope: null, scopeAssessment: null, pinnedModel: null };
  const snap: ProjectViewSnapshot = existingRun ? snap0 : { ...snap0, runs: put(snap0.runs, e.runId, run) };
  const setRun = (r: typeof run, s: ProjectViewSnapshot = snap): ProjectViewSnapshot => ({ ...s, runs: put(s.runs, e.runId, r) });
  const lifecycle = oneOf(p, 'lifecycle', RUN_STATUSES);

  switch (e.type) {
    case 'run.created':
      return setRun({ ...run, lifecycle: lifecycle ?? 'planning', pinnedModel: selection(p['pinnedModel']) ?? run.pinnedModel });
    case 'plan.accepted': {
      // A revised plan changes tasks that events cannot describe: a run that already has tasks needs a snapshot.
      if (Object.values(snap.tasks).some((t) => t.runId === e.runId)) return needs('plan_revision');
      // The first plan lists tasks that only a snapshot can describe: fetch it now so the board is not empty until the first task event.
      const listed = Array.isArray(p['taskIds']) ? (p['taskIds'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      if (listed.some((id) => !snap.tasks[id])) return needs('unknown_task');
      return setRun({ ...run, lifecycle: lifecycle ?? 'running', planRevision: int(p, 'planRevision', 1) ?? run.planRevision });
    }
    case 'run.reverted':
      return setRun({ ...run, lifecycle: lifecycle ?? 'running', latestEvidence: evidence(e.type, e.eventId, at) });
    case 'change.proposed':
    case 'change.merged':
    case 'candidate.assembled':
      return setRun({ ...run, ...(lifecycle ? { lifecycle } : {}), latestEvidence: evidence(e.type, e.eventId, at) });
    case 'candidate.failed': {
      const checkId = `candidate:${e.runId}`;
      const check = { checkId, taskId: null, state: 'failed' as const, summary: str(p, 'summary') ?? str(p, 'reason'), updatedAt: at, evidenceRef: e.eventId };
      return setRun({ ...run, latestEvidence: evidence(e.type, e.eventId, at) }, { ...snap, checks: put(snap.checks, checkId, check) });
    }
    case 'approval.requested': {
      const approvalId = str(p, 'approvalId');
      if (approvalId === null) return needs('missing_approval_id');
      const approval: ApprovalView = {
        approvalId, taskId: null, taskRevision: null, runId: e.runId, scopeHash: str(p, 'scopeHash'), reason: str(p, 'reason'), operation: str(p, 'operation'), destination: str(p, 'destination'), requester: null,
        state: 'pending', requestedAt: at, expiresAt: iso(p, 'expiresAt'), resolvedAt: null,
      };
      return { ...snap, approvals: put(snap.approvals, approvalId, approval) };
    }
    case 'approval.granted':
    case 'approval.denied': {
      const wanted = str(p, 'approvalId');
      const found = wanted !== null ? snap.approvals[wanted] : Object.values(snap.approvals).filter((a) => a.taskId === null && a.runId === e.runId && a.state === 'pending').at(-1);
      if (!found) return null;
      return { ...snap, approvals: put(snap.approvals, found.approvalId, { ...found, state: e.type === 'approval.granted' ? ('granted' as const) : ('denied' as const), resolvedAt: at }) };
    }
    case 'run.reduced_scope_accepted': {
      const notDelivered = NotDeliveredSchema.safeParse(p['notDelivered']);
      const decisionId = str(p, 'decisionId');
      // The acceptance is a fact the view must not lose or half-read, so anything it cannot read comes from a snapshot.
      if (!notDelivered.success || decisionId === null || !Array.isArray(p['deliveredRequirementIds'])) return needs('unreadable_reduced_scope');
      const reducedScope: ReducedScopeView = {
        decisionId, runId: e.runId, planRevision: run.planRevision, notDelivered: notDelivered.data, deliveredRequirementIds: (p['deliveredRequirementIds'] as unknown[]).filter((x): x is string => typeof x === 'string'),
        acceptedAt: at, acceptedBy: e.actor.id, note: str(p, 'note'),
      };
      return setRun({ ...run, reducedScope });
    }
    // Settings and run cancels are read from a snapshot: what is in force, which tasks a revoke blocked or stopped, and which a cancel closed are rows the event
    // only names. A snapshot is never guessed from the event.
    case 'settings.changed':
    case 'settings.applied':
      return needs('settings_changed');
    case 'run.cancel_requested':
    case 'run.cancelled':
      return needs('run_cancel');
    default:
      return null; // a task-level type addressed to the run id: nothing to project, and never a phantom task
  }
}

// ---- task-level events ----------------------------------------------------------------------------------------------------------
function projectTask(snap: ProjectViewSnapshot, e: ProjectViewEvent): Projected {
  const p = e.payload;
  const at = e.occurredAt;

  const existing = snap.tasks[e.taskId];
  if (!existing) return needs('unknown_task');
  const hinted = int(p, 'revision', 1);
  if (hinted !== null && hinted > existing.revision) return needs('unknown_revision');
  if (hinted !== null && hinted < existing.revision) return null;
  if (e.aggregateRevision < existing.aggregateRevision) return null;
  // Where an AI call ran is a fact about the task whatever its status: a finished task can still have had a step run on it.
  if (e.type === 'inference.reported') {
    const record = RouteRecordSchema.safeParse(p['record']);
    if (!record.success || !existing.route || record.data.taskId !== existing.taskId) return null;
    return { ...snap, tasks: put(snap.tasks, existing.taskId, { ...existing, route: { ...existing.route, lastObserved: record.data } }) };
  }
  if (TERMINAL.includes(existing.status)) {
    // The task takes no more events, but an approval decision is still a fact about the approval (and frees the worker waiting on it).
    if (e.type === 'approval.granted' || e.type === 'approval.denied') {
      const wanted = str(p, 'approvalId');
      const found = wanted !== null ? snap.approvals[wanted] : Object.values(snap.approvals).filter((a) => a.taskId === existing.taskId && a.state === 'pending').at(-1);
      if (!found) return null;
      const w = Object.values(snap.workers).find((x) => x.blockedByApprovalId === found.approvalId);
      return {
        ...snap, approvals: put(snap.approvals, found.approvalId, { ...found, state: e.type === 'approval.granted' ? ('granted' as const) : ('denied' as const), resolvedAt: at }),
        workers: w ? put(snap.workers, w.workerId, idleWorker(w, at)) : snap.workers,
      };
    }
    return null;
  }
  let task: TaskView = { ...existing, aggregateRevision: e.aggregateRevision, title: str(p, 'title') ?? existing.title };

  const commit = (t: TaskView, s: ProjectViewSnapshot = snap): ProjectViewSnapshot => ({ ...s, tasks: put(s.tasks, t.taskId, t) });
  const withEvidence = (t: TaskView, kind: string, ref: string = e.eventId): TaskView => ({ ...t, latestEvidence: evidence(kind, ref, at) });

  // Attempt-scoped events apply only to the task's active attempt and, when stated, its current fence.
  const attempt = e.attemptId !== null ? snap.attempts[e.attemptId] : undefined;
  const activeOk = (): boolean => {
    if (!attempt || attempt.outcome !== 'running' || task.activeAttemptId !== attempt.attemptId) return false;
    const fence = int(p, 'fence', 0);
    return fence === null || attempt.fence === null || fence >= attempt.fence;
  };

  switch (e.type) {
    case 'task.ready':
      return commit(moveTask(task, 'ready', str(p, 'reason'), at));

    case 'placement.blocked':
      return commit({ ...task, placementBlock: str(p, 'reason') ?? 'unknown' });

    case 'placement.cleared':
      return commit({ ...task, placementBlock: null });

    case 'placement.decided': {
      const w = workerFor(snap, e.attemptId);
      if (!w || !attempt || attempt.outcome !== 'running') return commit(task);
      const target = oneOf(p, 'target', ['local', 'cloud'] as const);
      const route = oneOf(p, 'modelRoute', ['device', 'cloud', 'unknown', 'none'] as const);
      return commit(task, { ...snap, workers: put(snap.workers, w.workerId, { ...w, execution: target ?? w.execution, modelRoute: route ?? w.modelRoute }) });
    }

    case 'attempt.started': {
      const cur = task.activeAttemptId !== null ? snap.attempts[task.activeAttemptId] : undefined;
      const fence = int(p, 'fence', 0);
      if (cur && cur.outcome === 'running' && fence !== null && cur.fence !== null && fence < cur.fence) return null;
      const attemptId = e.attemptId;
      if (attemptId === null || snap.attempts[attemptId]) return null;
      const runnerId = str(p, 'runnerId');
      const workerId = runnerId ?? `attempt:${attemptId}`;
      const next: AttemptView = {
        attemptId, taskId: task.taskId, number: int(p, 'attemptNumber', 1) ?? task.attemptIds.length + 1, fence, outcome: 'running',
        exitReason: null, runnerId, startedAt: at, endedAt: null, lastHeartbeatAt: at, assignment: recordedModel(p['assignment']),
      };
      const location = oneOf(p, 'location', ['local', 'cloud'] as const);
      const prior = snap.workers[workerId];
      const worker: WorkerView = {
        workerId, taskId: task.taskId, taskRevision: task.revision, attemptId, availability: 'assigned',
        // What the worker is doing is unknown until something reports it. Never defaulted.
        activity: null, health: 'healthy', leaseHeld: true,
        stateReason: null, enteredStateAt: at, latestAction: null, latestEvidence: null, lastHeartbeatAt: at,
        execution: location ?? prior?.execution ?? 'unknown', modelRoute: oneOf(p, 'modelRoute', ['device', 'cloud', 'unknown', 'none'] as const) ?? 'unknown', assignment: next.assignment,
        blockedByTaskIds: [], blockedByApprovalId: null,
      };
      const t = withEvidence({ ...moveTask(task, 'running', null, at), placementBlock: null, activeAttemptId: attemptId, attemptIds: [...task.attemptIds, attemptId] }, 'attempt.started');
      return commit(t, { ...snap, attempts: put(snap.attempts, attemptId, next), workers: put(snap.workers, workerId, worker) });
    }

    case 'attempt.heartbeat': {
      // Not emitted by the services today (liveness comes from snapshots); accepted for the day it is, as liveness only.
      if (!attempt || !activeOk()) return null;
      const w = workerFor(snap, attempt.attemptId);
      if (!w) return null;
      const activity = oneOf<WorkerActivity>(p, 'activity', WORKER_ACTIVITY) ?? w.activity;
      const worker: WorkerView = { ...w, activity, lastHeartbeatAt: at, health: w.health === 'failed' ? 'failed' : 'healthy' };
      return commit(task, { ...snap, workers: put(snap.workers, w.workerId, worker), attempts: put(snap.attempts, attempt.attemptId, { ...attempt, lastHeartbeatAt: at }) });
    }

    case 'attempt.completed': {
      if (!attempt || !activeOk()) return null;
      const w = workerFor(snap, attempt.attemptId);
      const t = withEvidence({ ...moveTask(task, 'verifying', null, at), activeAttemptId: null }, 'attempt.completed');
      // The attempt waits for its verdict, which sets the real outcome: it is not `succeeded` yet.
      return commit(t, {
        ...snap, attempts: put(snap.attempts, attempt.attemptId, { ...attempt, endedAt: at }),
        workers: w ? put(snap.workers, w.workerId, idleWorker(w, at, { leaseHeld: false, latestEvidence: evidence('attempt.completed', e.eventId, at) })) : snap.workers,
      });
    }

    case 'attempt.failed': {
      if (!attempt || !activeOk()) return null;
      const reason = str(p, 'reason');
      const lost = reason !== null && LEASE_LOSS_REASONS.includes(reason);
      const stated = oneOf(p, 'outcome', ['failed', 'interrupted'] as const);
      const outcome = stated ?? (lost ? 'interrupted' : 'failed');
      const w = workerFor(snap, attempt.attemptId);
      const next = { ...attempt, outcome, exitReason: reason, endedAt: at };
      // An interrupted attempt does not fail the task: the scheduler's follow-up `task.ready` or `task.blocked` says what it becomes.
      const base = outcome === 'failed' ? moveTask(task, 'failed', reason, at) : { ...task, statusReason: reason };
      const t = withEvidence({ ...base, activeAttemptId: null }, 'attempt.failed');
      const worker = w
        ? lost
          ? { ...w, availability: 'offline' as const, health: 'disconnected' as const, leaseHeld: false, stateReason: reason, enteredStateAt: at }
          : idleWorker(w, at, { leaseHeld: false, health: reason === 'worker_crashed' ? 'failed' : 'healthy', stateReason: reason })
        : null;
      return commit(t, { ...snap, attempts: put(snap.attempts, attempt.attemptId, next), workers: worker ? put(snap.workers, worker.workerId, worker) : snap.workers });
    }

    case 'approval.requested': {
      // The approval id is not in the event today. A snapshot supplies it; the reducer never makes one up.
      const approvalId = str(p, 'approvalId');
      if (approvalId === null) return needs('missing_approval_id');
      const approval: ApprovalView = {
        approvalId, taskId: task.taskId, taskRevision: task.revision, runId: e.runId, scopeHash: str(p, 'scopeHash'), reason: str(p, 'reason'), operation: str(p, 'operation'), destination: str(p, 'destination'), requester: null,
        state: 'pending', requestedAt: at, expiresAt: iso(p, 'expiresAt'), resolvedAt: null,
      };
      let attempts = snap.attempts;
      let workers = snap.workers;
      const running = task.activeAttemptId !== null ? snap.attempts[task.activeAttemptId] : undefined;
      if (running && running.outcome === 'running') {
        attempts = put(attempts, running.attemptId, { ...running, outcome: 'interrupted', exitReason: 'approval_requested', endedAt: at });
        const w = workerFor(snap, running.attemptId);
        // The worker holds no lease while it waits for a person, so heartbeat age says nothing about it.
        if (w) workers = put(workers, w.workerId, { ...w, activity: 'waiting_human', leaseHeld: false, blockedByApprovalId: approvalId, stateReason: str(p, 'reason'), enteredStateAt: at });
      }
      const t = { ...moveTask(task, 'awaiting_approval', str(p, 'reason'), at), activeAttemptId: null };
      return commit(t, { ...snap, attempts, workers, approvals: put(snap.approvals, approvalId, approval) });
    }

    case 'approval.granted':
    case 'approval.denied': {
      const granted = e.type === 'approval.granted';
      const wanted = str(p, 'approvalId');
      const found = wanted !== null
        ? snap.approvals[wanted]
        : Object.values(snap.approvals).filter((a) => a.taskId === task.taskId && a.state === 'pending').at(-1);
      const approvals = found ? put(snap.approvals, found.approvalId, { ...found, state: granted ? ('granted' as const) : ('denied' as const), resolvedAt: at }) : snap.approvals;
      const w = Object.values(snap.workers).find((x) => found && x.blockedByApprovalId === found.approvalId);
      const workers = w ? put(snap.workers, w.workerId, idleWorker(w, at)) : snap.workers;
      const moved = task.status === 'awaiting_approval' ? moveTask(task, granted ? 'ready' : 'blocked', granted ? null : 'approval_denied', at) : task;
      return commit(withEvidence(moved, e.type), { ...snap, approvals, workers });
    }

    case 'task.blocked': {
      const reason = str(p, 'reason');
      const running = task.activeAttemptId !== null ? snap.attempts[task.activeAttemptId] : undefined;
      let attempts = snap.attempts;
      let workers = snap.workers;
      if (running && running.outcome === 'running') {
        attempts = put(attempts, running.attemptId, { ...running, outcome: 'interrupted', exitReason: reason, endedAt: at });
        const w = workerFor(snap, running.attemptId);
        if (w) workers = put(workers, w.workerId, idleWorker(w, at, { leaseHeld: false, stateReason: reason, ...(reason?.startsWith('policy_denied') ? { activity: 'blocked_policy' as const } : {}) }));
      }
      // The expiry sweep says which approval lapsed. It stays denied-able and is never a grant.
      let approvals = snap.approvals;
      if (reason === 'approval_expired') {
        const lapsed = str(p, 'approvalId') !== null ? snap.approvals[str(p, 'approvalId')!] : Object.values(snap.approvals).filter((a) => a.taskId === task.taskId && a.state === 'pending').at(-1);
        if (lapsed && lapsed.state === 'pending') approvals = put(approvals, lapsed.approvalId, { ...lapsed, state: 'expired' as const, resolvedAt: at });
      }
      return commit({ ...moveTask(task, 'blocked', reason, at), activeAttemptId: null }, { ...snap, attempts, workers, approvals });
    }

    case 'verification.started':
    case 'verification.passed':
    case 'verification.failed': {
      const checkId = str(p, 'checkId') ?? `${task.taskId}:verification`;
      const state = e.type === 'verification.started' ? ('running' as const) : e.type === 'verification.passed' ? ('passed' as const) : ('failed' as const);
      const check = { checkId, taskId: task.taskId, state, summary: str(p, 'summary'), updatedAt: at, evidenceRef: e.eventId };
      const status: TaskStatus = state === 'running' ? 'verifying' : state === 'passed' ? 'verified' : 'failed';
      const moved = moveTask(task, status, state === 'failed' ? (str(p, 'reason') ?? 'verification_failed') : null, at);
      // The verdict gives the verified attempt its real outcome.
      const verified = e.attemptId !== null ? snap.attempts[e.attemptId] : undefined;
      const attempts = verified && state !== 'running' ? put(snap.attempts, verified.attemptId, { ...verified, outcome: state === 'passed' ? ('succeeded' as const) : ('failed' as const), exitReason: state === 'failed' ? 'verification_failed' : verified.exitReason }) : snap.attempts;
      return commit(withEvidence(moved, e.type), { ...snap, checks: put(snap.checks, checkId, check), attempts });
    }

    case 'change.merged':
      return commit(withEvidence(moveTask(task, 'merged', null, at), e.type));

    case 'change.proposed':
    case 'candidate.assembled':
      return commit(withEvidence(task, e.type));

    case 'candidate.failed': {
      const checkId = `candidate:${task.taskId}`;
      const check = { checkId, taskId: task.taskId, state: 'failed' as const, summary: str(p, 'summary') ?? str(p, 'reason'), updatedAt: at, evidenceRef: e.eventId };
      return commit(withEvidence(task, e.type), { ...snap, checks: put(snap.checks, checkId, check) });
    }

    case 'task.cancel_requested':
      return commit({ ...task, cancelRequested: { at, operationId: str(p, 'operationId') } });

    case 'task.cancelled': {
      const reason = oneOf(p, 'reason', ['cancel_requested', 'budget_exhausted'] as const);
      const running = task.activeAttemptId !== null ? snap.attempts[task.activeAttemptId] : undefined;
      let attempts = snap.attempts;
      let workers = snap.workers;
      if (running && running.outcome === 'running') {
        attempts = put(attempts, running.attemptId, { ...running, outcome: 'cancelled', exitReason: reason, endedAt: at });
        const w = workerFor(snap, running.attemptId);
        if (w) workers = put(workers, w.workerId, idleWorker(w, at, { leaseHeld: false }));
      }
      const t = { ...moveTask(task, 'cancelled', reason, at), cancelRequested: null, cancelReason: reason, activeAttemptId: null };
      return commit(t, { ...snap, attempts, workers });
    }

    case 'task.superseded':
      return commit({ ...moveTask(task, 'superseded', null, at), supersededByRevision: int(p, 'supersededByRevision', 1), activeAttemptId: null });

    case 'task.reopened': {
      // Real payload: { reason, candidateIds, status, blocked? }. `blocked` names a resource conflict.
      const blocked = str(p, 'blocked') ?? str(p, 'blockedReason');
      const status = blocked ? 'blocked' : (oneOf(p, 'status', ['verifying', 'blocked'] as const) ?? 'verifying');
      return commit(withEvidence(moveTask(task, status, blocked, at), e.type));
    }

    case 'attempt.human_intervened': {
      if (!attempt) return commit(task);
      return commit(task, { ...snap, attempts: put(snap.attempts, attempt.attemptId, { ...attempt, humanIntervenedAt: attempt.humanIntervenedAt ?? at }) });
    }

    case 'terminal.control_ended':
      return commit(task);

    // A handover is read on demand (the task's handover view), not from the snapshot: these advance the cursor and touch the task, and the attempt events around them
    // (`attempt.failed`, `task.ready`, `attempt.started`) carry the state change.
    case 'handover.requested':
    case 'checkpoint.recorded':
    case 'checkpoint.refused':
    case 'attempt.fenced':
    case 'attempt.route_changed':
    case 'attempt.publish_refused':
    case 'handover.decided':
      return commit(task);

    // An accepted patch proposal is ids and hashes: the apply attempt it queues arrives as `attempt.started`.
    case 'proposal.accepted':
      return commit(task);

    // H11: a delegation names the worker and the accepted plan revision; it holds for this task revision only.
    case 'task.delegated': {
      const workerId = str(p, 'workerId');
      const planRevision = int(p, 'planRevision', 1);
      if (!workerId || planRevision === null) return commit(task);
      return commit({ ...task, delegation: { workerId, planRevision, actor: e.actor.kind === 'agent' ? 'agent' : 'human', at } });
    }
    // H11 fix round 1: the delegation was released (its worker can no longer take the task); the task is claimed as usual.
    case 'task.undelegated':
      return commit({ ...task, delegation: null });


    default: {
      // Run-level types are handled by `projectRun`; a new domain event type fails to compile here until it is projected on purpose.
      const _run: 'run.created' | 'plan.accepted' | 'run.reduced_scope_accepted' | 'run.reverted' | 'settings.changed' | 'settings.applied' | 'run.cancel_requested' | 'run.cancelled' | 'product.recorded' | 'product.proposed' = e.type;
      void _run;
      return null;
    }
  }
}

/** Product records are read on demand (the Product view), not from the snapshot: their events only advance the cursor. */
const RUN_LEVEL_TYPES: readonly EventType[] = ['run.created', 'plan.accepted', 'run.reverted', 'settings.changed', 'settings.applied', 'run.cancel_requested', 'run.cancelled', 'product.recorded', 'product.proposed'];

function project(snap: ProjectViewSnapshot, e: ProjectViewEvent): Projected {
  // Run-level events, and events addressed to the run id (integration), are handled before any task lookup.
  if (RUN_LEVEL_TYPES.includes(e.type) || e.taskId === e.runId) return projectRun(snap, e);
  return projectTask(snap, e);
}

/**
 * Applies one event. `sequence <= cursor` is a redelivery and a no-op. The cursor must otherwise advance by exactly one: a gap returns
 * `resync` and leaves the state untouched, so the caller fetches a new snapshot instead of guessing. An event that needs data only a
 * snapshot has returns `resync` too. An event that does not apply (stale revision, terminal task, not the active attempt) is `ignored`
 * but still advances the cursor, because the sequence was received.
 */
export function applyEvent(state: ProjectionState, event: ProjectViewEvent): ApplyResult {
  const snap = state.snapshot;
  if (event.projectId !== snap.meta.projectId) return { outcome: 'resync', reason: 'wrong_project', state };
  // Simulated events must never merge into observed state, or the reverse.
  if (event.provenance !== snap.meta.provenance) return { outcome: 'resync', reason: 'provenance_mismatch', state };
  const cursor = cursorToSequence(snap.meta.cursor);
  if (event.sequence <= cursor || state.recentEventIds.includes(event.eventId)) return { outcome: 'duplicate', state };
  if (event.sequence !== cursor + 1) return { outcome: 'resync', reason: 'gap', state };

  const projected = project(snap, event);
  if (projected !== null && 'resync' in projected) return { outcome: 'resync', reason: projected.resync, state };
  const base = projected ?? snap;
  const next: ProjectViewSnapshot = {
    ...base,
    meta: { ...base.meta, cursor: sequenceToCursor(event.sequence), observedAt: event.receivedAt > base.meta.observedAt ? event.receivedAt : base.meta.observedAt },
  };
  const recentEventIds = [...state.recentEventIds, event.eventId].slice(-RECENT_EVENT_IDS);
  return { outcome: projected === null ? 'ignored' : 'applied', state: { snapshot: next, recentEventIds } };
}

/** Folds events in order. Stops at the first `resync`. */
export function applyEvents(state: ProjectionState, events: readonly ProjectViewEvent[]): ApplyResult {
  let current: ApplyResult = { outcome: 'ignored', state };
  for (const ev of events) {
    current = applyEvent(current.state, ev);
    if (current.outcome === 'resync') return current;
  }
  return current;
}

/**
 * Merges liveness from a fresher snapshot and nothing else: `attempts[].lastHeartbeatAt` and the matching worker's heartbeat. Event-derived
 * state and the cursor are untouched, so a refresh can never move the projection across events it has not received. The newer time wins.
 */
export function mergeLiveness(state: ProjectionState, fresh: ProjectViewSnapshot): ProjectionState {
  if (fresh.meta.projectId !== state.snapshot.meta.projectId || fresh.meta.provenance !== state.snapshot.meta.provenance) return state;
  const snap = state.snapshot;
  let attempts = snap.attempts;
  let workers = snap.workers;
  let changed = false;
  for (const a of Object.values(fresh.attempts)) {
    const mine = snap.attempts[a.attemptId];
    if (!mine || mine.outcome !== 'running' || mine.endedAt !== null || a.lastHeartbeatAt === null) continue;
    if (mine.lastHeartbeatAt !== null && Date.parse(a.lastHeartbeatAt) <= Date.parse(mine.lastHeartbeatAt)) continue;
    attempts = put(attempts, mine.attemptId, { ...mine, lastHeartbeatAt: a.lastHeartbeatAt });
    const w = workerFor(snap, mine.attemptId);
    if (w && w.leaseHeld) workers = put(workers, w.workerId, { ...w, lastHeartbeatAt: a.lastHeartbeatAt });
    changed = true;
  }
  // What a worker is doing arrives with its heartbeat, so it is liveness too. It stays with the attempt it was reported for.
  for (const w of Object.values(fresh.workers)) {
    const mine = workers[w.workerId];
    if (!mine || !mine.leaseHeld || mine.attemptId !== w.attemptId || w.latestAction === null) continue;
    if (mine.latestAction !== null && Date.parse(w.latestAction.at) <= Date.parse(mine.latestAction.at)) continue;
    workers = put(workers, w.workerId, { ...mine, latestAction: w.latestAction });
    changed = true;
  }
  const runners = JSON.stringify(snap.runners) === JSON.stringify(fresh.runners) ? snap.runners : fresh.runners;
  return changed || runners !== snap.runners ? { ...state, snapshot: { ...snap, attempts, workers, runners } } : state;
}

/**
 * Merges the run lifecycle and criteria counts from a snapshot, and nothing else. Neither has an event of its own. Two lifecycle changes have no event (`ready_for_review` is written with the
 * last verdict, and `merged` follows `change.merged` without saying so), so the periodic refresh carries them. Only a snapshot at or past
 * the projection's cursor counts: an older one cannot move a run backwards. Event-derived state and the cursor are untouched.
 */
export function mergeRunLifecycle(state: ProjectionState, fresh: ProjectViewSnapshot): ProjectionState {
  const snap = state.snapshot;
  if (fresh.meta.projectId !== snap.meta.projectId || fresh.meta.provenance !== snap.meta.provenance) return state;
  if (cursorToSequence(fresh.meta.cursor) < cursorToSequence(snap.meta.cursor)) return state;
  let runs = snap.runs;
  let changed = false;
  for (const r of Object.values(fresh.runs)) {
    const mine = snap.runs[r.runId];
    if (!mine || (mine.lifecycle === r.lifecycle && mine.criteria?.verified === r.criteria?.verified && mine.criteria?.total === r.criteria?.total && JSON.stringify(mine.evidence) === JSON.stringify(r.evidence))) continue;
    runs = put(runs, r.runId, { ...mine, lifecycle: r.lifecycle, criteria: r.criteria, evidence: r.evidence });
    changed = true;
  }
  return changed ? { ...state, snapshot: { ...snap, runs } } : state;
}

/**
 * Merges what the screens read and events do not carry: the change requests (merge reconciliation has no event), each run's reduced-scope
 * record and assessment, a cancel request written with no event (a budget stop), the scheduler's limits, and the model catalog and assignments (an assignment change has no event: it is project configuration, audited in its own table). Same rule as the lifecycle merge: only a snapshot at or past the cursor counts. Returns the state unchanged when nothing differs.
 */
export function mergeDecisionFacts(state: ProjectionState, fresh: ProjectViewSnapshot): ProjectionState {
  const snap = state.snapshot;
  if (fresh.meta.projectId !== snap.meta.projectId || fresh.meta.provenance !== snap.meta.provenance) return state;
  if (cursorToSequence(fresh.meta.cursor) < cursorToSequence(snap.meta.cursor)) return state;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  let runs = snap.runs;
  let changed = false;
  for (const r of Object.values(fresh.runs)) {
    const mine = snap.runs[r.runId];
    if (!mine) continue;
    // A recorded acceptance arrives by event first; a snapshot that has not caught up cannot clear it.
    const reducedScope = r.reducedScope ?? mine.reducedScope;
    if (same(mine.reducedScope, reducedScope) && same(mine.scopeAssessment, r.scopeAssessment)) continue;
    runs = put(runs, r.runId, { ...mine, reducedScope, scopeAssessment: r.scopeAssessment });
    changed = true;
  }
  // A budget stop writes its cancel request with no event of its own. Only ever sets one: the `task.cancelled` event is what clears it.
  let tasks = snap.tasks;
  for (const t of Object.values(fresh.tasks)) {
    const mine = tasks[t.taskId];
    if (!mine || mine.cancelRequested !== null || t.cancelRequested === null || mine.revision !== t.revision || mine.status !== 'running') continue;
    tasks = put(tasks, t.taskId, { ...mine, cancelRequested: t.cancelRequested });
  }
  const limits = same(snap.limits, fresh.limits) ? snap.limits : fresh.limits;
  const changeRequests = same(snap.changeRequests, fresh.changeRequests) ? snap.changeRequests : fresh.changeRequests;
  const approvalHistory = same(snap.approvalHistory, fresh.approvalHistory) ? snap.approvalHistory : fresh.approvalHistory;
  const modelCatalog = same(snap.modelCatalog, fresh.modelCatalog) ? snap.modelCatalog : fresh.modelCatalog;
  const modelAssignments = same(snap.modelAssignments, fresh.modelAssignments) ? snap.modelAssignments : fresh.modelAssignments;
  if (!changed && tasks === snap.tasks && limits === snap.limits && changeRequests === snap.changeRequests && approvalHistory === snap.approvalHistory && modelCatalog === snap.modelCatalog && modelAssignments === snap.modelAssignments) return state;
  return { ...state, snapshot: { ...snap, tasks, runs, limits, changeRequests, approvalHistory, modelCatalog, modelAssignments } };
}

const RESOLVED: readonly ApprovalView['state'][] = ['granted', 'denied', 'expired', 'superseded'];

/**
 * Keeps approvals resolved during this session across a snapshot replacement. A snapshot lists only open approvals, so a resync would otherwise forget a
 * decision the person just made until the server's history reports it. Open requests always come from the snapshot. An expired request the snapshot no longer
 * lists is history only: left among the approvals it would still build a card for a task that has moved on.
 */
export function carryResolvedApprovals(previous: ProjectViewSnapshot | null, fresh: ProjectViewSnapshot): ProjectViewSnapshot {
  if (previous === null) return fresh;
  let approvals = fresh.approvals;
  let approvalHistory = fresh.approvalHistory;
  for (const a of Object.values(previous.approvals)) {
    if (!RESOLVED.includes(a.state) || a.resolvedAt === null || approvals[a.approvalId]) continue;
    if (a.state === 'expired') {
      if (!approvalHistory.some((h) => h.approvalId === a.approvalId)) {
        approvalHistory = [...approvalHistory, { approvalId: a.approvalId, runId: a.runId, taskId: a.taskId, revision: a.taskRevision, outcome: 'expired', approver: null, scopeHash: a.scopeHash, operation: a.operation, destination: a.destination, requestedAt: a.requestedAt, resolvedAt: a.resolvedAt, consumedAt: null, consumedBy: null }];
      }
      continue;
    }
    approvals = put(approvals, a.approvalId, a);
  }
  return approvals === fresh.approvals && approvalHistory === fresh.approvalHistory ? fresh : { ...fresh, approvals, approvalHistory };
}
