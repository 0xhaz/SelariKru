import { buildContextBundle, effectiveRoutePolicy, isCloudCapable, type BrainDestination, type RoutePolicyMode, type RouteLock } from '@selarikru/domain';
import { DataSourceException, type TaskAgentContext, type TaskView } from '@selarikru/view-protocol';
import type { FixtureRoutes } from './routes.ts';

/**
 * What the demo's task agents read: the task's words, a label, demo criteria and paths, and a context bundle built by the same domain code the server runs (no
 * compilation, so it serves no claims). Everything is simulated and says so. A task that has had an attempt has a small demo change to review and describe.
 */

const localOf = (taskId: string): string => taskId.slice(taskId.indexOf('.') + 1);

export function demoCriteria(task: Pick<TaskView, 'taskId' | 'title'>): { id: string; text: string }[] {
  const key = localOf(task.taskId).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const title = task.title ?? localOf(task.taskId);
  return [
    { id: `${key}-1`, text: `${title} works for a signed-in user, end to end.` },
    { id: `${key}-2`, text: `${title} has tests that pass in CI.` },
  ];
}

export const demoAllowedPaths = (taskId: string): string[] => [`src/${localOf(taskId)}`];

function demoChange(taskId: string): TaskAgentContext['change'] {
  const path = `${demoAllowedPaths(taskId)[0]}/limits.ts`;
  const diff = [
    `diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, '@@ -0,0 +1,3 @@',
    '+// Simulated change for the demo.', '+export const PAGE_SIZE = 50;', "+export const ORDER = 'newest';", '',
  ].join('\n');
  return { diff, files: [{ path, classification: 'internal' }] };
}

export interface DemoContextState {
  readonly routes: FixtureRoutes | undefined;
  /** Criteria reworded through `reviseTaskCriteria`, by task. */
  readonly criteria: Map<string, { id: string; text: string }[]>;
  readonly planRevision: number;
}

export function demoTaskContext(state: DemoContextState, task: TaskView, destination: BrainDestination): TaskAgentContext {
  const label = state.routes?.tasks[task.taskId]?.label ?? 'internal';
  const criteria = state.criteria.get(task.taskId) ?? demoCriteria(task);
  const allowedPaths = demoAllowedPaths(task.taskId);
  const bundle = buildContextBundle({
    compilation: null, revisions: [], revocations: [], sourceHead: 0, destination, streamable: destination === 'cloud',
    task: { taskId: task.taskId, baseSha: 'demo', criteria: criteria.map((c) => c.id), dependsOn: task.dependsOn ?? [], paths: allowedPaths },
  });
  return {
    taskId: task.taskId, revision: task.revision, runId: task.runId, planRevision: state.planRevision, destination,
    task: { title: task.title ?? task.taskId, description: null, criteria, allowedPaths, classification: label },
    bundle, change: task.attemptIds.length > 0 ? demoChange(task.taskId) : null, simulated: true,
  };
}

const refused = (message: string): DataSourceException => new DataSourceException({ code: 'unavailable', message, retryable: false });

/** The demo's replan path for a criteria proposal: the same refusals as the live client, and the reworded criteria kept for the next read. Simulated. */
/** The statuses the server's plan route lets take a new revision. */
export const REPLANNABLE_STATUSES: readonly string[] = ['planned', 'ready', 'blocked', 'awaiting_approval'];

/** The server's check on a context's destination: `cloud` only when the route, with this call's override and after the lock, can use the cloud. */
export function checkDestination(destination: BrainDestination, route: { override: RoutePolicyMode | null; runDefault: RoutePolicyMode | null }, lock: RouteLock | null, callOverride: RoutePolicyMode | null): void {
  const mode = effectiveRoutePolicy({ call: callOverride, task: route.override, run: route.runDefault, lock }).mode;
  if (destination === 'cloud' && (mode === null || !isCloudCapable(mode))) throw refused('context_destination_refused: this task\'s route keeps its AI steps on the device, so no cloud context is served');
}

export function reviseDemoCriteria(state: DemoContextState, task: TaskView, expectedPlanRevision: number, reworded: readonly { id: string; text: string }[]): { id: string; text: string }[] {
  // The same order as the live client and the server's plan route: what the person saw, the data rule, the task's state, then the criteria themselves.
  if (state.planRevision !== expectedPlanRevision) throw refused('stale_revision: the plan moved since this was read; nothing was sent');
  const label = state.routes?.tasks[task.taskId]?.label ?? 'internal';
  if (label === 'restricted' || label === 'secret') throw refused('route_locked_restricted: this task reads restricted data, so a browser proposal does not revise it; nothing was sent');
  if (!REPLANNABLE_STATUSES.includes(task.status)) throw refused(`task_not_replannable: a ${task.status} task cannot take a new revision; nothing was sent`);
  const current = state.criteria.get(task.taskId) ?? demoCriteria(task);
  const ids = new Set(current.map((c) => c.id));
  if (reworded.some((c) => !ids.has(c.id))) throw refused('criterion_unknown: a criterion is not one this task has; nothing was sent');
  const byId = new Map(reworded.map((c) => [c.id, c.text]));
  return current.map((c) => ({ ...c, text: byId.get(c.id) ?? c.text }));
}
