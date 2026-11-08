import type { TaskSpec, TaskStatus } from './task.ts';

/** A versioned set of tasks proposed for a run. Pure data; validated before it is accepted. */
export interface PlanRevision {
  readonly projectId: string;
  readonly runId: string;
  readonly revision: number;
  readonly tasks: readonly TaskSpec[];
}

export interface PlanContext {
  readonly projectId: string;
  readonly runId: string;
}

export type PlanError =
  /** `path` is ordered along dependency edges and starts and ends on the same task. */
  | { kind: 'cycle'; path: string[] }
  | { kind: 'missing_dependency'; taskId: string; dependsOn: string }
  | { kind: 'cross_project_edge'; taskId: string; dependsOn: string }
  | { kind: 'duplicate_task_id'; taskId: string }
  | { kind: 'revision_mismatch'; taskId: string; dependsOn: string; expected: number; actual: number }
  | { kind: 'scope_mismatch'; taskId?: string; field: 'projectId' | 'runId' };

export type PlanValidation = { ok: true } | { ok: false; errors: PlanError[] };

/** Task id to observed status and revision. */
export type StatusMap = ReadonlyMap<string, { readonly status: TaskStatus; readonly revision: number }>;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** First occurrence of each task id wins. */
function indexTasks(plan: PlanRevision): Map<string, TaskSpec> {
  const m = new Map<string, TaskSpec>();
  for (const task of plan.tasks) if (!m.has(task.taskId)) m.set(task.taskId, task);
  return m;
}

/** Sorted, de-duplicated dependency ids that exist in the plan. */
function depsOf(task: TaskSpec, byId: ReadonlyMap<string, TaskSpec>): string[] {
  return [...new Set(task.dependencies.map((d) => d.taskId))].filter((id) => byId.has(id)).sort(cmp);
}

function findCycles(byId: ReadonlyMap<string, TaskSpec>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of depsOf(byId.get(id)!, byId)) {
      const s = state.get(d);
      if (s === 'visiting') cycles.push([...stack.slice(stack.indexOf(d)), d]);
      else if (s === undefined) visit(d);
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of [...byId.keys()].sort(cmp)) if (!state.has(id)) visit(id);
  return cycles;
}

