import { EVENT_TYPES, RUN_STATUSES, type EventType, type RunStatus, type TaskStatus } from '@selarikru/domain';
import { cursorToSequence, sequenceToCursor } from './common.ts';
import type { ProjectViewEvent } from './events.ts';
import {
  WORKER_ACTIVITY,
  type ApprovalView, type AttemptView, type EvidenceRef, type ProjectViewSnapshot, type TaskView, type WorkerActivity, type WorkerView,
} from './snapshot.ts';

/**
 * Projection reducers. Pure: no clock, randomness or I/O; the same events always give the same state. Event times come from the
 * events themselves. Payload fields are read defensively, because the payload bag is not part of the envelope contract: an absent
 * or malformed field leaves the projection unknown, it is never guessed.
 */

export const RECENT_EVENT_IDS = 512;

export interface ProjectionState {
  readonly snapshot: ProjectViewSnapshot;
  /** The last event ids applied, newest last. A replayed event whose id is here changes nothing. */
  readonly recentEventIds: readonly string[];
}

export type ResyncReason = 'gap' | 'out_of_order' | 'wrong_project' | 'provenance_mismatch';
export type ApplyResult =
  | { readonly outcome: 'applied' | 'ignored' | 'duplicate'; readonly state: ProjectionState }
  | { readonly outcome: 'resync'; readonly reason: ResyncReason; readonly state: ProjectionState };

export function projectionFromSnapshot(snapshot: ProjectViewSnapshot): ProjectionState {
  return { snapshot, recentEventIds: [] };
}

/** Every domain event type is either projected or explicitly ignored here; a test keeps this list equal to `EVENT_TYPES`. */
export const PROJECTED_EVENT_TYPES: readonly EventType[] = EVENT_TYPES;

const LEASE_LOSS_REASONS: readonly string[] = ['lease_expired', 'runner_lost'];

// ---- payload readers ----------------------------------------------------------------------------------------------------------
type Payload = Record<string, unknown>;
const str = (p: Payload, k: string): string | null => (typeof p[k] === 'string' && (p[k] as string).length > 0 ? (p[k] as string) : null);
const int = (p: Payload, k: string, min: number): number | null => (Number.isInteger(p[k]) && (p[k] as number) >= min ? (p[k] as number) : null);
const bool = (p: Payload, k: string): boolean => p[k] === true;
const iso = (p: Payload, k: string): string | null => {
  const v = str(p, k);
  return v !== null && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v ? v : null;
};
const oneOf = <T extends string>(p: Payload, k: string, allowed: readonly T[]): T | null => {
  const v = str(p, k);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : null;
};
const strList = (p: Payload, k: string): string[] | null => {
  const v = p[k];
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0) ? (v as string[]) : null;
};

// ---- helpers --------------------------------------------------------------------------------------------------------------------
const put = <T>(rec: Readonly<Record<string, T>>, key: string, value: NoInfer<T>): Record<string, T> => ({ ...rec, [key]: value });

function evidence(kind: string, ref: string, at: string): EvidenceRef {
  return { kind, ref, at };
}

function newTask(e: ProjectViewEvent, revision: number): TaskView {
  return {
    taskId: e.taskId, runId: e.runId, revision, aggregateRevision: e.aggregateRevision, title: null, role: null, dependsOn: [], status: 'planned',
    statusReason: null, placementBlock: null, cancelRequested: null, cancelReason: null, supersededByRevision: null, attemptIds: [], activeAttemptId: null,
    enteredStatusAt: e.occurredAt, latestEvidence: null,
  };
}

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

function runWith(snap: ProjectViewSnapshot, e: ProjectViewEvent): ProjectViewSnapshot {
  if (snap.runs[e.runId]) return snap;
  return { ...snap, runs: put(snap.runs, e.runId, { runId: e.runId, lifecycle: 'planning', planRevision: 0 }) };
}

