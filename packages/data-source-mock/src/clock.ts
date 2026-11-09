import type { Clock } from '@selarikru/view-protocol';

/** A virtual clock: it only moves when told to. Speeding it up affects the mock's pace and never a live deadline. */
export interface VirtualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
  onTick(listener: () => void): () => void;
}

export function createSeededClock(startIso: string): VirtualClock {
  let now = Date.parse(startIso);
  if (Number.isNaN(now)) throw new RangeError(`invalid start time: ${startIso}`);
  const listeners = new Set<() => void>();
  const tick = (): void => {
    for (const l of [...listeners]) l();
  };
  return {
    nowMs: () => now,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('a virtual clock only moves forward');
      now += ms;
      tick();
    },
    set(ms) {
      if (ms < now) throw new RangeError('a virtual clock only moves forward');
      now = ms;
      tick();
    },
    onTick(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
