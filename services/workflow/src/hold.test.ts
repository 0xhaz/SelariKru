import { describe, expect, it } from 'vitest';
import type { HarnessCatalog } from '@selarikru/domain';
import { holdMultiplier, sizeCapMicros, worstCaseHold } from './assignment.ts';

const rate = (i: number, o: number) => ({ inputUsdPerMTok: i, outputUsdPerMTok: o, source: 'test' });
const catalog = { status: 'detected', detail: null, providers: [{ provider: 'p', label: 'P', harnessVersion: '1', modelSelection: 'supported', models: [
  { id: 'mid', label: 'mid', route: 'cloud', rate: rate(3, 15) },
  { id: 'dear', label: 'dear', route: 'cloud', rate: rate(5, 25) },
  { id: 'cheap', label: 'cheap', route: 'cloud', rate: rate(1, 5) },
  { id: 'unrated', label: 'unrated', route: 'cloud', rate: null },
] }] } as unknown as HarnessCatalog;
const policy = { policyVersion: 'v', models: { allowed: [], default: { provider: 'p', model: 'mid' } } } as never;
const noReference = { policyVersion: 'v', models: { allowed: [], default: { provider: 'p', model: 'unrated' } } } as never;
const pick = (model: string) => ({ provider: 'p', model });

describe('sizing the cap', () => {
  it('a cheaper model never holds less than the cap', () => {
    expect(holdMultiplier(pick('cheap'), catalog, policy).ratio).toBe(1);
    expect(worstCaseHold(1_000_000, pick('cheap'), catalog, policy).amountMicros).toBe(1_000_000);
  });

  it('with no reference rate the ratio is 1 and says so', () => {
    expect(holdMultiplier(pick('dear'), catalog, noReference)).toMatchObject({ ratio: 1, basis: 'no_reference' });
  });

  it('a model with no rate is sized on the hold it will really take, so it is never understated', () => {
    const m = holdMultiplier(pick('unrated'), catalog, policy);
    expect(m.basis).toBe('conservative');
    expect(m.ratio).toBeGreaterThan(1);
    expect(worstCaseHold(1_000_000, pick('unrated'), catalog, policy).amountMicros).toBe(Math.ceil(1_000_000 * m.ratio));
  });

  it.each([[5_000_000], [25_000_000], [1_234_567], [7]])('at %d micros the real holds of every attempt never exceed the budget', (budget) => {
    const roles = [pick('dear'), pick('mid')];
    const cap = sizeCapMicros(budget, roles.map((s) => ({ selection: s, attempts: 3 })), catalog, policy);
    const total = roles.reduce((n, s) => n + 3 * worstCaseHold(cap, s, catalog, policy).amountMicros, 0);
    expect(total).toBeLessThanOrEqual(budget);
    if (budget > 1000) expect(budget - total).toBeLessThan(20);
  });
});
