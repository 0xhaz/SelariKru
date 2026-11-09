import type { AuthorizedTerminalRequest, AuthorizedViewCommand, CommandReceipt, TerminalChannel, TerminalControlChannel } from './commands.ts';
import type { ProjectViewEvent } from './events.ts';
import type { ProjectViewSnapshot, RunFailuresView } from './snapshot.ts';

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
  disconnect(): void;
}

/** What an async source call rejects with, so callers read a typed error instead of parsing a message. */
export class DataSourceException extends Error {
  constructor(readonly detail: DataSourceError) {
    super(detail.message);
    this.name = 'DataSourceException';
  }
}
