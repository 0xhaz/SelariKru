import type { KeyboardEvent } from 'react';
import { TONE_TEXT, formatClock, type Tone } from '@selarikru/ui';
import type { PresenceState } from './model.ts';
import type { PanelRow, TeamPanelModel } from './panel.ts';

/** Each state has its own glyph as well as its word, so no two read alike in color, in grayscale or to a screen reader. */
const GLYPH: Readonly<Record<PresenceState, string>> = { idle: '○', working: '◆', needs_you: '▲', blocked: '‖', lost: '✕', unknown: '?' };
const RAIL: Readonly<Partial<Record<Tone, string>>> = { warning: 'before:bg-warning', danger: 'before:bg-danger' };

export type PanelStatus =
  | { readonly kind: 'ready'; readonly panel: TeamPanelModel; readonly stale: boolean; readonly confirmedAt: string | null }
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' };

function since(row: PanelRow): string {
  return row.state === 'lost' || row.state === 'unknown' ? row.since : `for ${row.since}`;
}

function WorkerRow({ row, selected, onOpen }: { row: PanelRow; selected: boolean; onOpen: (id: string) => void }) {
  const rail = RAIL[row.tone] ?? 'before:bg-transparent';
  return (
    <li>
      <button
        type="button"
        data-testid="team-panel-row"
        data-panel-worker={row.workerId}
        data-state={row.state}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onOpen(row.workerId)}
        className={`relative block w-full overflow-hidden rounded-chip border bg-panel-2 py-2 pr-2.5 pl-3.5 text-left before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${rail} ${selected ? 'border-active' : 'border-line hover:border-line-strong'}`}
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate font-semibold text-fg">{row.role}</span>
          <span className="shrink-0 text-sm text-muted tabular-nums" data-testid="team-panel-since">{since(row)}</span>
        </span>
        <span className={`mt-0.5 flex items-center gap-1.5 text-sm font-medium ${TONE_TEXT[row.tone]}`} data-testid="team-panel-state">
          <span aria-hidden="true" className="w-3 shrink-0 text-center">{GLYPH[row.state]}</span>
          <span className="shrink-0 whitespace-nowrap">{row.label}</span>
          {row.detail ? <span className="min-w-0 truncate font-normal text-muted"><span aria-hidden="true">· </span><span className="sr-only">, </span>{row.detail}</span> : null}
        </span>
        <span className="mt-1 block truncate text-sm text-fg" data-testid="team-panel-task"><span className="sr-only">Task: </span>{row.task}</span>
        <span className="block truncate font-mono text-mono text-muted" data-testid="team-panel-model"><span className="sr-only">Recorded model: </span>{row.model}</span>
      </button>
    </li>
  );
}

function Rows({ status, selectedId, onOpen, grid }: { status: PanelStatus; selectedId: string | null; onOpen: (id: string) => void; grid: boolean }) {
  if (status.kind === 'loading') return <p className="px-1 py-2 text-sm text-muted">Loading workers</p>;
  if (status.kind === 'unavailable') return <p className="px-1 py-2 text-sm text-muted">No project data is connected, so no worker is shown.</p>;
  if (status.panel.rows.length === 0) return <p className="px-1 py-2 text-sm text-muted">No workers yet. They appear once a plan is accepted and a task starts.</p>;
  return (
    <>
      {status.stale ? <p className="mb-2 px-1 text-sm text-muted" data-testid="team-panel-stale">The connection is not live, so states are the last confirmed and shown as unknown.</p> : null}
      <ul className={grid ? 'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-2'}>
        {status.panel.rows.map((r) => <WorkerRow key={r.workerId} row={r} selected={r.workerId === selectedId} onOpen={onOpen} />)}
      </ul>
    </>
  );
}

const confirmedClock = (status: Extract<PanelStatus, { kind: 'ready' }>): string => (status.confirmedAt ? ` at ${formatClock(status.confirmedAt)}` : '');

