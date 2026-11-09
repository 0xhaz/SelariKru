import { availableCatalog, findCatalogModel, NO_HARNESS_CATALOG, type RunnerHarnessReport, type CatalogModel, type HarnessCatalog, type ModelRate, type ModelRefusalReason, type ModelSelection, type RecordedAssignment, type TaskSpec } from '@selarikru/domain';
import { evaluate, type Policy, type PolicyDecision } from '@selarikru/policy';
import { schema, type Executor } from '@selarikru/persistence';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { TaskKey } from './taskstate.ts';
import type { SchedulerContext } from './types.ts';

export type SelectionVerdict =
  | { readonly ok: true; readonly model: CatalogModel; readonly decision: PolicyDecision }
  | { readonly ok: false; readonly reason: ModelRefusalReason; readonly decision: PolicyDecision | null };

/**
 * The one check for a selection, shared by the owner's assignment route and the scheduler's claim, so a choice and a launch cannot disagree. A provider the
 * adapter does not declare, or a model it does not list, is refused before any policy question; policy then has the last word.
 */
export function validateSelection(selection: ModelSelection, catalog: HarnessCatalog, policy: Policy | undefined): SelectionVerdict {
  if (catalog.status !== 'detected' || catalog.providers.length === 0) return { ok: false, reason: 'no_provider_detected', decision: null };
  const found = findCatalogModel(catalog, selection);
  if (found.provider === null || found.provider.modelSelection !== 'supported') return { ok: false, reason: 'unsupported_provider', decision: null };
  if (found.model === null) return { ok: false, reason: 'unsupported_model', decision: null };
  const decision = evaluate({ kind: 'assign_model', selection }, policy);
  if (decision.decision !== 'allow') return { ok: false, reason: 'model_not_allowed', decision };
  return { ok: true, model: found.model, decision };
}

const blockCode = (reason: ModelRefusalReason, selection: ModelSelection): string => `${reason}:${selection.provider}/${selection.model}`;

export type ResolvedAssignment =
  | { readonly ok: true; readonly assignment: RecordedAssignment }
  | { readonly ok: false; readonly reason: string };

