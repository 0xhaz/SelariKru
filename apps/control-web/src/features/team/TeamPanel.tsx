// Card column adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import type { KeyboardEvent, ReactNode } from 'react';
import { TONE_TEXT, formatClock, type Tone } from '@selarikru/ui';
import type { PresenceState } from './model.ts';
import { unknownText, type PanelRow, type TeamPanelModel } from './panel.ts';
import { chipStyle, stateStyle, type RobotState } from '../../theme/tokens.ts';

const RAIL: Readonly<Partial<Record<Tone, string>>> = { warning: 'before:bg-warning', danger: 'before:bg-danger' };

export type PanelStatus =
  | { readonly kind: 'ready'; readonly panel: TeamPanelModel; readonly stale: boolean; readonly confirmedAt: string | null }
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' };

function since(row: PanelRow): string {
  return row.state === 'lost' || row.state === 'unknown' ? row.since : `for ${row.since}`;
}

/** Each card's chip names the state in words on its own colour, so no two read alike in colour, in grayscale or to a screen reader. */
const CHIP_OF: Readonly<Record<PresenceState, RobotState>> = { idle: 'idle', working: 'working', needs_you: 'needs_input', blocked: 'blocked', lost: 'offline', unknown: 'unknown' };

/** The reference's agent card: portrait, name, role and model, number key, a coloured state chip with its word, time in state, and the task. */
function WorkerRow({ row, selected, onOpen, decor }: { row: PanelRow; selected: boolean; onOpen: (id: string) => void; decor: RowDecor | null }) {
  const rail = RAIL[row.tone] ?? 'before:bg-transparent';
  const chip = decor?.chip ?? CHIP_OF[row.state];
  const style = chipStyle[chip];
  const needs = row.state === 'needs_you';
  const waiting = needs || row.state === 'blocked';
  return (
    <li>
      <button
        type="button"
        data-testid="team-panel-row"
        data-panel-worker={row.workerId}
        data-state={row.state}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onOpen(row.workerId)}
        className={`panel relative grid w-full grid-cols-[40px_minmax(0,1fr)] gap-x-2.5 gap-y-1 overflow-hidden px-2.5 pt-2 pb-2.5 text-left motion-safe:transition-transform before:absolute before:inset-y-0 before:left-0 before:w-[3px] hover:-translate-x-px hover:-translate-y-px ${rail} ${needs ? 'outline-[3px] outline-red outline-solid' : ''} ${selected ? 'bg-[#fff]' : ''}`}
      >
        {selected ? <span aria-hidden="true" className="absolute -left-0 top-4 text-[12px]">▶</span> : null}
        <span aria-hidden="true" className="row-span-2 self-start">{decor?.portrait ?? null}</span>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <b className="shrink-0 text-[17px] text-fg">{row.role}</b>
          <span className="min-w-0 flex-1 truncate font-mono text-mono text-muted" data-testid="team-panel-model"><span className="sr-only">Recorded model: </span>{row.model}</span>
          {decor?.key ? <kbd aria-hidden="true" className="kbd shrink-0 px-1 text-[13px]">{decor.key}</kbd> : null}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5" data-testid="team-panel-state">
          <span className="chip chip-dot" style={{ background: style.bg, color: style.fg }}>{stateStyle[chip].label}</span>
          <span className="font-mono text-mono text-muted tabular-nums" data-testid="team-panel-since">{since(row)}</span>
          {needs ? <span className="chip text-[11px]" style={{ background: '#ffec27', color: '#241a2e' }}>1 for you</span> : null}
        </span>
        {/* Why it waits, in brief: a decision, a block or a dependency. The full text is in its drawer. */}
        {waiting && row.detail ? <span className={`col-span-2 block truncate text-[13px] ${needs ? 'text-danger' : 'text-warning'}`} data-testid="team-panel-reason" title={row.detail}><span className="sr-only">Why: </span>{row.detail}</span> : null}
        <span className={`col-span-2 block truncate text-[13px] ${row.task === 'No task' ? 'text-muted' : 'text-fg'}`} data-testid="team-panel-task"><span className="sr-only">Task: </span>{row.task}</span>
      </button>
    </li>
  );
}

/** Decoration for a card: the office robot, the number key that opens it, and its robot state when the office knows it. */
export interface RowDecor {
  readonly portrait: ReactNode;
  readonly key: string | null;
  readonly chip: RobotState | null;
}

/** The card decoration for each worker. */
export type RowMark = (workerId: string, index: number) => RowDecor;

