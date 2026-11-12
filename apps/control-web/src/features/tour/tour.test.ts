import { describe, expect, it } from 'vitest';
import { TOUR_FIXTURE, TOUR_STEPS, tourOffered, markTourOffered, tourStartHref } from './tour.ts';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe('H9 item 4: the first-visit guided demo story', () => {
  it('has six short steps, in the order of the story, each pointing at a real element on a real screen', () => {
    expect(TOUR_STEPS.map((s) => s.title)).toEqual([
      'Drafted on this device', 'Too big for Nano: planned in the cloud', 'Restricted: Local only, never the cloud', 'Offline, then reconnected', 'Ask the Project Manager', 'Where every call ran',
    ]);
    for (const s of TOUR_STEPS) {
      expect(s.hash).toMatch(/^#\//);
      expect(s.target.length).toBeGreaterThan(0);
      expect(s.body.length).toBeLessThan(400);
    }
  });

  it('is offered once: dismissal is kept in localStorage, and a storage that throws only means it is offered again', () => {
    const s = memory();
    expect(tourOffered(s)).toBe(false);
    markTourOffered(s);
    expect(tourOffered(s)).toBe(true);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(tourOffered(broken)).toBe(false);
    expect(() => markTourOffered(broken)).not.toThrow();
  });

  it('starts on the demo project that shows every route, keeping ?demo', () => {
    expect(TOUR_FIXTURE).toBe('feature-delivery');
    expect(tourStartHref('http://127.0.0.1:5174/?demo&fixture=human-wait#/team')).toBe('http://127.0.0.1:5174/?demo=&fixture=feature-delivery&tour=1#/office');
    expect(tourStartHref('https://selarikru.web.app/')).toBe('https://selarikru.web.app/?fixture=feature-delivery&tour=1#/office');
  });
});

describe('H9 fix round 2: the tour asks the PM through the panel\'s own action, never through the DOM', () => {
  it('Tour.tsx neither sets an input value nor clicks a button', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./Tour.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/dispatchEvent|HTMLTextAreaElement|\.click\(\)|querySelectorAll<HTMLButtonElement>/);
    expect(src).toContain('waitForPanel');
  });
});

describe('H9 fix round 3: waiting for the PM panel', () => {
  it('stops listening for the panel\'s ready signal when the wait times out', async () => {
    const { waitForPanel } = await import('./wait.ts');
    const { pmPanelAction } = await import('../pm/panel-action.ts');
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const listeners = () => (pmPanelAction as unknown as { listeners?: Set<unknown> }).listeners;
      void listeners;
      let subscribed = 0;
      const subscribe = pmPanelAction.subscribe;
      pmPanelAction.subscribe = ((fn: Parameters<typeof subscribe>[0]) => { subscribed += 1; const off = subscribe(fn); return () => { subscribed -= 1; off(); }; }) as typeof subscribe;
      const waited = waitForPanel(1_000);
      expect(subscribed).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await waited).toBe('timeout');
      expect(subscribed).toBe(0);
      pmPanelAction.subscribe = subscribe;
    } finally {
      vi.useRealTimers();
    }
  });
});