/** The current row per scope and key: the highest revision. A removed assignment reads as null. */
async function currentRows(db: Executor, tenantId: string, projectId: string, wanted: readonly { readonly scope: 'role' | 'task'; readonly key: string }[]): Promise<Map<string, ModelSelection>> {
  const t = schema.modelAssignments;
  const rows = await db.select().from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.projectId, projectId), or(...wanted.map((w) => and(eq(t.scopeKind, w.scope), eq(t.scopeKey, w.key))))))
    .orderBy(desc(t.revision));
  const out = new Map<string, ModelSelection>();
  const seen = new Set<string>();
  for (const r of rows) {
    const id = `${r.scopeKind}:${r.scopeKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (r.provider !== null && r.model !== null) out.set(id, { provider: r.provider, model: r.model });
  }
  return out;
}

/**
 * What this attempt will run, decided once at claim. A benchmark trial uses its pin and nothing else; otherwise the task override, then the role, then the
 * project default. The result is checked again here because the adapter or the policy can have changed since the choice was made: a refusal blocks the claim
 * before any attempt, reservation or sandbox exists.
 */
export async function resolveAssignment(ctx: SchedulerContext, db: Executor, key: TaskKey, spec: Pick<TaskSpec, 'role' | 'taskId'>, run: { readonly trial: boolean; readonly pinnedModel: ModelSelection | null }, runnerReport: readonly RunnerHarnessReport[]): Promise<ResolvedAssignment> {
  let selection: ModelSelection;
  let source: RecordedAssignment['source'];
  if (run.trial) {
    if (run.pinnedModel === null) return { ok: false, reason: 'trial_model_not_pinned' };
    selection = run.pinnedModel;
    source = 'trial_pin';
  } else {
    const rows = await currentRows(db, key.tenantId, key.projectId, [{ scope: 'task', key: spec.taskId }, { scope: 'role', key: spec.role }]);
    const task = rows.get(`task:${spec.taskId}`);
    const role = rows.get(`role:${spec.role}`);
    const fallback = ctx.policy?.models?.default;
    if (task) { selection = task; source = 'task'; } else if (role) { selection = role; source = 'role'; } else if (fallback) { selection = fallback; source = 'default'; } else return { ok: false, reason: `model_not_assigned:${spec.role}` };
  }
  const declared = ctx.catalog ?? NO_HARNESS_CATALOG;
  const verdict = validateSelection(selection, declared, ctx.policy);
  if (!verdict.ok) return { ok: false, reason: blockCode(verdict.reason, selection) };
  // Declared and allowed is not enough: this runner has to be able to launch it.
  if (findCatalogModel(availableCatalog(declared, runnerReport), selection).model === null) return { ok: false, reason: blockCode('model_not_on_runner', selection) };
  return { ok: true, assignment: { ...selection, source, route: verdict.model.route } };
}

/**
 * Model calls follow the data, independently of where the worker runs: restricted (or stronger) input may reach only a device model, and a route nobody can state may not be used at all.
 * Returns the block code, or null when the route is acceptable.
 */
export function routeRefusal(assignment: Pick<RecordedAssignment, 'provider' | 'model' | 'route'>, classification: string): string | null {
  if (assignment.route === 'unknown') return blockCode('model_route_unknown', assignment);
  if ((classification === 'restricted' || classification === 'secret') && assignment.route !== 'device') return blockCode('restricted_requires_device_model', assignment);
  return null;
}

export interface WorstCaseHold {
  readonly amountMicros: number;
  /**
   * How the hold was derived. `known_rate`: the model's list price against the reference. `conservative`: this model has no rate, so the dearest known one is used.
   * `no_reference`: there is no reference rate to compare against, so the hold is the cap, unscaled. That is a gap, not a safety margin.
   */
  readonly basis: 'known_rate' | 'conservative' | 'no_reference';
  readonly rateSource: string | null;
}

const ratio = (a: ModelRate, reference: ModelRate): number => Math.max(a.inputUsdPerMTok / reference.inputUsdPerMTok, a.outputUsdPerMTok / reference.outputUsdPerMTok);

/**
 * A task's `maxCostUsd` is its worst case on the project's default model. A dearer model holds proportionally more; no model holds less than the owner's cap, however cheap,
 * because a low rate says nothing about how much work an attempt does. The rates are list prices for input and output tokens from the harness's own table, so the hold is an
 * estimate like every reservation, never an observed cost. Cache and long-prompt tiers are left out: the ratio can only raise a hold, and the cap is its floor.
 */
export function worstCaseHold(capMicros: number, selection: ModelSelection, catalog: HarnessCatalog, policy: Policy | undefined): WorstCaseHold {
  const reference = policy?.models?.default ? findCatalogModel(catalog, policy.models.default).model : null;
  const own = findCatalogModel(catalog, selection).model;
  if (!reference?.rate) return { amountMicros: capMicros, basis: 'no_reference', rateSource: null };
  if (own?.rate) return { amountMicros: Math.ceil(capMicros * Math.max(1, ratio(own.rate, reference.rate))), basis: 'known_rate', rateSource: own.rate.source };
  const knownRatios = catalog.providers.flatMap((p) => p.models).flatMap((m) => (m.rate ? [ratio(m.rate, reference.rate!)] : []));
  return { amountMicros: Math.ceil(capMicros * Math.max(1, ...knownRatios)), basis: 'conservative', rateSource: null };
}

/** The catalog as a screen may read it: each model marked with what policy says now. No rate leaves this function. */
export function catalogView(catalog: HarnessCatalog, policy: Policy | undefined) {
  return {
    status: catalog.status,
    detail: catalog.detail,
    projectDefault: policy?.models?.default ?? null,
    providers: catalog.providers.map((p) => ({
      provider: p.provider, label: p.label, harnessVersion: p.harnessVersion,
      models: p.models.map((m) => {
        const d = evaluate({ kind: 'assign_model', selection: { provider: p.provider, model: m.id } }, policy);
        return { modelId: m.id, label: m.label, route: m.route, allowedByPolicy: d.decision === 'allow', policyReason: d.decision === 'allow' ? null : d.reason };
      }),
    })),
  };
}

/** The current row per role and task, newest revision per key. A removed assignment stays listed with a null model, so a client can read the revision to send back. */
export async function loadModelAssignments(db: Executor, tenantId: string, projectId: string) {
  const t = schema.modelAssignments;
  const rows = await db.select().from(t).where(and(eq(t.tenantId, tenantId), eq(t.projectId, projectId))).orderBy(desc(t.revision));
  const seen = new Set<string>();
  const out: { scope: 'role' | 'task'; key: string; provider: string | null; model: string | null; revision: number; updatedBy: string; updatedAt: string }[] = [];
  for (const r of rows) {
    const id = `${r.scopeKind}:${r.scopeKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ scope: r.scopeKind as 'role' | 'task', key: r.scopeKey, provider: r.provider, model: r.model, revision: r.revision, updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString() });
  }
  return out;
}

/** What every enrolled, unrevoked runner last reported. The catalog offered to the owner is narrowed to this. */
export async function loadRunnerReports(db: Executor, tenantId: string): Promise<RunnerHarnessReport[]> {
  const rows = await db.select({ report: schema.runners.harnessReport }).from(schema.runners).where(and(eq(schema.runners.tenantId, tenantId), isNull(schema.runners.revokedAt)));
  return rows.flatMap((r) => r.report ?? []);
}

/** The revision a key is at now, removals included. Zero when none was ever set. */
export async function assignmentRevision(db: Executor, tenantId: string, projectId: string, scope: 'role' | 'task', scopeKey: string): Promise<number> {
  const t = schema.modelAssignments;
  const rows = await db.select({ revision: t.revision }).from(t).where(and(eq(t.tenantId, tenantId), eq(t.projectId, projectId), eq(t.scopeKind, scope), eq(t.scopeKey, scopeKey))).orderBy(desc(t.revision)).limit(1);
  return rows[0]?.revision ?? 0;
}
