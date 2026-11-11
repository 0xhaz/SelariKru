import { describe, expect, it } from 'vitest';
import { hashWith } from './route.ts';

describe('hashWith', () => {
  it('adds a key and keeps the route and its other keys', () => {
    expect(hashWith('worker', 'w 1', '#/pipeline?view=graph&task=t')).toBe('#/pipeline?view=graph&task=t&worker=w+1');
  });
  it('removes a key and drops an empty query', () => {
    expect(hashWith('worker', null, '#/team?worker=w')).toBe('#/team');
  });
  it('an empty hash is the office', () => {
    expect(hashWith('worker', 'w', '')).toBe('#/office?worker=w');
  });
});

describe('old links', () => {
  it('#/overview, #/decisions and #/attention are no longer routes of their own: they open the Action items drawer', async () => {
    const { ROUTES, decisionHref } = await import('./route.ts');
    for (const old of ['overview', 'decisions', 'attention']) expect(ROUTES).not.toContain(old);
    expect(ROUTES).toContain('actions');
    expect(decisionHref('decision:a')).toBe('#/actions?card=decision%3Aa');
  });
});
