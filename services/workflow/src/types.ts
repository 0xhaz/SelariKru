import type { ClaimReason } from './claim-reasons.ts';
import type { Db, Tx } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import type { ApprovalDestination, CodingWorkers, HarnessCatalog, LeaseGrant, RecordedAssignment, ResolvedSkill, Result, RunnerHarnessReport } from '@selarikru/domain';
import type { PlacementMode } from './placement.ts';
import type { LeaseHandover } from './handover.ts';

export type RunnerLocation = 'local' | 'cloud';

/** The identity of a claiming runner. `tenantId` and `runnerId` must come from the authenticated principal. */
export interface Runner {
  readonly runnerId: string;
  readonly tenantId: string;
  readonly location: RunnerLocation;
  /** What this runner reports it can launch. Absent or empty: it can launch nothing, so no claim can start. */
  readonly harnesses?: readonly RunnerHarnessReport[] | undefined;
  /** The runner said it materializes knowledge packs and confirms their digests. Absent: an older runner, which gets no task that has packs. */
  readonly skillDelivery?: boolean | undefined;
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
  /** What this build's harness adapters declare. Each claim narrows it to what the claiming runner reports. Absent blocks every claim: missing is never unlimited. */
  readonly catalog?: HarnessCatalog | undefined;
  /** How long an approval request stays grantable. Default `APPROVAL_TTL_SECONDS`. */
  readonly approvalTtlSeconds?: number | undefined;
  /**
   * Which coding workers may be dispatched to. Required, so no caller gets model workers by leaving it out. `off`, the hackathon build: only the no-model apply worker,
   * and a task waits for an accepted proposal. `claude_code`: model workers too.
   */
  readonly codingWorkers: CodingWorkers;
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
  /** Human grants delivered with this lease: every unused grant for this task revision, consumed by this attempt. Set at claim; absent on a lease rebuilt from a stored attempt. */
  readonly grants?: readonly LeaseGrant[];
  /** The model this attempt runs, as recorded at claim. Set at claim; absent on a lease rebuilt from a stored attempt. */
  readonly assignment?: RecordedAssignment;
  /** Whether this attempt's live output may leave the runner, decided once at claim. Set at claim; absent on a lease rebuilt from a stored attempt, which reads the stored value. */
  readonly streamable?: boolean;
  /** Whether this attempt can host a control session: streamable and not a benchmark trial. The control API re-checks both, and policy, for every ticket. Absent: it cannot. */
  readonly controllable?: boolean;
  /** The knowledge packs resolved for this attempt at claim, by version and digest. Set at claim; absent on a lease rebuilt from a stored attempt, which reads the record. */
  readonly skills?: readonly ResolvedSkill[];
  /** Set on a handover's successor: the checkpoint it starts from (ids and hashes), or a restart from the persisted input. Absent on any other lease. */
  readonly handover?: LeaseHandover;
  /** Set on an apply attempt: the accepted proposal it applies, by id and hashes. The runner fetches the results with its lease and checks them against these. */
  readonly proposal?: { readonly proposalId: string; readonly digest: string; readonly fileCount: number; readonly baseSha: string };
}

export interface SkippedCandidate {
  readonly taskId: string;
  /** One of `ClaimReason` (claim-reasons.ts), which also says whether it clears by itself. */
  readonly reason: ClaimReason;
}

export type ClaimOutcome =
  | { readonly ok: true; readonly lease: Lease; readonly skipped: readonly SkippedCandidate[] }
  | { readonly ok: false; readonly reason: ClaimReason; readonly skipped: readonly SkippedCandidate[] };

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
  /** When the attempt must be finished by. */
  readonly deadlineAt: string;
  /** The owner asked to cancel this task. A runner that sees it should stop; the lease is reaped to `cancelled` either way. */
  readonly cancelRequested: boolean;
  /** The stop is a handover to another location: the runner sends its checkpoint (`resume`) before it acknowledges. Null for any other stop. */
  readonly handover?: { readonly checkpointId: string; readonly mode: 'resume' | 'restart' } | null;
}

/** Usage the worker reports. Unverified: it reaches the ledger as `estimated` at best. Unknown is null, never zero. */
export interface ReportedUsage {
  readonly inputTokens?: number | null | undefined;
  readonly outputTokens?: number | null | undefined;
  readonly cacheReadTokens?: number | null | undefined;
  readonly cacheCreationTokens?: number | null | undefined;
  /** Part of the attempt's controller-timed span that the worker spent setting up, or sitting idle. */
  readonly setupSeconds?: number | null | undefined;
  readonly idleSeconds?: number | null | undefined;
  /** What the reported cost is based on. `list` means list prices, not money billed. */
  readonly costBasis?: 'list' | null | undefined;
}

/** What the worker claims it spent, in USD. It never reduces a reservation: only a trusted observed cost can. */
export type ReportedCost = { readonly reportedCostUsd?: number | null; readonly reportedUsage?: ReportedUsage | undefined };

export type PublishResult =
  | ({ readonly outcome: 'completed'; readonly headSha?: string; readonly changeManifestSha256?: string } & ReportedCost)
  | ({ readonly outcome: 'failed'; readonly reason: string } & ReportedCost)
  | ({ readonly outcome: 'blocked'; readonly reason: string } & ReportedCost)
  /** The sandbox could not be made ready for the worker. Interrupted, not failed: it spends no repair and the claim's infrastructure limit bounds the retries. */
  | ({ readonly outcome: 'infrastructure_failed'; readonly reason: string } & ReportedCost)
  /** `operation` names the policy operation asked for; `evaluate` decides. Absent or unknown is denied, and the worker's `reason` is never an operation. */
  | ({ readonly outcome: 'approval_requested'; readonly reason: string; readonly operation?: string; readonly destination?: ApprovalDestination } & ReportedCost);

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
  /** `setupComplete`: the sandbox is ready and the worker is about to start, so its time limit starts now. Honoured once per attempt. */
  heartbeat(lease: Lease, activity?: string, opts?: { readonly setupComplete?: boolean }): Promise<Result<HeartbeatReceipt, LeaseConflict>>;
  publishResult(lease: Lease, result: PublishResult): Promise<Result<PublishReceipt, LeaseConflict>>;
  expireLeases(now: Date): Promise<readonly ExpiredLease[]>;
  /** Closes pending approvals past their expiry and blocks the tasks waiting on them. Returns the approval ids closed. */
  expireApprovals(now: Date): Promise<readonly string[]>;
  /** Owner-requested retry of a failed task. Emits `task.ready` as the scheduler. `tx` joins the caller's transaction. */
  retry(key: { tenantId: string; projectId: string; taskId: string }, requestedBy: string, operationId?: string | null, tx?: Tx): Promise<Result<RetryReceipt, RetryRefusal>>;
}
