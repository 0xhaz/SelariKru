import { formatAge, formatCount, formatDuration, formatExact, formatUsd, type Tone } from '@selarikru/ui';
import {
  approvalStateAt, effectiveWorkerHealth, runnerRecent, usageFor,
  type AttemptView, type CheckView, type ProjectViewSnapshot, type TaskView, type UsageEntry, type UsageProvenance, type WorkerActivity, type WorkerHealthReading, type WorkerView,
} from '@selarikru/view-protocol';
import { explain, requestText, sentence } from '../overview/attention.ts';
import { activityOf, countFleet, taskRow, workerHealthDisplay, type WorkerHealthDisplay } from '../overview/model.ts';
import { buildAssignments, taskTarget, type AssignmentsModel, type AssignmentTarget } from './assignments.ts';

export type SortKey = 'attention' | 'role' | 'task' | 'activity' | 'runtime' | 'progress';
export const SORT_KEYS: readonly { key: SortKey; label: string }[] = [
  { key: 'attention', label: 'Attention' }, { key: 'role', label: 'Role' }, { key: 'task', label: 'Task' }, { key: 'activity', label: 'Activity' }, { key: 'runtime', label: 'Runtime' }, { key: 'progress', label: 'Last progress' },
];

export interface FleetFilter {
  readonly runtime: 'all' | WorkerView['execution'];
  /** A provider seen on a recorded attempt, or `unknown` for workers with no record. */
  readonly provider: string;
  readonly role: string;
  readonly run: string;
  readonly blockedOnly: boolean;
}
export const NO_FILTER: FleetFilter = { runtime: 'all', provider: 'all', role: 'all', run: 'all', blockedOnly: false };

export interface ActivitySignal {
  readonly label: string;
  readonly tone: Tone;
  /** False when nothing has said what the worker is doing. The view then shows one muted label and nothing else. */
  readonly reported: boolean;
  /** True when this is the last value confirmed before the connection or the session went stale. */
  readonly stale: boolean;
  /** Time in this state, as an age; null when unreported. */
  readonly since: string | null;
  /** The current tool or action when one was observed. */
  readonly tool: string | null;
}

export interface ResultSignal {
  /** False when no check or artifact exists yet. */
  readonly known: boolean;
  readonly label: string;
  readonly tone: Tone;
  readonly detail: string | null;
  readonly at: string | null;
}

export interface SpendSignal {
  readonly value: string;
  readonly provenance: UsageProvenance;
  /** A lower bound when some figures are missing. A lower bound is never presented as the total. */
  readonly note: string | null;
}

export interface TaskRef {
  readonly taskId: string;
  readonly title: string;
  readonly revision: number;
}

export interface TaskDetail extends TaskRef {
  /** False when the worker is idle and this is the work it last did. */
  readonly current: boolean;
  readonly role: string | null;
  readonly statusLabel: string;
  readonly statusTone: Tone;
  readonly reason: string | null;
  readonly reasonCode: string | null;
  /** Null when the dependencies are not known. Empty means none. */
  readonly dependencies: readonly { readonly taskId: string; readonly title: string; readonly status: string }[] | null;
  readonly attempt: string | null;
  readonly runId: string;
  readonly runCriteria: string | null;
}

export interface Blocker {
  readonly kind: string;
  readonly text: string;
  readonly code: string | null;
}

export interface TimelineEntry {
  readonly at: string;
  readonly label: string;
  readonly detail: string | null;
  readonly source: string;
}

export interface CheckEntry {
  readonly checkId: string;
  readonly label: string;
  readonly tone: Tone;
  readonly summary: string | null;
  readonly at: string;
  readonly evidenceRef: string;
}

export interface ArtifactEntry {
  readonly label: string;
  readonly ref: string;
  readonly at: string;
}

export interface PermissionEntry {
  readonly approvalId: string;
  readonly state: string;
  readonly tone: Tone;
  readonly reason: string;
  readonly reasonCode: string | null;
  readonly scopeHash: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
  readonly resolvedAt: string | null;
}

export interface Fact {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}

export interface UsageLine {
  readonly key: string;
  readonly metric: string;
  readonly value: string;
  readonly provenance: UsageProvenance;
  readonly source: string;
  readonly attempt: string | null;
}

