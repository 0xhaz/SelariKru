import { availableCatalog, findCatalogModel, NO_HARNESS_CATALOG, RUNNER_RECENT_SECONDS, type RunnerHarnessReport, type CatalogModel, type HarnessCatalog, type ModelRate, type ModelRefusalReason, type ModelSelection, type RecordedAssignment, type TaskSpec } from '@selarikru/domain';
import { evaluate, type Policy, type PolicyDecision } from '@selarikru/policy';
import { schema, type Executor, type Tx } from '@selarikru/persistence';
import { and, desc, eq, gte, isNull, ne, notInArray, or } from 'drizzle-orm';
import { lockBudget, toMicros } from './reserve.ts';
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
  /** `runnerOnly`: another unrevoked runner can launch this model, so the refusal says nothing about the task itself. */
  | { readonly ok: false; readonly reason: string; readonly runnerOnly?: boolean };

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
  if (findCatalogModel(availableCatalog(declared, runnerReport), selection).model === null) {
    // Only a runner seen recently counts: an old enrolment left unrevoked by a re-pair must not keep the task waiting for a machine that is gone.
    const elsewhere = findCatalogModel(availableCatalog(declared, await loadRecentRunnerReports(db, key.tenantId, ctx.now())), selection).model !== null;
    return { ok: false, reason: blockCode('model_not_on_runner', selection), runnerOnly: elsewhere };
  }
  return { ok: true, assignment: { ...selection, source, route: verdict.model.route } };
}

/**
 * Model calls follow the data, independently of where the worker runs: restricted (or stronger) input may reach only a device model, and a route nobody can state may not be used at all.
 * Returns the block code, or null when the route is acceptable.
 */
export function routeRefusal(assignment: Pick<RecordedAssignment, 'provider' | 'model' | 'route'>, classification: string): string | null {
  // No model call at all: nothing goes anywhere.
  if (assignment.route === 'none') return null;
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
  const m = holdMultiplier(selection, catalog, policy);
  return { amountMicros: m.basis === 'no_reference' ? capMicros : Math.ceil(capMicros * m.ratio), basis: m.basis, rateSource: m.rateSource };
}

/** How many times the cap one attempt on this model holds. At least 1. Used for the hold itself and for sizing caps, so a size can never disagree with the hold it plans for. */
export function holdMultiplier(selection: ModelSelection, catalog: HarnessCatalog, policy: Policy | undefined): { readonly ratio: number; readonly basis: WorstCaseHold['basis']; readonly rateSource: string | null } {
  const reference = policy?.models?.default ? findCatalogModel(catalog, policy.models.default).model : null;
  const own = findCatalogModel(catalog, selection).model;
  if (!reference?.rate) return { ratio: 1, basis: 'no_reference', rateSource: null };
  if (own?.rate) return { ratio: Math.max(1, ratio(own.rate, reference.rate)), basis: 'known_rate', rateSource: own.rate.source };
  const knownRatios = catalog.providers.flatMap((p) => p.models).flatMap((m) => (m.rate ? [ratio(m.rate, reference.rate!)] : []));
  return { ratio: Math.max(1, ...knownRatios), basis: 'conservative', rateSource: null };
}

/**
 * The largest cap at which every attempt of every role fits `budgetMicros`: budget / sum of (hold multiplier x attempts), rounded down to micro-dollars. Holds round up, so the result is
 * then checked against the holds themselves and lowered until they fit.
 */
