import { checkReservation } from '@selarikru/policy';
import { schema, type Tx } from '@selarikru/persistence';
import { and, eq, ne, sql } from 'drizzle-orm';

const MICROS = 1_000_000;

/** Whole micro-dollars, so that sums of decimal amounts do not drift. */
export const toMicros = (usd: number): number => Math.round(usd * MICROS);
export const formatMicros = (micros: number): string => `${Math.trunc(micros / MICROS)}.${String(micros % MICROS).padStart(6, '0')}`;

const parseAmount = (amount: string | null): number | null => {
  if (amount === null) return null;
  const n = Number(amount);
  return Number.isFinite(n) && n >= 0 ? toMicros(n) : null;
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
  const runs = await tx
    .select({ budget: schema.runs.budget })
    .from(schema.runs)
    .where(and(eq(schema.runs.tenantId, scope.tenantId), eq(schema.runs.projectId, scope.projectId), eq(schema.runs.runId, scope.runId)))
    .for('update');
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
}

/** Writes the reservation. Call only after `checkFits` passed on the same locked position. */
export async function reserve(tx: Tx, position: BudgetPosition, r: ReservationDetail): Promise<void> {
  await tx.insert(schema.budgetReservations).values({
    ...position.scope,
    reservationId: r.reservationId,
    taskId: r.taskId,
    revision: r.revision,
    amountUsd: formatMicros(r.amountMicros),
    state: 'reserved',
    detail: { attemptId: r.attemptId, fence: r.fence, source: 'spec.limits.maxCostUsd' },
  });
}

/**
 * Settles a reservation when its attempt ends. The worst-case amount stays consumed: a worker's figure is unverified,
 * so it is kept alongside as `reported` and cannot refund the hold. A trusted ledger (T4.8) may reconcile it later.
 */
export async function settle(tx: Tx, scope: RunScope, reservationId: string, state: 'settled' | 'expired', reportedCostUsd: number | null | undefined): Promise<void> {
  await lockBudget(tx, scope);
  const known = typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0;
  const recorded = { reportedCostUsd: known ? reportedCostUsd : null, costSource: known ? 'reported' : 'unavailable' };
  await tx
    .update(schema.budgetReservations)
    .set({ state, detail: sql`${schema.budgetReservations.detail} || ${JSON.stringify(recorded)}::jsonb` })
    .where(and(eq(schema.budgetReservations.tenantId, scope.tenantId), eq(schema.budgetReservations.projectId, scope.projectId), eq(schema.budgetReservations.reservationId, reservationId)));
}
