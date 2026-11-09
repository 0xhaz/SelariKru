import type { Clock } from './common.ts';
import { cursorToSequence } from './common.ts';
import type { DataSourceError, EngineeringDataSource } from './data-source.ts';
import { applyEvent, mergeDecisionFacts, mergeLiveness, mergeRunLifecycle, projectionFromSnapshot, type ProjectionState } from './reducers.ts';

/** `live`: subscribed. `reconnecting`: a snapshot load failed and a retry is scheduled. `dead`: the stream cannot recover; data is frozen. */
export type SessionStatus = 'live' | 'reconnecting' | 'dead';

export interface ProjectionSession {
  state(): ProjectionState | null;
  status(): SessionStatus;
  /** When the last successful snapshot or liveness refresh landed, by the injected clock; null before the first. Feed it to `effectiveWorkerHealth`. */
  livenessAsOfMs(): number | null;
  /** How many times a gap, a provenance mismatch or an event needing snapshot data made the session fetch a new snapshot. */
  resyncCount(): number;
  /** Fetches a snapshot and merges heartbeats, run lifecycle and the decision facts only (what events do not carry). The scheduled refresh calls this. A dead session does nothing. */
  refresh(): Promise<void>;
  /** Replaces the projection with a fresh snapshot now. Used after a refused command, so the view shows what actually changed. A dead session does nothing. */
  resync(): Promise<void>;
  stop(): void;
}

export interface SessionHooks {
  onState(state: ProjectionState): void;
  onError(error: DataSourceError): void;
  onStatus?(status: SessionStatus): void;
}

export interface SessionOptions {
  /** Repeats `fn` every `ms` and returns the cancel function. Required: the session reads no timer of its own, so tests and the mock drive it from a virtual clock. */
  readonly every: (fn: () => void, ms: number) => () => void;
  /** The injected clock, used to stamp when liveness was last refreshed. */
  readonly clock: Clock;
  /** Liveness refresh period in ms. Heartbeats are not events, so liveness arrives only this way. 0 disables. Default 10 000. */
  readonly refreshMs?: number;
  /** First retry delay after a failed snapshot load, in ms; it doubles each time. Default 1 000. */
  readonly retryBaseMs?: number;
}

/** Resyncs in a row whose snapshot did not advance the cursor. A snapshot that advances it resets the count. */
export const MAX_STUCK_RESYNCS = 5;
/** Backoff after a failed load or a stream error doubles from the base up to this cap, then repeats at the cap with no attempt limit. */
export const MAX_RETRY_DELAY_MS = 30_000;
/** Errors that no retry can fix: the session is dead. Anything else retryable, and `invalid_cursor`, goes back through a snapshot. */
const TERMINAL_CODES: readonly DataSourceError['code'][] = ['unauthorized', 'unknown_project', 'disconnected'];
const DEFAULT_REFRESH_MS = 10_000;
const DEFAULT_RETRY_BASE_MS = 1_000;

/**
 * Snapshot, then replay after its cursor, then live events. A gap, a provenance mismatch or an event that needs data only a snapshot has
 * stops the stream and fetches a fresh snapshot (resync); the projection is only replaced by a whole snapshot, never patched across a gap.
 * A snapshot older than the projection is rejected. A redelivered event is a no-op and never refetches.
 *
 * Failures: a failed snapshot load, or a retryable error on the stream, is retried with exponential backoff (capped at 30 s, repeated with no
 * attempt limit) on the injected scheduler and resubscribes from the new cursor on success. `invalid_cursor` (the server's `cursor_ahead`) goes
 * back through a snapshot at once. The resync budget counts only resyncs that made no progress, so spaced, successful resyncs stay live.
 * The session is dead only for a terminal error (`unauthorized` and the like) or a snapshot stuck behind the triggering event: it reports
 * `stream_dead`, stops merging liveness (so workers cannot look healthy over frozen task state) and keeps the last state, visibly stale
 * through `status()` and `livenessAsOfMs()`.
 */
