import { pmPlanRoutes, type PmPlanRoute, type RoutePolicyMode } from '@selarikru/domain';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';
import type { BrowserInputs } from '../hybrid/model.ts';

/**
 * H12: the Project Manager proposes where each task of its plan runs, with the reason, from suggestRoute's own inputs: the task's label (a revised task's lock in
 * the snapshot; a new task takes the label of the task the PM call was about), whether this browser is offline, and whether the cloud budget is spent. The owner
 * accepts the routes with the plan; a locked task stays Local only and is never sent a route.
 */
export function planRouteProposals(tasks: readonly { readonly key: string; readonly revises?: string }[], snap: ProjectViewSnapshot | null, subjectLabel: unknown, browser: BrowserInputs): PmPlanRoute[] {
  return pmPlanRoutes(tasks.map((t) => {
    const revised = t.revises ? snap?.tasks[t.revises] : undefined;
    // A revised task with no known route counts as restricted: missing is never allowed.
    const label = t.revises ? (revised?.route ? (revised.route.lock ? 'restricted' : 'internal') : 'restricted') : subjectLabel;
    return { key: t.key, label, inputChars: null };
  }), { nanoBudgetChars: browser.nanoBudgetChars, offline: !browser.online, cloudBudgetAvailable: browser.cloudBudgetAvailable });
}

/** Where each accepted route goes: a revised task by its own id, a new task by the ids the accept returned (in plan order). Locked ones are left alone. */
export function routeTargets(tasks: readonly { readonly key: string; readonly revises?: string }[], routes: readonly PmPlanRoute[], acceptedIds: readonly string[], snap: ProjectViewSnapshot | null): { taskId: string; mode: RoutePolicyMode; overrideRevision: number }[] {
  const revisedIds = new Set(tasks.flatMap((t) => (t.revises ? [t.revises] : [])));
  const fresh = acceptedIds.filter((id) => !revisedIds.has(id));
  let n = 0;
  return tasks.flatMap((t) => {
    const taskId = t.revises ?? fresh[n++];
    const r = routes.find((x) => x.key === t.key);
    if (!taskId || !r || r.locked) return [];
    return [{ taskId, mode: r.mode, overrideRevision: snap?.tasks[taskId]?.route?.overrideRevision ?? 0 }];
  });
}
