import { expireApprovals } from './approval.ts';
import { claimNext, tryClaim } from './claim.ts';
import { heartbeat, publishResult } from './lease.ts';
import { expireLeases } from './reconcile.ts';
import { retryTask } from './retry.ts';
import type { Scheduler, SchedulerContext } from './types.ts';

export * from './types.ts';
export { claimNext, tryClaim } from './claim.ts';
export { heartbeat, publishResult, leaseHealth, leaseDeadline, LEASE_EXPIRY_SECONDS, LEASE_SUSPECT_SECONDS, HEARTBEAT_INTERVAL_SECONDS, type LeaseHealth } from './lease.ts';
export { expireLeases } from './reconcile.ts';
export { APPROVAL_TTL_SECONDS, expireApprovals, openApproval, type ApprovalGate, type OpenedApproval } from './approval.ts';
export { acceptanceCovers, assessRunScope, loadAcceptedReducedScope, notDeliveredHash, reducedScopeContext, type AcceptedReducedScope, type NotDeliveredTask, type ReducedScope, type RunScopeAssessment } from './reduced-scope.ts';
export * from './placement.ts';
export { retryTask } from './retry.ts';
export { applyVerification, closeVerificationWithoutVerdict, isReverifiableBlock, markRunReadyForReview, releaseTaskClaims, reopenBlockedVerification, REVERIFY_LIMIT, type VerificationApplication, type VerificationVerdict } from './verification.ts';
export { markTaskMerged } from './merge.ts';
export { formatMicros, toMicros } from './reserve.ts';
export { reconcileObservedCost, runUsageLines, stopForExhaustedBudget, type ObservedCost, type ReconcileResult, type RunUsageLine } from './usage.ts';

/** Binds the operations to a database and clock. Instances hold no state: any instance sees every lease. */
export function createScheduler(ctx: SchedulerContext): Scheduler {
  return {
    claimNext: (r, c) => claimNext(ctx, r, c),
    tryClaim: (r, c) => tryClaim(ctx, r, c),
    heartbeat: (l) => heartbeat(ctx, l),
    publishResult: (l, r) => publishResult(ctx, l, r),
    expireLeases: (n) => expireLeases(ctx, n),
    expireApprovals: (n) => expireApprovals(ctx, n),
    retry: (key, by, op = null, tx) => retryTask(ctx, key, by, op, tx),
  };
}
