import type { AuthorizedTerminalRequest, AuthorizedViewCommand, CommandReceipt, TerminalChannel, TerminalControlChannel } from './commands.ts';
import type { ProjectViewEvent } from './events.ts';
import type { ProjectViewSnapshot, RunFailuresView } from './snapshot.ts';
import type { AttemptContextView, BrainAction, BrainSourceRevisionView, BrainView } from './brain.ts';
import type { StackActionRequestView, StackView } from './stack.ts';
import type { AttemptSkillsView, SkillActionView, SkillsView } from './skills.ts';
import type { ProductAction, ProductView } from './product.ts';

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
  /** One owner product write. Answers with the product view as it is afterwards. */
  productAction?(projectId: string, action: ProductAction): Promise<ProductView>;
  disconnect(): void;
}

/** What an async source call rejects with, so callers read a typed error instead of parsing a message. */
export class DataSourceException extends Error {
  constructor(readonly detail: DataSourceError) {
    super(detail.message);
    this.name = 'DataSourceException';
  }
}
