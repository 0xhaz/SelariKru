import { createStore, type StoreApi } from 'zustand/vanilla';
import { startProjection, type Clock, type DataSourceError, type EngineeringDataSource, type ProjectionSession, type ProjectionState, type SessionStatus } from '@selarikru/view-protocol';

/** Repeats `fn` every `ms` and returns the cancel function. Live uses timers; the demo drives it from the virtual clock. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

/**
 * What the shell tells the operator about the data under it. `connecting`: a first snapshot is on its way. `unavailable`: there is no source,
 * or no snapshot has ever loaded, so there is nothing to show. `reconnecting`: last confirmed state, retrying. `dead`: frozen; needs a restart.
 */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'unavailable' | 'dead';

export interface ProjectionStoreState {
  readonly projection: ProjectionState | null;
  readonly status: SessionStatus;
  /** True once this session has delivered state. A restart clears it, so the old projection reads as last-confirmed until a fresh one lands. */
  readonly loaded: boolean;
  readonly hasSource: boolean;
  readonly error: DataSourceError | null;
  readonly livenessAsOfMs: number | null;
  readonly nowMs: number;
  /** Liveness to pass to `effectiveWorkerHealth`: null unless the session is live, so workers cannot look healthy over frozen state. */
  livenessForHealth(): number | null;
  start(): void;
  stop(): void;
  restart(): void;
}

export type ProjectionStore = StoreApi<ProjectionStoreState>;

export function connectionOf(s: Pick<ProjectionStoreState, 'hasSource' | 'status' | 'loaded' | 'projection'>): ConnectionState {
  if (!s.hasSource) return 'unavailable';
  if (s.status === 'dead') return 'dead';
  if (s.status === 'reconnecting') return s.projection ? 'reconnecting' : 'unavailable';
  if (!s.loaded) return s.projection ? 'reconnecting' : 'connecting';
  return 'live';
}

const NOW_TICK_MS = 1000;

/**
 * The single projection store that every monitoring view reads (design section 12). It owns one `startProjection` session at a time; the
 * source is injected, and is null when no live source exists yet, which is an honest unavailable state and never mock data.
 */
export function createProjectionStore(options: { source: EngineeringDataSource | null; projectId: string; clock: Clock; every: Scheduler }): ProjectionStore {
  const { source, projectId, clock, every } = options;
  let session: ProjectionSession | null = null;
  let cancelTick: (() => void) | null = null;

  return createStore<ProjectionStoreState>()((set, get) => {
    function open(): void {
      if (!source) return;
      const mine: { current: ProjectionSession | null } = { current: null };
      set({ loaded: false, status: 'live', error: null });
      const guard = (fn: () => void): void => {
        // Callbacks can fire while `startProjection` is still returning; only a replaced session is ignored.
        if (mine.current === null || session === mine.current) fn();
      };
      mine.current = startProjection(source, projectId, {
        onState: (projection) => guard(() => set({ projection, loaded: true, error: null, livenessAsOfMs: mine.current?.livenessAsOfMs() ?? get().livenessAsOfMs, nowMs: clock.nowMs() })),
        onError: (error) => guard(() => set({ error })),
        onStatus: (status) => guard(() => set({ status })),
      }, { every, clock });
      session = mine.current;
      set({ status: session.status() });
    }

    function close(): void {
      session?.stop();
      session = null;
    }

    return {
      projection: null, status: 'live', loaded: false, hasSource: source !== null, error: null, livenessAsOfMs: null, nowMs: clock.nowMs(),
      livenessForHealth() {
        return connectionOf(get()) === 'live' ? get().livenessAsOfMs : null;
      },
      start() {
        if (!source || session) return;
        open();
        // A restarted session has no time of its own yet: keep the last confirmed one, so a labelled loss does not vanish while retries fail.
        cancelTick = every(() => set({ nowMs: clock.nowMs(), livenessAsOfMs: session?.livenessAsOfMs() ?? get().livenessAsOfMs }), NOW_TICK_MS);
      },
      stop() {
        close();
        cancelTick?.();
        cancelTick = null;
      },
      /** A dead session cannot revive: stop it and start a new projection. Last state stays on screen, marked as last-confirmed, until the new one lands. */
      restart() {
        close();
        open();
      },
    };
  });
}
