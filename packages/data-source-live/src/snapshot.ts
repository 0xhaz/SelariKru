import { AssistantViewSchema, ProjectViewSnapshotSchema, type ApprovalView, type AttemptView, type ProjectViewSnapshot, type TaskView, type WorkerView } from '@selarikru/view-protocol';

/** The fields this client reads from `GET /v1/projects/:id/snapshot`. Everything is checked against the strict view schema on the way out. */
interface RawAttempt {
  attemptId: string; number: number; runner: string | null; fence: number | null; outcome: string | null; exitReason: string | null;
  location: 'local' | 'cloud' | null; activity: { tool: string; at: string } | null;
  assignment: { provider: string; model: string; source: string; route?: string } | null;
  startedAt: string | null; endedAt: string | null; lastHeartbeatAt: string | null; humanIntervenedAt?: string | null;
}
interface RawTask {
  taskId: string; runId: string | null; revision: number; aggregateRevision: number; status: TaskView['status']; placementBlock: string | null; blockedReason: string | null; skillRunnerWait?: string[];
  title: string | null; role: string | null; dependsOn: string[] | null; enteredStatusAt: string; latestEvidence: TaskView['latestEvidence']; attempts: RawAttempt[];
  cancel: { operationId: string; requestedAt: string; reason?: string } | null;
  /** Where the task's AI steps run, as the server works it out. Absent from servers before route policy. */
  route?: unknown;
}
interface RawApproval {
  outcome: string; approvalId: string; runId: string; taskId: string | null; revision: number | null; requester: string | null; scopeHash: string | null;
  expiresAt: string | null; requestedAt: string; resolvedAt: string | null; operation: string | null; reason: string | null; destination: string | null;
}
interface RawHistory { approvalId: string; runId: string | null; taskId: string | null; revision: number | null; outcome: string; approver: string | null; scopeHash: string | null; operation: string | null; reason?: string | null; destination: string | null; requestedAt: string; resolvedAt: string | null; consumedAt: string | null; consumedBy: string | null }
interface RawUsage { entryId: string; runId: string; taskId: string | null; attemptId: string | null; metric: string; quantity: string | null; provenance: string; source: string }
export interface RawSnapshot {
  projectId: string; cursor: number; generatedAt: string; modelCatalog: unknown; modelAssignments: unknown[];
  limits: unknown; runners: unknown[]; checks: unknown[]; usage: RawUsage[]; settings?: unknown[];
  runs: { runId: string; rebuildDeferred?: unknown; failedRebuildMainMoved?: unknown; lifecycle: string; planRevision: number; pinnedModel: unknown; latestEvidence: unknown; criteria: unknown; evidence: unknown; reducedScope: unknown; scopeAssessment: unknown; humanInterventions?: unknown; budget?: unknown; cancel?: unknown; policy?: unknown; routePolicy?: unknown }[];
  tasks: RawTask[]; approvals: RawApproval[]; approvalHistory: RawHistory[]; changeRequests: unknown[];
  clientReports: { kind: string; payload: unknown; createdAt: string }[];
}

const OUTCOMES: readonly AttemptView['outcome'][] = ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'];
const LEASE_LOSS: readonly (string | null)[] = ['lease_expired', 'runner_lost'];

/**
 * The server's row outcome as the view states it. A finished attempt is stored `succeeded` as soon as the worker is done, but it has earned nothing until the verifier says so:
 * the view, like the event fold, calls it `running` (ended, verdict pending). An outcome the view does not know reads as not running, never as a success.
 */
function outcomeOf(a: RawAttempt, task: RawTask): AttemptView['outcome'] {
  if (a.outcome === 'succeeded' && task.status === 'verifying') return 'running';
  if (OUTCOMES.includes(a.outcome as AttemptView['outcome'])) return a.outcome as AttemptView['outcome'];
  return a.endedAt === null ? 'running' : 'interrupted';
}

const recordedModel = (a: RawAttempt): AttemptView['assignment'] => {
  // The wire adds `route`; the view's recorded model is strict and states provider, model and source only. The route goes on the worker's own axis.
  if (a.assignment === null) return null;
  const { provider, model, source } = a.assignment;
  return { provider, model, source } as AttemptView['assignment'];
};

const routeOf = (a: RawAttempt): WorkerView['modelRoute'] => (a.assignment?.route === 'device' || a.assignment?.route === 'cloud' || a.assignment?.route === 'none' ? a.assignment.route : 'unknown');

