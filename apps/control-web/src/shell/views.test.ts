import { describe, expect, it } from 'vitest';
import { ROUTES } from './route.ts';
import { ACTION_ITEMS_MENU, BOARDS_MENU, MISSION_CONTROL, SETTINGS_MENU_EXTRA, SETTINGS_TABS, frameOf, settingsSection, settingsHref, TITLES, topBarHomeOf } from './views.ts';

describe('where each screen lives', () => {
  it('the office is always in view; every other screen opens in a drawer over it, and Settings in its modal', () => {
    expect(frameOf('office')).toBe('office');
    expect(frameOf('settings')).toBe('settings');
    for (const r of ROUTES.filter((x) => x !== 'office' && x !== 'settings')) expect(frameOf(r), r).toBe('drawer');
  });

  it('every route can be reached from the top bar\'s menus; the office is what closing a drawer leaves', () => {
    const reachable = new Set([...ACTION_ITEMS_MENU, ...BOARDS_MENU, ...SETTINGS_MENU_EXTRA, ...MISSION_CONTROL].map((i) => i.route).concat(['evidence', 'settings']));
    for (const r of ROUTES.filter((x) => x !== 'office')) expect(reachable.has(r), r).toBe(true);
  });

  it('maps each screen to its main menu for now: Action items, Boards, PRs or Settings', () => {
    expect(ACTION_ITEMS_MENU.map((e) => e.route)).toEqual(['overview', 'decisions']);
    expect(BOARDS_MENU.map((e) => e.route)).toEqual(['overview', 'pipeline', 'decisions', 'team', 'product', 'brain', 'benchmark']);
    expect(SETTINGS_MENU_EXTRA.map((e) => e.route)).toEqual(['assistant', 'onboarding']);
    expect(topBarHomeOf('evidence')).toBe('PRs');
    expect(topBarHomeOf('assistant')).toBe('Settings');
    expect(topBarHomeOf('brain')).toBe('Boards');
    expect(topBarHomeOf('office')).toBe('office');
  });

  it('Mission Control is one drawer whose tabs are Overview, Pipeline and Decisions, with their existing names', () => {
    expect(MISSION_CONTROL.map((i) => [i.label, i.route])).toEqual([['Overview', 'overview'], ['Pipeline', 'pipeline'], ['Decisions', 'decisions']]);
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
