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

describe('H9 fix round 3: connectivity reads a cloud error with the adapter\'s own classifier', async () => {
  const { AIError, AIErrorCode } = await import('firebase/ai');
  const { createConnectivity, isOnlineState } = await import('./connectivity.ts');
  const URL_ = 'https://firebasevertexai.googleapis.com/v1beta/x:generateContent';
  it('a 429 (or any HTTP error) reached the cloud: it never flips the app offline', () => {
    const c = createConnectivity(true);
    c.getState().reportNetworkFailure(new AIError(AIErrorCode.FETCH_ERROR, `Error fetching from ${URL_}: [429 Too Many Requests] x`, { status: 429, statusText: 'Too Many Requests' }));
    c.getState().reportNetworkFailure(new AIError(AIErrorCode.FETCH_ERROR, `Error fetching from ${URL_}: [500 Internal Server Error] x`, { status: 500, statusText: 'Internal Server Error' }));
    expect(c.getState().networkFailed).toBe(false);
    expect(isOnlineState(c.getState())).toBe(true);
  });
  it('a fetch that got no response does', () => {
    const c = createConnectivity(true);
    c.getState().reportNetworkFailure(new AIError(AIErrorCode.ERROR, `Error fetching from ${URL_}: Failed to fetch`));
    expect(c.getState().networkFailed).toBe(true);
  });
});
