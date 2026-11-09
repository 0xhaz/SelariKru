import { describe, expect, it } from 'vitest';
import { formatAge, formatCount, formatDuration, formatExact, formatUsd } from '../src/format.ts';

describe('formatAge', () => {
  it('says seconds, then minutes and seconds, then hours and minutes', () => {
    expect(formatAge(0)).toBe('0s');
    expect(formatAge(59_400)).toBe('59s');
    expect(formatAge(62_000)).toBe('1m 2s');
    expect(formatAge(3_720_000)).toBe('1h 2m');
  });
  it('never shows a negative age', () => {
    expect(formatAge(-5000)).toBe('0s');
  });
});

describe('quantity formatting', () => {
  it('keeps cents on small dollar amounts', () => {
    expect(formatUsd('0.79')).toBe('$0.79');
    expect(formatUsd('1.2')).toBe('$1.20');
    expect(formatUsd('3')).toBe('$3.00');
  });
  it('rounds tiny amounts up to a visible figure rather than down to zero', () => {
    expect(formatUsd('0.001')).toBe('<$0.01');
    expect(formatUsd('0')).toBe('$0.00');
  });
  it('groups large counts and formats seconds as a duration', () => {
    expect(formatCount('120400')).toBe('120,400');
    expect(formatDuration('237')).toBe('3m 57s');
  });
});

describe('formatExact', () => {
  it('renders a date, a time and a zone without throwing', () => {
    expect(formatExact('2026-11-16T09:00:00.000Z')).toMatch(/2026.*\d{2}:\d{2}:\d{2}/);
  });
});