export interface WorkerDetail {
  /** Plain-language status reason for the drawer header. */
  readonly summary: string;
  readonly task: TaskDetail | null;
  readonly blockers: readonly Blocker[];
  readonly timeline: readonly TimelineEntry[];
  readonly checks: readonly CheckEntry[];
  readonly artifacts: readonly ArtifactEntry[];
  readonly permissions: readonly PermissionEntry[];
  readonly sandbox: readonly Fact[];
  readonly usage: readonly UsageLine[];
}

export interface TeamRow {
  readonly workerId: string;
  readonly role: string | null;
  /** The run of the task held now, or of the last one. Null when the worker has had no task. */
  readonly runId: string | null;
  /** The task held now. Null when idle or offline, in which case `lastTask` is what it last worked on. */
  readonly task: TaskRef | null;
  readonly lastTask: TaskRef | null;
  readonly activity: ActivitySignal;
  readonly health: WorkerHealthDisplay;
  readonly healthNote: string | null;
  readonly results: ResultSignal;
  readonly execution: WorkerView['execution'];
  readonly modelRoute: WorkerView['modelRoute'];
  /** What the worker's attempt was recorded to run. Null: no record, so provider and model are unknown. */
  readonly assignment: WorkerView['assignment'];
  /** The recorded model as the badge should word it: an idle worker's is its previous attempt's, not a current fact. */
  readonly modelDetail: string | null;
  /** The current or last task's own model assignment, when it can still take one. */
  readonly overrideTarget: AssignmentTarget | null;
  /** True when what is shown is the last confirmed state: the connection is lost, or the session or liveness is stale. */
  readonly stale: boolean;
  /** When this worker's state was last confirmed. */
  readonly lastConfirmedAt: string;
  readonly lastProgressAt: string;
  readonly blockers: number;
  readonly spend: SpendSignal | null;
  /** Lower is more urgent. */
  readonly attentionRank: number;
  /** The row's attention rail; null for ordinary work. */
  readonly rail: Tone | null;
  readonly detail: WorkerDetail;
}

export interface RunnerRow {
  readonly runnerId: string;
  readonly label: string | null;
  readonly location: 'local' | 'cloud';
  /** Seen recently enough for the scheduler to count it. */
  readonly recent: boolean;
  readonly lastSeenAt: string | null;
}

export interface TeamModel {
  readonly empty: boolean;
  readonly simulated: boolean;
  readonly stale: boolean;
  /** Null when there are no workers to count. */
  readonly summary: string | null;
  readonly rows: readonly TeamRow[];
  readonly roles: readonly string[];
  readonly runs: readonly string[];
  /** Providers on recorded attempts; `unknown` is listed only if some worker has no record. */
  readonly providers: readonly { readonly value: string; readonly label: string }[];
  readonly assignments: AssignmentsModel;
  /** Enrolled runners and whether each is still reachable, independently of any worker. */
  readonly runners: readonly RunnerRow[];
}

const ACTIVITY_RANK: Readonly<Partial<Record<WorkerActivity, number>>> = { blocked_policy: 1, waiting_human: 2 };

function attentionRank(w: WorkerView, health: WorkerHealthDisplay): number {
  if (health.state === 'disconnected' || health.state === 'failed') return 0;
  const byActivity = w.activity !== null ? ACTIVITY_RANK[w.activity] : undefined;
  if (byActivity !== undefined) return byActivity;
  if (health.state === 'suspected_stall' || health.state === 'unknown') return 3;
  if (w.activity !== null) return w.activity.startsWith('waiting') ? 4 : 5;
  if (w.availability === 'assigned') return 5;
  return w.availability === 'idle' ? 6 : 7;
}

const RAIL: readonly (Tone | null)[] = ['danger', 'danger', 'warning', 'warning', null, null, null, null];
const toolOf = (w: WorkerView): string | null => (w.latestAction ? (w.latestAction.summary ? `${w.latestAction.tool}, ${w.latestAction.summary}` : w.latestAction.tool) : null);
const lastOf = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];

function lastAttemptOf(w: WorkerView, snapshot: ProjectViewSnapshot): AttemptView | undefined {
  const own = Object.values(snapshot.attempts).filter((a) => a.runnerId === w.workerId || a.attemptId === w.attemptId);
  return lastOf([...own].sort((a, b) => a.startedAt.localeCompare(b.startedAt)));
}

