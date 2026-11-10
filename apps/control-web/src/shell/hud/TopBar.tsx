// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { TONE_TEXT, formatAge, formatClock, toneGlyph, type Tone } from '@selarikru/ui';
import { DemoBadge } from '../../data-source/DemoBadge.tsx';
import type { ConnectionState } from '../projection-store.ts';
import { hrefFor, type Route } from '../route.ts';
import { ui } from '../ui-store.ts';
import { TOP_BAR, topBarRouteOf, type NavItem } from '../views.ts';

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
  if (confirmedAt !== null) {
    if (connection === 'live') detail = `${formatAge(nowMs - Date.parse(confirmedAt))} ago`;
    else if (connection !== 'connecting') detail = `last confirmed ${formatClock(confirmedAt)}`;
  }
  return (
    <span data-testid="freshness" className="inline-flex items-baseline gap-x-1.5 whitespace-nowrap text-sm">
      <span className={`inline-flex items-center gap-1.5 font-semibold ${TONE_TEXT[c.tone]}`}>
        <span aria-hidden="true" className="text-glyph">{toneGlyph(c.tone)}</span>
        {c.label}
      </span>
      {/* Phone width keeps the word; the drawer's own banner gives the exact time when stale. */}
      {detail ? <span className="hidden text-muted sm:inline">{detail}</span> : null}
    </span>
  );
}

