import { describe, expect, it, vi } from 'vitest';
import { FACTS_RETRY_DELAYS_MS, loadFactsWithRetry } from './facts.ts';

describe('reading whether a task has a change', () => {
  it('retries a failed read with a bounded backoff, then gives up and says so; a failure is never kept as an answer', async () => {
    const waits: number[] = [];
    const read = vi.fn(async () => { throw new Error('down'); });
    expect(await loadFactsWithRetry(read, async (ms) => { waits.push(ms); })).toBeNull();
    expect(read).toHaveBeenCalledTimes(FACTS_RETRY_DELAYS_MS.length + 1);
    expect(waits).toEqual([...FACTS_RETRY_DELAYS_MS]);
    expect(FACTS_RETRY_DELAYS_MS.length).toBeLessThanOrEqual(4);
  });
  it('stops at the first read that works', async () => {
    let n = 0;
    const read = vi.fn(async () => { if (n++ === 0) throw new Error('blip'); return { hasChange: true, inputChars: 10 }; });
    expect(await loadFactsWithRetry(read, async () => undefined)).toEqual({ hasChange: true, inputChars: 10 });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