/** The "needs you" count, or, while the session is stale, that it is unknown and what it was when last confirmed. A stale zero is never shown as nobody. */
function NeedsYou({ status, testId }: { status: Extract<PanelStatus, { kind: 'ready' }>; testId: string }) {
  const { needsYou, confirmedNeedsYou, unknown } = status.panel;
  if (needsYou === null) {
    const at = status.confirmedAt ? ` at ${formatClock(status.confirmedAt)}` : '';
    return (
      <span data-testid={testId} data-unknown="">
        <span aria-hidden="true" className="text-muted">Needs you: unknown ({confirmedNeedsYou}{at})</span>
        <span className="sr-only">Who needs you is unknown while the connection is not live; {confirmedNeedsYou} needed you when last confirmed{at}.</span>
      </span>
    );
  }
  const others = unknown > 0 ? <span className="text-muted" data-testid="team-unknown"><span aria-hidden="true"> · </span><span className="sr-only">; </span>{unknown} unknown</span> : null;
  return needsYou > 0
    ? <span data-testid={testId}><span className="font-semibold text-warning"><span aria-hidden="true">▲ </span>{needsYou} need{needsYou === 1 ? 's' : ''} you</span>{others}</span>
    : <span data-testid={testId}><span className="text-muted">nobody needs you</span>{others}</span>;
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
export function TeamPanelSide({ status, selectedId, onOpen }: { status: PanelStatus; selectedId: string | null; onOpen: (id: string) => void }) {
  return (
    <aside aria-labelledby="team-panel-title" data-testid="team-panel" data-variant="side" className="border-r border-line bg-panel xl:sticky xl:top-[var(--header-h,6rem)] xl:h-[calc(100dvh-var(--header-h,6rem))] xl:overflow-y-auto">
      <div className="px-3 pt-4 pb-6">
        <div className="mb-3 px-1">
          {/* A label, not a heading: the panel comes before the page's own h1, and the landmark already carries the name. */}
          <p id="team-panel-title" className="text-sm font-semibold tracking-wide text-fg">Team</p>
          <p className="text-sm" data-testid="team-panel-summary"><Count status={status} /></p>
        </div>
        <Rows status={status} selectedId={selectedId} onOpen={onOpen} grid={false} />
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
  const needsYou = ready ? ready.panel.needsYou : 0;
  const workers = ready ? ready.panel.rows.length : null;
  const onKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      onOpenChange(false);
    }
  };
  let count;
  if (ready && needsYou === null) {
    count = <span data-testid="team-needs-you" data-unknown="" className="text-muted"><span aria-hidden="true">? </span><span className="sr-only sm:not-sr-only">needs you unknown</span><span className="sr-only">; {ready.panel.confirmedNeedsYou} when last confirmed{confirmedClock(ready)}</span></span>;
  } else if (needsYou !== null && needsYou > 0) {
    count = <span data-testid="team-needs-you" className="font-semibold text-warning"><span aria-hidden="true">▲ </span>{needsYou}<span className="sr-only sm:not-sr-only"> need{needsYou === 1 ? 's' : ''} you</span></span>;
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
export function TeamFoldRegion({ status, open, onOpenChange, regionId, selectedId, onOpen }: FoldProps & { selectedId: string | null; onOpen: (id: string) => void }) {
  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onOpenChange(false);
    document.querySelector<HTMLElement>('[data-team-toggle]')?.focus();
  };
  return (
    <section id={regionId} aria-label="Team" data-testid="team-panel" data-variant="fold" hidden={!open} onKeyDown={onKey} className="max-h-[60dvh] overflow-y-auto border-t border-line bg-panel">
      <div className="mx-auto max-w-[1600px] px-4 py-3 sm:px-6">
        <p className="mb-2 px-1 text-sm" data-testid="team-panel-summary"><Count status={status} testId="team-fold-needs-you" /></p>
        <Rows status={status} selectedId={selectedId} onOpen={(id) => { onOpenChange(false); onOpen(id); }} grid />
      </div>
    </section>
  );
}
