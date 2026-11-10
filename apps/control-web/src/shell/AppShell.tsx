import { Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { TONE_TEXT, buttonQuiet, formatAge, formatClock, toneGlyph, type Tone } from '@selarikru/ui';
import { DemoBadge } from '../data-source/DemoBadge.tsx';
import { MissionControl } from '../features/overview/MissionControl.tsx';
import { BoundedAutonomyPanel } from '../features/settings/SettingsPanel.tsx';
import { autonomyModel } from '../features/settings/model.ts';
import { buildOverview, type OverviewModel } from '../features/overview/model.ts';
import { TeamView } from '../features/team/TeamView.tsx';
import { buildTeam, type TeamModel } from '../features/team/model.ts';
import { panelOf } from '../features/team/panel.ts';
import { TeamFoldRegion, TeamFoldToggle, TeamPanelSide, type PanelStatus } from '../features/team/TeamPanel.tsx';
import { isTabId, type TabId } from '../features/team/WorkerDrawer.tsx';
import { WorkerDrawerHost } from './WorkerDrawerHost.tsx';
import { PANEL_WIDE, useMediaQuery } from './media.ts';
import { PipelineView } from '../features/pipeline/PipelineView.tsx';
import { buildPipeline, type PipelineModel } from '../features/pipeline/model.ts';
import { pipelinePresentation } from '../features/pipeline/presentation.ts';
import { DecisionsView } from '../features/decisions/DecisionsView.tsx';
import { buildDecisions, type DecisionsModel } from '../features/decisions/model.ts';
import { EvidenceView } from '../features/evidence/EvidenceView.tsx';
import { buildEvidence, type EvidenceModel } from '../features/evidence/model.ts';
import { BenchmarkView } from '../features/benchmark/BenchmarkView.tsx';
import { RouteBoundary } from './ErrorBoundary.tsx';
import { connectionOf, type ConnectionState, type ProjectionStore } from './projection-store.ts';
import { hashQuery, hrefFor, replaceHashQuery, useHashQuery, useRoute, type Route } from './route.ts';
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
  /** The project setup screen. */
  readonly onboarding?: ReactNode;
  /** Development controls, rendered below the page content under demo data only. */
  readonly devPanel?: ReactNode;
  /** Link that leaves demo mode, for the assistant notice. */
  readonly leaveDemoHref?: string;
}

const NAV: readonly { label: string; route: Route | null }[] = [
  { label: 'Overview', route: 'overview' },
  { label: 'Team', route: 'team' },
  { label: 'Pipeline', route: 'pipeline' },
  { label: 'Decisions', route: 'decisions' },
  { label: 'Evidence', route: 'evidence' },
  { label: 'Benchmark', route: 'benchmark' },
  { label: 'Assistant', route: 'assistant' },
  { label: 'New project', route: 'onboarding' },
];

const TITLES: Readonly<Record<Route, string>> = { overview: 'Mission Control', team: 'Team', pipeline: 'Pipeline', decisions: 'Decisions', evidence: 'Evidence', benchmark: 'Benchmark', assistant: 'Assistant', onboarding: 'New project' };

