import { describe, expect, it } from 'vitest';
import { describeError } from '../src/log.ts';

describe('describeError', () => {
  it('lists each cause of an AggregateError, redacted', () => {
    const out = describeError(new AggregateError([new Error('run run_a: boom'), new Error('run run_b: token=abcdef1234567890abcdef12')], 'assembly: 2 run(s) failed'));
    expect(out.split('\n')).toEqual(['assembly: 2 run(s) failed', '  - run run_a: boom', '  - run run_b: token=[REDACTED]']);
  });
  it('prints a plain error or value as one line', () => {
    expect(describeError(new Error('x'))).toBe('x');
    expect(describeError('y')).toBe('y');
  });
});
