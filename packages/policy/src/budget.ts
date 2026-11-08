export type BudgetReason = 'within_limit' | 'missing_limit' | 'unknown_cost' | 'exceeds_limit';
export interface BudgetCheck {
  readonly ok: boolean;
  readonly reason: BudgetReason;
}

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Pure check that an amount fits a limit. Absent limit denies; unknown cost blocks. */
export function checkWithinLimit(amount: number | null | undefined, limit: number | null | undefined): BudgetCheck {
  if (!valid(limit)) return { ok: false, reason: 'missing_limit' };
  if (!valid(amount)) return { ok: false, reason: 'unknown_cost' };
  return amount <= limit ? { ok: true, reason: 'within_limit' } : { ok: false, reason: 'exceeds_limit' };
}

/** A reservation needs a known cost and a known remaining budget. */
export function checkReservation(estimatedCost: number | null | undefined, remaining: number | null | undefined): BudgetCheck {
  return checkWithinLimit(estimatedCost, remaining);
}
