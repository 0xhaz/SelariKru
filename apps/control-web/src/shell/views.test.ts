import { describe, expect, it } from 'vitest';
import { ROUTES } from './route.ts';
import { BOARDS_MENU, SETTINGS_MENU_EXTRA, SETTINGS_TABS, frameOf, settingsSection, settingsHref, TITLES, topBarHomeOf } from './views.ts';

describe('where each screen lives', () => {
  it('the office is always in view; every other screen opens in a drawer over it, and Settings in its modal', () => {
    expect(frameOf('office')).toBe('office');
    expect(frameOf('settings')).toBe('settings');
    for (const r of ROUTES.filter((x) => x !== 'office' && x !== 'settings')) expect(frameOf(r), r).toBe('drawer');
  });

  it('every screen appears exactly once, under one top-bar entry; the office is what closing a drawer leaves', () => {
    const entries = [...BOARDS_MENU, ...SETTINGS_MENU_EXTRA].map((i) => i.route).concat(['actions', 'evidence', 'settings']);
    expect(new Set(entries).size).toBe(entries.length);
    for (const r of ROUTES.filter((x) => x !== 'office')) expect(entries.filter((e) => e === r), r).toHaveLength(1);
  });

  it('places each screen under its most relevant entry', () => {
    expect(BOARDS_MENU.map((e) => [e.label, e.route])).toEqual([['Talk to the PM', 'pm'], ['AI calls', 'calls'], ['Pipeline', 'pipeline'], ['Run summary', 'summary'], ['Product', 'product'], ['Brain', 'brain'], ['Benchmark', 'benchmark']]);
    expect(SETTINGS_MENU_EXTRA.map((e) => e.route)).toEqual(['team', 'assistant', 'onboarding']);
    expect(topBarHomeOf('actions')).toBe('Action items');
    expect(topBarHomeOf('evidence')).toBe('PRs');
    expect(topBarHomeOf('team')).toBe('Settings');
    expect(topBarHomeOf('summary')).toBe('Boards');
    expect(topBarHomeOf('office')).toBe('office');
  });

  it('no menu, title or label uses the Mission Control name', () => {
    const words = [...BOARDS_MENU, ...SETTINGS_MENU_EXTRA].map((e) => e.label).concat(Object.values(TITLES));
    for (const w of words) expect(w).not.toMatch(/mission control|overview/i);
  });

  it('every route has a page title', () => {
    for (const r of ROUTES) expect(TITLES[r], r).toBeTruthy();
    expect(TITLES.summary).toBe('Run summary');
    expect(TITLES.actions).toBe('Action items');
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
