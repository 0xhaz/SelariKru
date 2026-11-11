import type { ReactNode } from 'react';
import { hrefFor, type Route } from './route.ts';

/**
 * Where each screen lives in the office layout (T5.12). The office canvas is always in view. Every other screen opens in a right-side drawer
 * over it, chosen from the top bar, and Settings opens as a centred modal with its own tabs. All of them are routes, so each can be linked to.
 */
export type ViewFrame = 'office' | 'drawer' | 'settings';

export function frameOf(route: Route): ViewFrame {
  if (route === 'office') return 'office';
  if (route === 'settings') return 'settings';
  return 'drawer';
}

export const TITLES: Readonly<Record<Route, string>> = {
  office: 'Office', actions: 'Action items', summary: 'Run summary', team: 'Team', pipeline: 'Pipeline', evidence: 'Evidence and pull requests', product: 'Product',
  brain: 'Project Brain', benchmark: 'Benchmark', assistant: 'Assistant', settings: 'Settings', onboarding: 'New project',
};

export interface MenuEntry {
  readonly label: string;
  readonly route: Route;
  readonly badge?: ReactNode;
}

/**
 * The template menus (owner, T5.12): each screen appears exactly once, under the top-bar entry it is most relevant to.
 * Action items: one button and one drawer (what workers ask, and everything else waiting on you). Boards: Pipeline, Run summary, Product, Brain,
 * Benchmark. PRs: Evidence and pull requests. Terminal: the selected worker's terminal. Settings: the Settings tabs, plus Team, Assistant and New project.
 */
export const BOARDS_MENU: readonly MenuEntry[] = [
  { label: 'Pipeline', route: 'pipeline' }, { label: 'Run summary', route: 'summary' }, { label: 'Product', route: 'product' }, { label: 'Brain', route: 'brain' }, { label: 'Benchmark', route: 'benchmark' },
];

/** In the Settings modal's menu, after the settings tabs. */
export const SETTINGS_MENU_EXTRA: readonly MenuEntry[] = [{ label: 'Team fleet', route: 'team' }, { label: 'Assistant', route: 'assistant' }, { label: 'New project', route: 'onboarding' }];

export type TopMenu = 'Action items' | 'Boards' | 'PRs' | 'Settings';


/** The one top-bar menu each screen is under; the office is what closing a drawer leaves. */
export function topBarHomeOf(route: Route): 'office' | TopMenu {
  if (route === 'office') return 'office';
  if (route === 'evidence') return 'PRs';
  if (route === 'actions') return 'Action items';
  if (route === 'settings' || SETTINGS_MENU_EXTRA.some((e) => e.route === route)) return 'Settings';
  return 'Boards';
}

export type SettingsTab = 'team' | 'workflow' | 'stack' | 'mcp' | 'sandbox' | 'boards' | 'project';

export const SETTINGS_TABS: readonly { readonly id: SettingsTab; readonly label: string; readonly hint: string }[] = [
  { id: 'team', label: 'Team', hint: 'Workers, models, limits, skills' },
  { id: 'workflow', label: 'Workflow', hint: 'Review, merge, PR, replan' },
  { id: 'stack', label: 'Stack', hint: 'Frameworks and tools' },
  { id: 'mcp', label: 'MCP', hint: 'Connections for workers' },
  { id: 'sandbox', label: 'Sandbox', hint: 'Runtime, slots, resources' },
  { id: 'boards', label: 'Boards', hint: 'Feedback Board' },
  { id: 'project', label: 'Project', hint: 'Project, brief, look' },
];

/** The settings section in the hash. `skills` is Knowledge and skills, which sits under Team; an unknown section opens Team. */
export function settingsSection(raw: string | null): { tab: SettingsTab; sub: 'skills' | null } {
  if (raw === 'skills') return { tab: 'team', sub: 'skills' };
  const tab = SETTINGS_TABS.find((t) => t.id === raw)?.id ?? 'team';
  return { tab, sub: null };
}

export function settingsHref(tab: SettingsTab, sub: 'skills' | null = null): string {
  if (sub === 'skills') return `${hrefFor('settings')}?section=skills`;
  return tab === 'team' ? hrefFor('settings') : `${hrefFor('settings')}?section=${tab}`;
}
