// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useStore } from 'zustand';
import { MissionControl } from '../features/overview/MissionControl.tsx';
import { BoundedAutonomyPanel } from '../features/settings/SettingsPanel.tsx';
import { SettingsPage } from '../features/settings/SettingsPage.tsx';
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
import { BrainConflicts, BrainView } from '../features/brain/BrainView.tsx';
import { ProductFollowUps, ProductView } from '../features/product/ProductView.tsx';
import { HandoverDecisions } from '../features/handover/ContinueInCloud.tsx';
import { RouteBoundary } from './ErrorBoundary.tsx';
import { connectionOf, type ConnectionState, type ProjectionStore } from './projection-store.ts';
import { hashQuery, hrefFor, replaceHashQuery, useHashQuery, useRoute } from './route.ts';
import { applyTheme } from './theme.ts';
import { applyFont, savedFont } from '../theme/fonts.ts';
import { OfficeCanvas } from '../office/OfficeCanvas.tsx';
import { buildOfficeWorld, type OfficeWorld } from '../office/model.ts';
import { ActivityFeed } from './hud/ActivityFeed.tsx';
import { recentActivity } from './hud/activity.ts';
import { ConnectionBanner } from './hud/ConnectionBanner.tsx';
import { OfficeHome } from './hud/OfficeHome.tsx';
import { Tooltip } from './hud/Tooltip.tsx';
import { Portrait } from './hud/Portrait.tsx';
import { CONNECTION, TopBar } from './hud/TopBar.tsx';
import { SettingsModal, ViewDrawer } from './hud/ViewDrawer.tsx';
import { shortcutFor } from './shortcuts.ts';
import { ui } from './ui-store.ts';
import { TITLES, frameOf } from './views.ts';
import { useUi } from './ui-store.ts';

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

/**
 * The workspace frame (T5.12). Its structure and keyboard handling are adapted from the reference's App.tsx: the office canvas always in view,
 * the floating top bar, team cards and activity feed, each screen in a side drawer over the office, and Settings as a modal. Every screen reads
 * one projection store.
 */
