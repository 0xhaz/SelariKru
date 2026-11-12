import { PROJECT_MANAGER_ROLE, workerRoleOf, type RoutePolicyMode } from '@selarikru/domain';
import type { AgentCatalog, AgentResult, PmTurn } from '@selarikru/inference-firebase-web';
import type { ProjectViewSnapshot, TaskAgentContext, TaskRouteRead, TaskView } from '@selarikru/view-protocol';
import { destinationFor, taskAgentPolicy } from '../hybrid/runner.ts';
import { workerIdentity } from '../team/identity.ts';

/**
 * H11: one turn with the Project Manager. Every PM call is a Firebase AI Logic call through the same adapter as the task agents: it is about one task of the run
 * (its "subject"), so that task's route, lock, context bundle and served-context record apply unchanged (H2 to H5). Research forces the cloud only and is refused on a
 * locked route by the adapter. The conversation lives in this tab; each call carries only a bounded, label-filtered part of it (`pmHistory`).
 */
export type PmKind = 'pmAnswer' | 'pmResearch' | 'pmPlan' | 'pmDelegate';

export interface PmRequest {
  readonly kind: PmKind;
  readonly subjectTaskId: string;
  readonly question: string;
  /** The question's label. The owner marks it restricted to keep it on this device; missing counts as restricted. */
  readonly questionClassification: 'internal' | 'restricted';
  readonly history: readonly PmTurn[];
  readonly callOverride: RoutePolicyMode | null;
  /** H12: this turn continues a paused checkpoint (sent after reconnecting, or moved to device only). */
  readonly resume?: { readonly checkpointId: string; readonly kind: 'after_reconnect' | 'escalated' | 'device_only' | 'owner_resume' };
}

export type PmOutcome =
  | { readonly kind: 'result'; readonly result: AgentResult; readonly context: TaskAgentContext | null; readonly planRevision: number | null; readonly runId: string }
  | { readonly kind: 'refused'; readonly code: string };

export interface PmDeps {
  readonly projectId: string;
  readonly catalog: Pick<AgentCatalog, 'pmAnswer' | 'pmResearch' | 'pmPlan' | 'pmDelegate'>;
  readonly getTaskRoute: (taskId: string) => Promise<TaskRouteRead>;
  readonly getTaskContext: (taskId: string, destination: 'local' | 'cloud', callOverride: RoutePolicyMode | null, contextId: string) => Promise<TaskAgentContext>;
  readonly snapshot: () => ProjectViewSnapshot | null;
  readonly newContextId?: () => string;
  /** H11 fix round 1 (I5): whether the owner granted web research ("Google Search (web research)", Settings › Workflow). Absent: not granted. */
  readonly webResearch?: () => boolean;
}

/**
 * The label of an owner's question (H11 fix round 1, H2). A question about a locked task is restricted, whatever the checkbox says: the checkbox can only raise it.
 */
export function questionLabelFor(task: Pick<TaskView, 'route'> | undefined, markedRestricted: boolean): 'internal' | 'restricted' {
  return markedRestricted || (task?.route?.lock !== null && task?.route?.lock !== undefined) ? 'restricted' : 'internal';
}

/** Whether the owner granted web research for this run (off unless saved on). */
export function webResearchGranted(snap: ProjectViewSnapshot | null, runId: string | null): boolean {
  return snap !== null && runId !== null && snap.settings.some((x) => x.scope === 'run' && x.key === runId && x.field === 'web_research' && x.desired === true);
}

/** The accepted plan the Project Manager may delegate within: the subject task's run, its tasks and the project's workers (names quoted as data in the prompt). */
export function planScopeFor(snap: ProjectViewSnapshot, runId: string, fresh?: ReadonlyMap<string, boolean>) {
  const run = snap.runs[runId];
  // A locked task (or one whose route is not known) is restricted: a cloud-capable prompt lists only its id, role and status (H11 fix round 1, H1).
  // H12 step 0: `fresh` is each task's lock read again just before the scope is built (true: locked, or the read failed). The snapshot can be an interval stale, so
  // a task it shows unlocked is withheld when the fresh read says locked; the fresh read never unlocks a task the snapshot shows locked.
  const tasks = Object.values(snap.tasks).filter((t) => t.runId === runId).map((t) => ({ taskId: t.taskId, title: t.title ?? t.taskId, role: t.role ?? 'worker', status: t.status, restricted: !t.route || t.route.lock !== null || (fresh !== undefined && fresh.get(t.taskId) !== false) }));
  // One role rule with the server and the demo (fix round 2, I2): a saved role, else the role of the task the worker last claimed.
  const settings = snap.settings.filter((s) => s.scope === 'runner').map((s) => ({ workerId: s.key, field: s.field, value: s.desired }));
  const history = Object.values(snap.attempts).map((a) => ({ workerId: a.runnerId ?? '', role: snap.tasks[a.taskId]?.role ?? null, at: a.startedAt }));
  const workers = Object.keys(snap.workers).map((id) => {
    const ident = workerIdentity(snap, id, workerRoleOf(id, settings, history));
    const enabled = !snap.settings.some((s) => s.scope === 'runner' && s.key === id && s.field === 'enabled' && s.desired === false);
    return { workerId: id, name: ident.name, role: ident.role, enabled: enabled && ident.role !== PROJECT_MANAGER_ROLE };
  });
  return { planRevision: run?.planRevision ?? 0, tasks, workers };
}

