import { checkReservation } from '@selarikru/policy';
import { schema, type Tx } from '@selarikru/persistence';
import { and, eq, ne } from 'drizzle-orm';

const MICROS = 1_000_000;

/** Whole micro-dollars, so that sums of decimal amounts do not drift. */
export const toMicros = (usd: number): number => Math.round(usd * MICROS);
export const formatMicros = (micros: number): string => `${Math.trunc(micros / MICROS)}.${String(micros % MICROS).padStart(6, '0')}`;

/** Exact: a stored decimal never passes through a float. An amount that cannot be held exactly reads as unknown, which denies. */
const parseAmount = (amount: string | null): number | null => {
  if (amount === null || !/^\d+(\.\d{1,6})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  const micros = Number(whole) * MICROS + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(micros) ? micros : null;
};

/** Deterministic, so settlement needs no lookup and a claim's reservation is tied to its attempt. */
export const reservationIdFor = (attemptId: string): string => `res_${attemptId}`;

export interface RunScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
}

export interface BudgetPosition {
  readonly scope: RunScope;
  readonly limitMicros: number | null;
  /** Null when an outstanding reservation has no known amount: remaining budget is then unknown. */
  readonly consumedMicros: number | null;
}

const readLimit = (budget: Record<string, unknown>): number | null => {
  const limit = budget['limitUsd'];
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? toMicros(limit) : null;
};

/**
 * Locks the run row and totals what is committed against its budget. The lock serialises every reservation and
 * settlement for the run, so concurrent callers cannot both spend the same remainder. Every non-`released`
 * reservation counts, including settled and expired ones. A missing limit reads as null, never as unlimited.
 */
export async function lockBudget(tx: Tx, scope: RunScope): Promise<BudgetPosition> {
  return budgetPosition(tx, scope, true);
}

/** The same position read without the run row's lock: for a view or a sweep that only judges, and never reserves. */
export async function readBudget(tx: Tx, scope: RunScope): Promise<BudgetPosition> {
  return budgetPosition(tx, scope, false);
}

async function budgetPosition(tx: Tx, scope: RunScope, lock: boolean): Promise<BudgetPosition> {
  const q = tx
    .select({ budget: schema.runs.budget })
    .from(schema.runs)
    .where(and(eq(schema.runs.tenantId, scope.tenantId), eq(schema.runs.projectId, scope.projectId), eq(schema.runs.runId, scope.runId)));
  const runs = await (lock ? q.for('update') : q);
  const limitMicros = runs[0] ? readLimit(runs[0].budget) : null;
  const rows = await tx
    .select({ amountUsd: schema.budgetReservations.amountUsd })
    .from(schema.budgetReservations)
    .where(and(
      eq(schema.budgetReservations.tenantId, scope.tenantId), eq(schema.budgetReservations.projectId, scope.projectId),
      eq(schema.budgetReservations.runId, scope.runId), ne(schema.budgetReservations.state, 'released'),
    ));
  let consumed: number | null = 0;
  for (const r of rows) {
    const amount = parseAmount(r.amountUsd);
    if (amount === null) { consumed = null; break; }
    consumed += amount;
  }
  return { scope, limitMicros, consumedMicros: consumed };
}

/** Remaining budget in micro-dollars, clamped at zero; null when not known. */
export function remainingMicros(p: BudgetPosition): number | null {
  if (p.limitMicros === null || p.consumedMicros === null) return null;
  return Math.max(0, p.limitMicros - p.consumedMicros);
}

export type ReserveCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Whether `amountMicros` fits the locked position. Stable reasons match the policy package's `budget:` codes. */
export function checkFits(position: BudgetPosition, amountMicros: number | null): ReserveCheck {
  if (position.limitMicros === null) return { ok: false, reason: 'budget:missing_limit' };
  if (position.consumedMicros === null) return { ok: false, reason: 'budget:unknown_cost' };
  // A zero cap holds nothing, so it would fit even an exhausted budget. It says nothing about what the attempt will spend: treat it as unknown.
  if (amountMicros === 0) return { ok: false, reason: 'budget:unknown_cost' };
  const verdict = checkReservation(amountMicros, remainingMicros(position));
  return verdict.ok ? { ok: true } : { ok: false, reason: `budget:${verdict.reason}` };
}

export interface ReservationDetail {
  readonly reservationId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly attemptId: string;
  readonly fence: number;
  readonly amountMicros: number;
  /** Whether the hold used the model's list rate or stayed conservative. Never an observed price. */
  readonly rateBasis?: string;
  readonly rateSource?: string | null;
}

/** Writes the reservation. Call only after `checkFits` passed on the same locked position. */
export async function reserve(tx: Tx, position: BudgetPosition, r: ReservationDetail): Promise<void> {
  await tx.insert(schema.budgetReservations).values({
    ...position.scope,
    reservationId: r.reservationId,
    taskId: r.taskId,
    revision: r.revision,
    amountUsd: formatMicros(r.amountMicros),
    amountProvenance: 'estimated',
    state: 'reserved',
    detail: { attemptId: r.attemptId, fence: r.fence, source: 'spec.limits.maxCostUsd', ...(r.rateBasis !== undefined ? { rateBasis: r.rateBasis, rateSource: r.rateSource ?? null } : {}) },
  });
}

/**
 * Settles a reservation when its attempt ends. The worst-case amount stays consumed: a worker's figure goes to the usage ledger as
 * `estimated` and cannot refund the hold. Only a trusted observed cost reconciles it (`reconcileObservedCost`).
 * `released` is the one exception and gives the amount back: the attempt ended before anything that could spend existed.
 */
export async function settle(tx: Tx, scope: RunScope, reservationId: string, state: 'settled' | 'expired' | 'released'): Promise<void> {
  await lockBudget(tx, scope);
  await tx
    .update(schema.budgetReservations)
    .set({ state })
    .where(and(eq(schema.budgetReservations.tenantId, scope.tenantId), eq(schema.budgetReservations.projectId, scope.projectId), eq(schema.budgetReservations.reservationId, reservationId)));
}
