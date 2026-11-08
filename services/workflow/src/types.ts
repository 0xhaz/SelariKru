import type { Db, Tx } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import type { Result } from '@selarikru/domain';
import type { PlacementMode } from './placement.ts';

export type RunnerLocation = 'local' | 'cloud';

/** The identity of a claiming runner. `tenantId` and `runnerId` must come from the authenticated principal. */
export interface Runner {
  readonly runnerId: string;
  readonly tenantId: string;
  readonly location: RunnerLocation;
}

/** Limits supplied by configuration. A missing limit denies claiming; it is never unlimited. */
export interface Caps {
  readonly maxConcurrentTotal?: number | null;
  /** Upper bound on an attempt's run time; the deadline is the smaller of this and the spec's `timeoutSeconds`. */
  readonly attemptTimeoutSeconds?: number | null;
  /** Lease-expiry retries allowed per task revision. Separate from the repair count; 0 is a valid limit. */
  readonly maxInfraRetries?: number | null;
  /** Delay before the first infrastructure retry; it doubles per expiry up to `infraRetryBackoffMaxSeconds`. */
  readonly infraRetryBackoffSeconds?: number | null;
  readonly infraRetryBackoffMaxSeconds?: number | null;
}

/** The named run-level placement configuration (L1, L2, C1, H2 ...) and the execution destination cloud starts are judged against. */
export interface PlacementConfig {
  readonly mode: PlacementMode;
  readonly cloudDestination: string | null;
}

export interface SchedulerContext {
  readonly db: Db;
  /** Injected clock: lease timing never reads the system time directly. */
  readonly now: () => Date;
  /** Project policy, already loaded. Used for the repair gate; absent policy denies repairs. */
  readonly policy?: Policy | undefined;
  /**
   * Where tasks may run. Absent: local runners get up to `maxConcurrentTotal` slots and cloud has no limit,
   * which denies cloud placement. Missing is never unlimited.
   */
  readonly placement?: PlacementConfig | undefined;
}

/** What a worker holds. `leaseToken` is a credential: it never appears in events or logs. */
export interface Lease {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly fence: number;
  readonly leaseToken: string;
  readonly runnerId: string;
  readonly location: RunnerLocation;
  readonly reservationId: string;
  readonly acquiredAt: string;
  readonly lastHeartbeatAt: string;
  readonly expiresAt: string;
  /** Hard stop for the attempt. Heartbeats do not move it. */
  readonly deadlineAt: string;
}

export interface SkippedCandidate {
  readonly taskId: string;
  readonly reason: string;
}

export type ClaimOutcome =
  | { readonly ok: true; readonly lease: Lease; readonly skipped: readonly SkippedCandidate[] }
  | { readonly ok: false; readonly reason: string; readonly skipped: readonly SkippedCandidate[] };

export type LeaseConflictReason = 'stale_fence' | 'lease_expired' | 'attempt_timeout';

/** Typed `409`-equivalent: the API maps it to an HTTP conflict with a stable machine-readable `reason`. */
export interface LeaseConflict {
  readonly kind: 'lease_conflict';
  readonly httpStatus: 409;
  readonly reason: LeaseConflictReason;
  readonly taskId: string;
  readonly attemptId: string;
  readonly fence: number;
}

export interface HeartbeatReceipt {
  readonly attemptId: string;
  readonly fence: number;
  readonly lastHeartbeatAt: string;
  readonly expiresAt: string;
  /** The owner asked to cancel this task. A runner that sees it should stop; the lease is reaped to `cancelled` either way. */
  readonly cancelRequested: boolean;
}

/**
 * Cost the worker reports, in USD. Unverified: it is recorded as `reported` and never reduces a reservation
 * until a trusted ledger exists (T4.8). Unknown is null, never zero.
 */
export type ReportedCost = { readonly reportedCostUsd?: number | null };

export type PublishResult =
  | ({ readonly outcome: 'completed'; readonly headSha?: string; readonly changeManifestSha256?: string } & ReportedCost)
  | ({ readonly outcome: 'failed'; readonly reason: string } & ReportedCost)
  | ({ readonly outcome: 'blocked'; readonly reason: string } & ReportedCost)
  | ({ readonly outcome: 'approval_requested'; readonly reason: string } & ReportedCost);

export interface PublishReceipt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly fence: number;
  readonly outcome: PublishResult['outcome'];
  readonly taskStatus: string;
  /** Set when an attempt failed: whether another attempt may run. */
  readonly repair?: 'scheduled' | 'refused';
}

export interface RetryReceipt {
  readonly taskId: string;
  readonly taskStatus: string;
  readonly aggregateRevision: number;
}

export interface RetryRefusal {
  readonly kind: 'retry_refused';
  readonly reason: string;
  readonly status?: string;
  readonly attemptsUsed?: number;
}

export interface ExpiredLease {
  readonly tenantId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly fence: number;
  readonly reason: 'lease_expired' | 'attempt_timeout';
}

export interface Scheduler {
  claimNext(runner: Runner, caps: Caps): Promise<Lease | null>;
  tryClaim(runner: Runner, caps: Caps): Promise<ClaimOutcome>;
  heartbeat(lease: Lease): Promise<Result<HeartbeatReceipt, LeaseConflict>>;
  publishResult(lease: Lease, result: PublishResult): Promise<Result<PublishReceipt, LeaseConflict>>;
  expireLeases(now: Date): Promise<readonly ExpiredLease[]>;
  /** Owner-requested retry of a failed task. Emits `task.ready` as the scheduler. `tx` joins the caller's transaction. */
  retry(key: { tenantId: string; projectId: string; taskId: string }, requestedBy: string, operationId?: string | null, tx?: Tx): Promise<Result<RetryReceipt, RetryRefusal>>;
}
