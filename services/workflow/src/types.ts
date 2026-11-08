import type { Db } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import type { Result } from '@selarikru/domain';

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
}

export interface SchedulerContext {
  readonly db: Db;
  /** Injected clock: lease timing never reads the system time directly. */
  readonly now: () => Date;
  /** Project policy, already loaded. Used for the repair gate; absent policy denies repairs. */
  readonly policy?: Policy | undefined;
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
}

export interface SkippedCandidate {
  readonly taskId: string;
  readonly reason: string;
}

export type ClaimOutcome =
  | { readonly ok: true; readonly lease: Lease; readonly skipped: readonly SkippedCandidate[] }
  | { readonly ok: false; readonly reason: string; readonly skipped: readonly SkippedCandidate[] };

export type LeaseConflictReason = 'stale_fence' | 'lease_expired';

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
}

/** Observed cost in USD, or null when usage is unavailable. Unknown is null, never zero. */
export type ObservedCost = { readonly observedCostUsd?: number | null };

export type PublishResult =
  | ({ readonly outcome: 'completed'; readonly headSha?: string } & ObservedCost)
  | ({ readonly outcome: 'failed'; readonly reason: string } & ObservedCost)
  | ({ readonly outcome: 'blocked'; readonly reason: string } & ObservedCost)
  | ({ readonly outcome: 'approval_requested'; readonly reason: string } & ObservedCost);

export interface PublishReceipt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly fence: number;
  readonly outcome: PublishResult['outcome'];
  readonly taskStatus: string;
  /** Set when an attempt failed: whether another attempt may run. */
  readonly repair?: 'scheduled' | 'refused';
}

export interface ExpiredLease {
  readonly tenantId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly fence: number;
  readonly reason: 'lease_expired';
}

export interface Scheduler {
  claimNext(runner: Runner, caps: Caps): Promise<Lease | null>;
  tryClaim(runner: Runner, caps: Caps): Promise<ClaimOutcome>;
  heartbeat(lease: Lease): Promise<Result<HeartbeatReceipt, LeaseConflict>>;
  publishResult(lease: Lease, result: PublishResult): Promise<Result<PublishReceipt, LeaseConflict>>;
  expireLeases(now: Date): Promise<readonly ExpiredLease[]>;
}
