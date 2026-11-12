import { isNetworkFailure } from '@selarikru/inference-firebase-web';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * H12: whether this browser can reach the cloud now. Offline is the browser's own word (navigator.onLine), or a cloud request that failed on the network since the
 * last time the browser said it was online. The demo can simulate offline (Debug › Go offline); that never touches navigator.onLine and exists only under demo data.
 */
export interface Connectivity {
  readonly navigatorOnline: boolean;
  /** A cloud request failed on the network. Cleared by the next answer from the cloud, or when the browser reports `online` again. */
  readonly networkFailed: boolean;
  /**
   * Fix round 1 (I2): the backoff after a network failure has elapsed, so the next request may start: that request is the probe (no other endpoint is called). Its
   * success clears the failure; another failure starts a longer backoff.
   */
  readonly probeDue: boolean;
  /** Demo only: simulated offline. */
  readonly simulatedOffline: boolean;
}

export const isOnlineState = (c: Connectivity): boolean => c.navigatorOnline && (!c.networkFailed || c.probeDue) && !c.simulatedOffline;

export interface ConnectivityStore extends Connectivity {
  setNavigatorOnline(online: boolean): void;
  /**
   * A cloud request failed on the network. H9 fix round 3: given the error, it is read with the adapter's own classifier (isNetworkFailure): an HTTP error,
   * a 429 included, reached the cloud and never flips the app offline. Without an error it is taken as said.
   */
  reportNetworkFailure(error?: unknown): void;
  reportNetworkSuccess(): void;
  /** Demo only. */
  simulateOffline(offline: boolean): void;
}

/** The first backoff after a network failure, doubled on each failed probe up to the cap. */
export const PROBE_BACKOFF_MS = { first: 5_000, max: 60_000 } as const;

export function createConnectivity(navigatorOnline = typeof navigator === 'undefined' || navigator.onLine !== false): StoreApi<ConnectivityStore> {
  let backoff = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  return createStore<ConnectivityStore>()((set) => ({
    navigatorOnline, networkFailed: false, probeDue: false, simulatedOffline: false,
    // The browser's own `online` event clears a network failure too: it is the browser saying the connection is back.
    setNavigatorOnline: (online) => { if (online) { stop(); backoff = 0; } set(online ? { navigatorOnline: true, networkFailed: false, probeDue: false } : { navigatorOnline: false }); },
    reportNetworkFailure: (...args: unknown[]) => {
      if (args.length > 0 && !isNetworkFailure(args[0])) return;
      stop();
      backoff = backoff === 0 ? PROBE_BACKOFF_MS.first : Math.min(backoff * 2, PROBE_BACKOFF_MS.max);
      set({ networkFailed: true, probeDue: false });
      timer = setTimeout(() => { timer = null; set({ probeDue: true }); }, backoff);
    },
    reportNetworkSuccess: () => { stop(); backoff = 0; set({ networkFailed: false, probeDue: false }); },
    simulateOffline: (offline) => set({ simulatedOffline: offline }),
  }));
}

/** The one connectivity store of this tab. */
export const connectivity = createConnectivity();
export const isOnline = (): boolean => isOnlineState(connectivity.getState());

let watching = false;
/** Follows the browser's online and offline events. Idempotent. */
export function watchNavigator(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('online', () => connectivity.getState().setNavigatorOnline(true));
  window.addEventListener('offline', () => connectivity.getState().setNavigatorOnline(false));
}

/** Calls `fn` each time the browser goes from offline to online. Returns the unsubscribe. */
export function onReconnect(store: StoreApi<ConnectivityStore>, fn: () => void): () => void {
  let was = isOnlineState(store.getState());
  return store.subscribe((s) => {
    const now = isOnlineState(s);
    if (now && !was) fn();
    was = now;
  });
}

export const useOnlineNow = (): boolean => useStore(connectivity, isOnlineState);
export const useSimulatedOffline = (): boolean => useStore(connectivity, (s) => s.simulatedOffline);
