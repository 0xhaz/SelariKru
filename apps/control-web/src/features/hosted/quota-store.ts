import { createStore } from 'zustand/vanilla';
import type { CloudQuotaState } from './cloud-quota.ts';

/** A store with no cap in it, for builds that are not the hosted demo (hooks need a store either way). */
export const EMPTY_QUOTA_STORE = createStore<CloudQuotaState>()(() => ({ limit: 0, used: 0 }));

/** "Cloud calls left in this demo: N". */
export const quotaText = (s: CloudQuotaState): string => `Cloud calls left in this demo: ${Math.max(0, s.limit - s.used)}`;