export function sizeCapMicros(budgetMicros: number, roles: readonly { readonly selection: ModelSelection | null; readonly attempts: number }[], catalog: HarnessCatalog, policy: Policy | undefined): number {
  const hold = (cap: number, s: ModelSelection | null) => (s ? worstCaseHold(cap, s, catalog, policy).amountMicros : cap);
  const weight = roles.reduce((n, r) => n + r.attempts * (r.selection ? holdMultiplier(r.selection, catalog, policy).ratio : 1), 0);
  let cap = Math.floor(budgetMicros / weight);
  while (cap > 0 && roles.reduce((n, r) => n + r.attempts * hold(cap, r.selection), 0) > budgetMicros) cap -= 1;
  return Math.max(0, cap);
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

/** What the unrevoked runners seen within `RUNNER_RECENT_SECONDS` last reported. One that has never been seen does not count. */
export async function loadRecentRunnerReports(db: Executor, tenantId: string, now: Date): Promise<RunnerHarnessReport[]> {
  const since = new Date(now.getTime() - RUNNER_RECENT_SECONDS * 1000);
  const rows = await db.select({ report: schema.runners.harnessReport }).from(schema.runners).where(and(eq(schema.runners.tenantId, tenantId), isNull(schema.runners.revokedAt), gte(schema.runners.lastSeenAt, since)));
  return rows.flatMap((r) => r.report ?? []);
}

/** The revision a key is at now, removals included. Zero when none was ever set. */
export async function assignmentRevision(db: Executor, tenantId: string, projectId: string, scope: 'role' | 'task', scopeKey: string): Promise<number> {
  const t = schema.modelAssignments;
  const rows = await db.select({ revision: t.revision }).from(t).where(and(eq(t.tenantId, tenantId), eq(t.projectId, projectId), eq(t.scopeKind, scope), eq(t.scopeKey, scopeKey))).orderBy(desc(t.revision)).limit(1);
  return rows[0]?.revision ?? 0;
}

interface RunSlot { readonly taskId: string; readonly role: string; readonly capUsd: number; readonly left: number }

/** The run's live tasks, each with the attempts it still has to hold for. */
async function runSlots(tx: Tx, tenantId: string, projectId: string, runId: string): Promise<RunSlot[]> {
  const tasks = await tx.select({ taskId: schema.taskStatus.taskId, revision: schema.taskRevisions.revision, spec: schema.taskRevisions.spec }).from(schema.taskRevisions).innerJoin(schema.taskStatus, and(
    eq(schema.taskStatus.tenantId, schema.taskRevisions.tenantId), eq(schema.taskStatus.projectId, schema.taskRevisions.projectId), eq(schema.taskStatus.taskId, schema.taskRevisions.taskId), eq(schema.taskStatus.currentRevision, schema.taskRevisions.revision)))
    .where(and(eq(schema.taskRevisions.tenantId, tenantId), eq(schema.taskRevisions.projectId, projectId), eq(schema.taskRevisions.runId, runId), notInArray(schema.taskStatus.status, ['cancelled', 'superseded'])));
  const holds = await tx.select({ taskId: schema.budgetReservations.taskId, revision: schema.budgetReservations.revision }).from(schema.budgetReservations)
    .where(and(eq(schema.budgetReservations.tenantId, tenantId), eq(schema.budgetReservations.projectId, projectId), eq(schema.budgetReservations.runId, runId), ne(schema.budgetReservations.state, 'released')));
  return tasks.map((t) => {
    const spec = t.spec as TaskSpec;
    return { taskId: t.taskId, role: spec.role, capUsd: spec.limits.maxCostUsd, left: Math.max(0, spec.limits.maxAttempts - holds.filter((h) => h.taskId === t.taskId && h.revision === t.revision).length) };
  });
}

const slotKeys = (slots: readonly RunSlot[]) => slots.flatMap((s) => [{ scope: 'role' as const, key: s.role }, { scope: 'task' as const, key: s.taskId }]);

/**
 * The cap for the tasks a plan is accepting: what the run has left once the tasks staying on it are provided for, spread by each role's recorded model. On a first plan that is the whole budget.
 * Null when the run has no budget limit, which blocks the claim on its own.
 */
export async function planCapMicros(tx: Tx, input: {
  readonly tenantId: string; readonly projectId: string; readonly runId: string;
  readonly tasks: readonly { readonly taskId: string; readonly role: string; readonly attempts: number }[];
  readonly catalog: HarnessCatalog; readonly policy: Policy | undefined;
}): Promise<number | null> {
  const { tenantId, projectId, runId, tasks, catalog, policy } = input;
  const position = await lockBudget(tx, { tenantId, projectId, runId });
  if (position.limitMicros === null) return null;
  const replaced = new Set(tasks.map((t) => t.taskId));
  const kept = (await runSlots(tx, tenantId, projectId, runId)).filter((s) => !replaced.has(s.taskId));
  const rows = await currentRows(tx, tenantId, projectId, [...slotKeys(kept), ...tasks.map((t) => ({ scope: 'role' as const, key: t.role }))]);
  const fallback = policy?.models?.default ?? null;
  const reserved = kept.reduce((n, s) => {
    const selection = rows.get(`task:${s.taskId}`) ?? rows.get(`role:${s.role}`) ?? fallback;
    const cap = toMicros(s.capUsd);
    return n + s.left * (selection ? worstCaseHold(cap, selection, catalog, policy).amountMicros : cap);
  }, position.consumedMicros ?? 0);
  return sizeCapMicros(Math.max(0, position.limitMicros - reserved), tasks.map((t) => ({ selection: rows.get(`role:${t.role}`) ?? fallback, attempts: t.attempts })), catalog, policy);
}

/** Each role's share of the budget for one attempt, with the models recorded now: what onboarding shows before a plan exists. A share, so no rate leaves here. */
export async function roleAttemptShares(db: Executor, input: { readonly tenantId: string; readonly projectId: string; readonly roles: readonly string[]; readonly maxAttempts: number; readonly catalog: HarnessCatalog; readonly policy: Policy | undefined }): Promise<Record<string, number>> {
  const rows = await currentRows(db, input.tenantId, input.projectId, input.roles.map((key) => ({ scope: 'role' as const, key })));
  const fallback = input.policy?.models?.default ?? null;
  const ratios = input.roles.map((role) => { const s = rows.get(`role:${role}`) ?? fallback; return s ? holdMultiplier(s, input.catalog, input.policy).ratio : 1; });
  const weight = ratios.reduce((n, r) => n + r * input.maxAttempts, 0);
  return Object.fromEntries(input.roles.map((role, i) => [role, ratios[i]! / weight]));
}

/**
 * The run budget an assignment change would need, when it is more than the run has. Caps are frozen when a plan is accepted, each attempt left holds its worst case and no hold comes back, so
 * a dearer model after that point can leave a worker unable to start. Before a plan exists nothing is refused: acceptance sizes the caps to the recorded models.
 */
export async function modelOverRunBudget(tx: Tx, input: {
  readonly tenantId: string; readonly projectId: string;
  readonly change: { readonly scope: 'role' | 'task'; readonly key: string; readonly selection: ModelSelection };
  readonly catalog: HarnessCatalog; readonly policy: Policy | undefined;
}): Promise<{ readonly runId: string; readonly neededUsd: number; readonly limitUsd: number } | null> {
  const { tenantId, projectId, change, catalog, policy } = input;
  const runs = await tx.select({ runId: schema.runs.runId }).from(schema.runs).where(and(eq(schema.runs.tenantId, tenantId), eq(schema.runs.projectId, projectId), eq(schema.runs.trial, false), notInArray(schema.runs.lifecycle, ['merged', 'failed', 'cancelled'])));
  for (const { runId } of runs) {
    const position = await lockBudget(tx, { tenantId, projectId, runId });
    if (position.limitMicros === null) continue;
    const slots = await runSlots(tx, tenantId, projectId, runId);
    if (slots.length === 0) continue;
    const rows = await currentRows(tx, tenantId, projectId, slotKeys(slots));
    let needed = position.consumedMicros ?? 0;
    for (const s of slots) {
      const own = change.scope === 'task' && change.key === s.taskId ? change.selection : rows.get(`task:${s.taskId}`);
      const selection = own ?? (change.scope === 'role' && change.key === s.role ? change.selection : rows.get(`role:${s.role}`)) ?? policy?.models?.default;
      const cap = toMicros(s.capUsd);
      needed += s.left * (selection ? worstCaseHold(cap, selection, catalog, policy).amountMicros : cap);
    }
    if (needed > position.limitMicros) return { runId, neededUsd: Math.ceil(needed / 10_000) / 100, limitUsd: position.limitMicros / 1_000_000 };
  }
  return null;
}