function Rows({ status, selectedId, onOpen, grid, mark }: { status: PanelStatus; selectedId: string | null; onOpen: (id: string) => void; grid: boolean; mark?: RowMark | undefined }) {
  if (status.kind === 'loading') return <p className="px-1 py-2 text-sm text-muted">Loading workers</p>;
  if (status.kind === 'unavailable') return <p className="px-1 py-2 text-sm text-muted">No project data is connected, so no worker is shown.</p>;
  if (status.panel.rows.length === 0) return <p className="px-1 py-2 text-sm text-muted">No workers yet. They appear once a plan is accepted and a task starts.</p>;
  return (
    <>
      {status.stale ? <p className="panel mb-2 px-2 py-1 text-sm text-muted" data-testid="team-panel-stale">The connection is not live, so states are the last confirmed and shown as unknown.</p> : null}
      <ul className={grid ? 'grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-2.5'}>
        {status.panel.rows.map((r, i) => <WorkerRow key={r.workerId} row={r} selected={r.workerId === selectedId} onOpen={onOpen} decor={mark ? mark(r.workerId, i) : null} />)}
      </ul>
    </>
  );
}

const confirmedClock = (status: Extract<PanelStatus, { kind: 'ready' }>): string => (status.confirmedAt ? ` at ${formatClock(status.confirmedAt)}` : '');

/** The "needs you" count, or, while the session is stale, that it is unknown and what it was when last confirmed. A stale zero is never shown as nobody. */
function NeedsYou({ status, testId }: { status: Extract<PanelStatus, { kind: 'ready' }>; testId: string }) {
  const { needsYou, confirmedNeedsYou, unknown, unknownLastNeedsYou } = status.panel;
  if (needsYou === null) {
    const at = status.confirmedAt ? ` at ${formatClock(status.confirmedAt)}` : '';
    return (
      <span data-testid={testId} data-unknown="">
        <span aria-hidden="true" className="text-muted">Needs you: unknown ({confirmedNeedsYou}{at})</span>
        <span className="sr-only">Who needs you is unknown while the connection is not live; {confirmedNeedsYou} needed you when last confirmed{at}.</span>
      </span>
    );
  }
  const text = unknownText(unknown, unknownLastNeedsYou);
  if (needsYou > 0) {
    return <span data-testid={testId}><span className="font-semibold text-warning"><span aria-hidden="true">▲ </span>{needsYou} need{needsYou === 1 ? 's' : ''} you</span>{unknown > 0 ? <span className="text-muted" data-testid="team-unknown"><span aria-hidden="true"> · </span><span className="sr-only">; </span>{text}</span> : null}</span>;
  }
  // Never "nobody needs you" while a row is unknown: that row could be the one that does.
  return unknown > 0
    ? <span data-testid={testId}><span className="text-muted" data-testid="team-unknown">{text}</span></span>
    : <span data-testid={testId}><span className="text-muted">nobody needs you</span></span>;
}

function Count({ status, testId = 'team-needs-you' }: { status: PanelStatus; testId?: string }) {
  if (status.kind !== 'ready') return <span className="text-muted">{status.kind === 'loading' ? 'loading' : 'unavailable'}</span>;
  const n = status.panel.rows.length;
  return (
    <>
      <span className="text-muted">{n} worker{n === 1 ? '' : 's'}</span>
      <span aria-hidden="true" className="text-muted"> · </span>
      <span className="sr-only">, </span>
      <NeedsYou status={status} testId={testId} />
    </>
  );
}

/** The roster beside every page at wide widths. Selecting a worker opens its drawer over the page; nothing navigates. */
export function TeamPanelSide({ status, selectedId, onOpen, mark }: { status: PanelStatus; selectedId: string | null; onOpen: (id: string) => void; mark?: RowMark | undefined }) {
  return (
    <aside aria-labelledby="team-panel-title" data-testid="team-panel" data-variant="side" className="fixed bottom-[250px] left-4 top-[74px] z-10 flex w-[280px] flex-col gap-2">
      {/* The reference's "TEAM · N" header. On navy, not straight on the lawn, so its text meets AA. */}
      <div className="panel-dark flex items-center justify-between gap-2 px-2.5 py-1">
        {/* A label, not a heading: the panel comes before the page's own h1, and the landmark already carries the name. */}
        <p className="min-w-0 text-[13px] font-semibold uppercase tracking-[0.12em] text-cream">
          <span id="team-panel-title">Team</span><span aria-hidden="true"> · </span><span className="sr-only">: </span>
          <span data-testid="team-panel-summary" className="[&_.text-muted]:text-[#b9c3e6] [&_.text-warning]:text-yellow"><Count status={status} /></span>
        </p>
        <a href="#/settings" className="btn shrink-0 px-2 text-[12px] normal-case tracking-normal">Team settings</a>
      </div>
      <div className="scroll-thin -ml-4 flex min-h-0 flex-col overflow-y-auto pt-1 pr-1 pb-2 pl-4">
        {status.kind === 'ready' && status.panel.rows.length > 0 ? null : <div className="panel px-2.5 py-1"><Rows status={status} selectedId={selectedId} onOpen={onOpen} grid={false} mark={mark} /></div>}
        {status.kind === 'ready' && status.panel.rows.length > 0 ? <Rows status={status} selectedId={selectedId} onOpen={onOpen} grid={false} mark={mark} /> : null}
      </div>
    </aside>
  );
}

