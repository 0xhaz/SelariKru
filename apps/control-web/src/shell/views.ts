import { hrefFor, type Route } from './route.ts';

/**
 * Where each screen lives in the office layout (T5.12). The office canvas is the centre. Every other screen opens in a drawer over it,
 * chosen from the top bar, and Settings opens as one large panel with its own tabs. All of them are routes, so each can still be linked to.
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

/** The top bar's tabs. Mission Control's three screens sit together under its name; the labels are the ones every screen already had. */
export const NAV_GROUPS: readonly { readonly label: string | null; readonly items: readonly NavItem[] }[] = [
  { label: null, items: [{ label: 'Office', route: 'office' }] },
  { label: 'Mission Control', items: [{ label: 'Overview', route: 'overview' }, { label: 'Pipeline', route: 'pipeline' }, { label: 'Decisions', route: 'decisions' }] },
  {
    label: null,
    items: [
      { label: 'Team', route: 'team' }, { label: 'Evidence and PR', route: 'evidence' }, { label: 'Product', route: 'product' }, { label: 'Brain', route: 'brain' },
      { label: 'Benchmark', route: 'benchmark' }, { label: 'Assistant', route: 'assistant' }, { label: 'Settings', route: 'settings' }, { label: 'New project', route: 'onboarding' },
    ],
  },
];

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
