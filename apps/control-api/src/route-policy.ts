import {
  RoutePolicyModeSchema, RouteRecordSchema, TaskSpecSchema, effectiveRoutePolicy, routeLockFor, suggestRoute,
  type RouteLock, type RoutePolicyMode, type RouteRecord, type TaskSpec,
} from '@selarikru/domain';
import { schema, type Executor } from '@selarikru/persistence';
import { projectSourceReader, resolveSourcesWith } from '@selarikru/workflow';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';

/**
 * Route policy per task, as the server holds and serves it (plan.md §4.1). The run default is the run setting `route_policy`, or else the choice recorded at onboarding
 * (the run's setup snapshot); the task override is the task setting `route_override`. The lock is derived from labels on every read: the strongest of the project's
 * label, the task's current spec and every Brain source recorded for the task, folded as the Brain folds them. No route write can lift it; only a reclassification
 * that lowers a label does. Everything here is read without a lock.
 */

export interface RunRouteDefault {
  readonly value: RoutePolicyMode | null;
  readonly origin: 'setting' | 'onboarding' | 'unset';
  readonly revision: number;
}

const mode = (v: unknown): RoutePolicyMode | null => { const p = RoutePolicyModeSchema.safeParse(v); return p.success ? p.data : null; };

/** The run default: a saved setting (server-enforced, so in force when saved), else the onboarding choice, else unset. */
export function runRouteDefault(run: { setupSnapshot: Record<string, unknown> | null }, saved: { desired: unknown; desiredRevision: number } | undefined): RunRouteDefault {
  if (saved) return { value: mode(saved.desired), origin: 'setting', revision: saved.desiredRevision };
  const seeded = mode(run.setupSnapshot?.['inference']);
  return seeded ? { value: seeded, origin: 'onboarding', revision: 0 } : { value: null, origin: 'unset', revision: 0 };
}

/** The labels that decide a task's lock. An unreadable spec contributes `undefined`, which the fold reads as `secret`. */
export const lockLabels = (projectLabel: unknown, spec: TaskSpec | null, brainLabels: readonly unknown[], inherited: readonly unknown[] = []): unknown[] => [projectLabel, spec ? spec.classification : undefined, ...brainLabels, ...inherited];

/**
 * What each task inherits from its transitive predecessors and their contract artifacts, judged exactly as the claim judges it (`resolveSourcesWith`, fail closed): a
 * task downstream of a restricted one stays locked for routing, the base-file relay and accepting a proposal. The project is read once for all the given tasks, with
 * plain reads that lock nothing, and nothing is caught: a failed read fails the caller's request rather than leave its transaction aborted behind a guess.
 */
export async function inheritedLabelsFor(db: Executor, tenantId: string, projectId: string, specs: readonly (TaskSpec | null)[]): Promise<Map<string, unknown[]>> {
  const out = new Map<string, unknown[]>();
  const known = specs.filter((s): s is TaskSpec => s !== null);
  if (known.length === 0) return out;
  const read = await projectSourceReader(db, { tenantId, projectId });
  for (const spec of known) out.set(spec.taskId, [(await resolveSourcesWith(read, spec)).routeClassification]);
  return out;
}

/** What the suggestion measures: the task's own words that a change proposal reads. Paths and file contents are not known here, and the reason says only this. */
export const estimatedInputChars = (spec: TaskSpec | null): number | null =>
  spec === null ? null : spec.title.length + (spec.description?.length ?? 0) + (spec.criteria ?? []).reduce((n, c) => n + c.text.length, 0);

export interface TaskRouteView {
  readonly effective: RoutePolicyMode | null;
  readonly source: 'task' | 'run' | 'lock' | 'unset';
  readonly runDefault: RoutePolicyMode | null;
  readonly override: RoutePolicyMode | null;
  readonly overrideRevision: number;
  readonly lock: { readonly label: 'restricted' | 'secret'; readonly reason: string } | null;
  readonly suggestion: ReturnType<typeof suggestRoute>;
  readonly lastObserved: RouteRecord | null;
}

export function taskRouteView(input: {
  readonly spec: TaskSpec | null;
  readonly projectLabel: unknown;
  readonly brainLabels: readonly unknown[];
  readonly runDefault: RoutePolicyMode | null;
  readonly override: { readonly value: RoutePolicyMode | null; readonly revision: number } | undefined;
  readonly lastObserved: RouteRecord | null;
  readonly nanoBudgetChars: number;
  /** From the task's predecessors (`inheritedLabels`). */
  readonly inherited?: readonly unknown[];
}): TaskRouteView {
  const lock = routeLockFor(lockLabels(input.projectLabel, input.spec, input.brainLabels, input.inherited ?? []));
  const override = input.override?.value ?? null;
  const effective = effectiveRoutePolicy({ task: override, run: input.runDefault, lock });
  return {
    effective: effective.mode, source: effective.source as TaskRouteView['source'], runDefault: input.runDefault, override, overrideRevision: input.override?.revision ?? 0,
    lock: lock ? { label: lock.label, reason: lock.reason } : null,
    // The task's change proposal is its main AI step. Offline and the cloud budget are the browser's to know, so those rows are applied there, never guessed here.
    suggestion: suggestRoute({ label: lock?.label ?? input.spec?.classification ?? 'secret', stepKind: 'patch', inputChars: estimatedInputChars(input.spec) }, { nanoBudgetChars: input.nanoBudgetChars }),
    lastObserved: input.lastObserved,
  };
}

