// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { forwardRef, useEffect, useRef, type ReactNode } from 'react';
import { TONE_TEXT, buttonQuiet, formatAge, formatClock, toneGlyph, type Tone } from '@selarikru/ui';
import { DemoBadge } from '../../data-source/DemoBadge.tsx';
import type { ConnectionState } from '../projection-store.ts';
import { hrefFor, type Route } from '../route.ts';
import { ui } from '../ui-store.ts';
import { NAV_GROUPS } from '../views.ts';

export const CONNECTION: Readonly<Record<ConnectionState, { label: string; tone: Tone }>> = {
  connecting: { label: 'Connecting', tone: 'neutral' },
  live: { label: 'Live', tone: 'success' },
  reconnecting: { label: 'Reconnecting', tone: 'warning' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
  dead: { label: 'Stream stopped', tone: 'danger' },
};

function Freshness({ connection, confirmedAt, nowMs }: { connection: ConnectionState; confirmedAt: string | null; nowMs: number }) {
  const c = CONNECTION[connection];
  let detail: string | null = null;
  // The narrow header keeps a short age; when stale, the banner in the page carries the exact time.
  let compact: string | null = null;
  if (confirmedAt !== null) {
    if (connection === 'live') {
      detail = `updated ${formatAge(nowMs - Date.parse(confirmedAt))} ago`;
      compact = `${formatAge(nowMs - Date.parse(confirmedAt))} ago`;
    }
    else if (connection !== 'connecting') detail = `last confirmed ${formatClock(confirmedAt)}`;
  }
  return (
    <span data-testid="freshness" className="inline-flex flex-wrap items-baseline gap-x-1.5 text-sm">
      <span className={`inline-flex items-center gap-1.5 font-medium ${TONE_TEXT[c.tone]}`}>
        <span aria-hidden="true" className="text-glyph">{toneGlyph(c.tone)}</span>
        {c.label}
      </span>
      {detail ? <span className="hidden text-muted sm:inline">{detail}</span> : null}
      {compact ? <span className="text-muted sm:hidden">{compact}</span> : null}
    </span>
  );
}

/** Our own mark: a pixel "S" on a navy tile. */
function Mark() {
  return (
    <svg className="h-[26px] w-[26px] shrink-0" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="0" y="0" width="10" height="10" fill="#241a2e" />
      <rect x="1" y="1" width="8" height="8" fill="#1d2b53" />
      <rect x="3" y="2" width="5" height="1" fill="#ffec27" />
      <rect x="2" y="3" width="2" height="1" fill="#ffec27" />
      <rect x="3" y="4" width="4" height="1" fill="#ffec27" />
      <rect x="6" y="5" width="2" height="1" fill="#ffec27" />
      <rect x="2" y="6" width="5" height="1" fill="#ffec27" />
      <rect x="1" y="8" width="8" height="1" fill="#29adff" />
    </svg>
  );
}

export interface TopBarProps {
  readonly route: Route;
  readonly projectLabel: string;
  readonly mode: 'mock' | 'live';
  readonly connection: ConnectionState;
  readonly confirmedAt: string | null;
  readonly nowMs: number;
  readonly theme: 'dark' | 'light';
  readonly onToggleTheme: () => void;
  readonly account?: { readonly label: string; readonly onSignOut: () => void } | undefined;
  /** "2 need attention", or null when there is nothing to count. Shown as the Action items entry. */
  readonly attentionCount: string | null;
  readonly attentionUrgent: boolean;
  /** The glyph and count beside Overview at phone width. */
  readonly attentionBadge: string | null;
  readonly decisionCount: number;
  /** The folded team panel's toggle, below the side panel's width. */
  readonly teamToggle: ReactNode;
  /** The folded team panel's region, under the header's rows. */
  readonly teamFold: ReactNode;
  readonly panelWide: boolean;
}

/** The top bar: identity, the Demo data label, every screen as a tab, the action items, zoom, theme and the data's freshness. */
export const TopBar = forwardRef<HTMLElement, TopBarProps>(function TopBar(props, ref) {
  const { route, projectLabel, mode, connection, confirmedAt, nowMs, theme, onToggleTheme, account, attentionCount, attentionUrgent, attentionBadge, decisionCount, teamToggle, teamFold, panelWide } = props;
  // The tab list scrolls on narrow screens: the current page must be in view, or the operator cannot tell where they are.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [route]);
  return (
    <header ref={ref} data-testid="top-bar" className="sticky top-0 z-40 border-b-[3px] border-edge bg-panel shadow-[0_4px_0_var(--pixel-drop)]">
      <div className="mx-auto flex max-w-[1600px] items-center gap-x-3 px-4 pt-2 sm:gap-x-4 sm:px-6">
        <p className="flex min-w-0 flex-1 items-center gap-2">
          <Mark />
          {/* At phone width the project is what tells two tabs apart, so it keeps the room and the product name is read out instead. */}
          <span className="sr-only text-lg font-bold tracking-tight text-fg sm:not-sr-only">SelariKru</span>
          <span aria-hidden="true" className="hidden text-muted sm:inline">/</span>
          <span className="truncate text-sm font-semibold text-fg sm:font-normal sm:text-muted" data-testid="project-label"><span className="sr-only">, project </span>{projectLabel}</span>
        </p>
        <div className="ml-auto flex shrink-0 items-center justify-end gap-x-2 sm:gap-x-3">
          {panelWide ? null : teamToggle}
          <DemoBadge mode={mode} />
          {/* Below the side panel's width the Team toggle carries the count beside this, so this one waits for the room. */}
          {attentionCount && panelWide ? (
            <a href={hrefFor('overview')} className="btn hidden sm:inline-flex" data-testid="action-items" style={attentionUrgent ? { background: 'var(--color-warning-tint)' } : undefined}>
              <span>Action items</span>
              <span data-testid="attention-count" className={attentionUrgent ? 'text-warning' : 'text-muted'}>{attentionCount}</span>
            </a>
          ) : null}
          {route === 'office' ? (
            <span className="hidden gap-1.5 sm:flex" role="group" aria-label="Zoom the office">
              <button type="button" className="btn w-8 px-0 text-lg leading-none" aria-label="Zoom out" onClick={() => ui.zoom(-1)}>−</button>
              <button type="button" className="btn w-8 px-0 text-lg leading-none" aria-label="Zoom in" onClick={() => ui.zoom(1)}>+</button>
            </span>
          ) : null}
          <button type="button" aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} className="btn" onClick={onToggleTheme}>
            <span aria-hidden="true" className="sm:hidden">◐</span>
            <span className="hidden sm:inline">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
          </button>
          {account ? (
            <span className="flex items-center gap-2 text-sm">
              <span className="hidden max-w-[16rem] truncate font-mono text-mono text-muted lg:inline" title={account.label}>{account.label}</span>
              <button type="button" className={buttonQuiet} onClick={account.onSignOut}>Sign out</button>
            </span>
          ) : null}
        </div>
      </div>
      <div className="mx-auto flex max-w-[1600px] items-center gap-2 pr-4 sm:pr-6">
        <nav ref={navRef} aria-label="Primary" className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto px-1 pt-1.5 pb-1 sm:px-5">
          {NAV_GROUPS.map((group, gi) => (
            <span key={gi} className={`flex shrink-0 items-end gap-1 ${gi > 0 ? 'ml-1 border-l-2 border-line pl-2' : ''}`}>
              {group.label ? <span aria-hidden="true" className="hidden self-center pr-1 text-xs font-semibold uppercase tracking-[0.1em] text-muted xl:inline">{group.label}</span> : null}
              {group.items.map((item) => (
                <a
                  key={item.route}
                  href={hrefFor(item.route)}
                  aria-current={route === item.route ? 'page' : undefined}
                  className={`inline-flex items-baseline gap-1.5 whitespace-nowrap border-2 px-2.5 py-1 text-sm font-semibold ${route === item.route ? 'border-edge bg-active-tint text-fg' : 'border-transparent text-muted hover:border-line hover:text-fg'}`}
                >
                  {item.label}
                  {item.route === 'overview' && attentionBadge ? <span data-testid="attention-badge" aria-label={attentionCount ?? undefined} className="text-warning sm:hidden">{attentionBadge}</span> : null}
                  {item.route === 'decisions' && decisionCount > 0 ? <span data-testid="decisions-count" className="text-warning"><span className="sr-only">, </span>{decisionCount}<span className="sr-only"> waiting</span></span> : null}
                </a>
              ))}
            </span>
          ))}
        </nav>
        <div className="shrink-0">
          {/* Setting up a first project has no live data to be fresh about. */}
          {route === 'onboarding' && connection === 'unavailable' ? null : <Freshness connection={connection} confirmedAt={confirmedAt} nowMs={nowMs} />}
        </div>
      </div>
      {panelWide ? null : teamFold}
    </header>
  );
});
