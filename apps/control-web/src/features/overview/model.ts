import type { Tone } from '@selarikru/ui';
import {
  INFERENCE_LABELS, OBSERVED_SOURCE_LABELS, effectiveWorkerHealth, isEmptyProject, usageFor, verifiedCounts,
  type ProjectViewSnapshot, type RunView, type TaskView, type UsageTotal, type WorkerHealthReading, type WorkerView,
} from '@selarikru/view-protocol';
import { buildAttention, type AttentionItem } from './attention.ts';

export type CriterionCell = 'verified' | 'failed' | 'held' | 'active' | 'pending';

export interface TaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly role: string | null;
  readonly statusLabel: string;
  readonly tone: Tone;
  readonly cell: CriterionCell | null;
}

export interface DeliveryModel {
  readonly verified: number;
  readonly total: number;
  /** "n of m criteria verified" when per-criterion evidence exists, otherwise "n of m tasks verified". */
  readonly criteriaLabel: string;
  /** Visible qualifier for the task-count fallback; null when the label is about criteria. */
  readonly criteriaNote: string | null;
  /** One cell per criterion, or per task in the fallback. Only `verified` is ever drawn filled. */
  readonly segments: readonly CriterionCell[];
  readonly run: RunView | null;
  readonly tasks: readonly TaskRow[];
  /** The top non-informational attention item; null when nothing blocks delivery. */
  readonly blocker: string | null;
}

export interface FleetRow {
  readonly workerId: string;
  readonly role: string | null;
  readonly taskTitle: string | null;
  /** `reported` is false when nothing has said what the worker is doing, so the view can keep that quiet. */
  readonly activity: { readonly label: string; readonly tone: Tone; readonly reported: boolean };
  readonly health: WorkerHealthDisplay;
  readonly heartbeatAgeMs: number | null;
  /** The last time this worker's state was confirmed, for "state last confirmed at". */
  readonly lastConfirmedAt: string;
  readonly execution: WorkerView['execution'];
  readonly modelRoute: WorkerView['modelRoute'];
}

export interface FleetModel {
  readonly rows: readonly FleetRow[];
  readonly summary: FleetSummary;
}

export interface EvidenceRow {
  readonly id: string;
  readonly stateLabel: string;
  readonly tone: Tone;
  readonly summary: string;
  readonly subject: string | null;
  readonly at: string;
}

export interface UsageModel {
  readonly spend: UsageTotal;
  readonly inputTokens: UsageTotal;
  readonly outputTokens: UsageTotal;
  readonly workerSeconds: UsageTotal;
  readonly capacity: { readonly running: number; readonly local: number; readonly cloud: number; readonly unknown: number };
  /** The browser assistant's own axis. `observed` is null when it has not run. */
  readonly assistant: { readonly requested: string; readonly observed: string | null };
}

export interface OverviewModel {
  readonly empty: boolean;
  readonly simulated: boolean;
  readonly attention: readonly AttentionItem[];
  readonly needsYou: number;
  /** True while what is shown may no longer be current: the session is not live, or worker liveness is stale. */
  readonly stale: boolean;
  /** Null when nothing needs saying: the attention panel already says so, and repeating it makes a calm screen noisy. */
  readonly headline: string | null;
  /** The aggregate count for the header; null when live with nothing to count. */
  readonly attentionCount: string | null;
  /** The same count for the narrow header. `?` marks a count that may be out of date. */
  readonly attentionBadge: string | null;
  /** What to say to a screen reader about attention, once per change. */
  readonly announcement: string;
  readonly delivery: DeliveryModel;
  readonly fleet: FleetModel;
  readonly evidence: readonly EvidenceRow[];
  readonly usage: UsageModel;
}

