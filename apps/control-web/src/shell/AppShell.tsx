// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { settingsHref } from './views.ts';
import { PmProposals } from '../features/pm/PmProposals.tsx';
import { pmProposals, proposalRows } from '../features/pm/proposals.ts';
import { workerIdentity } from '../features/team/identity.ts';
import { Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { AttentionRow, MissionControl } from '../features/overview/MissionControl.tsx';
import { BoundedAutonomyPanel } from '../features/settings/SettingsPanel.tsx';
import { SettingsPage } from '../features/settings/SettingsPage.tsx';
import { autonomyModel } from '../features/settings/model.ts';
import { buildOverview, type OverviewModel } from '../features/overview/model.ts';
import { TeamView } from '../features/team/TeamView.tsx';
import { buildTeam, type TeamModel } from '../features/team/model.ts';
import { panelOf } from '../features/team/panel.ts';
import { TeamFoldRegion, TeamFoldToggle, TeamPanelSide, type PanelStatus, type RowDecor } from '../features/team/TeamPanel.tsx';
import { tabOf, type TabId } from '../features/team/WorkerDrawer.tsx';
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
import { PmPanel } from '../features/pm/PmPanel.tsx';
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
import { aiRunCounts, latestFallback, recentActivity } from './hud/activity.ts';
import { usePlayback, type Playback } from './playback.ts';
import { ConnectionBanner } from './hud/ConnectionBanner.tsx';
import { OfficeHome } from './hud/OfficeHome.tsx';
import { Tooltip } from './hud/Tooltip.tsx';
import { Portrait } from './hud/Portrait.tsx';
import { DebugPanel } from './hud/DebugPanel.tsx';
import { CONNECTION, TopBar } from './hud/TopBar.tsx';
import { SettingsModal, ViewDrawer } from './hud/ViewDrawer.tsx';
import { shortcutFor } from './shortcuts.ts';
import { ui } from './ui-store.ts';
import { TITLES, frameOf } from './views.ts';
import { useUi } from './ui-store.ts';
import type { AssistantSdk, FirebaseHybridAssistantAdapter } from '@selarikru/inference-firebase-web';
import { createAgents, type AgentsPort } from '../features/hybrid/agents.ts';
import { hybridResults, resultKey } from '../features/hybrid/context.tsx';
import { EMPTY_CHECKPOINT_STORE, createCheckpointEngine, type CheckpointRunner } from '../features/checkpoints/engine.ts';
import { defaultDeviceStore } from '../features/checkpoints/device-store.ts';
import { connectivity, isOnline, onReconnect, useOnlineNow, useSimulatedOffline, watchNavigator } from '../features/checkpoints/connectivity.ts';
import { checkpointActivity, waitingCloudCalls } from '../features/checkpoints/model.ts';
import { PausedWork } from '../features/checkpoints/PausedWork.tsx';
import { pausedRows } from '../features/checkpoints/model.ts';
import { pmConversation } from '../features/pm/PmPanel.tsx';
import type { AgentActionKind } from '../features/hybrid/model.ts';
import { HybridProvider, useInFlight, useOnline, type HybridValue } from '../features/hybrid/context.tsx';
import { DEFAULT_BROWSER, workerRouteText } from '../features/hybrid/model.ts';

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
  /** Demo only (H7 fix): the scripted timeline's playback. The top bar's speed buttons drive it, and the office animates at its speed. */
  readonly playback?: Playback | null;
  /** Link that leaves demo mode, for the assistant notice. */
  readonly leaveDemoHref?: string;
  /**
   * What runs the task agents (H4): the live Firebase AI Logic adapter, wired to the source's fresh route reads, or under demo data a stand-in SDK whose answers are
   * labelled demo data. Absent: no AI actions are offered.
   */
  readonly agentRuntime?: { readonly adapter?: Pick<FirebaseHybridAssistantAdapter, 'runAgent'>; readonly sdk?: AssistantSdk; readonly simulated: boolean } | null;
  /** H12: who this browser's checkpoints belong to (the signed-in owner's uid). The device store is scoped to it. Default: the demo operator, or the owner. */
  readonly ownerKey?: string;
}

