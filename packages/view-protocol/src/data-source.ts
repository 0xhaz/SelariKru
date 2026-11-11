import type { AuthorizedTerminalRequest, AuthorizedViewCommand, CommandReceipt, TerminalChannel, TerminalControlChannel } from './commands.ts';
import type { ProjectViewEvent } from './events.ts';
import type { ProjectViewSnapshot, RunFailuresView, TaskRouteRead } from './snapshot.ts';
import type { AttemptContextView, BrainAction, BrainSourceRevisionView, BrainView } from './brain.ts';
import type { StackActionRequestView, StackView } from './stack.ts';
import type { AttemptSkillsView, SkillActionView, SkillsView } from './skills.ts';
import type { ProductAction, ProductActionResult, ProductView } from './product.ts';
import type { HandoverAction, HandoverDiffView, HandoversView } from './handover.ts';
import type { CriteriaRevisionRequest, CriteriaRevisionResult, ProposalAcceptReceipt, TaskAgentContext, TaskBaseFiles, TaskContextSize, TaskFileListing } from './agent-context.ts';
import type { AcceptedProposal } from '@selarikru/domain';

export type DataSourceErrorCode = 'unknown_project' | 'invalid_cursor' | 'unauthorized' | 'unavailable' | 'invalid_event' | 'disconnected'
  /** Session-level codes: the event stream is dead and will not recover without a new session; a liveness refresh failed; a snapshot older than the projection was rejected. */
  | 'stream_dead' | 'refresh_failed' | 'snapshot_rejected';
/**
 * `disconnected` covers two different facts, told apart by `retryable`. Retryable: the connection dropped (a server restart, a network blip) and a reconnect can recover
 * it. Not retryable: this data source was deliberately closed with `disconnect()`, and no retry can open it again.
 */