export function AppShell({ store, mode, projectLabel, account, assistant, onboarding, devPanel, leaveDemoHref }: AppShellProps) {
  const route = useRoute();
  useEffect(applyTheme, []);
  // The font style is a per-browser choice (Settings, Project). theme-init.js applies it before first paint; this covers pages without it.
  useEffect(() => applyFont(savedFont()), []);
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
  const headerRef = useRef<HTMLElement>(null);
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
  // What last had focus outside the Settings modal, so closing Settings (Escape, ✕ or the backdrop) can give focus back to what opened it.
  const settingsOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocus = (e: FocusEvent): void => {
      const t = e.target;
      if (t instanceof HTMLElement && !t.closest('[data-shell-modal]')) settingsOpener.current = t;
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);
  useEffect(() => {
    if (previousRoute.current === route) return;
    const from = previousRoute.current;
    previousRoute.current = route;
    // Closing Settings back to the office gives focus back to its opener. A link from Settings to another screen is an ordinary route change: that screen's #main.
    if (from === 'settings' && route === 'office') {
      // The top bar was inert under the modal; it is live again before focus goes back.
      if (chromeRef.current) chromeRef.current.inert = false;
      const opener = settingsOpener.current;
      const visible = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.isConnected && el.getClientRects().length > 0;
      // A link chosen in the More menu is hidden once the menu closes: its button stands in for it.
      const target: HTMLElement | null | undefined = visible(opener) ? opener : (opener as HTMLElement | null)?.closest('[data-more]')?.querySelector<HTMLElement>('[data-testid="top-bar-more"]');
      if (visible(target)) { target.focus(); return; }
    }
    document.getElementById('main')?.focus();
  }, [route]);
  useEffect(() => {
    document.title = `${TITLES[route]} · SelariKru`;
  }, [route]);
  const showCount = overview !== null && !overview.empty;
  const attentionCount = showCount ? overview.attentionCount : null;
  const attentionBadge = showCount ? overview.attentionBadge : null;
  // On Decisions the view speaks for itself, one line per decision; the shell keeps to the connection there, so a decision is not announced twice.
  const announcement = route === 'decisions' ? `${CONNECTION[connection].label}.` : `${CONNECTION[connection].label}.${showCount ? ` ${overview.announcement}` : ''}`;

  // The office: a picture of the same team model the panel lists. Built only from facts in the snapshot; empty without one.
  const world = useMemo((): OfficeWorld | null => {
    if (!snapshot || !team) return null;
    try { return buildOfficeWorld(snapshot, team, projectLabel); } catch { return null; }
  }, [snapshot, team, projectLabel]);
  const activity = useMemo(() => {
    if ((route !== 'office' && !panelWide) || !snapshot) return [];
    try { return recentActivity(snapshot, 7); } catch { return []; }
  }, [route, panelWide, snapshot]);
  const frame = frameOf(route);
  // Each panel row shows its office robot and, for the first nine, the number key that opens it.
  const colorById = useMemo(() => new Map(world?.agents.map((a) => [a.id, a.color]) ?? []), [world]);
  const mark = (id: string, i: number): ReactNode => {
    const color = colorById.get(id);
    return <>{color ? <Portrait color={color} size={22} /> : null}{i < 9 ? <kbd className="kbd">{i + 1}</kbd> : null}</>;
  };
  const headerH = useHeaderHeight(headerRef);
  // On the office screen its own panels sit at the left of the canvas; the camera keeps the office clear of them where there is room.
  const drawerWidth = useUi((s) => s.drawerWidth);
  const drawerMaximized = useUi((s) => s.drawerMaximized);
  // The camera centres the office in what the floating panels leave free: the team cards on the left, an open drawer on the right.
  const insets = useMemo(() => {
    if (!panelWide) return { top: headerH + 8, left: 8, right: 8, bottom: 8 };
    const right = workerId !== null ? 600 : frame === 'drawer' && !drawerMaximized ? Math.min(drawerWidth, window.innerWidth - 32) + 32 : 16;
    return { top: 74, left: 312, right, bottom: 16 };
  }, [headerH, panelWide, frame, workerId, drawerWidth, drawerMaximized]);
  // Settings is modal: everything else is inert while it is open, so focus cannot leave it.
  const chromeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chromeRef.current;
    if (!el) return;
    el.inert = frame === 'settings';
    return () => { el.inert = false; };
  }, [frame]);

  // Shortcuts: 1 to 9 open a worker in the panel's order, + and - zoom the office, Escape on the page goes back to the office. Never from text entry,
  // a terminal, a dialog or the drawer (see shortcuts.ts).
  const rowsRef = useRef<readonly string[]>([]);
  rowsRef.current = panelStatus.kind === 'ready' ? panelStatus.panel.rows.map((r) => r.workerId) : [];
  const routeRef = useRef(route);
  routeRef.current = route;
  const openRef = useRef(openWorker);
  openRef.current = openWorker;
  // A layout effect, so the keys work from the first painted frame.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      const action = shortcutFor({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, defaultPrevented: e.defaultPrevented, target });
      if (!action) return;
      // An open drawer or dialog owns Escape and the digits.
      const open = hashQuery().get('worker') !== null || document.querySelector('dialog[open]') !== null;
      if (action.kind === 'escape') {
        if (open || routeRef.current === 'office') return;
        e.preventDefault();
        window.location.hash = hrefFor('office');
      } else if (action.kind === 'open-worker') {
        const id = rowsRef.current[action.index];
        if (!id || open) return;
        e.preventDefault();
        openRef.current(id);
        ui.focus({ kind: 'agent', id });
      } else if (routeRef.current === 'office') {
        e.preventDefault();
        ui.zoom(action.delta);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const openPlace = (place: 'plan' | 'prs'): void => { window.location.hash = hrefFor(place === 'plan' ? 'pipeline' : 'evidence'); };

  const views = (
    <>
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
            <PipelineView connection={connection} error={state.error} pipeline={builtPipeline.pipeline} failure={builtPipeline.failure} confirmedAt={confirmedAt} mode={mode} onRestart={state.restart} leaveDemoHref={leaveDemoHref} handover={state.handover} refreshKey={snapshot?.meta.cursor ?? '0'} />
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
              brain={<><BrainConflicts port={state.brain} /><ProductFollowUps port={state.product} /><HandoverDecisions port={state.handover} refreshKey={snapshot?.meta.cursor ?? '0'} live={connection === 'live'} titleOf={(id) => snapshot?.tasks[id]?.title ?? null} /></>}
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
        {route === 'product' ? (
          <RouteBoundary resetKey="product">
            <ProductView port={state.product} connection={connection} mode={mode} />
          </RouteBoundary>
        ) : null}
        {route === 'brain' ? (
          <RouteBoundary resetKey="brain">
            <BrainView port={state.brain} connection={connection} mode={mode} nowMs={state.nowMs} />
          </RouteBoundary>
        ) : null}
        {route === 'benchmark' ? (
          <RouteBoundary resetKey="benchmark">
            <BenchmarkView mode={mode} />
          </RouteBoundary>
        ) : null}
        {route === 'settings' ? (
          <RouteBoundary resetKey="settings">
            <SettingsPage
              stack={state.stack} skills={state.skills} connection={connection} mode={mode} projectLabel={projectLabel} snapshot={snapshot} team={team} autonomy={autonomyPanel}
              onOpenWorker={openWorker} onExecute={state.execute} onRefresh={state.refresh} onResync={state.resync}
            />
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
    </>
  );

  const pausedHint = drawerBeside ? (
    <div className="pointer-events-none absolute inset-0 z-20 bg-cream/60">
      <p data-testid="page-paused-hint" className="sticky top-3 mx-4 mt-3 max-w-[24rem] border-[3px] border-ink bg-cream px-3 py-2 text-sm text-fg shadow-[0_3px_0_rgba(36,26,46,0.45)]">The page is paused while a worker is open. Close the worker to use the page.</p>
    </div>
  ) : null;

  return (
    <div className="relative min-h-screen">
      <div ref={chromeRef}>
        <OfficeCanvas world={world} insets={insets} onOpenWorker={openWorker} onOpenPlace={openPlace} subject={frame === 'office'} paused={frame === 'settings' || (frame === 'drawer' && drawerMaximized && panelWide)} />
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:bg-cream focus:px-3 focus:py-2 focus:text-ink">Skip to content</a>
        <Announcer message={announcement} />
        <TopBar
          ref={headerRef} route={route} projectLabel={projectLabel} mode={mode} connection={connection} confirmedAt={confirmedAt} nowMs={state.nowMs} account={account}
          attentionCount={attentionCount} attentionUrgent={overview !== null && overview.needsYou > 0} attentionBadge={attentionBadge} decisionCount={decisionCount} panelWide={panelWide}
          teamToggle={<TeamFoldToggle status={panelStatus} open={foldOpen} onOpenChange={setFoldOpen} regionId={foldId} />}
          teamFold={<TeamFoldRegion status={panelStatus} open={foldOpen} onOpenChange={setFoldOpen} regionId={foldId} selectedId={workerId} onOpen={openWorker} mark={mark} />}
        />
        <ConnectionBanner connection={connection} />
        {panelWide ? <TeamPanelSide status={panelStatus} selectedId={workerId} onOpen={openWorker} mark={mark} /> : null}
        {panelWide ? <ActivityFeed items={activity} nowMs={state.nowMs} stale={stale} /> : null}
      </div>

      {/* The screen in front of the office. Under a worker open beside the team cards it is inert; the scrim and the hint say why it does not respond. */}
      {/* Floating, it is the area right of the team cards; it only takes the pointer while paused, so the office stays clickable around a drawer. */}
      <div ref={contentRef} className={`relative z-20 min-w-0 xl:fixed xl:top-[74px] xl:right-4 xl:bottom-4 xl:left-[312px] ${drawerBeside ? 'cursor-default after:pointer-events-none after:absolute after:inset-0 after:z-30 after:bg-cream/40 after:content-[\'\']' : 'pointer-events-none'}`} data-testid="page-content" data-frame={frame} data-paused={drawerBeside ? 'true' : undefined}>
        {frame === 'office' ? (
          <>
            {pausedHint ? <div className="fixed inset-x-0 top-[74px]">{pausedHint}</div> : null}
            <OfficeHome world={world} wide={panelWide} activity={<ActivityFeed items={activity} nowMs={state.nowMs} stale={stale} />} />
          </>
        ) : frame === 'settings' ? (
          <SettingsModal paused={pausedHint}>{views}</SettingsModal>
        ) : (
          <ViewDrawer view={route} title={TITLES[route]} route={route} decisionCount={decisionCount} paused={pausedHint}>
            {views}
          </ViewDrawer>
        )}
      </div>
      {/* The page under a worker open beside the team cards is inert, and an inert region is not hit-tested: this catcher gives the paused area its arrow pointer. */}
      {drawerBeside ? <div aria-hidden="true" className="fixed z-[19] cursor-default xl:top-[74px] xl:right-4 xl:bottom-4 xl:left-[312px]" /> : null}
      {/* Demo controls (dev only): outside every landmark's content, at the bottom left of the office beside the activity feed. */}
      {devPanel ? <div className="relative z-10 mx-3 my-3 max-w-[22rem] bg-cream xl:fixed xl:bottom-4 xl:left-[312px] xl:m-0 xl:w-[300px]">{devPanel}</div> : null}
      <Tooltip />
      {workerId !== null && team !== null && snapshot !== null ? (
        <WorkerDrawerHost
          workerId={workerId} tab={isTabId(workerTab) ? workerTab : undefined} team={team} snapshot={snapshot} decisions={builtDecisions.decisions} connection={connection} mode={mode} nowMs={state.nowMs}
          onClose={closeWorker} onTab={(t: TabId) => replaceHashQuery({ wtab: t === 'task' ? null : t })}
          onExecute={state.execute} onRefresh={state.refresh} onResync={state.resync} onOpenTerminal={state.openTerminal} onOpenTerminalControl={state.openTerminalControl} brain={state.brain} skills={state.skills} handover={state.handover}
        />
      ) : null}
    </div>
  );
}

/** The header's height, which changes with the width and the folded panel. The side panel sticks below it and the office camera keeps clear of it. */
function useHeaderHeight(ref: RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const header = ref.current;
    if (!header) return;
    // Floating, the bar ends 60 px down and the panels start at 74 px; in the page flow it is its own height.
    const set = (): void => {
      const floating = getComputedStyle(header).position === 'fixed';
      document.documentElement.style.setProperty('--header-h', floating ? '74px' : `${header.offsetHeight}px`);
      setH(header.offsetHeight);
    };
    set();
    const observer = new ResizeObserver(set);
    observer.observe(header);
    return () => observer.disconnect();
  }, [ref]);
  return h;
}