export interface FoldProps {
  readonly status: PanelStatus;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly regionId: string;
}

/**
 * The folded panel's toggle, in the header's top row so the header keeps its two rows. It keeps the "needs you" count in view while folded: in words where there is room,
 * as the glyph and number at phone width, with the words still read out.
 */
export function TeamFoldToggle({ status, open, onOpenChange, regionId }: FoldProps) {
  const ready = status.kind === 'ready' ? status : null;
  const needsYou = ready ? ready.panel.needsYou : null;
  const workers = ready ? ready.panel.rows.length : null;
  const unknown = ready ? ready.panel.unknown : 0;
  const unknownBit = unknown > 0 && ready
    ? <span data-testid="team-toggle-unknown" className="text-muted font-normal"><span aria-hidden="true"> ? {unknown}</span><span className="sr-only">; {unknownText(unknown, ready.panel.unknownLastNeedsYou)}</span></span>
    : null;
  const onKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      onOpenChange(false);
    }
  };
  let count;
  if (!ready) {
    // No team yet, or none to be had: say which, never a zero. Loading or unavailable is not nobody.
    const word = status.kind === 'loading' ? 'loading' : 'unavailable';
    count = <span data-testid="team-needs-you" data-status={status.kind} className="text-muted"><span aria-hidden="true" className="sm:hidden">?</span><span className="sr-only sm:not-sr-only">{word}</span></span>;
  } else if (needsYou === null) {
    count = <span data-testid="team-needs-you" data-unknown="" className="text-muted"><span aria-hidden="true">? </span><span className="sr-only sm:not-sr-only">needs you unknown</span><span className="sr-only">; {ready.panel.confirmedNeedsYou} when last confirmed{confirmedClock(ready)}</span></span>;
  } else if (needsYou !== null && needsYou > 0) {
    count = <span data-testid="team-needs-you" className="font-semibold text-warning"><span aria-hidden="true">▲ </span>{needsYou}<span className="sr-only sm:not-sr-only"> need{needsYou === 1 ? 's' : ''} you</span>{unknownBit}</span>;
  } else if (unknown > 0) {
    // Zero confirmed is not nobody while a row is unknown: the glyph and number at phone width, the words from sm up.
    count = <span data-testid="team-needs-you" data-has-unknown="" className="text-muted"><span aria-hidden="true" className="sm:hidden">? {unknown}</span><span className="sr-only sm:not-sr-only">{unknownText(unknown, ready.panel.unknownLastNeedsYou)}</span></span>;
  } else {
    count = <span data-testid="team-needs-you" className="text-muted"><span className="sr-only sm:not-sr-only">nobody needs you</span><span aria-hidden="true" className="sm:hidden">0</span></span>;
  }
  return (
    <button
      type="button"
      data-team-toggle=""
      data-testid="team-panel-toggle"
      aria-expanded={open}
      aria-controls={regionId}
      onClick={() => onOpenChange(!open)}
      onKeyDown={onKey}
      className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-chip border px-2 py-1 text-sm hover:border-active ${needsYou !== null && needsYou > 0 ? 'border-warning' : 'border-line-strong'}`}
    >
      <span className="font-semibold text-fg">Team</span>
      {workers !== null ? <span className="hidden text-muted lg:inline">{workers} worker{workers === 1 ? '' : 's'}<span aria-hidden="true"> ·</span><span className="sr-only">,</span></span> : null}
      {count}
      <span aria-hidden="true" className="hidden text-muted sm:inline">{open ? '▴' : '▾'}</span>
    </button>
  );
}

/** The roster the toggle unfolds, under the header's rows. Escape or choosing a worker folds it again. */
export function TeamFoldRegion({ status, open, onOpenChange, regionId, selectedId, onOpen, mark }: FoldProps & { selectedId: string | null; onOpen: (id: string) => void; mark?: RowMark | undefined }) {
  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onOpenChange(false);
    document.querySelector<HTMLElement>('[data-team-toggle]')?.focus();
  };
  return (
    <section id={regionId} aria-label="Team" data-testid="team-panel" data-variant="fold" hidden={!open} onKeyDown={onKey} className="max-h-[60dvh] overflow-y-auto border-t-[3px] border-ink bg-cream-2">
      <div className="mx-auto max-w-[1600px] px-4 py-3 sm:px-6">
        <p className="mb-2 px-1 text-sm" data-testid="team-panel-summary"><Count status={status} testId="team-fold-needs-you" /></p>
        <Rows status={status} selectedId={selectedId} onOpen={(id) => { onOpenChange(false); onOpen(id); }} grid mark={mark} />
      </div>
    </section>
  );
}