const STATUS: Readonly<Record<TaskView['status'], { label: string; tone: Tone }>> = {
  planned: { label: 'Planned', tone: 'neutral' },
  ready: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'active' },
  awaiting_approval: { label: 'Needs decision', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'warning' },
  verifying: { label: 'Verifying', tone: 'active' },
  verified: { label: 'Verified; awaiting merge', tone: 'success' },
  merged: { label: 'Merged', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

const CELL: Readonly<Partial<Record<TaskView['status'], CriterionCell>>> = {
  verified: 'verified', merged: 'verified', failed: 'failed', blocked: 'held', awaiting_approval: 'held', running: 'active', verifying: 'active', ready: 'pending', planned: 'pending',
};
const ORDER: readonly TaskView['status'][] = ['failed', 'blocked', 'awaiting_approval', 'running', 'verifying', 'ready', 'planned', 'verified', 'merged', 'cancelled', 'superseded'];

export function taskRow(t: TaskView): TaskRow {
  const placed = t.placementBlock !== null;
  const s = STATUS[t.status];
  const label = placed ? 'Cannot be placed' : t.status === 'superseded' && t.supersededByRevision !== null ? `Superseded by revision ${t.supersededByRevision}` : s.label;
  const tone: Tone = placed ? (t.placementBlock!.startsWith('approval_required:') ? 'warning' : 'danger') : s.tone;
  // Work stopped for budget still counts towards delivery, as unmet.
  const cell = placed || (t.status === 'cancelled' && t.cancelReason === 'budget_exhausted') ? 'held' : (CELL[t.status] ?? null);
  return { taskId: t.taskId, title: t.title ?? t.taskId, role: t.role, statusLabel: label, tone, cell };
}

/** The run a project overview follows: the latest one that is still moving, otherwise the latest one. */
export function activeRun(snapshot: ProjectViewSnapshot): RunView | null {
  const runs = Object.values(snapshot.runs);
  return runs.filter((r) => !['merged', 'failed', 'cancelled'].includes(r.lifecycle)).at(-1) ?? runs.at(-1) ?? null;
}

function delivery(snapshot: ProjectViewSnapshot, attention: readonly AttentionItem[]): DeliveryModel {
  const run = activeRun(snapshot);
  const scoped = run ? Object.values(snapshot.tasks).filter((t) => t.runId === run.runId) : Object.values(snapshot.tasks);
  const taskCounts = verifiedCounts(snapshot, run?.runId);
  const tasks = scoped.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)).map(taskRow);
  const criteria = run?.criteria ?? null;
  const { verified, total } = criteria ?? taskCounts;
  const blocker = attention.find((i) => i.needsOperator && i.status !== 'review' && !i.closedRecord)?.title ?? null;
  const segments: CriterionCell[] = criteria
    ? [...Array<CriterionCell>(criteria.verified).fill('verified'), ...Array<CriterionCell>(Math.max(0, criteria.total - criteria.verified)).fill('pending')]
    : tasks.flatMap((t) => (t.cell === null ? [] : [t.cell])).sort((a, b) => Number(b === 'verified') - Number(a === 'verified'));
  return {
    verified, total, run, tasks, segments, blocker,
    criteriaLabel: criteria ? `${verified} of ${total} criteria verified` : `${verified} of ${total} tasks verified`,
    criteriaNote: criteria ? null : 'Per-criterion evidence is not connected, so this counts tasks.',
  };
}

const ACTIVITY: Readonly<Record<NonNullable<WorkerView['activity']>, { label: string; tone: Tone }>> = {
  planning: { label: 'Planning', tone: 'active' },
  coding: { label: 'Coding', tone: 'active' },
  testing: { label: 'Testing', tone: 'active' },
  reviewing: { label: 'Reviewing', tone: 'active' },
  waiting_dependency: { label: 'Waiting on another task', tone: 'neutral' },
  waiting_human: { label: 'Needs decision', tone: 'warning' },
  waiting_resource: { label: 'Waiting for capacity', tone: 'neutral' },
  blocked_policy: { label: 'Blocked by policy', tone: 'danger' },
};
export const WAITING: readonly NonNullable<WorkerView['activity']>[] = ['waiting_dependency', 'waiting_human', 'waiting_resource', 'blocked_policy'];

export function activityOf(w: WorkerView, snapshot: ProjectViewSnapshot): FleetRow['activity'] {
  if (w.availability === 'offline') return { label: 'Offline', tone: 'neutral', reported: true };
  if (w.activity === null) return w.availability === 'idle' ? { label: 'Idle', tone: 'neutral', reported: true } : { label: 'Activity not reported', tone: 'neutral', reported: false };
  if (w.activity === 'waiting_dependency' && w.blockedByTaskIds.length > 0) {
    const on = w.blockedByTaskIds.map((id) => snapshot.tasks[id]?.title ?? id).join(', ');
    return { label: `Waiting on ${on}`, tone: 'neutral', reported: true };
  }
  return { ...ACTIVITY[w.activity], reported: true };
}

