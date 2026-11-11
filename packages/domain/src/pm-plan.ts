/**
 * H11 fix round 2 (I4): how an accepted Project Manager plan becomes a plan revision, one rule for the server and the demo. A plan task that names `revises` (an id
 * from the plan scope the PM saw) becomes the next revision of that task: same task id and role, with the PM's title, description, criteria, paths and dependencies.
 * A task without `revises` is a new task. Dependencies on T-keys map to the final task ids at their final revisions. A task of the run the plan does not mention is
 * left as it is. Nothing is squeezed: roles, paths and dependencies are carried as the PM gave them, inside the role's paths.
 */
export interface PmPlanTask {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly role: string;
  readonly requirementIds: readonly string[];
  readonly paths: readonly string[];
  readonly dependsOn: readonly string[];
  readonly revises?: string | undefined;
}

export interface PmPlanExisting {
  readonly taskId: string;
  readonly revision: number;
  readonly role: string;
  /** Restricted or secret data: its plan stays on the device, so a cloud-visible plan may not revise it. */
  readonly locked: boolean;
  readonly allowedPaths: readonly string[];
}

export type PmPlanRefusal = 'revises_unknown' | 'revises_locked' | 'revises_duplicate' | 'revises_role_changed' | 'path_outside_role' | 'dependency_unknown';

export interface PmPlanItem {
  readonly key: string;
  readonly taskId: string;
  readonly revision: number;
  /** The existing task this revises, or null for a new task. */
  readonly revises: string | null;
  readonly role: string;
  readonly title: string;
  readonly description: string;
  readonly requirementIds: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly dependencies: readonly { readonly taskId: string; readonly revision: number; readonly condition: 'artifact_verified' }[];
}

export type PmPlanMapping = { readonly ok: true; readonly items: readonly PmPlanItem[] } | { readonly ok: false; readonly reason: PmPlanRefusal; readonly key: string };

/** Whether a path lies inside one of the roots: the root itself or below it. */
export function pathWithin(path: string, roots: readonly string[]): boolean {
  return roots.some((r) => r === '**' || path === r || path.startsWith(`${r.replace(/\/+$/, '')}/`));
}

export function mapPmPlan(tasks: readonly PmPlanTask[], existing: readonly PmPlanExisting[], opts: {
  /** The id a new task gets, by its position in the plan. */
  readonly newTaskId: (index: number) => string;
  /** Per role, the paths its tasks may change (the project's role paths). A role not listed gets `allowedPaths`. */
  readonly rolePaths?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly allowedPaths: readonly string[];
}): PmPlanMapping {
  const byId = new Map(existing.map((e) => [e.taskId, e]));
  const seen = new Set<string>();
  const ids = new Map<string, { taskId: string; revision: number }>();
  for (const [i, t] of tasks.entries()) {
    if (t.revises !== undefined) {
      const e = byId.get(t.revises);
      if (!e) return { ok: false, reason: 'revises_unknown', key: t.key };
      if (e.locked) return { ok: false, reason: 'revises_locked', key: t.key };
      if (seen.has(e.taskId)) return { ok: false, reason: 'revises_duplicate', key: t.key };
      if (e.role !== t.role) return { ok: false, reason: 'revises_role_changed', key: t.key };
      seen.add(e.taskId);
      ids.set(t.key, { taskId: e.taskId, revision: e.revision + 1 });
    } else ids.set(t.key, { taskId: opts.newTaskId(i), revision: 1 });
  }
  const items: PmPlanItem[] = [];
  for (const t of tasks) {
    const e = t.revises !== undefined ? byId.get(t.revises)! : null;
    const roots = [...(opts.rolePaths?.[t.role] ?? opts.allowedPaths), ...(e?.allowedPaths ?? [])];
    if (t.paths.some((p) => !pathWithin(p, roots))) return { ok: false, reason: 'path_outside_role', key: t.key };
    const deps: PmPlanItem['dependencies'][number][] = [];
    for (const d of t.dependsOn) {
      const to = ids.get(d);
      if (!to) return { ok: false, reason: 'dependency_unknown', key: t.key };
      deps.push({ taskId: to.taskId, revision: to.revision, condition: 'artifact_verified' });
    }
    const id = ids.get(t.key)!;
    items.push({ key: t.key, taskId: id.taskId, revision: id.revision, revises: e?.taskId ?? null, role: t.role, title: t.title, description: t.description, requirementIds: [...t.requirementIds], allowedPaths: [...t.paths], dependencies: deps });
  }
  return { ok: true, items };
}