const EVIDENCE: Readonly<Record<string, { label: string; tone: Tone; detail: string }>> = {
  'attempt.completed': { label: 'Not verified yet', tone: 'neutral', detail: 'Attempt finished; no verdict yet' },
  'change.proposed': { label: 'Pull request proposed', tone: 'active', detail: 'Awaiting a human merge on GitHub' },
  'change.merged': { label: 'Merged', tone: 'success', detail: 'Merged on GitHub by a person' },
};
const CHECK: Readonly<Record<'running' | 'passed' | 'failed', { label: string; tone: Tone }>> = {
  running: { label: 'Check running', tone: 'active' }, passed: { label: 'Passed', tone: 'success' }, failed: { label: 'Failed', tone: 'danger' },
};

export function checksOf(snapshot: ProjectViewSnapshot, taskId: string | null) {
  if (taskId === null) return [];
  return Object.values(snapshot.checks).filter((c) => c.taskId === taskId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const taskNow = (t: TaskView): string => (t.latestEvidence?.kind === 'task.reopened' ? 'reopened' : taskRow(t).statusLabel.toLowerCase());

export interface CheckReading {
  readonly check: CheckView;
  readonly label: string;
  readonly tone: Tone;
  /** True when the check predates the attempt this worker is on, so it says nothing about that attempt. */
  readonly earlier: boolean;
}

/** What a check still says, given where its task is now. A check carries no revision of its own, so the task's status decides whether a pass still holds. */
export function readCheck(c: CheckView, focus: TaskView | undefined, attempt: AttemptView | undefined): CheckReading {
  const earlier = attempt !== undefined && attempt.taskId === c.taskId && Date.parse(c.updatedAt) < Date.parse(attempt.startedAt);
  if (c.state === 'passed') {
    const holds = focus?.status === 'verified' || focus?.status === 'merged';
    if (holds && !earlier) return { check: c, ...CHECK.passed, earlier };
    return { check: c, label: holds || !focus ? 'Passed earlier' : `Passed earlier; task now ${taskNow(focus)}`, tone: 'neutral', earlier };
  }
  if (!earlier) return { check: c, ...CHECK[c.state], earlier };
  return { check: c, label: c.state === 'failed' ? 'Failed earlier' : 'Check started earlier', tone: 'neutral', earlier };
}

function resultOf(w: WorkerView, focus: TaskView | undefined, attempt: AttemptView | undefined, snapshot: ProjectViewSnapshot, showTask: boolean): ResultSignal {
  const readings = checksOf(snapshot, focus?.taskId ?? null).map((c) => readCheck(c, focus, attempt));
  const current = readings.filter((r) => !r.earlier);
  // A failure outranks a newer pass, so green can never hide it.
  const pick = current.find((r) => r.check.state === 'failed') ?? current.find((r) => r.check.state === 'running') ?? current[0] ?? readings[0];
  if (pick) {
    const prefix = showTask && focus ? `${focus.title ?? focus.taskId}: ` : '';
    const before = pick.earlier && attempt ? `Before attempt ${attempt.number}: ` : '';
    const body = `${before}${pick.check.summary ?? ''}`;
    const detail = `${prefix}${body}`.replace(/: $/, '') || null;
    const failedBefore = pick.check.state === 'passed' && !pick.earlier && readings.some((r) => r.check.state === 'failed');
    if (failedBefore) return { known: true, label: 'Passed; an earlier check failed', tone: 'warning', detail, at: pick.check.updatedAt };
    return { known: true, label: pick.label, tone: pick.tone, detail, at: pick.check.updatedAt };
  }
  const evidence = w.latestEvidence ?? focus?.latestEvidence ?? null;
  const shape = evidence ? EVIDENCE[evidence.kind] : undefined;
  if (evidence && shape) return { known: true, ...shape, at: evidence.at };
  return { known: false, label: 'No results yet', tone: 'neutral', detail: null, at: null };
}

function spendOf(entries: readonly UsageEntry[], taskId: string | null): SpendSignal | null {
  if (taskId === null) return null;
  const total = usageFor(entries, 'cost_usd', { taskId });
  if (total.figureCount === 0) return null;
  if (total.total === null) return { value: 'Unavailable', provenance: 'unavailable', note: total.knownSubtotal !== null ? `At least ${formatUsd(total.knownSubtotal)} known` : null };
  return { value: formatUsd(total.total), provenance: total.provenance, note: null };
}

const METRIC: Readonly<Record<UsageEntry['figure']['metric'], { label: string; format: (q: string) => string }>> = {
  cost_usd: { label: 'Model spend', format: formatUsd },
  input_tokens: { label: 'Input tokens', format: formatCount },
  output_tokens: { label: 'Output tokens', format: formatCount },
  cache_read_tokens: { label: 'Cache read tokens', format: formatCount },
  cache_creation_tokens: { label: 'Cache creation tokens', format: formatCount },
  worker_seconds: { label: 'Worker time', format: formatDuration },
};
const METRIC_ORDER = Object.keys(METRIC);

function usageLines(entries: readonly UsageEntry[], taskId: string | null): UsageLine[] {
  if (taskId === null) return [];
  return entries.filter((e) => e.taskId === taskId).sort((a, b) => METRIC_ORDER.indexOf(a.figure.metric) - METRIC_ORDER.indexOf(b.figure.metric)).map((e) => {
    const m = METRIC[e.figure.metric];
    const { quantity, provenance, source } = e.figure;
    return { key: e.entryId, metric: m.label, value: quantity === null ? 'Unavailable' : m.format(quantity), provenance, source, attempt: e.attemptId };
  });
}

function taskDetail(t: TaskView, current: boolean, attempt: AttemptView | undefined, snapshot: ProjectViewSnapshot): TaskDetail {
  const row = taskRow(t);
  const run = snapshot.runs[t.runId];
  return {
    taskId: t.taskId, title: row.title, revision: t.revision, current, role: t.role, statusLabel: row.statusLabel, statusTone: row.tone,
    reason: t.statusReason ? explain(t.statusReason) : null, reasonCode: t.statusReason,
    dependencies: t.dependsOn === null ? null : t.dependsOn.map((id) => {
      const dep = snapshot.tasks[id];
      return { taskId: id, title: dep?.title ?? id, status: dep ? taskRow(dep).statusLabel : 'Unknown' };
    }),
    attempt: attempt ? `Attempt ${attempt.number}, ${attempt.outcome}${attempt.exitReason ? `. ${explain(attempt.exitReason)}` : ''}` : null,
    runId: t.runId, runCriteria: run?.criteria ? `${run.criteria.verified} of ${run.criteria.total} criteria verified across the run` : null,
  };
}

/** The one list of what holds this worker up, for the row's count and the drawer alike. Only the task held now can block it. */
function blockersOf(w: WorkerView, held: TaskView | undefined, snapshot: ProjectViewSnapshot): Blocker[] {
  const out: Blocker[] = [];
  if (w.blockedByApprovalId !== null) {
    const a = snapshot.approvals[w.blockedByApprovalId];
    out.push({ kind: 'Waiting on a person', text: a?.reason ? requestText(a) : 'A decision is pending', code: a?.reason ?? w.blockedByApprovalId });
  }
  for (const id of w.blockedByTaskIds) {
    const t = snapshot.tasks[id];
    out.push({ kind: 'Waiting on a task', text: t ? `${t.title ?? t.taskId} (${taskRow(t).statusLabel.toLowerCase()})` : id, code: null });
  }
  if (held?.placementBlock) out.push({ kind: 'Cannot be placed', text: explain(held.placementBlock), code: held.placementBlock });
  if (w.activity === 'blocked_policy' && w.stateReason && !held?.placementBlock) out.push({ kind: 'Blocked by policy', text: explain(w.stateReason), code: w.stateReason });
  return out;
}

function timelineOf(w: WorkerView, focus: TaskView | undefined, snapshot: ProjectViewSnapshot): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  if (focus) {
    const row = taskRow(focus);
    out.push({ at: focus.enteredStatusAt, label: `Task: ${row.statusLabel}`, detail: focus.statusReason ? explain(focus.statusReason) : null, source: 'Scheduler' });
    for (const id of focus.attemptIds) {
      const a = snapshot.attempts[id];
      if (!a) continue;
      out.push({ at: a.startedAt, label: `Attempt ${a.number} started`, detail: a.runnerId, source: 'Scheduler' });
      if (a.endedAt) out.push({ at: a.endedAt, label: `Attempt ${a.number} ended: ${a.outcome}`, detail: a.exitReason ? explain(a.exitReason) : null, source: 'Scheduler' });
    }
    for (const a of Object.values(snapshot.approvals).filter((x) => x.taskId === focus.taskId)) {
      out.push({ at: a.requestedAt, label: 'Permission requested', detail: a.reason ? requestText(a) : null, source: 'Worker' });
      if (a.resolvedAt) out.push({ at: a.resolvedAt, label: `Permission ${a.state}`, detail: a.reason ? requestText(a) : null, source: 'Decision' });
    }
    for (const c of checksOf(snapshot, focus.taskId)) out.push({ at: c.updatedAt, label: `Check ${c.state}`, detail: c.summary, source: 'Verifier' });
  }
  if (w.latestAction) out.push({ at: w.latestAction.at, label: `Tool: ${w.latestAction.tool}`, detail: w.latestAction.summary, source: 'Worker' });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Evidence kinds that are results. Lifecycle events such as an attempt starting produce nothing to inspect. */
const ARTIFACT_KINDS: Readonly<Record<string, string>> = {
  'attempt.completed': 'Attempt output', 'candidate.assembled': 'Assembled candidate', 'change.proposed': 'Proposed change', 'change.merged': 'Merged change',
};

function artifactsOf(w: WorkerView, focus: TaskView | undefined, snapshot: ProjectViewSnapshot): ArtifactEntry[] {
  const seen = new Set<string>();
  const out: ArtifactEntry[] = [];
  const add = (label: string, ref: string, at: string) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    out.push({ label, ref, at });
  };
  for (const c of checksOf(snapshot, focus?.taskId ?? null)) add(`Check output: ${c.checkId}`, c.evidenceRef, c.updatedAt);
  for (const evidence of [w.latestEvidence, focus?.latestEvidence]) {
    const label = evidence ? ARTIFACT_KINDS[evidence.kind] : undefined;
    if (evidence && label) add(label, evidence.ref, evidence.at);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

const APPROVAL: Readonly<Record<string, { label: string; tone: Tone }>> = {
  pending: { label: 'Pending', tone: 'warning' }, granted: { label: 'Granted', tone: 'success' }, denied: { label: 'Denied', tone: 'danger' }, expired: { label: 'Expired', tone: 'danger' }, superseded: { label: 'Superseded', tone: 'neutral' },
};

function permissionsOf(focus: TaskView | undefined, snapshot: ProjectViewSnapshot, nowMs: number): PermissionEntry[] {
  if (!focus) return [];
  return Object.values(snapshot.approvals).filter((a) => a.taskId === focus.taskId).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).map((a) => {
    const state = APPROVAL[approvalStateAt(a, nowMs)]!;
    return { approvalId: a.approvalId, state: state.label, tone: state.tone, reason: a.reason ? requestText(a) : 'No reason recorded', reasonCode: a.reason, scopeHash: a.scopeHash, requestedAt: a.requestedAt, expiresAt: a.expiresAt, resolvedAt: a.resolvedAt };
  });
}

function sandboxFacts(w: WorkerView, attempt: AttemptView | undefined, heartbeatAgeMs: number | null, nowMs: number): Fact[] {
  const facts: Fact[] = [
    { label: 'Availability', value: sentence(w.availability) },
    { label: 'Lease', value: w.leaseHeld ? 'Held' : 'Not held. Heartbeats are only expected during an attempt.' },
    { label: 'In this state since', value: `${formatExact(w.enteredStateAt)} (${formatAge(nowMs - Date.parse(w.enteredStateAt))})` },
    { label: 'Last heartbeat', value: w.lastHeartbeatAt ? `${formatExact(w.lastHeartbeatAt)}${heartbeatAgeMs !== null ? ` (${formatAge(heartbeatAgeMs)} ago)` : ''}` : 'None recorded' },
  ];
  if (attempt) {
    facts.push({ label: 'Attempt', value: `Attempt ${attempt.number}, ${attempt.outcome}` }, { label: 'Attempt started', value: formatExact(attempt.startedAt) });
    if (attempt.fence !== null) facts.push({ label: 'Fence', value: String(attempt.fence) });
  }
  facts.push({ label: 'Worker id', value: w.workerId, mono: true });
  return facts;
}

function summaryOf(w: WorkerView, activity: ActivitySignal, health: WorkerHealthDisplay, heartbeatAgeMs: number | null, lastConfirmedAt: string, nowMs: number, task: TaskRef | null): string {
  if (health.state === 'disconnected') return `Connection lost ${formatAge(nowMs - Date.parse(lastConfirmedAt))} ago`;
  if (health.state === 'unknown') return 'Health unknown; showing the last confirmed state';
  if (health.state === 'failed') return w.stateReason ? `Failed: ${explain(w.stateReason)}` : 'Failed';
  if (health.state === 'suspected_stall') return heartbeatAgeMs !== null ? `Connected; no progress event for ${formatAge(heartbeatAgeMs)}` : 'Connected; progress may be stalled';
  if (!activity.reported) return task ? `Assigned to ${task.title}; activity not reported` : 'Activity not reported';
  return activity.tool ? `${activity.label}: ${activity.tool}` : activity.label;
}

/**
 * When this worker's state was last confirmed. A reachable worker with no lease sends no heartbeat, so entering its state is the later fact. A lease
 * holder is confirmed only by its heartbeat, and for a lost worker the time it entered that state is the reaper's, which confirms nothing about the worker.
 */
function lastConfirmedOf(w: WorkerView, health: WorkerHealthReading['health']): string {
  if (w.lastHeartbeatAt === null) return w.enteredStateAt;
  if (w.leaseHeld || w.availability === 'offline' || health === 'disconnected') return w.lastHeartbeatAt;
  return Date.parse(w.enteredStateAt) > Date.parse(w.lastHeartbeatAt) ? w.enteredStateAt : w.lastHeartbeatAt;
}

function rowOf(w: WorkerView, snapshot: ProjectViewSnapshot, nowMs: number, livenessAsOfMs: number | null, sessionStale: boolean): TeamRow {
  const reading = effectiveWorkerHealth(w, nowMs, livenessAsOfMs);
  const health = workerHealthDisplay(w, reading, sessionStale);
  const stale = sessionStale || health.state === 'disconnected' || health.state === 'unknown';
  const lastConfirmedAt = lastConfirmedOf(w, reading.health);

  const currentTask = w.taskId !== null ? snapshot.tasks[w.taskId] : undefined;
  const attempt = w.attemptId !== null ? snapshot.attempts[w.attemptId] : lastAttemptOf(w, snapshot);
  const focus = currentTask ?? (attempt ? snapshot.tasks[attempt.taskId] : undefined);
  const ref = (t: TaskView): TaskRef => ({ taskId: t.taskId, title: t.title ?? t.taskId, revision: t.revision });
  const task = currentTask ? ref(currentTask) : null;
  const lastTask = !currentTask && focus ? ref(focus) : null;

  const base = activityOf(w, snapshot);
  const activity: ActivitySignal = base.reported
    ? { label: base.label, tone: stale ? 'neutral' : base.tone, reported: true, stale, since: formatAge(nowMs - Date.parse(w.enteredStateAt)), tool: w.activity === null ? null : toolOf(w) }
    : { label: base.label, tone: 'neutral', reported: false, stale: false, since: null, tool: null };

  let healthNote: string | null = null;
  if (health.state === 'healthy' && reading.heartbeatAgeMs !== null) healthNote = `Heartbeat ${formatAge(reading.heartbeatAgeMs)} ago`;
  else if (health.state === 'suspected_stall' && reading.heartbeatAgeMs !== null) healthNote = `No heartbeat for ${formatAge(reading.heartbeatAgeMs)}`;

  const rank = attentionRank(w, health);
  const blockers = blockersOf(w, currentTask, snapshot);
  const taskId = focus?.taskId ?? null;
  const progressTimes = [w.enteredStateAt, w.latestAction?.at, w.latestEvidence?.at].filter((t): t is string => t !== undefined);

  return {
    workerId: w.workerId, role: focus?.role ?? null, runId: focus?.runId ?? null, task, lastTask, activity, health, healthNote,
    results: resultOf(w, focus, attempt, snapshot, task === null),
    execution: w.execution, modelRoute: w.modelRoute, assignment: w.assignment, modelDetail: w.assignment ? (w.attemptId !== null ? w.assignment.model : `${w.assignment.model} (previous attempt)`) : null, overrideTarget: focus ? taskTarget(focus, snapshot) : null, stale, lastConfirmedAt,
    lastProgressAt: progressTimes.sort().at(-1)!,
    blockers: blockers.length, spend: spendOf(snapshot.usage, taskId), attentionRank: rank, rail: RAIL[rank] ?? null,
    detail: {
      summary: summaryOf(w, activity, health, reading.heartbeatAgeMs, lastConfirmedAt, nowMs, task),
      task: focus ? taskDetail(focus, currentTask !== undefined, attempt, snapshot) : null,
      blockers,
      timeline: timelineOf(w, focus, snapshot),
      checks: checksOf(snapshot, taskId).map((c) => {
        const { label, tone } = readCheck(c, focus, attempt);
        return { checkId: c.checkId, label, tone, summary: c.summary, at: c.updatedAt, evidenceRef: c.evidenceRef };
      }),
      artifacts: artifactsOf(w, focus, snapshot),
      permissions: permissionsOf(focus, snapshot, nowMs),
      sandbox: sandboxFacts(w, attempt, reading.heartbeatAgeMs, nowMs),
      usage: usageLines(snapshot.usage, taskId),
    },
  };
}

const byId = (a: TeamRow, b: TeamRow): number => a.workerId.localeCompare(b.workerId);

/** Ties break on the worker id, so rows do not jump between ticks. */
export function sortRows(rows: readonly TeamRow[], key: SortKey): TeamRow[] {
  const taskTitle = (r: TeamRow): string => r.task?.title ?? r.lastTask?.title ?? '￿';
  const compare: Readonly<Record<SortKey, (a: TeamRow, b: TeamRow) => number>> = {
    attention: (a, b) => a.attentionRank - b.attentionRank,
    role: (a, b) => (a.role ?? '￿').localeCompare(b.role ?? '￿'),
    task: (a, b) => taskTitle(a).localeCompare(taskTitle(b)),
    activity: (a, b) => a.activity.label.localeCompare(b.activity.label),
    runtime: (a, b) => a.execution.localeCompare(b.execution),
    progress: (a, b) => b.lastProgressAt.localeCompare(a.lastProgressAt),
  };
  return [...rows].sort((a, b) => compare[key](a, b) || byId(a, b));
}

export function filterRows(rows: readonly TeamRow[], f: FleetFilter): TeamRow[] {
  return rows.filter((r) => (f.runtime === 'all' || r.execution === f.runtime) && (f.provider === 'all' || (r.assignment?.provider ?? 'unknown') === f.provider) && (f.role === 'all' || r.role === f.role) && (f.run === 'all' || r.runId === f.run) && (!f.blockedOnly || r.blockers > 0));
}

export interface TeamOptions {
  /** When liveness last refreshed, whatever the session's state now. */
  readonly lastConfirmedMs?: number | null;
  /** True when the session is not live, so nothing shown can be called current. */
  readonly stale?: boolean;
}

/** Everything the Team view shows, derived from one snapshot. Pure; time and liveness are parameters. */
export function buildTeam(snapshot: ProjectViewSnapshot, nowMs: number, livenessAsOfMs: number | null, options: TeamOptions = {}): TeamModel {
  const workers = Object.values(snapshot.workers);
  const sessionStale = options.stale === true;
  const rows = sortRows(workers.map((w) => rowOf(w, snapshot, nowMs, livenessAsOfMs, sessionStale)), 'attention');
  const counts = countFleet(workers, nowMs, livenessAsOfMs, options.lastConfirmedMs ?? null);
  const parts = [[counts.working, 'assigned'], [counts.waiting, 'waiting'], [counts.idle, 'idle'], [counts.lost, 'lost']].filter(([n]) => (n as number) > 0).map(([n, label]) => `${n} ${label as string}`);
  const stale = sessionStale || rows.some((r) => r.health.state === 'unknown');
  const summary = rows.length === 0 ? null : `${stale ? 'Last confirmed: ' : ''}${rows.length} worker${rows.length === 1 ? '' : 's'} seen: ${parts.join(', ')}.${workers.some((w) => w.activity === 'waiting_resource') && snapshot.limits.maxConcurrentTotal === null ? ' Slot limit not reported.' : ''}`;
  return { empty: rows.length === 0, simulated: snapshot.meta.provenance === 'simulated', stale, summary, rows, roles: [...new Set(rows.flatMap((r) => (r.role ? [r.role] : [])))].sort(), runs: [...new Set(rows.flatMap((r) => (r.runId ? [r.runId] : [])))].sort(),
    providers: [...new Set(rows.map((r) => r.assignment?.provider ?? 'unknown'))].sort().map((value) => ({ value, label: value === 'unknown' ? 'Not recorded' : (snapshot.modelCatalog.providers.find((p) => p.provider === value)?.label ?? value) })),
    assignments: buildAssignments(snapshot),
    runners: snapshot.runners.map((r) => ({ runnerId: r.runnerId, label: r.label, location: r.location, recent: runnerRecent(r, nowMs), lastSeenAt: r.lastSeenAt })),
  };
}