export interface DataSourceError {
  readonly code: DataSourceErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** UI and bootstrap code receive the data source by injection. Live and mock sources pass the same conformance suite. */
export interface EngineeringDataSource {
  readonly mode: 'mock' | 'live';
  getSnapshot(projectId: string): Promise<ProjectViewSnapshot>;
  /** Replays events after `afterCursor`, then delivers new ones, in sequence order. Returns the unsubscribe function. */
  subscribe(projectId: string, afterCursor: string, onEvent: (event: ProjectViewEvent) => void, onError: (error: DataSourceError) => void): () => void;
  /** Why a run's criteria failed, from its current verification record. Read on demand: it is not state, and is too large to carry in every snapshot. */
  getRunFailures(projectId: string, runId: string): Promise<RunFailuresView>;
  execute(command: AuthorizedViewCommand): Promise<CommandReceipt>;
  openTerminal(session: AuthorizedTerminalRequest): Promise<TerminalChannel>;
  /** Control mode on one attempt: a single-use ticket and a separate connection. Additive: `execute` cannot carry a ticket, because a receipt is not a secret. Absent: this source offers no control mode. */
  openTerminalControl?(session: AuthorizedTerminalRequest): TerminalControlChannel;
  /** The Project Brain: derived pages, the source library, revocations and conflicts. Read on demand. Absent: this source has no Brain. */
  getBrain?(projectId: string): Promise<BrainView>;
  /** One stored source revision, opened from a citation. */
  getBrainSource?(projectId: string, sourceId: string, revision: number): Promise<BrainSourceRevisionView>;
  /** The context bundle an attempt received at claim. Null when none was recorded. */
  getAttemptContext?(projectId: string, attemptId: string): Promise<AttemptContextView | null>;
  /** Revoke a source or keep an accepted value. Answers with the Brain as it is afterwards. */
  brainAction?(projectId: string, action: BrainAction): Promise<BrainView>;
  /** The project's stack settings. Read on demand. Absent: this source has no stack settings. */
  getStack?(projectId: string): Promise<StackView>;
  /** One stack change against the revision last read. Metadata only: it never authenticates, installs, requests or runs anything. Answers with the stack afterwards. */
  stackAction?(projectId: string, request: StackActionRequestView): Promise<StackView>;
  /** The skill library for this project. Read on demand. Absent: this source has no skill library. */
  getSkills?(projectId: string): Promise<SkillsView>;
  /** One owner skill action. Answers with the library as it is afterwards. */
  skillAction?(projectId: string, action: SkillActionView): Promise<SkillsView>;
  /** The packs one attempt received at claim, by version and digest. */
  getAttemptSkills?(projectId: string, attemptId: string): Promise<AttemptSkillsView>;
  /** The product-learning records, trace and milestone summaries. Read on demand. Absent: this source has none. */
  getProduct?(projectId: string): Promise<ProductView>;
  /** One owner product write. Answers with the product view as it is afterwards, and whether text was redacted before saving. */
  productAction?(projectId: string, action: ProductAction): Promise<ProductActionResult>;
  /** Checkpoint continuation: which running tasks may continue on a cloud runner, why not, and each handover's state. Read on demand. Absent: this source has none. */
  getHandovers?(projectId: string): Promise<HandoversView>;
  /** Ask to continue a task in cloud (or restart it from its persisted input), or answer a restart offer. Answers with the handovers afterwards. */
  handoverAction?(projectId: string, action: HandoverAction): Promise<HandoversView>;
  /** One file's review diff of a checkpoint waiting for the owner. Owner only; redacted. */
  getHandoverDiff?(projectId: string, taskId: string, checkpointId: string, path: string): Promise<HandoverDiffView>;
  /**
   * One task's route, read fresh: the effective policy, its source, the lock and its reason, the suggestion, the last observed source and the route history. The
   * browser adapter calls this immediately before every AI call and never routes from a snapshot. Absent: this source has no route policy.
   */
  getTaskRoute?(projectId: string, taskId: string): Promise<TaskRouteRead>;
  /**
   * What a task's AI agents read, with the context bundle served for `destination` (`cloud` for any cloud-capable route). The source refuses `cloud` when the
   * task's route, with this call's override, keeps it on the device (`context_destination_refused`). Owner only. Absent: this source cannot run the task agents.
   */
  getTaskContext?(projectId: string, taskId: string, destination: 'local' | 'cloud', callOverride?: string | null): Promise<TaskAgentContext>;
  /** The task's agent input size and whether it has a change, for one destination: counts only, refused like the context. */
  getTaskContextSize?(projectId: string, taskId: string, destination: 'local' | 'cloud'): Promise<TaskContextSize>;
  /** An accepted criteria proposal, through the replan path: a new revision of the task with its criteria reworded. Absent: this source cannot replan. */
  reviseTaskCriteria?(projectId: string, request: CriteriaRevisionRequest): Promise<CriteriaRevisionResult>;
  /**
   * Accepts a checked patch proposal (H5): the server checks it again and the no-model apply worker writes its results on the task's next claim. A restricted task's
   * proposal is refused before its content is read (`proposal_restricted`). Absent: this source cannot apply a change.
   */
  acceptPatchProposal?(projectId: string, proposal: AcceptedProposal, idempotencyKey: string): Promise<ProposalAcceptReceipt>;
  /** An accepted proposal as it is now (state, round, why its last apply did not stand). Null: never accepted. */
  getProposalState?(projectId: string, taskId: string, proposalId: string): Promise<ProposalAcceptReceipt | null>;
  /** The task's files at its base commit for the patch agent, read by the local runner and relayed. Never for a restricted task. Absent: no file contents are available. */
  getTaskFiles?(projectId: string, taskId: string, paths?: readonly string[]): Promise<TaskBaseFiles>;
  /** What is under the task's allowed paths at its base: paths and sizes only, for choosing which files to read. Absent: none can be chosen. */
  listTaskFiles?(projectId: string, taskId: string): Promise<TaskFileListing>;
  disconnect(): void;
}

/** What an async source call rejects with, so callers read a typed error instead of parsing a message. */
export class DataSourceException extends Error {
  constructor(readonly detail: DataSourceError) {
    super(detail.message);
    this.name = 'DataSourceException';
  }
}