/** A stored route record as the view shows it. A row that does not read as one is left out rather than guessed. */
export function routeRecordOf(row: { reportId: string; subjectId: string; payload: Record<string, unknown>; createdAt: Date }): RouteRecord | null {
  const r = RouteRecordSchema.safeParse({ ...row.payload, recordId: row.reportId, taskId: row.subjectId, reportedBy: 'browser', trust: 'untrusted', reportedAt: row.createdAt.toISOString() });
  return r.success ? r.data : null;
}

export interface ProjectRouteInputs {
  readonly projectLabel: unknown;
  readonly runDefaults: ReadonlyMap<string, RunRouteDefault>;
  readonly overrides: ReadonlyMap<string, { readonly value: RoutePolicyMode | null; readonly revision: number }>;
  readonly brainLabels: ReadonlyMap<string, readonly unknown[]>;
  readonly lastObserved: ReadonlyMap<string, RouteRecord>;
}

/** Everything the project's task routes are built from, in a handful of reads. */
export async function loadProjectRouteInputs(db: Executor, tenantId: string, projectId: string, taskIds?: readonly string[]): Promise<ProjectRouteInputs> {
  const [project] = await db.select({ classification: schema.projects.classification }).from(schema.projects).where(and(eq(schema.projects.tenantId, tenantId), eq(schema.projects.projectId, projectId)));
  const runs = await db.select({ runId: schema.runs.runId, setupSnapshot: schema.runs.setupSnapshot }).from(schema.runs).where(and(eq(schema.runs.tenantId, tenantId), eq(schema.runs.projectId, projectId)));
  const saved = await db.select({ runId: schema.runSettings.runId, desired: schema.runSettings.desired, desiredRevision: schema.runSettings.desiredRevision }).from(schema.runSettings)
    .where(and(eq(schema.runSettings.tenantId, tenantId), eq(schema.runSettings.projectId, projectId), eq(schema.runSettings.field, 'route_policy')));
  const only = taskIds ? [...taskIds] : null;
  const overrides = await db.select({ taskId: schema.taskSettings.taskId, desired: schema.taskSettings.desired, desiredRevision: schema.taskSettings.desiredRevision }).from(schema.taskSettings)
    .where(and(eq(schema.taskSettings.tenantId, tenantId), eq(schema.taskSettings.projectId, projectId), eq(schema.taskSettings.field, 'route_override'), ...(only ? [inArray(schema.taskSettings.taskId, only)] : [])));
  // The latest revision of every Brain source recorded for a task, and each task's latest route record: only for the tasks asked about, when given.
  const bs = schema.brainSources;
  const brain = await db.selectDistinctOn([bs.sourceId], { sourceId: bs.sourceId, taskId: bs.taskId, classification: bs.classification }).from(bs)
    .where(and(eq(bs.tenantId, tenantId), eq(bs.projectId, projectId), only ? inArray(bs.taskId, only) : isNotNull(bs.taskId)))
    .orderBy(bs.sourceId, desc(bs.revision));
  const cr = schema.clientReports;
  // Served by `client_reports_route_lookup` (project, kind, subject, created_at).
  const last = await db.selectDistinctOn([cr.subjectId], { reportId: cr.reportId, subjectId: cr.subjectId, payload: cr.payload, createdAt: cr.createdAt }).from(cr)
    .where(and(eq(cr.tenantId, tenantId), eq(cr.projectId, projectId), eq(cr.kind, 'route'), eq(cr.subjectKind, 'task'), ...(only ? [inArray(cr.subjectId, only)] : [])))
    .orderBy(cr.subjectId, desc(cr.createdAt), desc(cr.reportId));
  const brainLabels = new Map<string, unknown[]>();
  for (const b of brain) {
    if (b.taskId === null) continue;
    brainLabels.set(b.taskId, [...(brainLabels.get(b.taskId) ?? []), b.classification]);
  }
  const lastObserved = new Map<string, RouteRecord>();
  for (const r of last) {
    const rec = routeRecordOf(r);
    if (rec) lastObserved.set(rec.taskId, rec);
  }
  return {
    // A project row that cannot be read locks every task: fails closed.
    projectLabel: project?.classification,
    runDefaults: new Map(runs.map((r) => [r.runId, runRouteDefault(r, saved.find((s) => s.runId === r.runId))])),
    overrides: new Map(overrides.map((o) => [o.taskId, { value: mode(o.desired), revision: o.desiredRevision }])),
    brainLabels,
    lastObserved,
  };
}