/** Reports every problem found; never throws. Agent-proposed plans are accepted only when `ok`. */
export function validatePlanRevision(plan: PlanRevision, ctx: PlanContext): PlanValidation {
  const errors: PlanError[] = [];
  if (plan.projectId !== ctx.projectId) errors.push({ kind: 'scope_mismatch', field: 'projectId' });
  if (plan.runId !== ctx.runId) errors.push({ kind: 'scope_mismatch', field: 'runId' });

  const byId = new Map<string, TaskSpec>();
  const dupes = new Set<string>();
  for (const task of plan.tasks) {
    if (byId.has(task.taskId)) {
      if (!dupes.has(task.taskId)) errors.push({ kind: 'duplicate_task_id', taskId: task.taskId });
      dupes.add(task.taskId);
    } else byId.set(task.taskId, task);
  }

  for (const task of byId.values()) {
    if (task.projectId !== ctx.projectId) errors.push({ kind: 'scope_mismatch', taskId: task.taskId, field: 'projectId' });
    if (task.runId !== ctx.runId) errors.push({ kind: 'scope_mismatch', taskId: task.taskId, field: 'runId' });
    for (const edge of task.dependencies) {
      const target = byId.get(edge.taskId);
      if (!target) {
        errors.push({ kind: 'missing_dependency', taskId: task.taskId, dependsOn: edge.taskId });
        continue;
      }
      if (target.projectId !== task.projectId || target.projectId !== ctx.projectId) {
        errors.push({ kind: 'cross_project_edge', taskId: task.taskId, dependsOn: edge.taskId });
      }
      if (edge.revision !== target.revision) {
        errors.push({ kind: 'revision_mismatch', taskId: task.taskId, dependsOn: edge.taskId, expected: edge.revision, actual: target.revision });
      }
    }
  }
  for (const path of findCycles(byId)) errors.push({ kind: 'cycle', path });
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Both `artifact_verified` and `candidate_verified` need `verified` or `merged`: the spec does not
 * distinguish them by predecessor status. `change_merged` needs `merged`.
 */
function edgeSatisfied(edge: TaskSpec['dependencies'][number], statuses: StatusMap): boolean {
  const s = statuses.get(edge.taskId);
  if (!s || s.revision !== edge.revision) return false;
  return edge.condition === 'change_merged' ? s.status === 'merged' : s.status === 'verified' || s.status === 'merged';
}

/** Task ids in `planned` whose every dependency edge is satisfied. Dependency readiness only. Sorted by id. */
export function readyTasks(plan: PlanRevision, statuses: StatusMap): string[] {
  const out = new Set<string>();
  for (const task of plan.tasks) {
    if (statuses.get(task.taskId)?.status !== 'planned') continue;
    if (task.dependencies.every((e) => edgeSatisfied(e, statuses))) out.add(task.taskId);
  }
  return [...out].sort(cmp);
}

/**
 * Longest dependency chain by node count, predecessor first; ties go to the smaller task id.
 * Invalid plans: returns [] if there is a cycle; otherwise ignores missing dependencies and
 * duplicate ids (first occurrence wins).
 */
export function criticalPath(plan: PlanRevision): string[] {
  const byId = indexTasks(plan);
  if (findCycles(byId).length > 0) return [];
  const len = new Map<string, number>();
  const best = new Map<string, string | undefined>();
  const measure = (id: string): number => {
    const known = len.get(id);
    if (known !== undefined) return known;
    let top = 0;
    let via: string | undefined;
    for (const d of depsOf(byId.get(id)!, byId)) {
      const l = measure(d);
      if (l > top) { top = l; via = d; }
    }
    len.set(id, top + 1);
    best.set(id, via);
    return top + 1;
  };
  let end: string | undefined;
  for (const id of [...byId.keys()].sort(cmp)) {
    const l = measure(id);
    if (end === undefined || l > len.get(end)!) end = id;
  }
  const path: string[] = [];
  for (let cur = end; cur !== undefined; cur = best.get(cur)) path.push(cur);
  return path.reverse();
}

export type ReplanDecision = { kind: 'merged_dependent'; taskId: string };

export interface ReplanDiff {
  /** Tasks whose current revision must be superseded (sorted). */
  superseded: string[];
  /** Tasks unaffected by the change (sorted). */
  stillValid: string[];
  /** Human or planner decisions needed: merged dependents cannot be superseded and need a follow-up or revert task. */
  requiredDecisions: ReplanDecision[];
}

/**
 * Pure replan diff for a contract change. `changed` is a task id (its transitive dependents are
 * affected) or a contract artifact id (tasks holding that ref and their transitive dependents are
 * affected). Merged tasks are immutable; superseded and cancelled ones need no action.
 * A task missing from `statuses` is treated as `planned`.
 */
export function supersedeAfterContractChange(plan: PlanRevision, changed: string, statuses: StatusMap): ReplanDiff {
  const byId = indexTasks(plan);
  const dependents = new Map<string, string[]>();
  for (const task of byId.values()) {
    for (const d of depsOf(task, byId)) dependents.set(d, [...(dependents.get(d) ?? []), task.taskId]);
  }
  const seeds = byId.has(changed)
    ? (dependents.get(changed) ?? [])
    : [...byId.values()].filter((x) => x.contractRefs.some((r) => r.artifactId === changed)).map((x) => x.taskId);
  const affected = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (affected.has(id) || id === changed) continue;
    affected.add(id);
    queue.push(...(dependents.get(id) ?? []));
  }
  const superseded: string[] = [];
  const requiredDecisions: ReplanDecision[] = [];
  const touched = new Set<string>();
  for (const id of [...affected].sort(cmp)) {
    const status = statuses.get(id)?.status ?? 'planned';
    if (status === 'merged') { requiredDecisions.push({ kind: 'merged_dependent', taskId: id }); touched.add(id); }
    else if (status !== 'superseded' && status !== 'cancelled') { superseded.push(id); touched.add(id); }
  }
  const stillValid = [...byId.keys()].filter((id) => !touched.has(id)).sort(cmp);
  return { superseded, stillValid, requiredDecisions };
}
