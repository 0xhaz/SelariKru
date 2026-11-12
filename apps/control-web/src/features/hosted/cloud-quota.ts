import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * H9: the hosted demo's per-tab cap on cloud calls. It protects the free-tier quota for the whole judging period: past it, a step that needs the cloud pauses as a
 * checkpoint (stop reason `cloud_quota`) with a clear message, and device calls still run. A constant, not a setting. Hosted build only.
 */
export const HOSTED_CLOUD_CALL_LIMIT = 40;
const KEY = 'selarikru.hosted-cloud-calls';

export interface CloudQuotaState { readonly limit: number; readonly used: number }
export interface CloudQuota {
  readonly store: StoreApi<CloudQuotaState>;
  allowed(): boolean;
  /** H9 fix round 1 (I2): takes one unit, or refuses at the cap. Synchronous, so two calls cannot both take the last one. */
  reserve(): boolean;
  /** Gives one back: the call was answered on this device. */
  refund(): void;
}

/** Kept in this tab's session storage, so a reload does not reset it. Any storage failure is ignored: the count then lives in memory for this page. */
export function createCloudQuota(opts: { readonly limit?: number; readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null } = {}): CloudQuota {
  const limit = opts.limit ?? HOSTED_CLOUD_CALL_LIMIT;
  const storage = opts.storage !== undefined ? opts.storage : (typeof sessionStorage === 'undefined' ? null : sessionStorage);
  let start = 0;
  try {
    const n = Number(storage?.getItem(KEY) ?? '0');
    start = Number.isInteger(n) && n >= 0 ? Math.min(n, limit) : 0;
  } catch { /* storage blocked: start at zero */ }
  const store = createStore<CloudQuotaState>()(() => ({ limit, used: start }));
  const set = (used: number): void => {
    store.setState({ used });
    try { storage?.setItem(KEY, String(used)); } catch { /* a convenience only */ }
  };
  return {
    store,
    allowed: () => store.getState().used < store.getState().limit,
    reserve() {
      if (store.getState().used >= limit) return false;
      set(store.getState().used + 1);
      return true;
    },
    refund() { set(Math.max(0, store.getState().used - 1)); },
  };
}

export { quotaText } from './quota-store.ts';