/** A task's current spec, its run and its route, read fresh. Null when there is no such task. */
export async function loadTaskRoute(db: Executor, tenantId: string, projectId: string, taskId: string, nanoBudgetChars: number): Promise<{ readonly runId: string; readonly revision: number; readonly rowRevision: number; readonly spec: TaskSpec | null; readonly lock: RouteLock | null; readonly route: TaskRouteView; readonly labels: readonly unknown[] } | null> {
  const [row] = await db.select({ revision: schema.taskStatus.currentRevision, rowRevision: schema.taskStatus.rowRevision, runId: schema.taskRevisions.runId, spec: schema.taskRevisions.spec }).from(schema.taskStatus)
    .innerJoin(schema.taskRevisions, and(eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId), eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision)))
    .where(and(eq(schema.taskStatus.tenantId, tenantId), eq(schema.taskStatus.projectId, projectId), eq(schema.taskStatus.taskId, taskId)));
  if (!row) return null;
  const parsed = TaskSpecSchema.safeParse(row.spec);
  const spec = parsed.success ? parsed.data : null;
  const inputs = await loadProjectRouteInputs(db, tenantId, projectId, [taskId]);
  const brainLabels = inputs.brainLabels.get(taskId) ?? [];
  const inherited = (await inheritedLabelsFor(db, tenantId, projectId, [spec])).get(taskId) ?? [];
  const route = taskRouteView({
    spec, projectLabel: inputs.projectLabel, brainLabels, runDefault: inputs.runDefaults.get(row.runId)?.value ?? null, override: inputs.overrides.get(taskId),
    lastObserved: inputs.lastObserved.get(taskId) ?? null, nanoBudgetChars, inherited,
  });
  const labels = lockLabels(inputs.projectLabel, spec, brainLabels, inherited);
  return { runId: row.runId, revision: row.revision, rowRevision: row.rowRevision, spec, lock: routeLockFor(labels), route, labels };
}

/** A task's route history, newest first. Metadata only. */
export async function loadRouteHistory(db: Executor, tenantId: string, projectId: string, taskId: string, limit = 200): Promise<RouteRecord[]> {
  const rows = await db.select({ reportId: schema.clientReports.reportId, subjectId: schema.clientReports.subjectId, payload: schema.clientReports.payload, createdAt: schema.clientReports.createdAt }).from(schema.clientReports)
    .where(and(eq(schema.clientReports.tenantId, tenantId), eq(schema.clientReports.projectId, projectId), eq(schema.clientReports.kind, 'route'), eq(schema.clientReports.subjectKind, 'task'), eq(schema.clientReports.subjectId, taskId)))
    .orderBy(desc(schema.clientReports.createdAt), asc(schema.clientReports.reportId)).limit(limit);
  return rows.flatMap((r) => { const rec = routeRecordOf(r); return rec ? [rec] : []; });
}

/**
 * The lock on each of these tasks, from their current specs and labels. For the settings list: an override the lock overrides is shown as `locked`, so the list never
 * contradicts the task's route.
 */
export async function taskRouteLocks(db: Executor, tenantId: string, projectId: string, taskIds: readonly string[]): Promise<Map<string, RouteLock | null>> {
  const out = new Map<string, RouteLock | null>();
  if (taskIds.length === 0) return out;
  const ids = [...new Set(taskIds)];
  const rows = await db.select({ taskId: schema.taskStatus.taskId, spec: schema.taskRevisions.spec }).from(schema.taskStatus)
    .innerJoin(schema.taskRevisions, and(eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId), eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision)))
    .where(and(eq(schema.taskStatus.tenantId, tenantId), eq(schema.taskStatus.projectId, projectId), inArray(schema.taskStatus.taskId, ids)));
  const inputs = await loadProjectRouteInputs(db, tenantId, projectId, ids);
  const specs = new Map(ids.map((id) => { const parsed = TaskSpecSchema.safeParse(rows.find((r) => r.taskId === id)?.spec); return [id, parsed.success ? parsed.data : null] as const; }));
  const inherited = await inheritedLabelsFor(db, tenantId, projectId, [...specs.values()]);
  for (const id of ids) out.set(id, routeLockFor(lockLabels(inputs.projectLabel, specs.get(id) ?? null, inputs.brainLabels.get(id) ?? [], inherited.get(id) ?? [])));
  return out;
}