/**
 * Builds the worker views the snapshot route does not return. One worker per runner, in the state its latest attempt leaves it, matching what the event fold reaches.
 * `activity` is left null: a tool name is not a statement about planning or coding, so it goes in `latestAction` only.
 */
function buildWorkers(tasks: readonly RawTask[], approvals: readonly RawApproval[]): Record<string, WorkerView> {
  const latest = new Map<string, { a: RawAttempt; t: RawTask }>();
  const started = tasks.flatMap((t) => t.attempts.map((a) => ({ a, t }))).sort((x, y) => (x.a.startedAt ?? '').localeCompare(y.a.startedAt ?? ''));
  for (const entry of started) if (entry.a.startedAt !== null) latest.set(entry.a.runner ?? `attempt:${entry.a.attemptId}`, entry);
  const out: Record<string, WorkerView> = {};
  for (const [workerId, { a, t }] of latest) {
    const base: WorkerView = {
      workerId, taskId: null, taskRevision: null, attemptId: null, availability: 'idle', activity: null, health: 'healthy', leaseHeld: false, stateReason: null, enteredStateAt: a.endedAt ?? a.startedAt!,
      latestAction: a.activity ? { tool: a.activity.tool, summary: null, longRunning: false, at: a.activity.at } : null, latestEvidence: t.latestEvidence, lastHeartbeatAt: a.lastHeartbeatAt,
      execution: a.location ?? 'unknown', modelRoute: routeOf(a), assignment: recordedModel(a), blockedByTaskIds: [], blockedByApprovalId: null,
    };
    if (a.endedAt === null) {
      out[workerId] = { ...base, taskId: t.taskId, taskRevision: t.revision, attemptId: a.attemptId, availability: 'assigned', leaseHeld: true, enteredStateAt: a.startedAt!, latestEvidence: null };
    } else if (a.exitReason === 'approval_requested' && t.status === 'awaiting_approval') {
      const waiting = approvals.find((p) => p.taskId === t.taskId && p.outcome === 'pending');
      out[workerId] = { ...base, taskId: t.taskId, taskRevision: t.revision, attemptId: a.attemptId, availability: 'assigned', activity: 'waiting_human', blockedByApprovalId: waiting?.approvalId ?? null, stateReason: waiting?.reason ?? null };
    } else if (LEASE_LOSS.includes(a.exitReason)) {
      out[workerId] = { ...base, taskId: t.taskId, taskRevision: t.revision, attemptId: a.attemptId, availability: 'offline', health: 'disconnected', stateReason: a.exitReason };
    } else {
      out[workerId] = { ...base, health: a.exitReason === 'worker_crashed' ? 'failed' : 'healthy', stateReason: a.exitReason === 'worker_crashed' ? a.exitReason : null };
    }
  }
  return out;
}

const HISTORY_STATES: readonly ApprovalView['state'][] = ['granted', 'denied', 'superseded'];

/** Maps the server's snapshot to the view snapshot and validates it. Throws if the result does not match the strict schema: a screen must never read a shape it was not built for. */
/** The run's limit when the server says one is set. Anything else is unknown, never zero. */
function limitOf(budget: unknown): number | null {
  const b = budget as { status?: unknown; limitUsd?: unknown } | null | undefined;
  return b?.status === 'set' && typeof b.limitUsd === 'number' ? b.limitUsd : null;
}

