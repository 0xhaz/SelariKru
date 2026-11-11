import { pmPlanRoutes, type PmPlanRoute, type RoutePolicyMode } from '@selarikru/domain';
import { modeLabel } from '../hybrid/model.ts';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';
import type { BrowserInputs } from '../hybrid/model.ts';

/**
 * H12: the Project Manager proposes where each task of its plan runs, with the reason, from suggestRoute's own inputs: the task's label (a revised task's lock in
 * the snapshot; a new task takes the label of the task the PM call was about), whether this browser is offline, and whether the cloud budget is spent. The owner
 * accepts the routes with the plan; a locked task stays Local only and is never sent a route.
 */
/** Fix round 1 (I5): how wide a mode lets a call go. A proposal is never wider than the task's route now. */
const WIDTH: Readonly<Record<RoutePolicyMode, number>> = { ONLY_ON_DEVICE: 0, PREFER_ON_DEVICE: 1, PREFER_IN_CLOUD: 2, ONLY_IN_CLOUD: 2 };

export interface ShownRoute extends PmPlanRoute {
  /** The task's effective route now (a new task: the run default). Null: none set. */
  readonly now: RoutePolicyMode | null;
  /** "now X → proposed Y", as shown. */
  readonly change: string;
}

export function planRouteProposals(tasks: readonly { readonly key: string; readonly revises?: string }[], snap: ProjectViewSnapshot | null, subjectLabel: unknown, browser: BrowserInputs, runId: string | null = null): ShownRoute[] {
  const runDefault = runId ? snap?.runs[runId]?.routePolicy?.value ?? null : null;
  const suggested = pmPlanRoutes(tasks.map((t) => {
    const revised = t.revises ? snap?.tasks[t.revises] : undefined;
    // A revised task with no known route counts as restricted: missing is never allowed.
    const label = t.revises ? (revised?.route ? (revised.route.lock ? 'restricted' : 'internal') : 'restricted') : subjectLabel;
    return { key: t.key, label, inputChars: null };
  }), { nanoBudgetChars: browser.nanoBudgetChars, offline: !browser.online, cloudBudgetAvailable: browser.cloudBudgetAvailable });
  return suggested.map((r) => {
    const t = tasks.find((x) => x.key === r.key)!;
    const now: RoutePolicyMode | null = t.revises ? snap?.tasks[t.revises]?.route?.effective ?? null : (runDefault as RoutePolicyMode | null);
    // Never wider than now: device only stays device only, Local first never becomes cloud.
    const mode = now !== null && WIDTH[r.mode] > WIDTH[now] ? now : r.mode;
    const reason = mode === r.mode ? r.reason : `${modeLabel(now)}, kept: the Project Manager never widens a task's route. (${r.reason})`;
    return { ...r, mode, reason, now, change: `now ${modeLabel(now)} → proposed ${modeLabel(mode)}` };
  });
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