/** Our own mark: a pixel "S" on a navy tile. */
function Mark() {
  return (
    <svg className="h-[30px] w-[30px] shrink-0" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden="true">
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

/** Shown in the bar itself; the rest sit in the More menu so the bar stays one row. */
const DIRECT: ReadonlySet<Route> = new Set(['overview', 'team', 'evidence', 'settings']);

export interface TopBarProps {
  readonly route: Route;
  readonly projectLabel: string;
  readonly mode: 'mock' | 'live';
  readonly connection: ConnectionState;
  readonly confirmedAt: string | null;
  readonly nowMs: number;
  readonly account?: { readonly label: string; readonly onSignOut: () => void } | undefined;
  /** "2 need attention", or null when there is nothing to count. Shown on the Action items button. */
  readonly attentionCount: string | null;
  readonly attentionUrgent: boolean;
  /** The glyph and count on Mission Control at phone width, where Action items has no room. */
  readonly attentionBadge: string | null;
  readonly decisionCount: number;
  /** The folded team panel's toggle, below the floating layout's width. */
  readonly teamToggle: ReactNode;
  readonly teamFold: ReactNode;
  readonly panelWide: boolean;
}

function NavLink({ item, route, attentionBadge, attentionCount, decisionCount, onPick }: { item: NavItem; route: Route; attentionBadge: string | null; attentionCount: string | null; decisionCount: number; onPick?: () => void }) {
  const current = topBarRouteOf(route) === item.route;
  return (
    <a href={hrefFor(item.route)} aria-current={current ? 'page' : undefined} onClick={onPick} className="btn inline-flex items-baseline gap-1.5 text-sm">
      {item.label}
      {item.route === 'overview' && attentionBadge ? <span data-testid="attention-badge" aria-label={attentionCount ?? undefined} className="text-warning sm:hidden">{attentionBadge}</span> : null}
      {item.route === 'overview' && decisionCount > 0 ? <span data-testid="decisions-count" className="text-warning"><span className="sr-only">, </span>{decisionCount}<span className="sr-only"> decision{decisionCount === 1 ? '' : 's'} waiting</span></span> : null}
    </a>
  );
}

/** The More menu: a disclosure of links. Escape or choosing a link closes it, and focus goes back to its button. */
function More({ items, route, ...counts }: { items: readonly NavItem[]; route: Route; attentionBadge: string | null; attentionCount: string | null; decisionCount: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && open) { e.stopPropagation(); e.preventDefault(); setOpen(false); button.current?.focus(); }
  };
  const inside = items.some((i) => topBarRouteOf(route) === i.route);
  return (
    <div ref={box} className="relative" onKeyDown={onKey}>
      <button ref={button} type="button" className="btn text-sm" aria-expanded={open} aria-controls={id} data-testid="top-bar-more" onClick={() => setOpen((o) => !o)} style={inside ? { background: 'var(--color-yellow)' } : undefined}>
        More <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      <ul id={id} hidden={!open} className="panel absolute right-0 top-[calc(100%+8px)] z-50 m-0 flex w-max min-w-[11rem] list-none flex-col gap-2 p-2">
        {items.map((i) => <li key={i.route}><NavLink item={i} route={route} {...counts} onPick={() => setOpen(false)} /></li>)}
      </ul>
    </div>
  );
}

/**
 * The reference's top bar: one floating panel with the mark, the project, the Demo data label, the buttons that open each drawer, Action items,
 * zoom and freshness. Below the floating layout's width it sits at the top of the page and wraps.
 */
export const TopBar = forwardRef<HTMLElement, TopBarProps>(function TopBar(props, ref) {
  const { route, projectLabel, mode, connection, confirmedAt, nowMs, account, attentionCount, attentionUrgent, attentionBadge, decisionCount, teamToggle, teamFold, panelWide } = props;
  const counts = { attentionBadge, attentionCount, decisionCount };
  return (
    <header ref={ref} data-testid="top-bar" className="panel sticky top-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1 xl:fixed xl:left-4 xl:right-4 xl:top-[10px] xl:h-[50px] xl:flex-nowrap xl:py-0">
      <p className="flex min-w-0 flex-1 items-center gap-2.5 xl:flex-none">
        <Mark />
        {/* At phone width the project is what tells two tabs apart, so it keeps the room and the product name is read out instead. */}
        <b className="sr-only whitespace-nowrap text-[22px] font-bold tracking-[0.02em] sm:not-sr-only">SelariKru</b>
        <span className="min-w-0 truncate text-[16px] text-muted" data-testid="project-label"><span aria-hidden="true" className="hidden sm:inline">— </span><span className="sr-only">, project </span><em className="font-semibold not-italic text-fg">{projectLabel}</em></span>
      </p>
      <nav aria-label="Primary" className="order-3 flex w-full min-w-0 items-center gap-1.5 xl:order-2 xl:w-auto xl:flex-1 xl:justify-end">
        {/* Scrolls sideways when narrow; the More menu sits outside the scroller so its list is never clipped. */}
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto pt-0.5 pb-1 xl:overflow-visible xl:p-0">
          {TOP_BAR.filter((i) => DIRECT.has(i.route)).map((i) => <NavLink key={i.route} item={i} route={route} {...counts} />)}
        </div>
        <More items={TOP_BAR.filter((i) => !DIRECT.has(i.route))} route={route} {...counts} />
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-2 xl:order-3 xl:ml-0">
        {panelWide ? null : teamToggle}
        <DemoBadge mode={mode} />
        {attentionCount && panelWide ? (
          <a href={hrefFor('overview')} className="btn inline-flex items-baseline gap-1.5 text-sm" data-testid="action-items" style={attentionUrgent ? { background: 'var(--color-yellow)' } : undefined}>
            <span>Action items</span>
            <span data-testid="attention-count" className={attentionUrgent ? 'text-fg' : 'text-muted'}>{attentionCount}</span>
          </a>
        ) : null}
        <span className="hidden gap-1.5 sm:flex" role="group" aria-label="Zoom the office">
          <button type="button" className="btn w-8 px-0 text-[18px] leading-none" aria-label="Zoom out" onClick={() => ui.zoom(-1)}>−</button>
          <button type="button" className="btn w-8 px-0 text-[18px] leading-none" aria-label="Zoom in" onClick={() => ui.zoom(1)}>+</button>
        </span>
        {/* Setting up a first project has no live data to be fresh about. */}
        {route === 'onboarding' && connection === 'unavailable' ? null : <Freshness connection={connection} confirmedAt={confirmedAt} nowMs={nowMs} />}
        {account ? (
          <span className="flex items-center gap-2 text-sm">
            <span className="hidden max-w-[12rem] truncate font-mono text-mono text-muted 2xl:inline" title={account.label}>{account.label}</span>
            <button type="button" className="btn text-sm" onClick={account.onSignOut}>Sign out</button>
          </span>
        ) : null}
      </div>
      {panelWide ? null : <div className="order-4 w-full">{teamFold}</div>}
    </header>
  );
});