/** H12 step 0: every listed task's lock, read fresh just before a plan scope is built. A failed read counts as locked (fail closed). */
export async function freshLocks(deps: Pick<PmDeps, 'getTaskRoute'>, snap: ProjectViewSnapshot, runId: string): Promise<Map<string, boolean>> {
  const ids = Object.values(snap.tasks).filter((t) => t.runId === runId).map((t) => t.taskId);
  const out = new Map<string, boolean>();
  await Promise.all(ids.map(async (id) => {
    try { out.set(id, (await deps.getTaskRoute(id)).route.lock !== null); } catch { out.set(id, true); }
  }));
  return out;
}

export async function runPmStep(deps: PmDeps, req: PmRequest): Promise<PmOutcome> {
  if (!req.question.trim()) return { kind: 'refused', code: 'question_empty' };
  const override: RoutePolicyMode | null = req.kind === 'pmResearch' ? 'ONLY_IN_CLOUD' : req.callOverride;
  let read: TaskRouteRead;
  try {
    read = await deps.getTaskRoute(req.subjectTaskId);
  } catch {
    return { kind: 'refused', code: 'route_fetch_failed' };
  }
  // Research on a locked task never asks for cloud context: it is refused, in plain words, before any read. It needs the owner's own grant, and never overrides a
  // task the owner set to device only (H11 fix round 1, I5).
  if (req.kind === 'pmResearch' && read.route.lock !== null) return { kind: 'refused', code: 'research_locked' };
  // The route without this call's override: the task's own, else the run default or the seed (fix round 2).
  if (req.kind === 'pmResearch' && (read.route.override === 'ONLY_ON_DEVICE' || read.route.effective === 'ONLY_ON_DEVICE')) return { kind: 'refused', code: 'research_device_only' };
  if (req.kind === 'pmResearch' && !(deps.webResearch?.() ?? false)) return { kind: 'refused', code: 'research_not_granted' };
  // A question about a locked task is restricted, whatever the request says.
  const questionClassification = read.route.lock !== null ? 'restricted' : req.questionClassification;
  const snapNow = deps.snapshot();
  const runIdNow = snapNow?.tasks[req.subjectTaskId]?.runId ?? read.runId;
  if (req.kind === 'pmResearch') {
    // Research sends only the owner's question: no task context, bundle or history is read or sent.
    const sourceId = `task:${req.subjectTaskId}`;
    const result = await deps.catalog.pmResearch({
      projectId: deps.projectId, task: { taskId: req.subjectTaskId, title: '', description: null, criteria: [], allowedPaths: [], classification: 'internal' },
      bundle: null, sources: [{ id: sourceId, classification: 'internal' }], policy: taskAgentPolicy(sourceId), callOverride: 'ONLY_IN_CLOUD',
      question: req.question, questionClassification, history: [],
    });
    return { kind: 'result', result, context: null, planRevision: snapNow?.runs[runIdNow]?.planRevision ?? null, runId: runIdNow };
  }
  const contextId = (deps.newContextId ?? (() => `ctx_${crypto.randomUUID().replace(/-/g, '')}`))();
  let context: TaskAgentContext;
  try {
    context = await deps.getTaskContext(req.subjectTaskId, destinationFor(read, override), override, contextId);
  } catch (e) {
    const code = /^([a-z_]+):/.exec(e instanceof Error ? e.message : '')?.[1];
    return { kind: 'refused', code: code ?? 'context_unavailable' };
  }
  const t = context.task;
  const sourceId = `task:${req.subjectTaskId}`;
  const base = {
    projectId: deps.projectId,
    task: { taskId: req.subjectTaskId, title: t.title, description: t.description, criteria: t.criteria, allowedPaths: t.allowedPaths, classification: t.classification },
    bundle: context.bundle, sources: [{ id: sourceId, classification: t.classification }], policy: taskAgentPolicy(sourceId),
    callOverride: req.callOverride, contextId,
    question: req.question, questionClassification, history: req.history,
    ...(req.resume ? { resume: req.resume } : {}),
  };
  const snap = deps.snapshot();
  const runId = snap?.tasks[req.subjectTaskId]?.runId ?? read.runId;
  const planRevision = snap?.runs[runId]?.planRevision ?? null;
  const done = (result: AgentResult): PmOutcome => ({ kind: 'result', result, context, planRevision, runId });
  switch (req.kind) {
    case 'pmAnswer': return done(await deps.catalog.pmAnswer(base));
    // The run's current tasks, so the plan can revise them by id (fix round 2, I4).
    case 'pmPlan': return done(await deps.catalog.pmPlan(snap ? { ...base, plan: planScopeFor(snap, runId, await freshLocks(deps, snap, runId)) } : base));
    case 'pmDelegate': {
      if (!snap) return { kind: 'refused', code: 'no_snapshot' };
      return done(await deps.catalog.pmDelegate({ ...base, plan: planScopeFor(snap, runId, await freshLocks(deps, snap, runId)) }));
    }
  }
}

/** Fix round 2 (M-b): an owner's question whose call came back locked read restricted data, so the stored turn is restricted too, whatever the snapshot said. */
export function ownerTurnLabelAfter(label: 'internal' | 'restricted', outcome: PmOutcome): 'internal' | 'restricted' {
  return outcome.kind === 'result' && outcome.result.locked ? 'restricted' : label;
}

/** Fix round 2 (M-c): what the delegation POST carries: each assignment as the call gave it, without its reason (the prose stays in this tab). */
export function delegationAssignments(items: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return items.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'why')));
}
