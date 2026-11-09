import type { Tone } from '@selarikru/ui';
import {
  INFERENCE_LABELS, OBSERVED_SOURCE_LABELS, effectiveWorkerHealth, isEmptyProject, usageFor, verifiedCounts,
  type ProjectViewSnapshot, type RunView, type TaskView, type UsageTotal, type WorkerHealthReading, type WorkerView,
} from '@selarikru/view-protocol';
import { ATTENTION_ORDER, buildAttention, type AttentionItem } from './attention.ts';

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
  readonly criteriaLabel: string;
  readonly run: RunView | null;
  readonly tasks: readonly TaskRow[];
  /** The top non-informational attention item; null when nothing blocks delivery. */
  readonly blocker: string | null;
}

export interface FleetRow {
  readonly workerId: string;
  readonly role: string | null;
  readonly taskTitle: string | null;
  readonly activity: { readonly label: string; readonly tone: Tone };
  readonly health: { readonly state: WorkerHealthReading['health']; readonly label: string; readonly tone: Tone };
  readonly heartbeatAgeMs: number | null;
  /** The last time this worker's state was confirmed, for "state last confirmed at". */
  readonly lastConfirmedAt: string;
  readonly execution: WorkerView['execution'];
  readonly modelRoute: WorkerView['modelRoute'];
}

export interface FleetModel {
  readonly rows: readonly FleetRow[];
  readonly summary: { readonly working: number; readonly waiting: number; readonly idle: number; readonly lost: number };
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
  readonly headline: string;
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

function taskRow(t: TaskView): TaskRow {
  const placed = t.placementBlock !== null;
  const s = STATUS[t.status];
  const label = placed ? 'Cannot be placed' : t.status === 'superseded' && t.supersededByRevision !== null ? `Superseded by revision ${t.supersededByRevision}` : s.label;
  const tone: Tone = placed ? (t.placementBlock!.startsWith('approval_required:') ? 'warning' : 'danger') : s.tone;
  const cell = placed ? 'held' : (CELL[t.status] ?? null);
  return { taskId: t.taskId, title: t.title ?? t.taskId, role: t.role, statusLabel: label, tone, cell };
}

/** The run a project overview follows: the latest one that is still moving, otherwise the latest one. */
export function activeRun(snapshot: ProjectViewSnapshot): RunView | null {
  const runs = Object.values(snapshot.runs);
  return runs.filter((r) => !['merged', 'failed', 'cancelled'].includes(r.lifecycle)).at(-1) ?? runs.at(-1) ?? null;
}

function delivery(snapshot: ProjectViewSnapshot, attention: readonly AttentionItem[]): DeliveryModel {
  const { verified, total } = verifiedCounts(snapshot);
  const tasks = Object.values(snapshot.tasks).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)).map(taskRow);
  return {
    verified, total, criteriaLabel: `${verified} of ${total} criteria verified`, run: activeRun(snapshot), tasks,
    blocker: attention.find((i) => i.kind !== 'information')?.title ?? null,
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
const WAITING: readonly NonNullable<WorkerView['activity']>[] = ['waiting_dependency', 'waiting_human', 'waiting_resource', 'blocked_policy'];

function activityOf(w: WorkerView, snapshot: ProjectViewSnapshot): { label: string; tone: Tone } {
  if (w.availability === 'offline') return { label: 'Offline', tone: 'neutral' };
  if (w.activity === null) return w.availability === 'idle' ? { label: 'Idle', tone: 'neutral' } : { label: 'Activity unknown', tone: 'neutral' };
  if (w.activity === 'waiting_dependency' && w.blockedByTaskIds.length > 0) {
    const on = w.blockedByTaskIds.map((id) => snapshot.tasks[id]?.title ?? id).join(', ');
    return { label: `Waiting on ${on}`, tone: 'neutral' };
  }
  return ACTIVITY[w.activity];
}

const HEALTH: Readonly<Record<WorkerHealthReading['health'], { label: string; tone: Tone }>> = {
  healthy: { label: 'Healthy', tone: 'success' },
  suspected_stall: { label: 'Connected; progress may be stalled', tone: 'warning' },
  disconnected: { label: 'Connection lost', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  unknown: { label: 'Health unknown', tone: 'warning' },
};

function fleet(snapshot: ProjectViewSnapshot, nowMs: number, livenessAsOfMs: number | null): FleetModel {
  const summary = { working: 0, waiting: 0, idle: 0, lost: 0 };
  const rows = Object.values(snapshot.workers).map((w): FleetRow => {
    const reading = effectiveWorkerHealth(w, nowMs, livenessAsOfMs);
    const task = w.taskId !== null ? snapshot.tasks[w.taskId] : undefined;
    if (reading.health === 'disconnected' || reading.health === 'failed') summary.lost += 1;
    else if (w.activity !== null && WAITING.includes(w.activity)) summary.waiting += 1;
    else if (w.availability === 'idle') summary.idle += 1;
    else if (w.availability === 'assigned') summary.working += 1;
    return {
      workerId: w.workerId, role: task?.role ?? null, taskTitle: task ? (task.title ?? task.taskId) : null, activity: activityOf(w, snapshot),
      health: { state: reading.health, ...HEALTH[reading.health] }, heartbeatAgeMs: reading.heartbeatAgeMs, lastConfirmedAt: w.lastHeartbeatAt ?? w.enteredStateAt,
      execution: w.execution, modelRoute: w.modelRoute,
    };
  });
  return { rows, summary };
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

/** Everything Mission Control shows, derived from one snapshot. Pure; time and liveness are parameters. */
export function buildOverview(snapshot: ProjectViewSnapshot, nowMs: number, livenessAsOfMs: number | null): OverviewModel {
  const attention = buildAttention(snapshot, nowMs, livenessAsOfMs);
  const needsYou = attention.filter((i) => i.kind !== ATTENTION_ORDER[ATTENTION_ORDER.length - 1]).length;
  const headline = needsYou === 0 ? 'Nothing needs you right now.' : `${needsYou} ${needsYou === 1 ? 'item needs' : 'items need'} you. Start with ${attention[0]!.title}.`;
  return {
    empty: isEmptyProject(snapshot), simulated: snapshot.meta.provenance === 'simulated', attention, needsYou, headline,
    delivery: delivery(snapshot, attention), fleet: fleet(snapshot, nowMs, livenessAsOfMs), evidence: evidence(snapshot), usage: usage(snapshot),
  };
}
