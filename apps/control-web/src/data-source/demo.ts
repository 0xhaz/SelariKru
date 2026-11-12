import type { Clock, DataSourceError, EngineeringDataSource } from '@selarikru/view-protocol';
import type { Scheduler } from '../shell/projection-store.ts';

/**
 * The only way the mock data source reaches the app. It is a dynamic import behind `import.meta.env.DEV`: in a production build Vite
 * replaces the flag with `false`, the branch is dead and the import is never emitted, so the mock and its fixtures are not in the bundle.
 * `data-source-mock` is a devDependency for the same reason. Do not import it from any module a production build can reach.
 */

export type DemoFault = 'reconnecting' | 'unavailable' | 'dead' | 'corrupt';
export const DEMO_FAULTS: readonly DemoFault[] = ['reconnecting', 'unavailable', 'dead', 'corrupt'];

export interface DemoProject {
  readonly projectId: string;
  readonly fixtureId: string;
  readonly name: string;
  readonly description: string;
}

export interface DemoSession {
  readonly source: EngineeringDataSource;
  readonly projects: readonly DemoProject[];
  clockFor(projectId: string): Clock;
  /** The virtual clock's scheduler. The mock's time only moves when `advance` is called, so a fixture stays on the state it demonstrates. */
  readonly every: Scheduler;
  advance(ms: number): void;
  /** How many of a project's scripted events are still to come (H7 fix: playback loops at zero). */
  remaining(projectId: string): number;
  close(): void;
}

/** Simulated transport faults for the development panel, so every connection state can be seen. A `dead` fault clears after one restart. */
function withFault(source: EngineeringDataSource, fault: DemoFault): EngineeringDataSource {
  const outage: DataSourceError = { code: 'unavailable', message: 'simulated outage', retryable: true };
  // One malformed snapshot that gets past transport, so the view's error boundary and its recovery can be seen.
  if (fault === 'corrupt') {
    let once = true;
    return {
      ...source,
      getSnapshot: async (projectId) => {
        const snapshot = await source.getSnapshot(projectId);
        if (!once) return snapshot;
        once = false;
        return { ...snapshot, tasks: null as never };
      },
    };
  }
  if (fault === 'unavailable') return { ...source, getSnapshot: () => Promise.reject(new Error(outage.message)) };
  if (fault === 'reconnecting') {
    let loads = 0;
    return {
      ...source,
      getSnapshot: (projectId) => (++loads > 1 ? Promise.reject(new Error(outage.message)) : source.getSnapshot(projectId)),
      subscribe: (_projectId, _cursor, _onEvent, onError) => {
        queueMicrotask(() => onError(outage));
        return () => {};
      },
    };
  }
  let deadOnce = true;
  return {
    ...source,
    subscribe: (projectId, cursor, onEvent, onError) => {
      if (!deadOnce) return source.subscribe(projectId, cursor, onEvent, onError);
      deadOnce = false;
      queueMicrotask(() => onError({ code: 'unauthorized', message: 'simulated terminal error', retryable: false }));
      return () => {};
    },
  };
}

export async function loadDemoSession(fault: DemoFault | null): Promise<DemoSession | null> {
  if (!import.meta.env.DEV) return null;
  const { createDemoDataSource } = await import('@selarikru/data-source-mock');
  // H12 fix round 2 (N1): the demo's simulated offline reaches the demo server too, so its checkpoint calls fail as live ones would.
  const { connectivity } = await import('../features/checkpoints/connectivity.ts');
  const mock = createDemoDataSource({ isOffline: () => connectivity.getState().simulatedOffline });
  const every: Scheduler = (fn, ms) => {
    let last = mock.clock.nowMs();
    const off = mock.clock.onTick(() => {
      if (mock.clock.nowMs() - last < ms) return;
      last = mock.clock.nowMs();
      fn();
    });
    return () => {
      off();
    };
  };
  return {
    source: fault ? withFault(mock, fault) : mock,
    projects: mock.listProjects(),
    clockFor: (projectId) => mock.clockFor(projectId),
    every,
    advance: (ms) => mock.clock.advance(ms),
    remaining: (projectId) => mock.pendingCount(projectId),
    close: () => mock.disconnect(),
  };
}
