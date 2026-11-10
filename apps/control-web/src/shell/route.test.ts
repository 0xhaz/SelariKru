import { describe, expect, it } from 'vitest';
import { hashWith } from './route.ts';

describe('hashWith', () => {
  it('adds a key and keeps the route and its other keys', () => {
    expect(hashWith('worker', 'w 1', '#/pipeline?view=graph&task=t')).toBe('#/pipeline?view=graph&task=t&worker=w+1');
  });
  it('removes a key and drops an empty query', () => {
    expect(hashWith('worker', null, '#/team?worker=w')).toBe('#/team');
  });
  it('an empty hash is Mission Control', () => {
    expect(hashWith('worker', 'w', '')).toBe('#/overview?worker=w');
  });
});
