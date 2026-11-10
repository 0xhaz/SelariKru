import { expireApprovals } from './approval.ts';
import { claimNext, tryClaim } from './claim.ts';
import { heartbeat, publishResult } from './lease.ts';
import { expireLeases } from './reconcile.ts';
import { retryTask } from './retry.ts';
import type { Scheduler, SchedulerContext } from './types.ts';

export * from './types.ts';
export { asClaimReason, classifyClaimReason, CLAIM_REASONS, type ClaimReason, type ClaimReasonCode } from './claim-reasons.ts';
export { claimNext, tryClaim } from './claim.ts';
export { holdMultiplier, modelOverRunBudget, planCapMicros, roleAttemptShares, sizeCapMicros, assignmentRevision, catalogView, loadModelAssignments, loadRecentRunnerReports, loadRunnerReports, resolveAssignment, routeRefusal, validateSelection, worstCaseHold, type ResolvedAssignment, type SelectionVerdict, type WorstCaseHold } from './assignment.ts';
export { INFRASTRUCTURE_REASON_PREFIX, heartbeat, publishResult, leaseHealth, leaseDeadline, LEASE_EXPIRY_SECONDS, LEASE_SUSPECT_SECONDS, HEARTBEAT_INTERVAL_SECONDS, type LeaseHealth } from './lease.ts';
export { expireLeases } from './reconcile.ts';
export { APPROVAL_TTL_SECONDS, expireApprovals, openApproval, type ApprovalGate, type OpenedApproval } from './approval.ts';
export { acceptanceCovers, assessRunScope, loadAcceptedReducedScope, notDeliveredHash, reducedScopeContext, type AcceptedReducedScope, type NotDeliveredTask, type ReducedScope, type RunScopeAssessment } from './reduced-scope.ts';
export * from './placement.ts';
export { retryTask } from './retry.ts';
export { applyVerification, closePartsWithoutVerdict, closeVerificationWithoutVerdict, isReverifiableBlock, leaveReviewForPlan, markRunReadyForReview, lockPartsForClaims, releaseTaskClaims, lockBeforeRunRow, lockStaleCandidate, reopenBlockedVerification, reverifyRun, reopenStaleVerification, retireStaleCandidate, REVERIFY_LIMIT, type ReverifyOutcome, type StaleCandidate, type VerificationApplication, type VerificationVerdict } from './verification.ts';
export { markTaskMerged } from './merge.ts';
export { formatMicros, lockBudget, remainingMicros as remainingBudgetMicros, toMicros } from './reserve.ts';
export { loadRunEvidence, type RunEvidence } from './evidence.ts';
export { loadLatestAppliedRecord, RecordStoreUnavailableError, validRecordOf, type LatestAppliedRecord, type RecordBar, type RecordBytes, type TrustedVerifier } from './verification-record.ts';
export { reconcileObservedCost, runUsageLines, stopForExhaustedBudget, type ObservedCost, type ReconcileResult, type RunUsageLine } from './usage.ts';

/** Binds the operations to a database and clock. Instances hold no state: any instance sees every lease. */
export function createScheduler(ctx: SchedulerContext): Scheduler {
  return {
    claimNext: (r, c) => claimNext(ctx, r, c),
    tryClaim: (r, c) => tryClaim(ctx, r, c),
    heartbeat: (l, activity, opts) => heartbeat(ctx, l, activity, opts),
    publishResult: (l, r) => publishResult(ctx, l, r),
    expireLeases: (n) => expireLeases(ctx, n),
    expireApprovals: (n) => expireApprovals(ctx, n),
    retry: (key, by, op = null, tx) => retryTask(ctx, key, by, op, tx),
  };
}
export { gateFor, loadRunGates, loadRunnerGate, pathsRevoked, requestPolicyStop, type RunGate, type RunnerGate } from './settings.ts';
export { cancelRequestReason } from './cancel.ts';
export { buildTaskState, loadAttempts } from './taskstate.ts';
export { bindingOf, loadBindings, loadKnownVersions, resolveTaskSkills } from './skills.ts';
export { assessHandover, closeHandovers, CLOUD_RUNNER_FRESH_SECONDS, decideHandover, openHandover, recordCheckpoint, requestHandover, reviewHandovers, successorCheckpoint, VISIBLE_HOLDS, type CheckpointCheck, type CheckpointReceipt, type CheckpointRow, type HandoverAssessment, type HandoverEstimate, type HandoverFigure, type HandoverReceipt, type HandoverRefusal, type LeaseHandover } from './handover.ts';
