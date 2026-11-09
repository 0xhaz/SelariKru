import type { DataSourceError, EngineeringDataSource } from './data-source.ts';
import { applyEvent, mergeLiveness, projectionFromSnapshot, type ProjectionState } from './reducers.ts';
import { cursorToSequence } from './common.ts';

export interface ProjectionSession {
  state(): ProjectionState | null;
  /** How many times a gap, a provenance mismatch or an event needing snapshot data made the session fetch a new snapshot. */
  resyncCount(): number;
  /** Fetches a snapshot and merges liveness only. The scheduled refresh calls this. Resolves when merged. */
  refresh(): Promise<void>;
  stop(): void;
}

export interface SessionHooks {
  onState(state: ProjectionState): void;
  onError(error: DataSourceError): void;
}

export interface SessionOptions {
  /** Liveness refresh period in ms on the injected scheduler. Heartbeats are not events, so liveness arrives only this way. 0 disables. Default 10 000. */
  readonly refreshMs?: number;
  /** Repeats `fn` every `ms` and returns the cancel function. Injected so tests and the mock drive it from a virtual clock. Defaults to setInterval. */
  readonly every?: (fn: () => void, ms: number) => () => void;
}

const MAX_CONSECUTIVE_RESYNCS = 5;
const DEFAULT_REFRESH_MS = 10_000;

/**
 * Snapshot, then replay after its cursor, then live events. A gap, a provenance mismatch or an event that needs data only a snapshot has stops
 * the stream and fetches a fresh snapshot (resync); the projection is only replaced by a whole snapshot, never patched across a gap. A
 * snapshot older than the projection is rejected. A redelivered event (sequence at or below the cursor) is a no-op and never refetches.
 * Resyncing is bounded: a source that keeps failing is reported unavailable instead of looping.
 * Liveness is refreshed on a schedule by merging snapshot heartbeats only, so event-derived state and the cursor never move.
 */
export function startProjection(source: EngineeringDataSource, projectId: string, hooks: SessionHooks, options: SessionOptions = {}): ProjectionSession {
  let current: ProjectionState | null = null;
  let stopped = false;
  let generation = 0;
  let resyncs = 0;
  let consecutive = 0;
  let loading = false;
  let unsubscribe: (() => void) | null = null;

  const fail = (error: DataSourceError): void => {
    if (!stopped) hooks.onError(error);
  };

  function listen(mine: number, cursor: string): void {
    unsubscribe = source.subscribe(
      projectId,
      cursor,
      (event) => {
        if (stopped || mine !== generation || current === null) return;
        const result = applyEvent(current, event);
        if (result.outcome === 'resync') {
          resyncs += 1;
          consecutive += 1;
          if (consecutive > MAX_CONSECUTIVE_RESYNCS) {
            generation += 1;
            unsubscribe?.();
            unsubscribe = null;
            fail({ code: 'unavailable', message: `event stream kept needing a resync (${result.reason})`, retryable: true });
            return;
          }
          void load();
          return;
        }
        consecutive = 0;
        if (result.outcome === 'duplicate') return;
        current = result.state;
        hooks.onState(current);
      },
      (error) => {
        if (!stopped && mine === generation) fail(error);
      },
    );
  }

  async function load(): Promise<void> {
    const mine = ++generation;
    unsubscribe?.();
    unsubscribe = null;
    loading = true;
    let snapshot;
    try {
      snapshot = await source.getSnapshot(projectId);
    } catch {
      loading = false;
      if (mine === generation) fail({ code: 'unavailable', message: 'snapshot could not be loaded', retryable: true });
      return;
    }
    loading = false;
    if (stopped || mine !== generation) return;
    if (current !== null && cursorToSequence(snapshot.meta.cursor) < cursorToSequence(current.snapshot.meta.cursor)) {
      // An older snapshot would move the projection backwards. Keep what we have and stay subscribed from where we are.
      fail({ code: 'unavailable', message: 'snapshot is older than the projection and was rejected', retryable: true });
      listen(mine, current.snapshot.meta.cursor);
      return;
    }
    current = projectionFromSnapshot(snapshot);
    hooks.onState(current);
    listen(mine, snapshot.meta.cursor);
  }

  async function refresh(): Promise<void> {
    if (stopped || current === null || loading) return;
    let fresh;
    try {
      fresh = await source.getSnapshot(projectId);
    } catch {
      fail({ code: 'unavailable', message: 'liveness refresh failed', retryable: true });
      return;
    }
    if (stopped || current === null) return;
    const merged = mergeLiveness(current, fresh);
    if (merged !== current) {
      current = merged;
      hooks.onState(current);
    }
  }

  void load();
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const every = options.every ?? ((fn, ms) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  });
  const cancelRefresh = refreshMs > 0 ? every(() => void refresh(), refreshMs) : () => {};

  return {
    state: () => current,
    resyncCount: () => resyncs,
    refresh,
    stop() {
      stopped = true;
      generation += 1;
      cancelRefresh();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
