import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { buttonQuiet, formatAge, formatClock, toneGlyph, type Tone } from '@selarikru/ui';
import { DemoBadge } from '../data-source/DemoBadge.tsx';
import { MissionControl } from '../features/overview/MissionControl.tsx';
import { buildOverview, type OverviewModel } from '../features/overview/model.ts';
import { TeamView } from '../features/team/TeamView.tsx';
import { buildTeam, type TeamModel } from '../features/team/model.ts';
import { RouteBoundary } from './ErrorBoundary.tsx';
import { connectionOf, type ConnectionState, type ProjectionStore } from './projection-store.ts';
import { hrefFor, useRoute, type Route } from './route.ts';
import { useTheme } from './theme.ts';

export interface AccountInfo {
  readonly label: string;
  readonly onSignOut: () => void;
}

export interface AppShellProps {
  readonly store: ProjectionStore;
  readonly mode: 'mock' | 'live';
  readonly projectLabel: string;
  readonly account?: AccountInfo;
  /** The live assistant. Null under demo data, where it is not mounted. */
  readonly assistant: ReactNode | null;
  /** Development controls, rendered below the page content under demo data only. */
  readonly devPanel?: ReactNode;
  /** Link that leaves demo mode, for the assistant notice. */
  readonly leaveDemoHref?: string;
}

const NAV: readonly { label: string; route: Route | null }[] = [
  { label: 'Overview', route: 'overview' },
  { label: 'Team', route: 'team' },
  { label: 'Pipeline', route: null },
  { label: 'Decisions', route: null },
  { label: 'Assistant', route: 'assistant' },
];

const TITLES: Readonly<Record<Route, string>> = { overview: 'Mission Control', team: 'Team', assistant: 'Assistant' };