export function toViewSnapshot(raw: RawSnapshot): ProjectViewSnapshot {
  const tasks: Record<string, unknown> = {};
  const attempts: Record<string, unknown> = {};
  for (const t of raw.tasks) {
    if (t.runId === null) continue;
    const started = t.attempts.filter((a) => a.startedAt !== null);
    for (const a of started) {
      attempts[a.attemptId] = {
        attemptId: a.attemptId, taskId: t.taskId, number: a.number, fence: a.fence, outcome: outcomeOf(a, t), exitReason: a.exitReason, runnerId: a.runner, startedAt: a.startedAt,
        endedAt: a.endedAt, lastHeartbeatAt: a.lastHeartbeatAt, assignment: recordedModel(a), humanIntervenedAt: a.humanIntervenedAt ?? null,
      };
    }
    tasks[t.taskId] = {
      taskId: t.taskId, runId: t.runId, revision: t.revision, aggregateRevision: t.aggregateRevision, title: t.title, role: t.role, dependsOn: t.dependsOn, status: t.status, statusReason: t.blockedReason, placementBlock: t.placementBlock, ...(Array.isArray(t.skillRunnerWait) && t.skillRunnerWait.length > 0 ? { skillRunnerWait: t.skillRunnerWait.filter((x): x is string => typeof x === 'string') } : {}),
      cancelRequested: t.cancel ? { at: t.cancel.requestedAt, operationId: t.cancel.operationId, reason: t.cancel.reason ?? null } : null, cancelReason: null, supersededByRevision: null,
      attemptIds: started.map((a) => a.attemptId), activeAttemptId: started.find((a) => a.endedAt === null)?.attemptId ?? null, enteredStatusAt: t.enteredStatusAt, latestEvidence: t.latestEvidence,
      ...(t.route !== undefined ? { route: t.route } : {}),
    };
  }
  const approvals: Record<string, unknown> = {};
  for (const h of raw.approvalHistory) {
    if (h.runId === null || !HISTORY_STATES.includes(h.outcome as ApprovalView['state'])) continue;
    approvals[h.approvalId] = { approvalId: h.approvalId, taskId: h.taskId, taskRevision: h.revision, runId: h.runId, scopeHash: h.scopeHash, reason: h.reason ?? null, operation: h.operation, destination: h.destination, requester: null, state: h.outcome, requestedAt: h.requestedAt, expiresAt: null, resolvedAt: h.resolvedAt };
  }
  for (const a of raw.approvals) {
    approvals[a.approvalId] = { approvalId: a.approvalId, taskId: a.taskId, taskRevision: a.revision, runId: a.runId, scopeHash: a.scopeHash, reason: a.reason, operation: a.operation, destination: a.destination, requester: a.requester, state: a.outcome === 'expired' ? 'expired' : 'pending', requestedAt: a.requestedAt, expiresAt: a.expiresAt, resolvedAt: a.resolvedAt };
  }
  // Client reports are self-reported and untrusted. The latest one that reads as an inference report states the assistant's axis; anything else stays unknown.
  const report = raw.clientReports.filter((r) => r.kind === 'inference').flatMap((r) => { const v = AssistantViewSchema.safeParse(r.payload && typeof r.payload === 'object' ? { mode: (r.payload as Record<string, unknown>)['mode'] ?? null, observedSource: (r.payload as Record<string, unknown>)['observedSource'] } : null); return v.success ? [v.data] : []; })[0];
  return ProjectViewSnapshotSchema.parse({
    meta: { schemaVersion: 1, projectId: raw.projectId, cursor: String(raw.cursor), observedAt: raw.generatedAt, provenance: 'observed' },
    assistant: report ?? { mode: null, observedSource: 'unknown' },
    runs: Object.fromEntries(raw.runs.map((r) => [r.runId, { runId: r.runId, rebuildDeferred: r.rebuildDeferred ?? null, failedRebuildMainMoved: r.failedRebuildMainMoved === true, lifecycle: r.lifecycle, planRevision: r.planRevision, latestEvidence: r.latestEvidence, criteria: r.criteria, evidence: r.evidence, reducedScope: r.reducedScope, scopeAssessment: r.scopeAssessment, pinnedModel: r.pinnedModel, budgetLimitUsd: limitOf(r.budget), cancel: r.cancel ?? null, policy: r.policy ?? null, ...(r.humanInterventions !== undefined ? { humanInterventions: r.humanInterventions } : {}), ...(r.routePolicy !== undefined ? { routePolicy: r.routePolicy } : {}) }])),
    tasks, attempts, approvals,
    workers: buildWorkers(raw.tasks, raw.approvals),
    checks: Object.fromEntries((raw.checks as { checkId: string }[]).map((c) => [c.checkId, c])),
    usage: raw.usage.map((u) => ({ entryId: u.entryId, runId: u.runId, taskId: u.taskId, attemptId: u.attemptId, figure: { metric: u.metric, quantity: u.quantity, provenance: u.provenance, source: u.source } })),
    changeRequests: raw.changeRequests, approvalHistory: raw.approvalHistory.map(({ reason: _reason, ...h }) => h),
    modelCatalog: raw.modelCatalog, modelAssignments: raw.modelAssignments, runners: raw.runners, limits: raw.limits, settings: raw.settings ?? [],
  });
}
