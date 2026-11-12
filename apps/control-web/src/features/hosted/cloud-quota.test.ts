import { describe, expect, it } from 'vitest';
import { HOSTED_CLOUD_CALL_LIMIT, createCloudQuota, quotaText } from './cloud-quota.ts';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };

describe('H9: the hosted demo\'s per-tab cloud call cap', () => {
  it('defaults to 40 calls, counts each cloud answer, and stops allowing at the cap', () => {
    expect(HOSTED_CLOUD_CALL_LIMIT).toBe(40);
    const q = createCloudQuota({ limit: 2, storage: memory() });
    expect(q.allowed()).toBe(true);
    q.spend();
    expect(q.store.getState()).toEqual({ limit: 2, used: 1 });
    q.spend();
    expect(q.allowed()).toBe(false);
    q.spend();
    expect(q.store.getState().used).toBe(2);
  });

  it('is kept for this tab (session storage), so a reload does not reset it; a storage that throws changes nothing else', () => {
    const s = memory();
    createCloudQuota({ limit: 40, storage: s }).spend();
    expect(createCloudQuota({ limit: 40, storage: s }).store.getState().used).toBe(1);
    s.m.set('selarikru.hosted-cloud-calls', 'garbage');
    expect(createCloudQuota({ limit: 40, storage: s }).store.getState().used).toBe(0);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const q = createCloudQuota({ limit: 1, storage: broken });
    q.spend();
    expect(q.allowed()).toBe(false);
  });

  it('says how many are left, in plain words', () => {
    expect(quotaText({ limit: 40, used: 0 })).toBe('Cloud calls left in this demo: 40');
    expect(quotaText({ limit: 40, used: 40 })).toBe('Cloud calls left in this demo: 0');
  });
});
