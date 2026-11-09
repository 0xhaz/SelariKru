import type { AuthorizedTerminalRequest, AuthorizedViewCommand, CommandReceipt, TerminalChannel } from './commands.ts';
import type { ProjectViewEvent } from './events.ts';
import type { ProjectViewSnapshot } from './snapshot.ts';

export type DataSourceErrorCode = 'unknown_project' | 'invalid_cursor' | 'unauthorized' | 'unavailable' | 'invalid_event' | 'disconnected'
  /** Session-level codes: the event stream is dead and will not recover without a new session; a liveness refresh failed; a snapshot older than the projection was rejected. */
  | 'stream_dead' | 'refresh_failed' | 'snapshot_rejected';
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
  execute(command: AuthorizedViewCommand): Promise<CommandReceipt>;
  openTerminal(session: AuthorizedTerminalRequest): Promise<TerminalChannel>;
  disconnect(): void;
}

/** What an async source call rejects with, so callers read a typed error instead of parsing a message. */
export class DataSourceException extends Error {
  constructor(readonly detail: DataSourceError) {
    super(detail.message);
    this.name = 'DataSourceException';
  }
}
