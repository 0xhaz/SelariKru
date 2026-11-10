import { describe, expect, it } from 'vitest';
import { ROUTES } from './route.ts';
import { MISSION_CONTROL, SETTINGS_TABS, TOP_BAR, frameOf, settingsSection, settingsHref, TITLES, topBarRouteOf } from './views.ts';

describe('where each screen lives', () => {
  it('the office is always in view; every other screen opens in a drawer over it, and Settings in its modal', () => {
    expect(frameOf('office')).toBe('office');
    expect(frameOf('settings')).toBe('settings');
    for (const r of ROUTES.filter((x) => x !== 'office' && x !== 'settings')) expect(frameOf(r), r).toBe('drawer');
  });

  it('every route can be reached from the top bar or Mission Control\'s tabs; the office is what closing a drawer leaves', () => {
    const reachable = new Set([...TOP_BAR, ...MISSION_CONTROL].map((i) => i.route));
    for (const r of ROUTES.filter((x) => x !== 'office')) expect(reachable.has(r), r).toBe(true);
  });

  it('Mission Control is one drawer whose tabs are Overview, Pipeline and Decisions, with their existing names', () => {
    expect(MISSION_CONTROL.map((i) => [i.label, i.route])).toEqual([['Overview', 'overview'], ['Pipeline', 'pipeline'], ['Decisions', 'decisions']]);
    for (const r of ['overview', 'pipeline', 'decisions'] as const) expect(topBarRouteOf(r)).toBe('overview');
    expect(topBarRouteOf('brain')).toBe('brain');
    expect(topBarRouteOf('office')).toBeNull();
  });

  it('every route has a page title', () => {
    for (const r of ROUTES) expect(TITLES[r], r).toBeTruthy();
    expect(TITLES.overview).toBe('Mission Control');
  });
});

describe('settings tabs', () => {
  it('has the reference tab set, in order', () => {
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual(['Team', 'Workflow', 'Stack', 'MCP', 'Sandbox', 'Boards', 'Project']);
  });

  it('opens on Team; a known section opens its tab', () => {
    expect(settingsSection(null)).toEqual({ tab: 'team', sub: null });
    expect(settingsSection('stack')).toEqual({ tab: 'stack', sub: null });
    expect(settingsSection('mcp')).toEqual({ tab: 'mcp', sub: null });
    expect(settingsSection('nonsense')).toEqual({ tab: 'team', sub: null });
  });

  it('Knowledge and skills sits under Team, and its old link still lands on it', () => {
    expect(settingsSection('skills')).toEqual({ tab: 'team', sub: 'skills' });
    expect(settingsHref('team', 'skills')).toBe('#/settings?section=skills');
    expect(settingsHref('team')).toBe('#/settings');
    expect(settingsHref('stack')).toBe('#/settings?section=stack');
  });
});