/** `no_lease`: a worker that holds no attempt lease sends no heartbeat, so there is nothing to call healthy. */
export type WorkerHealthState = WorkerHealthReading['health'] | 'no_lease';
export interface WorkerHealthDisplay {
  readonly state: WorkerHealthState;
  readonly label: string;
  readonly tone: Tone;
}

const HEALTH: Readonly<Record<WorkerHealthState, { label: string; tone: Tone }>> = {
  healthy: { label: 'Healthy', tone: 'success' },
  suspected_stall: { label: 'Connected; progress may be stalled', tone: 'warning' },
  disconnected: { label: 'Connection lost', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  unknown: { label: 'Health unknown', tone: 'warning' },
  no_lease: { label: 'No active attempt', tone: 'neutral' },
};

/** What a view may say about a worker's connection. `stale` means the session is not live, so nothing here can be called healthy. */
export function workerHealthDisplay(w: WorkerView, reading: WorkerHealthReading, stale: boolean): WorkerHealthDisplay {
  const state: WorkerHealthState = reading.health !== 'healthy' ? reading.health : stale ? 'unknown' : w.leaseHeld ? 'healthy' : 'no_lease';
  return { state, ...HEALTH[state] };
}

export interface FleetSummary {
  readonly working: number;
  readonly waiting: number;
  readonly idle: number;
  readonly lost: number;
}

/** Counts the fleet. A loss already seen at the last confirmed time stays counted while the current reading is unknown. */
export function countFleet(workers: readonly WorkerView[], nowMs: number, livenessAsOfMs: number | null, lastConfirmedMs: number | null): FleetSummary {
  const summary = { working: 0, waiting: 0, idle: 0, lost: 0 };
  for (const w of workers) {
    const reading = effectiveWorkerHealth(w, nowMs, livenessAsOfMs);
    const counted = reading.health === 'unknown' && lastConfirmedMs !== null ? effectiveWorkerHealth(w, lastConfirmedMs, lastConfirmedMs).health : reading.health;
    if (counted === 'disconnected' || counted === 'failed') summary.lost += 1;
    else if (w.activity !== null && WAITING.includes(w.activity)) summary.waiting += 1;
    else if (w.availability === 'idle') summary.idle += 1;
    else if (w.availability === 'assigned') summary.working += 1;
  }
  return summary;
}

function fleet(snapshot: ProjectViewSnapshot, nowMs: number, livenessAsOfMs: number | null, lastConfirmedMs: number | null, stale: boolean): FleetModel {
  const workers = Object.values(snapshot.workers);
  const rows = workers.map((w): FleetRow => {
    const reading = effectiveWorkerHealth(w, nowMs, livenessAsOfMs);
    const task = w.taskId !== null ? snapshot.tasks[w.taskId] : undefined;
    return {
      workerId: w.workerId, role: task?.role ?? null, taskTitle: task ? (task.title ?? task.taskId) : null, activity: activityOf(w, snapshot),
      health: workerHealthDisplay(w, reading, stale), heartbeatAgeMs: reading.heartbeatAgeMs, lastConfirmedAt: w.lastHeartbeatAt ?? w.enteredStateAt,
      execution: w.execution, modelRoute: w.modelRoute,
    };
  });
  return { rows, summary: countFleet(workers, nowMs, livenessAsOfMs, lastConfirmedMs) };
}

const CHECK_STATE = { passed: { stateLabel: 'Passed', tone: 'success' }, failed: { stateLabel: 'Failed', tone: 'danger' }, running: { stateLabel: 'Running', tone: 'active' } } as const;
const RUN_EVIDENCE: Readonly<Record<string, { stateLabel: string; tone: Tone; summary: string }>> = {
  'candidate.assembled': { stateLabel: 'Assembled', tone: 'active', summary: 'Candidate assembled for review' },
  'candidate.failed': { stateLabel: 'Failed', tone: 'danger', summary: 'Candidate failed to assemble' },
  'change.proposed': { stateLabel: 'Proposed', tone: 'active', summary: 'Pull request proposed' },
  'change.merged': { stateLabel: 'Merged', tone: 'success', summary: 'Merged on GitHub by a person' },
  'run.reverted': { stateLabel: 'Reverted', tone: 'warning', summary: 'Run reverted' },
};

function evidence(snapshot: ProjectViewSnapshot): EvidenceRow[] {
  const rows: EvidenceRow[] = Object.values(snapshot.checks).map((c) => {
    const task = c.taskId !== null ? snapshot.tasks[c.taskId] : undefined;
    return { id: c.checkId, ...CHECK_STATE[c.state], summary: c.summary ?? c.checkId, subject: task ? (task.title ?? task.taskId) : null, at: c.updatedAt };
  });
  for (const run of Object.values(snapshot.runs)) {
    const shape = run.latestEvidence ? RUN_EVIDENCE[run.latestEvidence.kind] : undefined;
    if (run.latestEvidence && shape) rows.push({ id: `${run.runId}:${run.latestEvidence.ref}`, ...shape, subject: null, at: run.latestEvidence.at });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
}

function usage(snapshot: ProjectViewSnapshot): UsageModel {
  const capacity = { running: 0, local: 0, cloud: 0, unknown: 0 };
  for (const w of Object.values(snapshot.workers)) {
    if (!w.leaseHeld) continue;
    capacity.running += 1;
    capacity[w.execution] += 1;
  }
  const { mode, observedSource } = snapshot.assistant;
  return {
    spend: usageFor(snapshot.usage, 'cost_usd'), inputTokens: usageFor(snapshot.usage, 'input_tokens'), outputTokens: usageFor(snapshot.usage, 'output_tokens'), workerSeconds: usageFor(snapshot.usage, 'worker_seconds'),
    capacity, assistant: mode === null ? { requested: 'Not used yet', observed: null } : { requested: INFERENCE_LABELS[mode], observed: OBSERVED_SOURCE_LABELS[observedSource] },
  };
}

const items = (n: number, verb: [string, string]): string => `${n} ${n === 1 ? `item ${verb[0]}` : `items ${verb[1]}`}`;

export interface OverviewOptions {
  /** When liveness last refreshed, whatever the session's state now. Stale worker readings are taken at this time and labelled. */
  readonly lastConfirmedMs?: number | null;
  /** True when the session is not live, so nothing here can be called current. */
  readonly stale?: boolean;
}

/** Everything Mission Control shows, derived from one snapshot. Pure; time and liveness are parameters. */
export function buildOverview(snapshot: ProjectViewSnapshot, nowMs: number, livenessAsOfMs: number | null, options: OverviewOptions = {}): OverviewModel {
  const attention = buildAttention(snapshot, nowMs, livenessAsOfMs, options.lastConfirmedMs ?? null);
  const needsYou = attention.filter((i) => i.needsOperator).length;
  const fleetModel = fleet(snapshot, nowMs, livenessAsOfMs, options.lastConfirmedMs ?? null, options.stale === true);
  const workersUnknown = fleetModel.rows.some((r) => r.health.state === 'unknown');
  const stale = options.stale === true || workersUnknown;

  let headline: string | null;
  let attentionCount: string | null;
  let attentionBadge: string | null;
  let announcement: string;
  if (stale) {
    const workers = workersUnknown ? 'Worker connections are unknown.' : '';
    headline = needsYou > 0
      ? `${items(needsYou, ['needed', 'needed'])} you at the last confirmed state.${workers ? ` ${workers}` : ''}`
      : workers ? `${workers} Showing the last confirmed state.` : 'Showing the last confirmed state, which may be out of date.';
    attentionCount = needsYou > 0 ? `${needsYou} ${needsYou === 1 ? 'item' : 'items'} at last confirmed state` : 'Attention unknown';
    attentionBadge = needsYou > 0 ? `${needsYou}?` : '?';
    announcement = needsYou > 0 ? `${items(needsYou, ['needed', 'needed'])} attention at the last confirmed state.` : 'Attention is unknown until the connection returns.';
  } else {
    headline = needsYou === 0 ? null : `${items(needsYou, ['needs', 'need'])} you.`;
    attentionCount = needsYou === 0 ? null : `${needsYou} ${needsYou === 1 ? 'needs' : 'need'} attention`;
    attentionBadge = needsYou === 0 ? null : String(needsYou);
    announcement = needsYou === 0 ? 'Nothing needs attention.' : `${items(needsYou, ['needs', 'need'])} attention.`;
  }

  return {
    empty: isEmptyProject(snapshot), simulated: snapshot.meta.provenance === 'simulated', attention, needsYou, stale, headline, attentionCount, attentionBadge, announcement,
    delivery: delivery(snapshot, attention), fleet: fleetModel, evidence: evidence(snapshot), usage: usage(snapshot),
  };
}
