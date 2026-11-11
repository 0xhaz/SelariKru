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
  office: 'Office', overview: 'Mission Control', team: 'Team', pipeline: 'Pipeline', decisions: 'Decisions', evidence: 'Evidence and PR', product: 'Product', brain: 'Project Brain',
  benchmark: 'Benchmark', assistant: 'Assistant', settings: 'Settings', onboarding: 'New project',
};

export interface NavItem {
  readonly label: string;
  readonly route: Route;
}

/** Mission Control's three screens: one drawer, with these as its tabs. */
export const MISSION_CONTROL: readonly NavItem[] = [{ label: 'Overview', route: 'overview' }, { label: 'Pipeline', route: 'pipeline' }, { label: 'Decisions', route: 'decisions' }];

export interface MenuEntry {
  readonly label: string;
  readonly route: Route;
  /** A heading the entry sits under in the menu. */
  readonly group?: string;
  readonly badge?: ReactNode;
}

/**
 * Where our screens sit in the reference's top bar for now (owner, T5.12): the owner will rearrange them later.
 * Action items: the attention queue and Decisions. Boards: Mission Control, the Team screen, Product, Brain and Benchmark.
 * PRs: Evidence and PR. Terminal: the selected worker's Terminal tab. Settings: the Settings modal, whose menu also holds Assistant and New project.
 */
export const ACTION_ITEMS_MENU: readonly MenuEntry[] = [{ label: 'Attention queue', route: 'overview' }, { label: 'Decisions', route: 'decisions' }];

export const BOARDS_MENU: readonly MenuEntry[] = [
  { label: 'Overview', route: 'overview', group: 'Mission Control' }, { label: 'Pipeline', route: 'pipeline', group: 'Mission Control' }, { label: 'Decisions', route: 'decisions', group: 'Mission Control' },
  { label: 'Team', route: 'team' }, { label: 'Product', route: 'product' }, { label: 'Brain', route: 'brain' }, { label: 'Benchmark', route: 'benchmark' },
];

/** In the Settings modal's menu, beside the settings tabs. */
export const SETTINGS_MENU_EXTRA: readonly MenuEntry[] = [{ label: 'Assistant', route: 'assistant' }, { label: 'New project', route: 'onboarding' }];

/** Every route and the top-bar entry it is reached from. */
export function topBarHomeOf(route: Route): 'office' | 'Action items' | 'Boards' | 'PRs' | 'Settings' {
  if (route === 'office') return 'office';
  if (route === 'evidence') return 'PRs';
  if (route === 'settings' || SETTINGS_MENU_EXTRA.some((e) => e.route === route)) return 'Settings';
  if (BOARDS_MENU.some((e) => e.route === route)) return 'Boards';
  return 'Action items';
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