/** H12: one device store per tab (IndexedDB, or memory without it). */
let sharedDeviceStore: ReturnType<typeof defaultDeviceStore> | null = null;
const deviceStore = () => (sharedDeviceStore ??= defaultDeviceStore());

/** H12, demo only (Debug): simulates going offline and reconnecting. It never changes the browser's own online state. Demo data, never evidence. */
function DemoNetwork({ offline }: { offline: boolean }) {
  return (
    <div className="mt-2 space-y-1 p-1" data-testid="demo-network">
      <button type="button" className="btn text-[14px]" aria-pressed={offline} onClick={() => connectivity.getState().simulateOffline(!offline)}>{offline ? 'Go online' : 'Go offline'}</button>
      <p className="text-sm">Demo only: {offline ? 'simulated offline. Steps that need the cloud wait as checkpoints.' : 'simulates losing the connection.'} The browser&apos;s own online state is not changed.</p>
    </div>
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

/**
 * The workspace frame (T5.12). Its structure and keyboard handling are adapted from the reference's App.tsx: the office canvas always in view,
 * the floating top bar, team cards and activity feed, each screen in a side drawer over the office, and Settings as a modal. Every screen reads
 * one projection store.
 */
/** Counts projections, so each new store gets its own office epoch. */
let epochSeq = 0;
const nextEpoch = (): number => (epochSeq += 1);

export function AppShell({ store, mode, projectLabel, account, assistant, onboarding, devPanel, leaveDemoHref, agentRuntime = null, playback = null, ownerKey }: AppShellProps) {
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
    // H11 fix round 1 (M10): a "not started" desk has no worker yet: it opens Team settings, where a worker is given that role.
    if (id.startsWith('role:')) { window.location.hash = settingsHref('team').replace(/^#/, ''); return; }
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
  const assistantHost = useMemo(() => document.createElement('div'), []);
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
  const announcement = route === 'actions' ? `${CONNECTION[connection].label}.` : `${CONNECTION[connection].label}.${showCount ? ` ${overview.announcement}` : ''}`;

  // The office: a picture of the same team model the panel lists. Built only from facts in the snapshot; empty without one.
  // The plan wall's run (the top bar's Plan wall select): the current run unless one is chosen.
  const [planRunId, setPlanRunId] = useState<string | null>(null);
  // Demo only: the office animation speed. Never touches data.
  const [localSpeed, setLocalSpeed] = useState(1);
  const played = usePlayback(playback);
  const speed = played?.speed ?? localSpeed;
  const setSpeed = (s: number): void => { if (playback) playback.setSpeed(s); else setLocalSpeed(s); };
  // Development only: the reference's debug panel.
  // Under ?demo it opens with the demo controls in it (fixture, advance, restart); close it to see the office alone.
  const [debugOpen, setDebugOpen] = useState(() => import.meta.env.DEV && mode === 'mock' && devPanel != null);
  // The task agents, and their calls in flight for the office's desk marks and rooftop cloud deck.
  // H12: the AI step checkpoints (the offline queue), kept on this device and, when not restricted, by the server. One engine per project and source.
  const owner = ownerKey ?? (mode === 'mock' ? 'demo-operator' : 'owner');
  const engine = useMemo(() => {
    const src = state.agentSource;
    if (!agentRuntime || !src?.getTaskRoute || !src.getTaskContext) return null;
    const projectId = state.projectId;
    return createCheckpointEngine({
      projectId, ownerKey: owner, device: deviceStore(),
      server: src.saveAiCheckpoint ? { saveAiCheckpoint: src.saveAiCheckpoint, ...(src.listAiCheckpoints ? { listAiCheckpoints: src.listAiCheckpoints } : {}), ...(src.claimAiCheckpointEscalation ? { claimAiCheckpointEscalation: src.claimAiCheckpointEscalation } : {}) } : null,
      getTaskRoute: (taskId) => src.getTaskRoute!(projectId, taskId),
      getTaskContext: (taskId, destination, callOverride, contextId) => src.getTaskContext!(projectId, taskId, destination, callOverride, contextId),
      ...(src.getTaskFiles ? { getTaskFiles: (taskId: string, paths: readonly string[]) => src.getTaskFiles!(projectId, taskId, paths) } : {}),
      snapshot: () => store.getState().projection?.snapshot ?? null, isOnline,
      // The projection's own clock: the demo's under demo data, so checkpoints sit in the same timeline as everything else.
      now: () => new Date(store.getState().nowMs),
    });
  }, [agentRuntime, state.agentSource, state.projectId, store, owner]);
  const agents = useMemo((): AgentsPort | null => (agentRuntime && state.agentSource ? createAgents({
    projectId: state.projectId, source: state.agentSource, ...agentRuntime,
    execute: (c) => store.getState().execute(c), snapshot: () => store.getState().projection?.snapshot ?? null,
    checkpoints: engine,
    // A step that continued a paused checkpoint shows its outcome where the step lives: its task's AI actions, or the PM conversation.
    onResumed: (req, outcome) => {
      if (req.kind.startsWith('pm')) {
        pmConversation.getState().add({ who: 'owner', text: req.question ?? '', restricted: req.restricted === true, kind: req.kind as never });
        pmConversation.getState().add({ who: 'pm', reply: { kind: req.kind as never, subjectTaskId: req.taskId, outcome: outcome as never } });
      } else {
        hybridResults.getState().set(resultKey(req.taskId, req.kind as AgentActionKind), { phase: 'done', outcome: outcome as never });
      }
      store.getState().refresh();
    },
  }) : null), [agentRuntime, state.agentSource, state.projectId, store, engine]);
  useEffect(() => {
    if (!engine || !agents) return;
    engine.attach(agents as unknown as CheckpointRunner);
    watchNavigator();
    // A reload, or a new tab: the queue is read back, and whatever may be sent now is checked again and sent.
    void engine.load().then(() => engine.reconnect());
    return onReconnect(connectivity, () => void engine.reconnect());
  }, [engine, agents]);
  const checkpointState = useStore(engine?.store ?? EMPTY_CHECKPOINT_STORE);
  const onlineNow = useOnlineNow();
  const simulatedOffline = useSimulatedOffline();
  const calls = useInFlight(agents);
  const pmItems = pmProposals((x) => x.items);
  const online = useOnline();
  const hybrid = useMemo((): HybridValue => ({
    projectId: state.projectId, snapshot, live: connection === 'live', mode, execute: state.execute, refresh: state.refresh, resync: state.resync, agents,
    browser: { ...DEFAULT_BROWSER, online: online && onlineNow }, handover: state.handover, checkpoints: engine,
  }), [state.projectId, snapshot, connection, mode, state.execute, state.refresh, state.resync, agents, online, onlineNow, state.handover, engine]);
  // A new store is a new projection (another fixture or project, or the demo loop starting over): the office treats it as a fresh start (round 2).
  const epoch = useMemo(() => nextEpoch(), [store]);
  const world = useMemo((): OfficeWorld | null => {
    if (!snapshot || !team) return null;
    // H12: a step waiting to be sent to the cloud stands at the rooftop CLOUD deck, marked waiting; offline, the roof says so.
    const waiting = waitingCloudCalls(Object.values(checkpointState.checkpoints)).filter((w) => !calls.some((c) => c.taskId === w.taskId));
    try { return buildOfficeWorld(snapshot, team, projectLabel, planRunId, [...calls.map((c) => ({ taskId: c.taskId, place: c.place, stepKind: c.kind })), ...waiting], `${snapshot.meta.projectId}#${epoch}`, { offline: !onlineNow }); } catch { return null; }
  }, [snapshot, team, projectLabel, planRunId, calls, epoch, checkpointState.checkpoints, onlineNow]);
  const activity = useMemo(() => {
    if ((route !== 'office' && !panelWide) || !snapshot) return [];
    const titleOf = (id: string): string => snapshot.tasks[id]?.title ?? id;
    try { return recentActivity(snapshot, 7, checkpointActivity(Object.values(checkpointState.checkpoints), titleOf)); } catch { return []; }
  }, [route, panelWide, snapshot, checkpointState.checkpoints]);
  const fallback = useMemo(() => { try { return snapshot && world ? latestFallback(snapshot, world.planRunId) : null; } catch { return null; } }, [snapshot, world]);
  const aiCounts = useMemo(() => { try { return snapshot && world ? aiRunCounts(snapshot, world.planRunId) : null; } catch { return null; } }, [snapshot, world]);
  const frame = frameOf(route);
  // The Action items drawer: what workers ask with no card of its own goes under "From workers"; records needing nothing from you stay visible as "Noted".
  const titles = useMemo(() => Object.fromEntries(Object.values(snapshot?.tasks ?? {}).map((t) => [t.taskId, t.title ?? t.taskId])), [snapshot]);
  const asks = overview ? overview.attention.filter((i) => i.needsOperator && i.decisionId === null) : [];
  const notes = overview ? overview.attention.filter((i) => !i.needsOperator) : [];
  const actionsFromWorkers = asks.length > 0 ? <ol className="space-y-3" aria-label="Asks from workers">{asks.map((i, n) => <AttentionRow key={i.id} item={i} top={n === 0} titles={titles} nowMs={state.nowMs} />)}</ol> : null;
  const actionsNoted = notes.length > 0 ? (
    <section aria-labelledby="noted-title" data-testid="actions-noted">
      <h2 id="noted-title" className="mb-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">Noted, nothing for you to do</h2>
      <ol className="space-y-3">{notes.map((i) => <AttentionRow key={i.id} item={i} top={false} titles={titles} nowMs={state.nowMs} />)}</ol>
    </section>
  ) : null;
  // An approval card's worker: the one holding the task the request is about.
  const workerOfCard = (card: { id: string }): { id: string; label: string } | null => {
    if (!snapshot || !card.id.startsWith('decision:')) return null;
    const taskId = snapshot.approvals[card.id.slice('decision:'.length)]?.taskId ?? null;
    const w = taskId ? Object.values(snapshot.workers).find((x) => x.taskId === taskId) : undefined;
    if (!w) return null;
    return { id: w.workerId, label: workerIdentity(snapshot, w.workerId, snapshot.tasks[taskId!]?.role ?? null).label };
  };
  // H11 fix round 1 (I3): the Project Manager's assignments waiting for the owner count as waiting too.
  const pmWaiting = proposalRows(snapshot, pmItems).length;
  // H12: paused AI steps count as waiting on you too.
  const titleOfTask = (id: string): string => snapshot?.tasks[id]?.title ?? id;
  const pausedCount = engine ? pausedRows(checkpointState, titleOfTask, onlineNow).length : 0;
  const waitingCount = (builtDecisions.decisions?.waiting ?? 0) + asks.length + pmWaiting + pausedCount;
  // Each panel row shows its office robot and, for the first nine, the number key that opens it.
  const agentById = useMemo(() => new Map(world?.agents.map((a) => [a.id, a]) ?? []), [world]);
  const mark = (id: string, i: number): RowDecor => {
    const a = agentById.get(id);
    // The worker card shows the effective route of its task's AI steps (inference), beside its model and sandbox.
    const taskId = snapshot?.workers[id]?.taskId ?? team?.rows.find((r) => r.workerId === id)?.task?.taskId ?? null;
    const route = taskId ? snapshot?.tasks[taskId]?.route : undefined;
    return { portrait: a ? <Portrait color={a.color} size={40} /> : null, key: i < 9 ? String(i + 1) : null, chip: a?.state ?? null, route: route ? workerRouteText(route) : null };
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
  const openPlace = (place: 'plan' | 'prs' | 'pm'): void => { window.location.hash = hrefFor(place === 'plan' ? 'pipeline' : place === 'pm' ? 'pm' : 'evidence'); };

  const views = (
    <>
        {route === 'summary' ? (
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
        {route === 'actions' ? (
          <RouteBoundary resetKey={`actions:${builtDecisions.failure === undefined ? 'ok' : 'failed'}`}>
            <DecisionsView
              fromWorkers={actionsFromWorkers} noted={actionsNoted} workerOf={workerOfCard}
              connection={connection} error={state.error} model={builtDecisions.decisions} failure={builtDecisions.failure} confirmedAt={confirmedAt} nowMs={state.nowMs} mode={mode} leaveDemoHref={leaveDemoHref}
              delivery={overview ? { criteria: overview.delivery.criteriaLabel, blocker: overview.delivery.blocker } : null}
              elsewhere={(overview ? overview.attention.filter((i) => i.needsOperator && i.decisionId === null).length : 0) + pausedCount}
              paused={engine ? <PausedWork engine={engine} titleOf={titleOfTask} simulated={mode === 'mock'} /> : null}
              counted={overview ? overview.attention.filter((i) => i.needsOperator && i.decisionId !== null).length : 0}
              onRestart={state.restart} onExecute={state.execute} onRefresh={state.refresh} onResync={state.resync}
              brain={<><PmProposals /><BrainConflicts port={state.brain} /><ProductFollowUps port={state.product} /><HandoverDecisions port={state.handover} refreshKey={snapshot?.meta.cursor ?? '0'} live={connection === 'live'} titleOf={(id) => snapshot?.tasks[id]?.title ?? null} /></>}
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
        {route === 'pm' ? (
          <RouteBoundary resetKey="pm">
            <PmPanel />
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
        {/* The assistant lives in a portal (below) so moving through the drawer and the Settings modal never discards a draft; this is where it shows. */}
        {route === 'assistant' && assistant !== null ? <PortalSlot el={assistantHost} /> : null}
    </>
  );

  const pausedHint = drawerBeside ? (
    <div className="pointer-events-none absolute inset-0 z-20 bg-paper/60">
      <p data-testid="page-paused-hint" className="absolute bottom-3 left-4 right-4 mx-auto max-w-[24rem] border-2 border-ink bg-paper px-3 py-2 text-sm text-fg rounded-[4px] shadow-[2px_3px_0_rgba(43,29,20,0.22)]">The page is paused while a worker is open. Close the worker to use the page.</p>
    </div>
  ) : null;

  return (
    <HybridProvider value={hybrid}>
    <div className="relative min-h-screen">
      <div ref={chromeRef}>
        <OfficeCanvas world={world} insets={insets} onOpenWorker={openWorker} onOpenPlace={openPlace} subject={frame === 'office'} speed={mode === 'mock' ? speed : 1} paused={frame === 'settings' || (frame === 'drawer' && drawerMaximized && panelWide)} />
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:bg-paper focus:px-3 focus:py-2 focus:text-ink">Skip to content</a>
        <Announcer message={announcement} />
        <TopBar
          ref={headerRef} route={route} projectLabel={projectLabel} mode={mode} connection={connection} confirmedAt={confirmedAt} nowMs={state.nowMs} account={account}
          attentionCount={attentionCount} attentionNumber={builtDecisions.decisions ? waitingCount : null} attentionUrgent={overview !== null && overview.needsYou > 0} attentionBadge={attentionBadge} decisionCount={decisionCount} panelWide={panelWide}
          runs={world?.runs ?? []} planRunId={world?.planRunId ?? planRunId} onPlanRun={setPlanRunId} speed={speed} onSpeed={setSpeed} running={world ? world.running : null} aiCounts={aiCounts}
          workers={world?.agents.filter((a) => !a.notStarted).map((a) => ({ id: a.id, name: a.name })) ?? []} selectedWorker={workerId}
          debugOpen={debugOpen} onDebug={import.meta.env.DEV ? () => setDebugOpen((o) => !o) : null}
          teamToggle={<TeamFoldToggle status={panelStatus} open={foldOpen} onOpenChange={setFoldOpen} regionId={foldId} />}
          teamFold={<TeamFoldRegion status={panelStatus} open={foldOpen} onOpenChange={setFoldOpen} regionId={foldId} selectedId={workerId} onOpen={openWorker} mark={mark} />}
        />
        <ConnectionBanner connection={connection} />
        {panelWide ? <TeamPanelSide status={panelStatus} selectedId={workerId} onOpen={openWorker} mark={mark} /> : null}
        {panelWide ? <ActivityFeed items={activity} fallback={fallback} nowMs={state.nowMs} stale={stale} /> : null}
      </div>

      {/* The screen in front of the office. Under a worker open beside the team cards it is inert; the scrim and the hint say why it does not respond. */}
      {/* Floating, it is the area right of the team cards; it only takes the pointer while paused, so the office stays clickable around a drawer. */}
      <div ref={contentRef} className={`relative z-20 min-w-0 xl:fixed xl:top-[74px] xl:right-4 xl:bottom-4 xl:left-[312px] ${drawerBeside ? 'cursor-default after:pointer-events-none after:absolute after:inset-0 after:z-30 after:bg-paper/40 after:content-[\'\']' : 'pointer-events-none'}`} data-testid="page-content" data-frame={frame} data-paused={drawerBeside ? 'true' : undefined}>
        {frame === 'office' ? (
          <>
            {pausedHint ? <div className="fixed inset-x-0 top-[74px]">{pausedHint}</div> : null}
            <OfficeHome world={world} wide={panelWide} activity={<ActivityFeed items={activity} fallback={fallback} nowMs={state.nowMs} stale={stale} />} />
          </>
        ) : frame === 'settings' ? (
          <SettingsModal paused={pausedHint}>{views}</SettingsModal>
        ) : (
          <ViewDrawer view={route} title={TITLES[route]} paused={pausedHint} aside={route === 'actions' && builtDecisions.decisions ? `${waitingCount} waiting on you` : null}>
            {views}
          </ViewDrawer>
        )}
        {/* Inside the page region, so it is inert like the rest of the page while a worker is open beside the team cards. */}
        {import.meta.env.DEV && debugOpen ? <DebugPanel connection={connection} snapshot={snapshot} world={world} onClose={() => setDebugOpen(false)}>{devPanel}{mode === 'mock' ? <DemoNetwork offline={simulatedOffline} /> : null}</DebugPanel> : null}
      </div>
      {/* The page under a worker open beside the team cards is inert, and an inert region is not hit-tested: this catcher gives the paused area its arrow pointer. */}
      {drawerBeside ? <div aria-hidden="true" className="fixed z-[19] cursor-default xl:top-[74px] xl:right-4 xl:bottom-4 xl:left-[312px]" /> : null}
      {assistant !== null && assistantOpened ? createPortal(
        <RouteBoundary resetKey="assistant">
          <Suspense fallback={<p role="status" className="text-muted">Loading the assistant</p>}>{assistant}</Suspense>
        </RouteBoundary>,
        assistantHost,
      ) : null}
      <Tooltip />
      {workerId !== null && team !== null && snapshot !== null ? (
        <WorkerDrawerHost
          look={agentById.get(workerId) ?? null} workerId={workerId} tab={tabOf(workerTab) ?? undefined} team={team} snapshot={snapshot} decisions={builtDecisions.decisions} connection={connection} mode={mode} nowMs={state.nowMs}
          onClose={closeWorker} onTab={(t: TabId) => replaceHashQuery({ wtab: t === 'task' ? null : t })}
          onExecute={state.execute} onRefresh={state.refresh} onResync={state.resync} onOpenTerminal={state.openTerminal} onOpenTerminalControl={state.openTerminalControl} brain={state.brain} skills={state.skills} handover={state.handover}
        />
      ) : null}
    </div>
    </HybridProvider>
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

/** Shows a long-lived element here while mounted, and lets it go (without unmounting what React rendered into it) when not. */
function PortalSlot({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.appendChild(el);
    return () => { if (el.parentElement === host) host.removeChild(el); };
  }, [el]);
  return <div ref={ref} />;
}
