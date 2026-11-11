// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { TONE_TEXT, formatAge, formatClock, toneGlyph, type Tone } from '@selarikru/ui';
import type { OfficeRunChoice } from '../../office/model.ts';
import type { ConnectionState } from '../projection-store.ts';
import { hashWith, hrefFor, type Route } from '../route.ts';
import { ui } from '../ui-store.ts';
import { ACTION_ITEMS_MENU, BOARDS_MENU, type MenuEntry } from '../views.ts';

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
    <span data-testid="freshness" className="inline-flex items-baseline gap-x-1.5 whitespace-nowrap text-[13px]">
      <span className={`inline-flex items-center gap-1 font-semibold ${TONE_TEXT[c.tone]}`}>
        <span aria-hidden="true" className="text-glyph">{toneGlyph(c.tone)}</span>
        {c.label}
      </span>
      {/* The exact time is in the drawer's own banner when stale; the bar keeps to the word where room is short. */}
      {detail ? <span className="hidden text-muted 2xl:inline">{detail}</span> : null}
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

/**
 * A top-bar menu: a disclosure of links. Escape or choosing a link closes it, and focus goes back to its button. The screen open now, when it
 * is in this menu, is named on the button and the button carries aria-current, so the current page is never only inside a closed menu.
 */
function Menu({ label, testId, entries, route, extra, urgent }: { label: string; testId: string; entries: readonly MenuEntry[]; route: Route; extra?: ReactNode; urgent?: boolean }) {
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
  const current = entries.find((e) => e.route === route) ?? null;
  return (
    <div ref={box} className="relative" data-more="" onKeyDown={onKey}>
      <button ref={button} type="button" className="btn text-[14px]" aria-expanded={open} aria-controls={id} aria-current={current ? 'page' : undefined} data-testid={testId}
        onClick={() => setOpen((o) => !o)} style={urgent ? { background: 'var(--color-yellow)' } : undefined}>
        {label}{extra}{current ? <span className="font-normal">: {current.label}</span> : null}
      </button>
      <ul id={id} hidden={!open} className="panel absolute right-0 top-[calc(100%+8px)] z-50 m-0 flex w-max min-w-[13rem] list-none flex-col gap-1.5 p-2">
        {entries.map((e, i) => (
          <li key={`${e.route}-${i}`} className="flex flex-col">
            {e.group && (i === 0 || entries[i - 1]!.group !== e.group) ? <span aria-hidden="true" className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{e.group}</span> : null}
            <a href={hrefFor(e.route)} aria-current={e.route === route ? 'page' : undefined} onClick={() => setOpen(false)} className="btn text-left text-[14px]">
              {e.group ? <span className="sr-only">{e.group}: </span> : null}{e.label}{e.badge}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Terminal: opens the Terminal tab of the selected worker, or lets you pick one. */
function TerminalMenu({ workers, selectedId }: { workers: readonly { id: string; name: string }[]; selectedId: string | null }) {
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
  const go = (workerId: string): string => hashWith('wtab', 'terminal', hashWith('worker', workerId));
  if (selectedId !== null) return <a href={go(selectedId)} className="btn text-[14px]" data-testid="top-bar-terminal">Terminal</a>;
  return (
    <div ref={box} className="relative" onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); e.preventDefault(); setOpen(false); button.current?.focus(); } }}>
      <button ref={button} type="button" className="btn text-[14px]" aria-expanded={open} aria-controls={id} data-testid="top-bar-terminal" onClick={() => setOpen((o) => !o)}>Terminal</button>
      <ul id={id} hidden={!open} className="panel absolute right-0 top-[calc(100%+8px)] z-50 m-0 flex w-max min-w-[12rem] list-none flex-col gap-1.5 p-2">
        {workers.length === 0 ? <li className="px-1 text-[13px] text-muted">No worker has a terminal yet.</li> : workers.map((w) => (
          <li key={w.id}><a href={go(w.id)} onClick={() => setOpen(false)} className="btn block text-left text-[14px]">{w.name}<span className="sr-only"> terminal</span></a></li>
        ))}
      </ul>
    </div>
  );
}

export interface TopBarProps {
  readonly route: Route;
  readonly projectLabel: string;
  readonly mode: 'mock' | 'live';
  readonly connection: ConnectionState;
  readonly confirmedAt: string | null;
  readonly nowMs: number;
  readonly account?: { readonly label: string; readonly onSignOut: () => void } | undefined;
  /** "2 need attention", or null when there is nothing to count. */
  readonly attentionCount: string | null;
  readonly attentionNumber: number | null;
  readonly attentionUrgent: boolean;
  /** The glyph and count on Action items at phone width. */
  readonly attentionBadge: string | null;
  readonly decisionCount: number;
  readonly runs: readonly OfficeRunChoice[];
  readonly planRunId: string | null;
  readonly onPlanRun: (runId: string | null) => void;
  /** Demo only: the office animation speed. */
  readonly speed: number;
  readonly onSpeed: (speed: number) => void;
  readonly running: number | null;
  readonly workers: readonly { id: string; name: string }[];
  readonly selectedWorker: string | null;
  readonly debugOpen: boolean;
  readonly onDebug: (() => void) | null;
  readonly teamToggle: ReactNode;
  readonly teamFold: ReactNode;
  readonly panelWide: boolean;
}

const SPEEDS = [1, 2, 4] as const;

/**
 * The reference's top bar: the mark and name, the Demo data chip, the project, the plan wall's run, the demo speed, zoom, the sandbox count, and
 * the main menus (Action items, Boards, PRs, Terminal, Settings, Debug in development). Below the floating layout's width it sits at the top of
 * the page and wraps.
 */
export const TopBar = forwardRef<HTMLElement, TopBarProps>(function TopBar(props, ref) {
  const { route, projectLabel, mode, connection, confirmedAt, nowMs, account, attentionCount, attentionNumber, attentionUrgent, attentionBadge, decisionCount, runs, planRunId, onPlanRun, speed, onSpeed, running, workers, selectedWorker, debugOpen, onDebug, teamToggle, teamFold, panelWide } = props;
  // The narrow nav scrolls sideways: the current page must be in view, or the operator cannot tell where they are.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [route]);
  const decisionsBadge = decisionCount > 0 ? <span data-testid="decisions-count" className="ml-1.5 text-warning"><span className="sr-only">, </span>{decisionCount}<span className="sr-only"> waiting</span></span> : null;
  const actionEntries = ACTION_ITEMS_MENU.map((e) => (e.route === 'decisions' ? { ...e, badge: decisionsBadge } : e));
  return (
    <header ref={ref} data-testid="top-bar" className="panel sticky top-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1 xl:fixed xl:left-4 xl:right-4 xl:top-[10px] xl:h-[50px] xl:flex-nowrap xl:gap-x-2.5 xl:py-0">
      <p className="flex min-w-0 flex-1 items-center gap-2 xl:flex-none">
        <Mark />
        {/* At phone width the project is what tells two tabs apart, so it keeps the room and the product name is read out instead. */}
        <b className="sr-only whitespace-nowrap text-[22px] font-bold tracking-[0.02em] sm:not-sr-only">SelariKru</b>
        <span className="contents" data-testid="top-bar-demo-chip">{mode === 'mock' ? <span role="status" data-testid="demo-badge" className="chip shrink-0 text-[12px]" style={{ background: '#ffec27' }}>Demo data</span> : null}</span>
        <span className="min-w-0 truncate text-[15px] text-muted xl:max-w-[11rem]" data-testid="project-label"><span aria-hidden="true" className="hidden sm:inline">— </span><span className="sr-only">, project </span><em className="font-semibold not-italic text-fg">{projectLabel}</em></span>
      </p>
      {runs.length > 0 ? (
        <label className="hidden items-center gap-2 text-[14px] 2xl:flex">
          <span className="text-muted">Plan wall</span>
          <select className="field w-[11rem] py-0 text-[14px]" value={planRunId ?? ''} onChange={(e) => onPlanRun(e.target.value || null)} aria-label="Run shown on the plan wall">
            <option value="">Current run</option>
            {runs.map((r) => <option key={r.runId} value={r.runId}>{r.label}</option>)}
          </select>
        </label>
      ) : null}
      {mode === 'mock' ? (
        <span className="hidden gap-1.5 lg:flex" role="group" aria-label="Office animation speed (demo)" title="Demo only: how fast the office animates. It does not change any data.">
          {SPEEDS.map((x) => <button key={x} type="button" className="btn px-2 text-[14px]" aria-pressed={speed === x} onClick={() => onSpeed(x)}>{x}x</button>)}
        </span>
      ) : null}
      <span className="hidden gap-1.5 sm:flex" role="group" aria-label="Zoom the office">
        <button type="button" className="btn w-8 px-0 text-[18px] leading-none" aria-label="Zoom out" onClick={() => ui.zoom(-1)}>−</button>
        <button type="button" className="btn w-8 px-0 text-[18px] leading-none" aria-label="Zoom in" onClick={() => ui.zoom(1)}>+</button>
      </span>
      {running !== null ? (
        <span data-testid="sandbox-chip" className="hidden items-center gap-2 whitespace-nowrap border-[3px] border-ink bg-navy px-2.5 py-0.5 text-[15px] text-cream lg:flex" title="Each worker runs in its own sandbox">
          <span>Sandbox · <b>{running}</b> running</span>
          <i aria-hidden="true" className="led" data-off={running === 0 ? '' : undefined} />
        </span>
      ) : null}
      <nav ref={navRef} aria-label="Primary" className="order-3 flex w-full min-w-0 items-center gap-1.5 overflow-x-auto pt-0.5 pb-1 xl:order-none xl:w-auto xl:flex-1 xl:justify-end xl:overflow-visible xl:p-0">
        <Menu label="Action items" testId="action-items" entries={actionEntries} route={route} urgent={attentionUrgent}
          extra={<>
            {attentionNumber !== null && attentionNumber > 0 ? <span aria-hidden="true" className="hidden sm:inline"> · {attentionNumber}</span> : null}
            {attentionBadge ? <span data-testid="attention-badge" aria-label={attentionCount ?? undefined} className="ml-1 text-warning sm:hidden">{attentionBadge}</span> : null}
            {attentionCount && panelWide ? <span data-testid="attention-count" className="sr-only">{attentionCount}</span> : null}
          </>} />
        <Menu label="Boards" testId="top-bar-boards" entries={BOARDS_MENU} route={route} />
        <a href={hrefFor('evidence')} aria-current={route === 'evidence' ? 'page' : undefined} className="btn text-[14px]">PRs</a>
        <TerminalMenu workers={workers} selectedId={selectedWorker} />
        <a href={hrefFor('settings')} aria-current={route === 'settings' || route === 'assistant' || route === 'onboarding' ? 'page' : undefined} className="btn text-[14px]">Settings</a>
        {onDebug ? <button type="button" className="btn text-[14px]" aria-pressed={debugOpen} onClick={onDebug} title="Development only">Debug</button> : null}
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-2 xl:ml-0">
        {panelWide ? null : teamToggle}
        {/* Setting up a first project has no live data to be fresh about. */}
        {route === 'onboarding' && connection === 'unavailable' ? null : <Freshness connection={connection} confirmedAt={confirmedAt} nowMs={nowMs} />}
        {account ? <button type="button" className="btn text-[14px]" onClick={account.onSignOut} title={account.label}>Sign out</button> : null}
      </div>
      {panelWide ? null : <div className="order-4 w-full">{teamFold}</div>}
    </header>
  );
});
