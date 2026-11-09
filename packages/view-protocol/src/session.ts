import type { DataSourceError, EngineeringDataSource } from './data-source.ts';
import { applyEvent, projectionFromSnapshot, type ProjectionState } from './reducers.ts';

export interface ProjectionSession {
  state(): ProjectionState | null;
  /** How many times a gap, reordering or provenance mismatch made the session fetch a new snapshot. */
  resyncCount(): number;
  stop(): void;
}

export interface SessionHooks {
  onState(state: ProjectionState): void;
  onError(error: DataSourceError): void;
}

const MAX_CONSECUTIVE_RESYNCS = 5;

/**
 * Snapshot, then replay after its cursor, then live events. A sequence gap, a reordering or a provenance mismatch stops the stream and
 * fetches a fresh snapshot (resync). The projection is only ever replaced by a whole snapshot, never patched across a gap. Resyncing is
 * bounded: a source that keeps producing gaps is reported as unavailable instead of looping.
 */
export function startProjection(source: EngineeringDataSource, projectId: string, hooks: SessionHooks): ProjectionSession {
  let current: ProjectionState | null = null;
  let stopped = false;
  let generation = 0;
  let resyncs = 0;
  let consecutive = 0;
  let unsubscribe: (() => void) | null = null;

  const fail = (error: DataSourceError): void => {
    if (!stopped) hooks.onError(error);
  };

  async function load(): Promise<void> {
    const mine = ++generation;
    unsubscribe?.();
    unsubscribe = null;
    let snapshot;
    try {
      snapshot = await source.getSnapshot(projectId);
    } catch {
      if (mine === generation) fail({ code: 'unavailable', message: 'snapshot could not be loaded', retryable: true });
      return;
    }
    if (stopped || mine !== generation) return;
    current = projectionFromSnapshot(snapshot);
    hooks.onState(current);
    unsubscribe = source.subscribe(
      projectId,
      snapshot.meta.cursor,
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
            fail({ code: 'unavailable', message: `event stream kept losing sequence (${result.reason})`, retryable: true });
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

  void load();
  return {
    state: () => current,
    resyncCount: () => resyncs,
    stop() {
      stopped = true;
      generation += 1;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