export function startProjection(source: EngineeringDataSource, projectId: string, hooks: SessionHooks, options: SessionOptions): ProjectionSession {
  let current: ProjectionState | null = null;
  let stopped = false;
  let status: SessionStatus = 'live';
  let generation = 0;
  let resyncs = 0;
  let stuck = 0;
  let retries = 0;
  let loading = false;
  let asOf: number | null = null;
  let unsubscribe: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;
  let cancelRefresh: () => void = () => {};

  const isLive = (): boolean => status === 'live';
  const fail = (error: DataSourceError): void => {
    if (!stopped) hooks.onError(error);
  };
  const setStatus = (next: SessionStatus): void => {
    if (status === next) return;
    status = next;
    if (!stopped) hooks.onStatus?.(next);
  };

  function die(message: string): void {
    generation += 1;
    unsubscribe?.();
    unsubscribe = null;
    cancelRetry?.();
    cancelRetry = null;
    cancelRefresh();
    setStatus('dead');
    fail({ code: 'stream_dead', message, retryable: false });
  }

  function listen(mine: number, cursor: string): void {
    const un = source.subscribe(
      projectId,
      cursor,
      (event) => {
        if (stopped || mine !== generation || current === null) return;
        const result = applyEvent(current, event);
        if (result.outcome === 'resync') {
          resyncs += 1;
          stuck += 1;
          if (stuck > MAX_STUCK_RESYNCS) {
            die(`event stream kept needing a resync without progress (${result.reason})`);
            return;
          }
          void load();
          return;
        }
        retries = 0; // the stream is delivering: the next outage starts its backoff from the base
        if (result.outcome === 'duplicate') return;
        current = result.state;
        hooks.onState(current);
      },
      (error) => {
        if (stopped || mine !== generation) return;
        fail(error);
        if (TERMINAL_CODES.includes(error.code) || (!error.retryable && error.code !== 'invalid_cursor')) {
          die(`event stream failed and cannot be retried (${error.code})`);
          return;
        }
        // The stream is gone whatever the status said. Go back through a snapshot: at once for a cursor the server does not know,
        // after a backoff for anything else, so a down server is not hammered.
        generation += 1;
        unsubscribe?.();
        unsubscribe = null;
        if (error.code === 'invalid_cursor') {
          stuck += 1;
          if (stuck > MAX_STUCK_RESYNCS) {
            die('the server keeps rejecting the cursor');
            return;
          }
          void load();
        } else scheduleRetry();
      },
    );
    // A source may call back, or the caller may stop, before `subscribe` returns: never keep a subscription nobody owns.
    if (stopped || mine !== generation) {
      un();
      return;
    }
    unsubscribe = un;
  }

  function scheduleRetry(): void {
    const delay = Math.min((options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS) * 2 ** Math.min(retries, 20), MAX_RETRY_DELAY_MS);
    retries += 1;
    setStatus('reconnecting');
    // A one-shot timer on the injected scheduler: cancel on first fire.
    const cancel = options.every(() => {
      cancel();
      cancelRetry = null;
      if (!stopped && !isLive() && status !== 'dead') void load();
    }, delay);
    cancelRetry = cancel;
  }

  async function load(): Promise<void> {
    const mine = ++generation;
    unsubscribe?.();
    unsubscribe = null;
    cancelRetry?.();
    cancelRetry = null;
    loading = true;
    let snapshot;
    try {
      snapshot = await source.getSnapshot(projectId);
    } catch {
      loading = false;
      if (mine !== generation || stopped) return;
      fail({ code: 'unavailable', message: 'snapshot could not be loaded; retrying', retryable: true });
      scheduleRetry();
      return;
    }
    loading = false;
    if (stopped || mine !== generation) return;
    const nextSeq = cursorToSequence(snapshot.meta.cursor);
    if (current !== null && nextSeq < cursorToSequence(current.snapshot.meta.cursor)) {
      // An older snapshot would move the projection backwards. Keep what we have and stay subscribed from where we are.
      fail({ code: 'snapshot_rejected', message: 'snapshot is older than the projection and was rejected', retryable: true });
      setStatus('live');
      listen(mine, current.snapshot.meta.cursor);
      return;
    }
    // Progress resets the stuck-resync budget; only snapshots that go nowhere count against it.
    if (current === null || nextSeq > cursorToSequence(current.snapshot.meta.cursor)) stuck = 0;
    current = projectionFromSnapshot(snapshot);
    asOf = options.clock.nowMs();
    setStatus('live');
    hooks.onState(current);
    listen(mine, snapshot.meta.cursor);
  }

  async function refresh(): Promise<void> {
    if (stopped || !isLive() || current === null || loading) return;
    let fresh;
    try {
      fresh = await source.getSnapshot(projectId);
    } catch {
      fail({ code: 'refresh_failed', message: 'liveness refresh failed; heartbeat data is going stale', retryable: true });
      return;
    }
    if (stopped || !isLive() || current === null) return;
    asOf = options.clock.nowMs();
    const merged = mergeDecisionFacts(mergeRunLifecycle(mergeLiveness(current, fresh), fresh), fresh);
    if (merged !== current) {
      current = merged;
      hooks.onState(current);
    }
  }

  void load();
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  cancelRefresh = refreshMs > 0 ? options.every(() => void refresh(), refreshMs) : () => {};

  return {
    state: () => current,
    status: () => status,
    livenessAsOfMs: () => asOf,
    resyncCount: () => resyncs,
    refresh,
    async resync() {
      if (stopped || status === 'dead') return;
      await load();
    },
    stop() {
      stopped = true;
      generation += 1;
      cancelRefresh();
      cancelRetry?.();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