// ---- the projection -------------------------------------------------------------------------------------------------------------
/** Returns the next snapshot, or null when the event does not apply (stale revision, or an attempt that is not the active one). */
function project(snap0: ProjectViewSnapshot, e: ProjectViewEvent): ProjectViewSnapshot | null {
  const p = e.payload;
  const at = e.occurredAt;
  let snap = runWith(snap0, e);

  // Run-level events.
  if (e.type === 'run.created' || e.type === 'plan.accepted' || e.type === 'run.reverted') {
    const run = snap.runs[e.runId]!;
    const lifecycle: RunStatus =
      oneOf(p, 'lifecycle', RUN_STATUSES) ?? (e.type === 'run.created' ? 'planning' : 'running');
    const planRevision = int(p, 'planRevision', 1) ?? run.planRevision;
    return { ...snap, runs: put(snap.runs, e.runId, { ...run, lifecycle, planRevision }) };
  }

  // Task-level events. An event for an older revision, or older than the task's aggregate revision, is stale.
  const existing = snap.tasks[e.taskId];
  const hintedRevision = int(p, 'revision', 1);
  if (existing && hintedRevision !== null && hintedRevision < existing.revision) return null;
  if (existing && e.aggregateRevision < existing.aggregateRevision) return null;
  let task: TaskView = existing ?? newTask(e, hintedRevision ?? 1);
  if (existing && hintedRevision !== null && hintedRevision > existing.revision) {
    task = {
      ...newTask(e, hintedRevision), title: existing.title, role: existing.role, dependsOn: existing.dependsOn, attemptIds: existing.attemptIds,
    };
  }
  task = {
    ...task, aggregateRevision: e.aggregateRevision, title: str(p, 'title') ?? task.title, role: str(p, 'role') ?? task.role,
    dependsOn: strList(p, 'dependsOn') ?? task.dependsOn,
  };
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

    case 'placement.decided': {
      const w = workerFor(snap, e.attemptId);
      if (!w || !attempt || attempt.outcome !== 'running') return commit(task);
      const target = oneOf(p, 'target', ['local', 'cloud'] as const);
      const route = oneOf(p, 'modelRoute', ['device', 'cloud', 'unknown'] as const);
      return commit(task, { ...snap, workers: put(snap.workers, w.workerId, { ...w, execution: target ?? w.execution, modelRoute: route ?? w.modelRoute }) });
    }

    case 'attempt.started': {
      if (task.activeAttemptId !== null && snap.attempts[task.activeAttemptId]?.outcome === 'running') {
        const cur = snap.attempts[task.activeAttemptId]!;
        const fence = int(p, 'fence', 0);
        if (fence !== null && cur.fence !== null && fence < cur.fence) return null;
      }
      const attemptId = e.attemptId;
      if (attemptId === null || snap.attempts[attemptId]) return null;
      const runnerId = str(p, 'runnerId');
      const workerId = runnerId ?? `attempt:${attemptId}`;
      const next: AttemptView = {
        attemptId, taskId: task.taskId, number: int(p, 'attemptNumber', 1) ?? task.attemptIds.length + 1, fence: int(p, 'fence', 0), outcome: 'running',
        exitReason: null, runnerId, startedAt: at, endedAt: null, lastHeartbeatAt: null,
      };
      const location = oneOf(p, 'location', ['local', 'cloud'] as const);
      const prior = snap.workers[workerId];
      const worker: WorkerView = {
        workerId, taskId: task.taskId, taskRevision: task.revision, attemptId, availability: 'assigned', activity: 'planning', health: 'healthy', leaseHeld: true,
        stateReason: null, enteredStateAt: at, latestAction: null, latestEvidence: null, lastHeartbeatAt: at,
        execution: location ?? prior?.execution ?? 'unknown', modelRoute: oneOf(p, 'modelRoute', ['device', 'cloud', 'unknown'] as const) ?? prior?.modelRoute ?? 'unknown',
        blockedByTaskIds: [], blockedByApprovalId: null,
      };
      const t = withEvidence({ ...moveTask(task, 'running', null, at), placementBlock: null, activeAttemptId: attemptId, attemptIds: [...task.attemptIds, attemptId] }, 'attempt.started');
      return commit(t, { ...snap, attempts: put(snap.attempts, attemptId, next), workers: put(snap.workers, workerId, worker) });
    }

    case 'attempt.heartbeat': {
      if (!attempt || !activeOk()) return null;
      const w = workerFor(snap, attempt.attemptId);
      if (!w) return null;
      const activity = oneOf<WorkerActivity>(p, 'activity', WORKER_ACTIVITY) ?? w.activity;
      const tool = str(p, 'tool');
      // A heartbeat proves the connection, not progress: only a reported tool event counts as evidence.
      const action = tool ? { tool, summary: str(p, 'summary'), longRunning: bool(p, 'longRunning'), at } : w.latestAction;
      const worker: WorkerView = {
        ...w, activity, latestAction: action, lastHeartbeatAt: at, health: w.health === 'failed' ? 'failed' : 'healthy',
        latestEvidence: tool ? evidence('tool_event', e.eventId, at) : w.latestEvidence,
        enteredStateAt: activity !== w.activity ? at : w.enteredStateAt,
      };
      return commit(tool ? withEvidence(task, 'tool_event') : task, {
        ...snap, workers: put(snap.workers, w.workerId, worker), attempts: put(snap.attempts, attempt.attemptId, { ...attempt, lastHeartbeatAt: at }),
      });
    }

    case 'attempt.completed': {
      if (!attempt || !activeOk()) return null;
      const w = workerFor(snap, attempt.attemptId);
      const next = { ...attempt, outcome: 'succeeded' as const, endedAt: at };
      const t = withEvidence({ ...moveTask(task, 'verifying', null, at), activeAttemptId: null }, 'attempt.completed');
      return commit(t, {
        ...snap, attempts: put(snap.attempts, attempt.attemptId, next),
        workers: w ? put(snap.workers, w.workerId, idleWorker(w, at, { leaseHeld: false, latestEvidence: evidence('attempt.completed', e.eventId, at) })) : snap.workers,
      });
    }

    case 'attempt.failed': {
      if (!attempt || !activeOk()) return null;
      const reason = str(p, 'reason');
      const lost = reason !== null && LEASE_LOSS_REASONS.includes(reason);
      const interrupted = lost || reason === 'attempt_timeout';
      const w = workerFor(snap, attempt.attemptId);
      const next = { ...attempt, outcome: interrupted ? ('interrupted' as const) : ('failed' as const), exitReason: reason, endedAt: at };
      const t = withEvidence({ ...moveTask(task, 'failed', reason, at), activeAttemptId: null }, 'attempt.failed');
      // Lost connection keeps the last confirmed activity; it is shown disconnected, never as idle or finished.
      const worker = w
        ? lost
          ? { ...w, availability: 'offline' as const, health: 'disconnected' as const, leaseHeld: false, stateReason: reason, enteredStateAt: at }
          : idleWorker(w, at, { leaseHeld: false, health: reason === 'worker_crashed' ? 'failed' : 'healthy', stateReason: reason })
        : null;
      return commit(t, { ...snap, attempts: put(snap.attempts, attempt.attemptId, next), workers: worker ? put(snap.workers, worker.workerId, worker) : snap.workers });
    }

    case 'approval.requested': {
      const approvalId = str(p, 'approvalId') ?? `apr_${e.eventId}`;
      const approval: ApprovalView = {
        approvalId, taskId: task.taskId, taskRevision: task.revision, runId: e.runId, scopeHash: str(p, 'scopeHash'), reason: str(p, 'reason'), state: 'pending',
        requestedAt: at, expiresAt: iso(p, 'expiresAt'), resolvedAt: null,
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
      return commit({ ...moveTask(task, 'blocked', reason, at), activeAttemptId: null }, { ...snap, attempts, workers });
    }

    case 'verification.started':
    case 'verification.passed':
    case 'verification.failed': {
      const checkId = str(p, 'checkId') ?? `${task.taskId}:verification`;
      const state = e.type === 'verification.started' ? ('running' as const) : e.type === 'verification.passed' ? ('passed' as const) : ('failed' as const);
      const check = { checkId, taskId: task.taskId, state, summary: str(p, 'summary'), updatedAt: at, evidenceRef: e.eventId };
      const status: TaskStatus = state === 'running' ? 'verifying' : state === 'passed' ? 'verified' : 'failed';
      const moved = moveTask(task, status, state === 'failed' ? (str(p, 'reason') ?? 'verification_failed') : null, at);
      return commit(withEvidence(moved, e.type), { ...snap, checks: put(snap.checks, checkId, check) });
    }

    case 'candidate.failed': {
      const checkId = `candidate:${task.taskId}`;
      const check = { checkId, taskId: task.taskId, state: 'failed' as const, summary: str(p, 'summary') ?? str(p, 'reason'), updatedAt: at, evidenceRef: e.eventId };
      return commit(withEvidence(task, e.type), { ...snap, checks: put(snap.checks, checkId, check) });
    }

    case 'candidate.assembled':
    case 'change.proposed':
      return commit(withEvidence(task, e.type));

    case 'change.merged':
      return commit(withEvidence(moveTask(task, 'merged', null, at), e.type));

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
      const blocked = str(p, 'blockedReason');
      return commit(withEvidence(moveTask(task, blocked ? 'blocked' : 'verifying', blocked, at), e.type));
    }

    default: {
      // Exhaustive over the domain's event types. A new type fails to compile here until it is projected or ignored on purpose.
      const _never: never = e.type;
      void _never;
      return null;
    }
  }
}

/**
 * Applies one event. The cursor must advance by exactly one: a gap or a reordering returns `resync` and leaves the state untouched, so the
 * caller fetches a new snapshot instead of guessing. A replayed event id is a `duplicate` and changes nothing. An event that does not
 * apply (stale revision, not the active attempt) is `ignored` but still advances the cursor, because the sequence was received.
 */
export function applyEvent(state: ProjectionState, event: ProjectViewEvent): ApplyResult {
  const snap = state.snapshot;
  if (state.recentEventIds.includes(event.eventId)) return { outcome: 'duplicate', state };
  if (event.projectId !== snap.meta.projectId) return { outcome: 'resync', reason: 'wrong_project', state };
  // Simulated events must never merge into observed state, or the reverse.
  if (event.provenance !== snap.meta.provenance) return { outcome: 'resync', reason: 'provenance_mismatch', state };
  const cursor = cursorToSequence(snap.meta.cursor);
  if (event.sequence <= cursor) return { outcome: 'resync', reason: 'out_of_order', state };
  if (event.sequence !== cursor + 1) return { outcome: 'resync', reason: 'gap', state };

  const projected = project(snap, event);
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
