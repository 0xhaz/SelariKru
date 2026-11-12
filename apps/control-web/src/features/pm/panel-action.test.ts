import { describe, expect, it } from 'vitest';
import { exclusive, type BusyGuard } from './panel-action.ts';

describe('M1: the PM panel starts one call at a time', () => {
  it('two calls in the same tick start one request; the second answers false at once', async () => {
    const guard: BusyGuard = { current: false };
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = async () => { started += 1; await gate; return true; };
    const first = exclusive(guard, false, run);
    const second = exclusive(guard, false, run);
    expect(await second).toBe(false);
    expect(started).toBe(1);
    release();
    expect(await first).toBe(true);
  });

  it('the guard is released when the call settles, also when it throws', async () => {
    const guard: BusyGuard = { current: false };
    await expect(exclusive(guard, false, async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(guard.current).toBe(false);
    expect(await exclusive(guard, false, async () => true)).toBe(true);
  });
});
