import { PROJECT_MANAGER_ROLE, type RoutePolicyMode } from '@selarikru/domain';
import type { AgentCatalog, AgentResult, PmTurn } from '@selarikru/inference-firebase-web';
import type { ProjectViewSnapshot, TaskAgentContext, TaskRouteRead } from '@selarikru/view-protocol';
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
}

export type PmOutcome =
  | { readonly kind: 'result'; readonly result: AgentResult; readonly context: TaskAgentContext; readonly planRevision: number | null; readonly runId: string }
  | { readonly kind: 'refused'; readonly code: string };

export interface PmDeps {
  readonly projectId: string;
  readonly catalog: Pick<AgentCatalog, 'pmAnswer' | 'pmResearch' | 'pmPlan' | 'pmDelegate'>;
  readonly getTaskRoute: (taskId: string) => Promise<TaskRouteRead>;
  readonly getTaskContext: (taskId: string, destination: 'local' | 'cloud', callOverride: RoutePolicyMode | null, contextId: string) => Promise<TaskAgentContext>;
  readonly snapshot: () => ProjectViewSnapshot | null;
  readonly newContextId?: () => string;
}

/** The accepted plan the Project Manager may delegate within: the subject task's run, its tasks and the project's workers (names quoted as data in the prompt). */
export function planScopeFor(snap: ProjectViewSnapshot, runId: string) {
  const run = snap.runs[runId];
  const tasks = Object.values(snap.tasks).filter((t) => t.runId === runId).map((t) => ({ taskId: t.taskId, title: t.title ?? t.taskId, role: t.role ?? 'worker', status: t.status }));
  const workers = Object.keys(snap.workers).map((id) => {
    const held = snap.workers[id]?.taskId;
    const ident = workerIdentity(snap, id, held ? snap.tasks[held]?.role ?? null : lastRole(snap, id));
    const enabled = !snap.settings.some((s) => s.scope === 'runner' && s.key === id && s.field === 'enabled' && s.desired === false);
    return { workerId: id, name: ident.name, role: ident.role, enabled: enabled && ident.role !== PROJECT_MANAGER_ROLE };
  });
  return { planRevision: run?.planRevision ?? 0, tasks, workers };
}

const lastRole = (snap: ProjectViewSnapshot, workerId: string): string | null => {
  const a = Object.values(snap.attempts).filter((x) => x.runnerId === workerId).sort((x, y) => Date.parse(y.startedAt ?? '0') - Date.parse(x.startedAt ?? '0'))[0];
  return a ? snap.tasks[a.taskId]?.role ?? null : null;
};

export async function runPmStep(deps: PmDeps, req: PmRequest): Promise<PmOutcome> {
  if (!req.question.trim()) return { kind: 'refused', code: 'question_empty' };
  const override: RoutePolicyMode | null = req.kind === 'pmResearch' ? 'ONLY_IN_CLOUD' : req.callOverride;
  let read: TaskRouteRead;
  try {
    read = await deps.getTaskRoute(req.subjectTaskId);
  } catch {
    return { kind: 'refused', code: 'route_fetch_failed' };
  }
  // Research on a locked task never asks for cloud context: it is refused, in plain words, before any read.
  if (req.kind === 'pmResearch' && read.route.lock !== null) return { kind: 'refused', code: 'research_locked' };
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
    question: req.question, questionClassification: req.questionClassification, history: req.history,
  };
  const snap = deps.snapshot();
  const runId = snap?.tasks[req.subjectTaskId]?.runId ?? read.runId;
  const planRevision = snap?.runs[runId]?.planRevision ?? null;
  const done = (result: AgentResult): PmOutcome => ({ kind: 'result', result, context, planRevision, runId });
  switch (req.kind) {
    case 'pmAnswer': return done(await deps.catalog.pmAnswer(base));
    case 'pmResearch': return done(await deps.catalog.pmResearch(base));
    case 'pmPlan': return done(await deps.catalog.pmPlan(base));
    case 'pmDelegate': {
      if (!snap) return { kind: 'refused', code: 'no_snapshot' };
      return done(await deps.catalog.pmDelegate({ ...base, plan: planScopeFor(snap, runId) }));
    }
  }
}