const CONNECTION: Readonly<Record<ConnectionState, { label: string; tone: Tone }>> = {
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
export function AppShell({ store, mode, projectLabel, account, assistant, onboarding, devPanel, leaveDemoHref }: AppShellProps) {
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
  const query = useHashQuery();
  // The open drawer lives in the hash (`?worker=`, and `&wtab=` for its tab), so it can be linked to and the view under it stays put.
  const workerId = query.get('worker');
  const workerTab = query.get('wtab');
  // Always built: the team panel is on every view. Same containment as the overview: a snapshot that cannot be read fails the Team route and empties the panel, not the shell.
  const builtTeam = useMemo((): { team: TeamModel | null; failure?: unknown } => {
    if (!snapshot) return { team: null };
    try {
      // Presence for every worker on every tick; the drawer's detail only for the Team route and the open drawer.
      return { team: buildTeam(snapshot, state.nowMs, liveness, { lastConfirmedMs: state.livenessAsOfMs, stale, detailFor: route === 'team' ? 'all' : workerId !== null ? [workerId] : [] }) };
    } catch (failure) {
      return { team: null, failure };
    }
  }, [route, workerId, snapshot, state.nowMs, liveness, state.livenessAsOfMs, stale]);
  const team = builtTeam.team;
  const panelStatus = useMemo((): PanelStatus => {
    if (team) return { kind: 'ready', panel: panelOf(team, stale), stale, confirmedAt };
    return connection === 'unavailable' || connection === 'dead' || builtTeam.failure !== undefined ? { kind: 'unavailable' } : { kind: 'loading' };
  }, [team, stale, confirmedAt, connection, builtTeam.failure]);
  const panelWide = useMediaQuery(PANEL_WIDE);
  const [foldOpen, setFoldOpen] = useState(false);
  const foldId = useId();
  useEffect(() => { if (panelWide) setFoldOpen(false); }, [panelWide]);
  // The side panel sticks below the header, whose height changes with the width and with the folded panel.
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const set = (): void => document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const pipelineRunId = useStore(pipelinePresentation, (s) => s.runId);
  const builtPipeline = useMemo((): { pipeline: PipelineModel | null; failure?: unknown } => {
    if (route !== 'pipeline' || !snapshot) return { pipeline: null };
    try {
      return { pipeline: buildPipeline(snapshot, state.nowMs, liveness, { runId: pipelineRunId, lastConfirmedMs: state.livenessAsOfMs, stale }) };
    } catch (failure) {
      return { pipeline: null, failure };
    }
  }, [route, snapshot, state.nowMs, liveness, state.livenessAsOfMs, stale, pipelineRunId]);
  // Always built, for the navigation count; contained the same way so a bad snapshot fails the route and not the shell.
  const builtDecisions = useMemo((): { decisions: DecisionsModel | null; failure?: unknown } => {
    if (!snapshot) return { decisions: null };
    try {
      return { decisions: buildDecisions(snapshot, state.nowMs, { mode, connection }) };
    } catch (failure) {
      return { decisions: null, failure };
    }
  }, [snapshot, state.nowMs, mode, connection]);
  const decisionCount = builtDecisions.decisions?.waiting ?? 0;
  // The run's effective policy and its controls, from the server's snapshot. Null when the server reports none: nothing is invented in its place.
  const autonomy = useMemo(() => {
    if (!snapshot) return null;
    try { return autonomyModel(snapshot, connection === 'live'); } catch { return null; }
  }, [snapshot, connection]);
  const autonomyPanel = autonomy ? <BoundedAutonomyPanel key={autonomy.runId} model={autonomy} onExecute={state.execute} onRefresh={state.refresh} onResync={state.resync} /> : null;
  const opener = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const openWorker = (id: string): void => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    replaceHashQuery({ wtab: null, worker: id });
  };
  const focusAfterDrawer = (id: string | null): void => {
    // The page under a non-modal drawer is inert until the next render; focus is moving back into it now.
    if (contentRef.current) contentRef.current.inert = false;
    // Back to what opened it, or the same worker elsewhere on the page, or the folded panel's toggle, so focus is never stranded.
    const sameWorker = id !== null ? document.querySelector<HTMLElement>(`[data-panel-worker="${CSS.escape(id)}"], [data-open-worker="${CSS.escape(id)}"]`) : null;
    const target = [opener.current, sameWorker, document.querySelector<HTMLElement>('[data-team-toggle]')].find((el) => el?.isConnected && el.offsetParent !== null);
    opener.current = null;
    (target ?? document.getElementById('main'))?.focus();
  };
  const closeWorker = (): void => {
    // Following a link out of the drawer has already moved on: that view decides where focus goes.
    const id = hashQuery().get('worker');
    if (id === null) return;
    replaceHashQuery({ wtab: null, worker: null });
    focusAfterDrawer(id);
  };
  // Beside the panel the drawer is not modal, so the page under it is made inert while it is open: keyboard focus cannot land on what the drawer covers. The header,
  // the nav and the team panel stay live, so another worker can still be chosen.
  const drawerBeside = panelWide && workerId !== null && team !== null && team.rows.some((r) => r.workerId === workerId);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.inert = drawerBeside;
    return () => { el.inert = false; };
  }, [drawerBeside]);
  // A worker that is not in the snapshot, from a stale link or a project change, closes the drawer and focus lands on the page.
  const workerMissing = workerId !== null && team !== null && !team.rows.some((r) => r.workerId === workerId);
  useEffect(() => {
    if (!workerMissing) return;
    replaceHashQuery({ wtab: null, worker: null });
    opener.current = null;
    if (contentRef.current) contentRef.current.inert = false;
    document.getElementById('main')?.focus();
  }, [workerMissing]);
  const evidenceRun = route === 'evidence' ? query.get('run') : null;
  const builtEvidence = useMemo((): { evidence: EvidenceModel | null; failure?: unknown } => {
    if (route !== 'evidence' || !snapshot) return { evidence: null };
    try {
      return { evidence: buildEvidence(snapshot, evidenceRun) };
    } catch (failure) {
      return { evidence: null, failure };
    }
  }, [route, snapshot, evidenceRun]);
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
  // The tab list scrolls on narrow screens: the current page must be in view, or the operator cannot tell where they are.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [route]);

  const showCount = overview !== null && !overview.empty;
  const attentionCount = showCount ? overview.attentionCount : null;
  const attentionBadge = showCount ? overview.attentionBadge : null;
  // On Decisions the view speaks for itself, one line per decision; the shell keeps to the connection there, so a decision is not announced twice.
  const announcement = route === 'decisions' ? `${CONNECTION[connection].label}.` : `${CONNECTION[connection].label}.${showCount ? ` ${overview.announcement}` : ''}`;

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-chip focus:bg-active focus:px-3 focus:py-2 focus:text-bg">Skip to content</a>
      <Announcer message={announcement} />
      <header ref={headerRef} className="sticky top-0 z-40 border-b border-line bg-panel">
        <div className="mx-auto flex max-w-[1600px] items-center gap-x-3 px-4 pt-2 sm:gap-x-4 sm:px-6">
          <p className="flex min-w-0 flex-1 items-baseline gap-2">
            {/* At phone width the project is what tells two tabs apart, so it keeps the room and the product name is read out instead. */}
            <span className="sr-only text-base font-semibold tracking-tight text-fg sm:not-sr-only">SelariKru</span>
            <span aria-hidden="true" className="hidden text-muted sm:inline">/</span>
            <span className="truncate text-sm font-medium text-fg sm:font-normal sm:text-muted" data-testid="project-label"><span className="sr-only">, project </span>{projectLabel}</span>
          </p>
          <div className="ml-auto flex shrink-0 items-center justify-end gap-x-2 sm:gap-x-3">
            {panelWide ? null : <TeamFoldToggle status={panelStatus} open={foldOpen} onOpenChange={setFoldOpen} regionId={foldId} />}
            <DemoBadge mode={mode} />
            {/* Below the side panel's width the Team toggle carries the count beside this, so this one waits for the room. */}
            {attentionCount && panelWide ? <a data-testid="attention-count" href={hrefFor('overview')} className={`hidden text-sm font-medium underline-offset-2 hover:underline sm:inline ${overview!.needsYou > 0 ? 'text-warning' : 'text-muted'}`}>{attentionCount}</a> : null}
            <button type="button" aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} className="rounded-chip border border-line-strong px-2 py-1 text-sm text-fg hover:border-active" onClick={toggleTheme}>
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
          <nav ref={navRef} aria-label="Primary" className="flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 pt-1 sm:px-5">
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
                  {item.route === 'decisions' && decisionCount > 0 ? <span data-testid="decisions-count" className="text-warning"><span className="sr-only">, </span>{decisionCount}<span className="sr-only"> waiting</span></span> : null}
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
            {/* Setting up a first project has no live data to be fresh about. */}
            {route === 'onboarding' && connection === 'unavailable' ? null : <Freshness connection={connection} confirmedAt={confirmedAt} nowMs={state.nowMs} />}
          </div>
        </div>
        {panelWide ? null : <TeamFoldRegion status={panelStatus} open={foldOpen} onOpenChange={setFoldOpen} regionId={foldId} selectedId={workerId} onOpen={openWorker} />}
      </header>

      {/* Columns follow the same query as the panel itself, so the page never lays out for a panel that is not there yet. */}
      {/* An inert region is not hit-tested, so the arrow comes from here; the scrim and the hint below say why it does not respond. */}
      <div className={`mx-auto max-w-[1600px] ${panelWide ? 'grid grid-cols-[17.5rem_minmax(0,1fr)]' : ''} ${drawerBeside ? 'cursor-default' : ''}`}>
      {panelWide ? <TeamPanelSide status={panelStatus} selectedId={workerId} onOpen={openWorker} /> : null}
      <div ref={contentRef} className={`relative min-w-0 ${drawerBeside ? 'after:pointer-events-none after:absolute after:inset-0 after:z-10 after:bg-bg/60 after:content-[\'\']' : ''}`} data-testid="page-content" data-paused={drawerBeside ? 'true' : undefined}>
      {/* On the scrim, out of the flow, so pausing moves nothing on the page; sticky under the header, so it stays in view however far the page is scrolled. */}
      {drawerBeside ? (
        <div className="pointer-events-none absolute inset-0 z-20">
          <p data-testid="page-paused-hint" className="sticky top-[calc(var(--header-h,6rem)+0.75rem)] mx-4 mt-3 max-w-[24rem] rounded-chip border border-line bg-panel px-3 py-2 text-sm text-fg shadow-sm sm:mx-6">The page is paused while a worker is open. Close the worker to use the page.</p>
        </div>
      ) : null}
      <main id="main" tabIndex={-1} className="mx-auto max-w-[1320px] px-4 py-6 outline-none sm:px-6">
        {route === 'overview' ? (
          <RouteBoundary resetKey={`${route}:${built.failure === undefined ? 'ok' : 'failed'}`}>
            <MissionControl connection={connection} error={state.error} overview={overview} failure={built.failure} snapshot={snapshot} confirmedAt={confirmedAt} nowMs={state.nowMs} mode={mode} onRestart={state.restart} leaveDemoHref={leaveDemoHref} fleetInPanel={panelWide} autonomy={autonomyPanel} />
          </RouteBoundary>
        ) : null}
        {route === 'team' ? (
          <RouteBoundary resetKey={`team:${builtTeam.failure === undefined ? 'ok' : 'failed'}`}>
            <TeamView connection={connection} error={state.error} team={builtTeam.team} failure={builtTeam.failure} confirmedAt={confirmedAt} nowMs={state.nowMs} mode={mode} onRestart={state.restart} leaveDemoHref={leaveDemoHref} onExecute={state.execute} onRefresh={state.refresh} onResync={state.resync} onOpenWorker={openWorker} autonomy={autonomyPanel} />
          </RouteBoundary>
        ) : null}
        {route === 'pipeline' ? (
          <RouteBoundary resetKey={`pipeline:${builtPipeline.failure === undefined ? 'ok' : 'failed'}`}>
            <PipelineView connection={connection} error={state.error} pipeline={builtPipeline.pipeline} failure={builtPipeline.failure} confirmedAt={confirmedAt} mode={mode} onRestart={state.restart} leaveDemoHref={leaveDemoHref} />
          </RouteBoundary>
        ) : null}
        {route === 'decisions' ? (
          <RouteBoundary resetKey={`decisions:${builtDecisions.failure === undefined ? 'ok' : 'failed'}`}>
            <DecisionsView
              connection={connection} error={state.error} model={builtDecisions.decisions} failure={builtDecisions.failure} confirmedAt={confirmedAt} nowMs={state.nowMs} mode={mode} leaveDemoHref={leaveDemoHref}
              delivery={overview ? { criteria: overview.delivery.criteriaLabel, blocker: overview.delivery.blocker } : null}
              elsewhere={overview ? overview.attention.filter((i) => i.needsOperator && i.decisionId === null).length : 0}
              counted={overview ? overview.attention.filter((i) => i.needsOperator && i.decisionId !== null).length : 0}
              onRestart={state.restart} onExecute={state.execute} onRefresh={state.refresh} onResync={state.resync}
            />
          </RouteBoundary>
        ) : null}
        {route === 'evidence' ? (
          <RouteBoundary resetKey={`evidence:${builtEvidence.failure === undefined ? 'ok' : 'failed'}`}>
            <EvidenceView
              connection={connection} error={state.error} model={builtEvidence.evidence} failure={builtEvidence.failure} hasSnapshot={snapshot !== null} confirmedAt={confirmedAt} mode={mode} leaveDemoHref={leaveDemoHref}
              checkTarget={query.get('check')} candidateTarget={query.get('candidate')} onLoadFailures={state.loadFailures} onRestart={state.restart} onChooseRun={(id) => { window.location.hash = `${hrefFor('evidence')}?run=${encodeURIComponent(id)}`; }}
            />
          </RouteBoundary>
        ) : null}
        {route === 'benchmark' ? (
          <RouteBoundary resetKey="benchmark">
            <BenchmarkView mode={mode} />
          </RouteBoundary>
        ) : null}
        {route === 'onboarding' ? (
          <RouteBoundary resetKey="onboarding">{onboarding ?? null}</RouteBoundary>
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
      </div>
      {workerId !== null && team !== null && snapshot !== null ? (
        <WorkerDrawerHost
          workerId={workerId} tab={isTabId(workerTab) ? workerTab : undefined} team={team} snapshot={snapshot} decisions={builtDecisions.decisions} connection={connection} mode={mode} nowMs={state.nowMs}
          onClose={closeWorker} onTab={(t: TabId) => replaceHashQuery({ wtab: t === 'task' ? null : t })}
          onExecute={state.execute} onRefresh={state.refresh} onResync={state.resync} onOpenTerminal={state.openTerminal} onOpenTerminalControl={state.openTerminalControl}
        />
      ) : null}
    </div>
  );
}
