import { describe, expect, it, vi } from 'vitest';
import { createConnectivity, isOnlineState, onReconnect } from './connectivity.ts';

describe('connectivity (H12 fix round 1, I2)', () => {
  it('a network blip with navigator.onLine true recovers: after a backoff the next request may start (the probe), and its success clears the failure and fires onReconnect', () => {
    vi.useFakeTimers();
    try {
      const c = createConnectivity(true);
      const reconnects: number[] = [];
      onReconnect(c, () => reconnects.push(1));
      c.getState().reportNetworkFailure();
      expect(isOnlineState(c.getState())).toBe(false);
      // The backoff elapses: the next request may start, as a probe. That is a reconnect for the queue.
      vi.advanceTimersByTime(5_000);
      expect(isOnlineState(c.getState())).toBe(true);
      expect(reconnects).toHaveLength(1);
      // The probe failed again: offline, with a longer backoff.
      c.getState().reportNetworkFailure();
      expect(isOnlineState(c.getState())).toBe(false);
      vi.advanceTimersByTime(5_000);
      expect(isOnlineState(c.getState())).toBe(false);
      vi.advanceTimersByTime(5_000);
      expect(isOnlineState(c.getState())).toBe(true);
      // A successful request clears it outright.
      c.getState().reportNetworkFailure();
      c.getState().reportNetworkSuccess();
      expect(c.getState()).toMatchObject({ networkFailed: false });
      expect(isOnlineState(c.getState())).toBe(true);
      expect(reconnects).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the browser saying it is offline wins over a probe', () => {
    const c = createConnectivity(false);
    expect(isOnlineState(c.getState())).toBe(false);
    c.getState().reportNetworkSuccess();
    expect(isOnlineState(c.getState())).toBe(false);
  });
});