const CONNECTION: Readonly<Record<ConnectionState, { label: string; tone: Tone }>> = {
  connecting: { label: 'Connecting', tone: 'neutral' },
  live: { label: 'Live', tone: 'success' },
  reconnecting: { label: 'Reconnecting', tone: 'warning' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
  dead: { label: 'Stream stopped', tone: 'danger' },
};
const TONE_TEXT: Readonly<Record<Tone, string>> = { neutral: 'text-muted', active: 'text-active', success: 'text-success', warning: 'text-warning', danger: 'text-danger' };

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

/** One polite announcement per change of connection state or attention count. Heartbeats and ticks say nothing. */
function Announcer({ message }: { message: string }) {
  const [spoken, setSpoken] = useState('');
  const last = useRef('');
  useEffect(() => {
    if (message === last.current) return;
    last.current = message;
    setSpoken(message);
  }, [message]);
  return <p role="status" aria-live="polite" className="sr-only">{spoken}</p>;
}

function AssistantNotice({ leaveDemoHref }: { leaveDemoHref?: string | undefined }) {
  return (
    <section aria-labelledby="assistant-off" className="mx-auto mt-10 max-w-xl rounded-card border border-line bg-panel p-6">
      <h1 id="assistant-off" className="text-xl font-semibold">The assistant is off in demo mode</h1>
      <p className="mt-2 text-muted">The assistant talks to real models and a real control API, so it does not run on demo data. Nothing here is a live result.</p>
      {leaveDemoHref ? <p className="mt-4"><a className="text-active underline" href={leaveDemoHref}>Leave demo mode</a></p> : null}
    </section>
  );
}

/** The workspace frame: identity, navigation, data freshness and the demo label. Monitoring views render inside it and read one projection store. */
export function AppShell({ store, mode, projectLabel, account, assistant, devPanel, leaveDemoHref }: AppShellProps) {
  const route = useRoute();
  const [theme, toggleTheme] = useTheme();
  const state = useStore(store);
  const connection = connectionOf(state);
  const liveness = state.livenessForHealth();
  const snapshot = state.projection?.snapshot ?? null;
  // A liveness refresh does not bump the snapshot's own time, so freshness follows the last successful load or refresh.
  const confirmedAt = state.livenessAsOfMs !== null ? new Date(state.livenessAsOfMs).toISOString() : (snapshot?.meta.observedAt ?? null);
  const stale = connection !== 'live';
  // Caught here so a bad snapshot reaches the route's boundary through MissionControl and cannot take the shell down.
  const built = useMemo((): { overview: OverviewModel | null; failure?: unknown } => {
    if (!snapshot) return { overview: null };
    try {
      return { overview: buildOverview(snapshot, state.nowMs, liveness, { lastConfirmedMs: state.livenessAsOfMs, stale }) };
    } catch (failure) {
      return { overview: null, failure };
    }
  }, [snapshot, state.nowMs, liveness, state.livenessAsOfMs, stale]);
  const overview = built.overview;
  // Same containment as the overview: a snapshot that cannot be read fails this route, not the shell.
  const builtTeam = useMemo((): { team: TeamModel | null; failure?: unknown } => {
    if (route !== 'team' || !snapshot) return { team: null };
    try {
      return { team: buildTeam(snapshot, state.nowMs, liveness, { lastConfirmedMs: state.livenessAsOfMs, stale }) };
    } catch (failure) {
      return { team: null, failure };
    }
  }, [route, snapshot, state.nowMs, liveness, state.livenessAsOfMs, stale]);
  // The assistant mounts on first visit and then stays mounted, so moving between tabs does not discard a draft.
  const [assistantOpened, setAssistantOpened] = useState(route === 'assistant');
  useEffect(() => {
    if (route === 'assistant') setAssistantOpened(true);
  }, [route]);
  // Keyboard and screen reader users land on the new view. Not on first load, where the browser's own start point is right.
  const previousRoute = useRef(route);
  useEffect(() => {
    if (previousRoute.current === route) return;
    previousRoute.current = route;
    document.getElementById('main')?.focus();
  }, [route]);
  useEffect(() => {
    document.title = `${TITLES[route]} · SelariKru`;
  }, [route]);

  const showCount = overview !== null && !overview.empty;
  const attentionCount = showCount ? overview.attentionCount : null;
  const attentionBadge = showCount ? overview.attentionBadge : null;
  const announcement = `${CONNECTION[connection].label}.${showCount ? ` ${overview.announcement}` : ''}`;

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-chip focus:bg-active focus:px-3 focus:py-2 focus:text-bg">Skip to content</a>
      <Announcer message={announcement} />
      <header className="sticky top-0 z-40 border-b border-line bg-panel">
        <div className="mx-auto flex max-w-[1320px] items-center gap-x-3 px-4 pt-2 sm:gap-x-4 sm:px-6">
          <p className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight text-fg">SelariKru</span>
            <span aria-hidden="true" className="text-muted">/</span>
            <span className="truncate text-sm text-muted" data-testid="project-label">{projectLabel}</span>
          </p>
          <div className="ml-auto flex shrink-0 items-center justify-end gap-x-3">
            <DemoBadge mode={mode} />
            {attentionCount ? <a data-testid="attention-count" href={hrefFor('overview')} className={`hidden text-sm font-medium underline-offset-2 hover:underline sm:inline ${overview!.needsYou > 0 ? 'text-warning' : 'text-muted'}`}>{attentionCount}</a> : null}
            <button type="button" aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} className="rounded-chip border border-line-strong px-2 py-1 text-sm text-fg hover:border-active" onClick={toggleTheme}>
              <span className="sm:hidden">{theme === 'dark' ? 'Light' : 'Dark'}</span>
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
        <div className="mx-auto flex max-w-[1320px] items-center gap-2 pr-4 sm:pr-6">
          <nav aria-label="Primary" className="flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 pt-1 sm:px-5">
            {NAV.map((item) =>
              item.route ? (
                <a
                  key={item.label}
                  href={hrefFor(item.route)}
                  aria-current={route === item.route ? 'page' : undefined}
                  className={`inline-flex items-baseline gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${route === item.route ? 'border-active text-fg' : 'border-transparent text-muted hover:text-fg'}`}
                >
                  {item.label}
                  {item.route === 'overview' && attentionBadge ? <span data-testid="attention-badge" aria-label={attentionCount ?? undefined} className="text-warning sm:hidden">{attentionBadge}</span> : null}
                </a>
              ) : (
                <span key={item.label} className="hidden items-baseline gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-muted md:inline-flex">
                  {item.label}
                  <span className="text-xs">soon</span>
                </span>
              ),
            )}
          </nav>
          <div className="shrink-0">
            <Freshness connection={connection} confirmedAt={confirmedAt} nowMs={state.nowMs} />
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto max-w-[1320px] px-4 py-6 outline-none sm:px-6">
        {route === 'overview' ? (
          <RouteBoundary resetKey={`${route}:${built.failure === undefined ? 'ok' : 'failed'}`}>
            <MissionControl connection={connection} error={state.error} overview={overview} failure={built.failure} snapshot={snapshot} confirmedAt={confirmedAt} nowMs={state.nowMs} mode={mode} onRestart={state.restart} leaveDemoHref={leaveDemoHref} />
          </RouteBoundary>
        ) : null}
        {route === 'team' ? (
          <RouteBoundary resetKey={`team:${builtTeam.failure === undefined ? 'ok' : 'failed'}`}>
            <TeamView connection={connection} error={state.error} team={builtTeam.team} failure={builtTeam.failure} confirmedAt={confirmedAt} nowMs={state.nowMs} mode={mode} onRestart={state.restart} leaveDemoHref={leaveDemoHref} />
          </RouteBoundary>
        ) : null}
        {route === 'assistant' && assistant === null ? <AssistantNotice leaveDemoHref={leaveDemoHref} /> : null}
        {assistant !== null && assistantOpened ? (
          <div hidden={route !== 'assistant'}>
            <RouteBoundary resetKey="assistant">
              <Suspense fallback={<p role="status" className="text-muted">Loading the assistant</p>}>{assistant}</Suspense>
            </RouteBoundary>
          </div>
        ) : null}
      </main>
      {devPanel ? <div className="mx-auto max-w-[1320px] px-4 pb-8 sm:px-6">{devPanel}</div> : null}
    </div>
  );
}
