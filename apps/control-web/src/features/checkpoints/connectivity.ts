import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * H12: whether this browser can reach the cloud now. Offline is the browser's own word (navigator.onLine), or a cloud request that failed on the network since the
 * last time the browser said it was online. The demo can simulate offline (Debug › Go offline); that never touches navigator.onLine and exists only under demo data.
 */
export interface Connectivity {
  readonly navigatorOnline: boolean;
  /** A cloud request failed on the network. Cleared when the browser reports `online` again, or the owner retries. */
  readonly networkFailed: boolean;
  /** Demo only: simulated offline. */
  readonly simulatedOffline: boolean;
}

export const isOnlineState = (c: Connectivity): boolean => c.navigatorOnline && !c.networkFailed && !c.simulatedOffline;

export interface ConnectivityStore extends Connectivity {
  setNavigatorOnline(online: boolean): void;
  reportNetworkFailure(): void;
  clearNetworkFailure(): void;
  /** Demo only. */
  simulateOffline(offline: boolean): void;
}

export function createConnectivity(navigatorOnline = typeof navigator === 'undefined' || navigator.onLine !== false): StoreApi<ConnectivityStore> {
  return createStore<ConnectivityStore>()((set) => ({
    navigatorOnline, networkFailed: false, simulatedOffline: false,
    // The browser's own `online` event clears a network failure too: it is the browser saying the connection is back.
    setNavigatorOnline: (online) => set(online ? { navigatorOnline: true, networkFailed: false } : { navigatorOnline: false }),
    reportNetworkFailure: () => set({ networkFailed: true }),
    clearNetworkFailure: () => set({ networkFailed: false }),
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
