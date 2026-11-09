import { describe, expect, it, vi } from 'vitest';
import { buildFixture, createMockDataSource, createSeededClock, FIXTURE_T0_MS } from '@selarikru/data-source-mock';
import { DataSourceException, type DataSourceError, type EngineeringDataSource } from '@selarikru/view-protocol';
import { CommandNotSent, connectionOf, createProjectionStore, type Scheduler } from './projection-store.ts';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function setup(wrap: (s: EngineeringDataSource) => EngineeringDataSource = (s) => s) {
  const fixture = buildFixture('healthy-parallel-work');
  const clock = createSeededClock(new Date(FIXTURE_T0_MS).toISOString());
  const mock = createMockDataSource({ clock, fixtures: [fixture] });
  const timers = new Set<() => void>();
  const every: Scheduler = (fn) => {
    timers.add(fn);
    return () => timers.delete(fn);
  };
  const source = wrap(mock);
  const store = createProjectionStore({ source, projectId: fixture.projectId, clock: mock.clockFor(fixture.projectId), every });
  return { store, mock, clock, fire: () => [...timers].forEach((f) => f()), timers };
}

const failing = (s: EngineeringDataSource): EngineeringDataSource => ({ ...s, getSnapshot: () => Promise.reject(new DataSourceException({ code: 'unavailable', message: 'down', retryable: true })) });
const deadOnce = (s: EngineeringDataSource): EngineeringDataSource => {
  let first = true;
  return {
    ...s,
    subscribe(projectId, after, onEvent, onError) {
      if (first) {
        first = false;
        const e: DataSourceError = { code: 'unauthorized', message: 'no', retryable: false };
        queueMicrotask(() => onError(e));
        return () => {};
      }
      return s.subscribe(projectId, after, onEvent, onError);
    },
  };
};

describe('projection store', () => {
  it('reads connecting until the first snapshot, then live with state and a liveness time', async () => {
    const { store } = setup();
    store.getState().start();
    expect(connectionOf(store.getState())).toBe('connecting');
    await flush();
    expect(connectionOf(store.getState())).toBe('live');
    expect(store.getState().projection).not.toBeNull();
    expect(store.getState().livenessAsOfMs).not.toBeNull();
    store.getState().stop();
  });

  it('is unavailable, not live or empty, when no snapshot ever loaded', async () => {
    const { store } = setup(failing);
    store.getState().start();
    await flush();
    expect(store.getState().projection).toBeNull();
    expect(connectionOf(store.getState())).toBe('unavailable');
    expect(store.getState().error?.code).toBe('unavailable');
    store.getState().stop();
  });

  it('keeps the last confirmed state while reconnecting', async () => {
    let fail = false;
    const { store } = setup((s) => ({
      ...s,
      getSnapshot: (p) => (fail ? Promise.reject(new Error('down')) : s.getSnapshot(p)),
      subscribe(p, c, onEvent, onError) {
        const un = s.subscribe(p, c, onEvent, onError);
        queueMicrotask(() => {
          if (fail) onError({ code: 'unavailable', message: 'down', retryable: true });
        });
        return un;
      },
    }));
    store.getState().start();
    await flush();
    fail = true;
    store.getState().restart(); // re-enters through a failing source while holding state
    await flush();
    expect(connectionOf(store.getState())).toBe('reconnecting');
    expect(store.getState().projection).not.toBeNull();
    store.getState().stop();
  });

  it('never reports liveness as fresh while the session is not live', async () => {
    const { store } = setup(deadOnce);
    store.getState().start();
    await flush();
    expect(connectionOf(store.getState())).toBe('dead');
    expect(store.getState().livenessForHealth()).toBeNull();
  });

  it('a dead session restarts with stop then a new projection, and recovers', async () => {
    const { store } = setup(deadOnce);
    store.getState().start();
    await flush();
    expect(connectionOf(store.getState())).toBe('dead');
    store.getState().restart();
    await flush();
    expect(connectionOf(store.getState())).toBe('live');
    expect(store.getState().livenessForHealth()).not.toBeNull();
    store.getState().stop();
  });

  it('keeps the last confirmed time across a restart while retries fail', async () => {
    let fail = false;
    const { store, fire } = setup((s) => ({ ...s, getSnapshot: (p) => (fail ? Promise.reject(new Error('down')) : s.getSnapshot(p)) }));
    store.getState().start();
    await flush();
    const confirmed = store.getState().livenessAsOfMs;
    expect(confirmed).not.toBeNull();
    fail = true;
    store.getState().restart();
    await flush();
    fire();
    expect(store.getState().livenessAsOfMs).toBe(confirmed);
    store.getState().stop();
  });

  it('stop cancels the scheduled work', async () => {
    const { store, timers } = setup();
    store.getState().start();
    await flush();
    expect(timers.size).toBeGreaterThan(0);
    store.getState().stop();
    expect(timers.size).toBe(0);
  });

  it('moves now forward on the scheduled tick', async () => {
    const { store, clock, fire } = setup();
    store.getState().start();
    await flush();
    const before = store.getState().nowMs;
    clock.advance(5000);
    fire();
    expect(store.getState().nowMs).toBe(before + 5000);
    store.getState().stop();
  });
});

describe('with no data source at all', () => {
  it('is unavailable and does nothing, so production never shows mock data', () => {
    const store = createProjectionStore({ source: null, projectId: '', clock: { nowMs: () => 0 }, every: () => () => {} });
    store.getState().start();
    expect(connectionOf(store.getState())).toBe('unavailable');
    expect(store.getState().projection).toBeNull();
  });
});

describe('commands', () => {
  it('refuses to send while the session is not live, and says nothing was sent', async () => {
    const execute = vi.fn();
    const store = createProjectionStore({ source: { mode: 'mock', getSnapshot: () => new Promise(() => {}), subscribe: () => () => {}, execute, openTerminal: vi.fn(), disconnect: vi.fn() } as never, projectId: 'p', clock: { nowMs: () => 0 }, every: () => () => {} });
    await expect(store.getState().execute({ command: 'task.cancel', expectedRevision: 0, idempotencyKey: 'k', args: { taskId: 't' } })).rejects.toBeInstanceOf(CommandNotSent);
    expect(execute).not.toHaveBeenCalled();
  });
});
