import { canonicalJson, sha256Hex, TaskSpecSchema, type TaskSpec } from '@selarikru/domain';
import { schema, type Executor } from '@selarikru/persistence';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from './errors.ts';
import { ProjectPlanConfigSchema, reviewPmPlan, toPlanReviewAppError, type ProjectPlanSettings } from './proposals.ts';
import { loadTaskRoute } from './route-policy.ts';

/**
 * H11 fix rounds 2 and 3: a Project Manager plan's task specs, derived by the server from the PM's own output, the same way for the review and for plan-revisions, so
 * a client cannot skip a check by editing what it sends. Each task the plan may revise is judged locked by its real route lock (N2). New task ids are derived from
 * the pmPlan call's record, so the two derivations agree.
 */
export const PM_PLAN_REFUSAL: Readonly<Record<string, string>> = {
  revises_unknown: 'The plan revises a task this run does not have.',
  revises_locked: 'The plan revises a task that holds restricted data; that task is planned on this device only.',
  revises_duplicate: 'Two tasks of the plan revise the same task.',
  revises_role_changed: 'A revision keeps its task\'s role; a new role needs a new task.',
  path_outside_role: 'A task names a path outside its role\'s paths.',
  path_invalid: 'A task names a path that is not a plain path inside the repository (no "..", no absolute or empty path).',
  path_reserved: 'A task names a reserved path (.git, .env, the skills workspace or a credentials file).',
  dependency_unknown: 'A task depends on a key the plan does not have.',
  role_unknown: 'A new task\'s role is not one of this project\'s roles.',
};

export const pmPlanHash = (plan: unknown): string => sha256Hex(canonicalJson(plan));

export async function derivePmPlanSpecs(db: Executor, input: {
  readonly tenantId: string; readonly projectId: string; readonly runId: string; readonly routeRecordId: string; readonly plan: unknown; readonly settings: ProjectPlanSettings | null | undefined; readonly nanoBudgetChars: number;
}): Promise<TaskSpec[]> {
  const cfg = ProjectPlanConfigSchema.safeParse({ ...(input.settings ?? {}), tenantId: input.tenantId, projectId: input.projectId, runId: input.runId });
  if (!input.settings || !cfg.success) throw new AppError(422, 'missing_server_config', 'project plan settings are missing or incomplete', cfg.success ? [] : cfg.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const rows = await db.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions).innerJoin(schema.taskStatus, and(
    eq(schema.taskStatus.tenantId, schema.taskRevisions.tenantId), eq(schema.taskStatus.projectId, schema.taskRevisions.projectId), eq(schema.taskStatus.taskId, schema.taskRevisions.taskId), eq(schema.taskStatus.currentRevision, schema.taskRevisions.revision)))
    .where(and(eq(schema.taskRevisions.tenantId, input.tenantId), eq(schema.taskRevisions.projectId, input.projectId), eq(schema.taskRevisions.runId, input.runId), sql`${schema.taskStatus.status} NOT IN ('cancelled', 'superseded')`));
  const current: { spec: TaskSpec; locked: boolean }[] = [];
  for (const r of rows) {
    const p = TaskSpecSchema.safeParse(r.spec);
    if (!p.success) continue;
    // The lock as every route read computes it: an unreadable route counts as locked.
    const route = await loadTaskRoute(db, input.tenantId, input.projectId, p.data.taskId, input.nanoBudgetChars);
    current.push({ spec: p.data, locked: route === null || route.lock !== null });
  }
  // The project's roles, as a worker's role must be one (M1): those its tasks name.
  const all = await db.select({ spec: schema.taskRevisions.spec }).from(schema.taskRevisions).where(and(eq(schema.taskRevisions.tenantId, input.tenantId), eq(schema.taskRevisions.projectId, input.projectId)));
  const projectRoles = [...new Set([...all.map((x) => (x.spec as { role?: unknown }).role).filter((r): r is string => typeof r === 'string'), ...Object.keys(cfg.data.rolePaths ?? {}), cfg.data.role])];
  const r = reviewPmPlan(input.plan, cfg.data, current, { taskIdPrefix: `pm-${pmPlanHash(input.routeRecordId).slice(0, 10)}`, projectRoles });
  if (!r.ok) {
    if (r.error.code === 'pm_plan_refused') throw new AppError(422, 'pm_plan_refused', PM_PLAN_REFUSAL[r.error.reason] ?? 'this plan cannot be accepted', { reason: r.error.reason, key: r.error.key });
    throw toPlanReviewAppError(r.error);
  }
  return r.value.tasks;
}
