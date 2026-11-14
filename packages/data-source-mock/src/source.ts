import { demoPlanBriefNotes } from './plan-brief.ts';
import {
  AuthorizedTerminalRequestSchema, AuthorizedViewCommandSchema, CriteriaRevisionRequestSchema, CursorSchema, DataSourceException, TERMINAL_MAX_LINES, applyEvent, approvalStateAt, cursorToSequence, emptySnapshot,
  isoOf, projectionFromSnapshot, sequenceToCursor,
  isReverifiableReason,
  type AuthorizedTerminalRequest, type AuthorizedViewCommand, type ChangeRequestView, type Clock, type ModelAssignmentView, type ModelCatalogView, type CommandReceipt, type DataSourceError, type EngineeringDataSource, type NotDelivered, type ProjectViewEvent,
  type ProjectViewSnapshot, type ProposalAcceptReceipt, type ProjectionState, type RunView, type ScopeAssessment, type SettingView, type TaskView, type BoundedAutonomy, type DelegationReceipt, type TerminalChannel, type TerminalControlChannel, type TerminalControlState, type TerminalState,
} from '@selarikru/view-protocol';
import { APPLY_MODEL, APPLY_PROVIDER, AiCheckpointSchema, effectiveRoutePolicy, escalationDecision, serverCheckpointRefusal, type AiCheckpoint, MAX_ATTEMPTS_CAP, canonicalJson, mapPmPlan, sha256Hex, checkDelegation, delegationOutputSha256, workerNameProblem, workerRoleOf, PROJECT_MANAGER_ROLE, RoutePolicyModeSchema, approvalUnavailableReason, strongerLabel, criterionDescription, isCloudCapable, SETTING_ENFORCER, type RouteRecord, type SettingChange } from '@selarikru/domain';
import type { VirtualClock } from './clock.ts';
import { DEMO_CATALOG, FIXTURE_T0_MS, HUMAN, INTEGRATION, REAPER, SCHEDULER, scoped, type Fixture, type TaskSeed } from './builder.ts';
import { buildDemoFixtures } from './fixtures.ts';
import { mulberry32, seededId } from './prng.ts';
import { createDemoBrain } from './brain.ts';
import { createDemoStack } from './stack.ts';
import { createDemoSkills } from './skills.ts';
import { createDemoProduct } from './product.ts';
import { createDemoHandover } from './handover.ts';
import { acceptDemoProposal, checkDestination, demoBaseFiles, demoFileListing, demoTaskContext, reviseDemoCriteria } from './agent-context.ts';
import { routeLockOf, routeRecordOf, runRouteDefaultOf, seededRouteRecords, seededRouteSettings, taskRouteOf, withRouteLocks, type FixtureRoutes } from './routes.ts';

interface Subscriber {
  cursor: number;
  readonly onEvent: (event: ProjectViewEvent) => void;
  readonly onError: (error: DataSourceError) => void;
  active: boolean;
}

interface Project {
  readonly fixture: Fixture;
  /** Fixture events not yet due. Sequences are assigned when an event is released, so commands can slot in without a clash. */
  pending: ProjectViewEvent[];
  readonly released: ProjectViewEvent[];
  /** The server-side view: what a snapshot returns. It knows what events do not say (task titles, approval ids), as a database would. */
  state: ProjectionState;
  readonly subscribers: Set<Subscriber>;
  readonly receipts: Map<string, CommandReceipt>;
  /** Pull requests, as the provider last reported them. Merge reconciliation has no event. */
  changeRequests: ChangeRequestView[];
  /** Re-verifications spent per task revision, bounded like the real route. */
  readonly reverifyCounts: Map<string, number>;
  /** The adapter's declared models and the current assignments, as the real tables would hold them. */
  readonly modelCatalog: ModelCatalogView;
  modelAssignments: ModelAssignmentView[];
  /** Every assignment's revision, including removed ones: the real route's optimistic check never forgets. */
  readonly assignmentRevisions: Map<string, number>;
  /** Saved run and worker settings, as the real tables would hold them. */
  settings: SettingView[];
  /** Run cancels requested and not yet confirmed. */
  readonly cancels: Map<string, { readonly requestedAt: string }>;
  /** Scripted events held back while their run is paused: an attempt start, and everything after it for that task. Released, in order, on resume. */
  held: ProjectViewEvent[];
  readonly heldTasks: Set<string>;
  /** Every route record per task, newest first, as the browser reported them. */
  readonly routeRecords: Map<string, RouteRecord[]>;
  /** Criteria reworded by an accepted proposal, by task. Simulated. */
  readonly criteria: Map<string, { id: string; text: string }[]>;
  /** Proposals accepted in the demo, by proposal id, with the key that accepted them. Nothing is applied. */
  readonly acceptedProposals: Map<string, { key: string; receipt: ProposalAcceptReceipt }>;
  /** As the server's backstop: the label of each served context, by context id, and the context each reported call names, by request id. Simulated. */
  readonly contextLabels: Map<string, string>;
  readonly reportContexts: Map<string, { taskId: string; contextId: string | null; locked: boolean }>;
  /** H11 fix round 1: each pmDelegate record authorises one delegation: the request it was used for (to replay a retry) and its answer. */
  readonly usedDelegations: Map<string, { print: string; result: DelegationReceipt }>;
  /** H12: AI step checkpoints the demo keeps as the server would: public and internal only, by checkpoint id. Simulated. */
  readonly aiCheckpoints: Map<string, AiCheckpoint>;
  /** Fix round 2 (N4): the claim token of each checkpoint being sent. */
  readonly claimTokens: Map<string, string>;
}

const NO_ROUTES: FixtureRoutes = { runDefault: null, tasks: {} };

export interface MockOptions {
  readonly clock: VirtualClock;
  /** Defaults to the ten named fixtures. */
  readonly fixtures?: readonly Fixture[];
  /**
   * H12 fix round 2 (N1): the demo's simulated offline (Debug › Go offline). While it is true, the checkpoint calls fail as a network failure would against the
   * live server, so the demo behaves as live does. Absent: never offline.
   */
  readonly isOffline?: () => boolean;
  /**
   * H9 fix round 1 (H1): coding workers on, with their catalog and the model each attempt records (`CLAUDE_DEMO` for dev `?demo&codingWorkers=claude_code`).
   * Absent: the hackathon build, coding workers off: the apply harness only, and every attempt records the apply worker (no model).
   */
  readonly codingWorkers?: { readonly catalog: ModelCatalogView; readonly assignment: { readonly provider: string; readonly model: string } } | null;
}

/**
 * H9 fix round 1 (H1): a fixture's events for the build's coding-workers setting. Off: an attempt records the apply worker, whose model route is none, and a
 * benchmark trial pins nothing. On: the coding worker's model, as before.
 */
function forCodingWorkers(events: readonly ProjectViewEvent[], on: MockOptions['codingWorkers']): ProjectViewEvent[] {
  return events.map((e) => {
    const p = e.payload as Record<string, unknown> | null | undefined;
    if (!p || (e.type !== 'attempt.started' && e.type !== 'run.created')) return e;
    if (e.type === 'run.created' && p['pinnedModel']) {
      if (on) return { ...e, payload: { ...p, pinnedModel: { ...on.assignment } } };
      const { pinnedModel: _pin, ...rest } = p;
      void _pin;
      return { ...e, payload: rest } as ProjectViewEvent;
    }
    const a = p['assignment'] as { source?: string } | undefined;
    if (e.type !== 'attempt.started' || !a) return e;
    if (on) return { ...e, payload: { ...p, assignment: { ...on.assignment, source: a.source } } };
    return { ...e, payload: { ...p, modelRoute: 'none', assignment: { provider: APPLY_PROVIDER, model: APPLY_MODEL, source: 'role' } } };
  });
}

export interface MockDataSource extends EngineeringDataSource {
  readonly mode: 'mock';
  readonly clock: VirtualClock;
  /** The clock a project's UI should read: the shared virtual clock shifted to that fixture's start time. */
  clockFor(projectId: string): Clock;
  listProjects(): readonly { projectId: string; fixtureId: Fixture['id']; name: string; description: string }[];
  /** How many scripted events of a project are still to come (H7 fix: the demo's playback loops when this reaches zero). */
  pendingCount(projectId: string): number;
}

/** The same lists the real cancel route uses: a running task gets a cancel request, these cancel at once, anything else is refused. */
const IMMEDIATE_CANCEL: readonly string[] = ['planned', 'ready', 'awaiting_approval', 'blocked', 'verifying'];
const HEARTBEAT_STEP_MS = 10_000;
/** The paths every demo plan lists. Simulated: a demo setting can only narrow these, as the real one can only narrow its plan's. */
const DEMO_PLAN_PATHS: readonly string[] = ['src', 'tests'];
/** How long a simulated running attempt takes to stop after a cancel. */
const STOP_MS = 2_000;
/** The route's `REVERIFY_LIMIT`: re-verifications per task revision. */
const REVERIFY_LIMIT = 3;
const NOT_OWED: readonly string[] = ['verified', 'merged', 'superseded'];
/** Fixture activity: what a worker reports through its heartbeat, one tool name every 15 s from the attempt's start. Simulated, and only ever a tool name. */
const TOOL_CYCLE = ['Read', 'Grep', 'Edit', 'Bash'] as const;
const TOOL_STEP_MS = 15_000;
/** The candidate every fixture's verdicts judge. Simulated, never a real commit. */
const SIMULATED_CANDIDATE = 'c'.repeat(40);
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
/** The mock's stand-in for the server's SHA-256: deterministic over the same fields, and never presented as a real digest. */
function digest(notDelivered: NotDelivered): string {
  const text = JSON.stringify([notDelivered.tasks.map((t) => [t.taskId, t.revision, t.status, t.budgetStopped]), notDelivered.requirementIds, notDelivered.acceptanceCheckIds]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `simulated-${h.toString(16)}`;
}

const fail = (code: DataSourceError['code'], message: string, retryable = false): DataSourceException => new DataSourceException({ code, message, retryable });

function seedTask(seed: TaskSeed, runId: string, at: string, prior?: TaskView): TaskView {
  return {
    taskId: seed.taskId, runId, revision: seed.revision, aggregateRevision: prior?.aggregateRevision ?? 0, title: seed.title, role: seed.role, dependsOn: [...seed.dependsOn],
    status: 'planned', statusReason: null, placementBlock: null, cancelRequested: null, cancelReason: null, supersededByRevision: null, attemptIds: prior?.attemptIds ?? [],
    activeAttemptId: null, enteredStatusAt: at, latestEvidence: null,
  };
}

/**
 * A deterministic in-memory EngineeringDataSource. It holds every fixture as a project, releases events as the injected virtual clock
 * advances, and answers commands with simulated receipts. It plays the server: its snapshots carry what events do not (titles,
 * dependencies, approval ids, heartbeat times) while the events it streams are the plain domain events. It imports no runtime or provider
 * client and never touches the network. Everything it returns is labelled `simulated`; none of it is evidence.
 */
export function createMockDataSource(options: MockOptions): MockDataSource {
  const { clock } = options;
  const offlineCheck = (): void => { if (options.isOffline?.()) throw fail('unavailable', 'unavailable: network error (demo offline)', true); };
  const timeOf = (p: Project): number => clock.nowMs() + p.fixture.startSec * 1000;
  const projects = new Map<string, Project>();
  let closed = false;

  for (const fixture of options.fixtures ?? buildDemoFixtures()) {
    projects.set(fixture.projectId, {
      fixture, pending: forCodingWorkers(fixture.events, options.codingWorkers ?? null), released: [], subscribers: new Set(), receipts: new Map(), changeRequests: [...(fixture.changeRequests ?? [])], reverifyCounts: new Map(),
      // A fixture's own catalog (no-data: nothing detected) keeps its providers, and follows the build's coding-workers setting.
      modelCatalog: fixture.modelCatalog ? (options.codingWorkers ? { ...fixture.modelCatalog, codingWorkers: options.codingWorkers.catalog.codingWorkers } : fixture.modelCatalog) : options.codingWorkers?.catalog ?? DEMO_CATALOG, modelAssignments: (fixture.modelAssignments ?? []).map((a) => ({ ...a, state: a.state ?? 'applied' as const })), assignmentRevisions: new Map((fixture.modelAssignments ?? []).map((a) => [`${a.scope}:${a.key}`, a.revision])),
      settings: fixture.routes ? seededRouteSettings(fixture.routes, isoOf(clock.nowMs() + fixture.startSec * 1000)) : [], cancels: new Map(), held: [], heldTasks: new Set(),
      criteria: new Map(),
      acceptedProposals: new Map(),
      contextLabels: new Map(),
      reportContexts: new Map(),
      usedDelegations: new Map(),
      aiCheckpoints: new Map(),
      claimTokens: new Map(),
      routeRecords: fixture.routes ? seededRouteRecords(fixture.routes, seededRouteSettings(fixture.routes, ''), scoped(fixture.id, 'run')) : new Map(),
      state: projectionFromSnapshot(emptySnapshot({ projectId: fixture.projectId, observedAt: isoOf(clock.nowMs() + fixture.startSec * 1000), provenance: 'simulated' })),
    });
  }

  const tick = (): void => {
    for (const p of projects.values()) {
      release(p);
      flushAll(p);
    }
  };

  /** Applies a released event to the server-side view, filling in what a database would hold. The event itself is delivered untouched. */
  function serverApply(p: Project, event: ProjectViewEvent): void {
    let snap = p.state.snapshot;
    const seeds = p.fixture.tasks;
    const seedFor = (taskId: string, planRevision: number): TaskSeed | undefined =>
      seeds.filter((s) => s.taskId === taskId && s.planRevision <= planRevision).sort((a, b) => b.revision - a.revision)[0];

    if (event.type === 'plan.accepted') {
      // The server owns tasks: accepting a plan creates or re-plans every task it lists, at the revision that plan introduced.
      const planRevision = Number(event.payload['planRevision'] ?? 1);
      const ids = Array.isArray(event.payload['taskIds']) ? (event.payload['taskIds'] as string[]) : [];
      let tasks = snap.tasks;
      // A criteria revision accepted in the demo re-plans a task the fixture has no new seed for: its next revision, planned again, as the plan route does.
      const replanned = Array.isArray(event.payload['replanned']) ? (event.payload['replanned'] as string[]) : [];
      // A Project Manager plan the demo accepted (fix round 2): its items carry the PM's title, role and dependencies.
      const pmItems = Array.isArray(event.payload['pmPlan']) ? (event.payload['pmPlan'] as { taskId: string; revision: number; title: string; role: string; dependencies: { taskId: string }[] }[]) : [];
      for (const m of pmItems) {
        const prior = tasks[m.taskId];
        const base: TaskView = prior ?? { taskId: m.taskId, runId: event.runId, revision: 1, aggregateRevision: 0, title: m.title, role: m.role, dependsOn: [], status: 'planned', statusReason: null, placementBlock: null, cancelRequested: null, cancelReason: null, supersededByRevision: null, attemptIds: [], activeAttemptId: null, enteredStatusAt: event.occurredAt, latestEvidence: null };
        tasks = { ...tasks, [m.taskId]: { ...base, revision: m.revision, aggregateRevision: base.aggregateRevision + 1, title: m.title, role: m.role, dependsOn: m.dependencies.map((d) => d.taskId), status: 'planned', statusReason: null, placementBlock: null, activeAttemptId: null, enteredStatusAt: event.occurredAt, supersededByRevision: null } };
      }
      for (const id of ids) {
        if (pmItems.some((m) => m.taskId === id)) continue;
        const prior = tasks[id];
        if (replanned.includes(id) && prior) {
          tasks = { ...tasks, [id]: { ...prior, revision: prior.revision + 1, aggregateRevision: prior.aggregateRevision + 1, status: 'planned', statusReason: null, placementBlock: null, activeAttemptId: null, enteredStatusAt: event.occurredAt, supersededByRevision: null } };
          continue;
        }
        const seed = seedFor(id, planRevision);
        if (seed) tasks = { ...tasks, [id]: seedTask(seed, event.runId, event.occurredAt, tasks[id]) };
      }
      const run = snap.runs[event.runId] ?? { runId: event.runId, lifecycle: 'running' as const, planRevision: 0, latestEvidence: null, criteria: null, evidence: null, reducedScope: null, scopeAssessment: null, pinnedModel: null };
      snap = {
        ...snap, tasks, runs: { ...snap.runs, [event.runId]: { ...run, lifecycle: 'running', planRevision } },
        meta: { ...snap.meta, cursor: sequenceToCursor(event.sequence), observedAt: event.receivedAt },
      };
      p.state = { snapshot: snap, recentEventIds: [...p.state.recentEventIds, event.eventId].slice(-512) };
      return;
    }

    // What the real server reads from its own rows: the reducer asks for a snapshot on these, so the mock keeps them here and only moves its cursor.
    if (event.type === 'settings.changed' || event.type === 'settings.applied' || event.type === 'run.cancel_requested' || event.type === 'run.cancelled') {
      if (event.type === 'settings.applied') {
        const key = event.payload['key'];
        const field = event.payload['field'];
        const revision = event.payload['revision'];
        if (event.payload['scope'] === 'assignment') p.modelAssignments = p.modelAssignments.map((a) => (`${a.scope}:${a.key}` === key && a.revision === revision ? { ...a, state: 'applied' as const } : a));
        else p.settings = p.settings.map((x) => (x.key === key && x.field === field && x.desiredRevision === revision ? { ...x, effective: x.desired, effectiveRevision: x.desiredRevision, state: 'applied' as const, appliedAt: event.occurredAt } : x));
      }
      let next = snap;
      const run = snap.runs[event.runId];
      if (event.type === 'run.cancel_requested' && run) next = { ...next, runs: { ...next.runs, [event.runId]: { ...run, cancel: { requestedAt: event.occurredAt, requestedBy: event.actor.id } } } };
      if (event.type === 'run.cancelled' && run) {
        p.cancels.delete(event.runId);
        next = { ...next, runs: { ...next.runs, [event.runId]: { ...run, lifecycle: 'cancelled' } } };
      }
      p.state = { snapshot: { ...next, meta: { ...next.meta, cursor: sequenceToCursor(event.sequence), observedAt: event.receivedAt } }, recentEventIds: [...p.state.recentEventIds, event.eventId].slice(-512) };
      return;
    }

    let applied = event;
    if (event.type === 'approval.requested' && typeof event.payload['approvalId'] !== 'string') {
      const seed = p.fixture.approvals.find((a) => a.taskId === (event.taskId === event.runId ? null : event.taskId) && !snap.approvals[a.approvalId]);
      if (seed) applied = { ...event, payload: { ...event.payload, approvalId: seed.approvalId, scopeHash: seed.scopeHash, expiresAt: seed.expiresAt, ...(seed.operation !== null ? { operation: seed.operation } : {}), ...(seed.destination !== null ? { destination: seed.destination, destinationKind: 'network_host' } : {}) } };
    }
    const result = applyEvent(p.state, applied);
    if (result.outcome === 'resync' || result.outcome === 'duplicate') throw new Error(`mock fixture ${p.fixture.id} is inconsistent at ${event.type}: ${result.outcome}`);
    p.state = result.state;
    // The provider's merge record arrives when the merge does. Only the run-level event states it; merge reconciliation has no event of its own on the real server.
    if (event.type === 'change.merged' && event.taskId === event.runId) {
      const mergeCommitSha = typeof event.payload['mergeCommitSha'] === 'string' ? event.payload['mergeCommitSha'] : null;
      p.changeRequests = p.changeRequests.map((c) => (c.runId === event.runId ? { ...c, status: 'merged', mergeCommitSha, observedAt: event.occurredAt } : c));
    }
    advanceLifecycle(p, event.runId);
  }

  /** The server writes run lifecycle with no event: ready_for_review with the last verdict, merged once every task is merged. */
  function advanceLifecycle(p: Project, runId: string): void {
    const snap = p.state.snapshot;
    const run = snap.runs[runId];
    if (!run) return;
    const tasks = Object.values(snap.tasks).filter((t) => t.runId === runId && t.status !== 'cancelled' && t.status !== 'superseded');
    let lifecycle = run.lifecycle;
    if ((lifecycle === 'running' || lifecycle === 'blocked') && tasks.length > 0 && tasks.every((t) => t.status === 'verified' || t.status === 'merged')) lifecycle = 'ready_for_review';
    if (lifecycle === 'ready_for_review' && tasks.length > 0 && tasks.every((t) => t.status === 'merged')) lifecycle = 'merged';
    if (lifecycle !== run.lifecycle) p.state = { ...p.state, snapshot: { ...snap, runs: { ...snap.runs, [runId]: { ...run, lifecycle } } } };
  }

  function accept(p: Project, event: ProjectViewEvent): void {
    const numbered = { ...event, sequence: p.released.length + 1 };
    serverApply(p, numbered);
    p.released.push(numbered);
    // A cancelled task takes no further events: whatever the fixture had scheduled for it is dropped.
    if (numbered.type === 'task.cancelled') p.pending = p.pending.filter((e) => e.taskId !== numbered.taskId);
  }

  const runPaused = (p: Project, runId: string): boolean => p.settings.some((x) => x.scope === 'run' && x.key === runId && x.field === 'paused' && x.desired === true);

  function release(p: Project): void {
    const now = timeOf(p);
    while (p.pending[0] && Date.parse(p.pending[0].occurredAt) <= now) {
      const e = p.pending.shift()!;
      // As the server's claim gate does: a paused run starts no attempt. The start, and what the script has that task do next, wait for the resume.
      if (p.heldTasks.has(e.taskId) || (e.type === 'attempt.started' && runPaused(p, e.runId))) {
        p.held.push(e);
        p.heldTasks.add(e.taskId);
        continue;
      }
      accept(p, e);
    }
  }

  /** On resume, the held starts happen at the scheduler's next claim, one second on, and the rest of those tasks' script moves with them. */
  function releaseHeld(p: Project): void {
    if (p.held.length === 0) return;
    const delta = timeOf(p) + 1_000 - Date.parse(p.held[0]!.occurredAt);
    const shift = (e: ProjectViewEvent): ProjectViewEvent => ({ ...e, occurredAt: isoOf(Date.parse(e.occurredAt) + delta), receivedAt: isoOf(Date.parse(e.receivedAt) + delta) });
    const later = p.pending.filter((e) => p.heldTasks.has(e.taskId));
    p.pending = [...p.pending.filter((e) => !p.heldTasks.has(e.taskId)), ...p.held.map(shift), ...later.map(shift)].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    p.held = [];
    p.heldTasks.clear();
  }

  function flush(p: Project, sub: Subscriber): void {
    while (sub.active && sub.cursor < p.released.length) {
      const event = p.released[sub.cursor]!;
      sub.cursor += 1;
      sub.onEvent(event);
    }
  }
  const flushAll = (p: Project): void => {
    for (const s of [...p.subscribers]) flush(p, s);
  };

  // Seed the first snapshot: every event due at the clock's start.
  for (const p of projects.values()) release(p);
  const stopTicking = clock.onTick(tick);

  const project = (projectId: string): Project => {
    if (closed) throw fail('disconnected', 'the mock data source is disconnected');
    const p = projects.get(projectId);
    if (!p) throw fail('unknown_project', `no mock project ${projectId}`);
    return p;
  };

  /** Heartbeats every 10 s from the attempt's start, except inside the fixture's silent window. Heartbeats are snapshot liveness, never events. */
  function heartbeatAt(p: Project, attemptId: string, startedAt: string): string {
    const start = Date.parse(startedAt);
    const now = timeOf(p);
    const s = p.fixture.silences[attemptId];
    let limit = now;
    if (s) {
      const from = FIXTURE_T0_MS + s.fromSec * 1000;
      const to = s.toSec === null ? Number.POSITIVE_INFINITY : FIXTURE_T0_MS + s.toSec * 1000;
      if (now >= from && now < to) limit = from;
    }
    return isoOf(start + Math.floor(Math.max(0, limit - start) / HEARTBEAT_STEP_MS) * HEARTBEAT_STEP_MS);
  }

  /** Per-criterion counts as a server would hold them. A scene whose tasks declare no criteria reports null: per-criterion evidence is not connected. */
  function criteriaOf(p: Project, runId: string): RunView['criteria'] {
    // Approved criteria are the denominator: stopped work keeps its criteria in the total. Only superseded work leaves.
    const live = Object.values(p.state.snapshot.tasks).filter((t) => t.runId === runId && t.status !== 'superseded');
    if (live.length === 0) return null;
    let verified = 0;
    let total = 0;
    for (const t of live) {
      const seed = p.fixture.tasks.filter((x) => x.taskId === t.taskId && x.revision <= t.revision).sort((a, b) => b.revision - a.revision)[0];
      if (!seed || seed.criteria === null) return null;
      total += seed.criteria;
      if (t.status === 'verified' || t.status === 'merged') verified += seed.criteria;
    }
    return { verified, total };
  }

  /** Per-criterion evidence as a server would hold it. Null exactly when `criteria` is. The rows are built from the same seeds, so the two cannot disagree. */
  function evidenceOf(p: Project, runId: string): RunView['evidence'] {
    if (criteriaOf(p, runId) === null) return null;
    const snap = p.state.snapshot;
    const live = Object.values(snap.tasks).filter((t) => t.runId === runId && t.status !== 'superseded');
    const judged = Object.values(snap.checks).some((c) => live.some((t) => t.taskId === c.taskId));
    const candidate = judged ? {
      sha: SIMULATED_CANDIDATE, status: 'assembled', live: true, baseSha: 'b'.repeat(40), treeSha: 'd'.repeat(40), target: 'main', recordedAt: Object.values(snap.checks).map((c) => c.updatedAt).sort().at(-1)!,
      recordId: 'ver_simulated', recordValid: true, verifierHost: 'demo-verifier', checkManifestSha256: 'e'.repeat(64), verifierSha256: '1'.repeat(64), flaky: [],
    } : null;
    const criteria = live.flatMap((t) => {
      const seed = p.fixture.tasks.filter((x) => x.taskId === t.taskId && x.revision <= t.revision).sort((a, b) => b.revision - a.revision)[0]!;
      const check = Object.values(snap.checks).filter((c) => c.taskId === t.taskId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const verified = t.status === 'verified' || t.status === 'merged';
      const failed = t.status === 'failed' || check?.state === 'failed';
      const count = seed.criteria ?? 0;
      return Array.from({ length: count }, (_, i) => {
        const criterionId = seed.requirementIds.length === count ? seed.requirementIds[i]! : `${seed.taskId.split('.').at(-1)!.toUpperCase()}-${i + 1}`;
        const ran = (verified || failed) && check !== undefined && t.status !== 'cancelled';
        if (t.status === 'cancelled') return { criterionId, description: criterionDescription(criterionId), state: 'not_delivered' as const, verified: false, taskIds: [t.taskId], check: null, candidateSha: null };
        return {
          criterionId, description: criterionDescription(criterionId), state: ran ? (verified ? ('passed' as const) : ('failed' as const)) : ('not_run' as const), verified, taskIds: [t.taskId],
          check: ran ? { checkRunId: `${check.checkId}:${criterionId}`, checkId: criterionId, checkVersion: 'demo-1', taskId: t.taskId, revision: t.revision, attemptId: t.attemptIds.at(-1) ?? null, recordId: 'ver_simulated', verificationAttempt: 1, at: check.updatedAt } : null,
          candidateSha: ran ? SIMULATED_CANDIDATE : null,
        };
      });
    });
    return { candidate, criteria };
  }

  /** The same reading as the real `assessRunScope`: what the budget stopped, and what is and is not delivered. Null when nothing was stopped. */
  function scopeAssessmentOf(p: Project, runId: string): ScopeAssessment | null {
    const tasks = Object.values(p.state.snapshot.tasks).filter((t) => t.runId === runId).sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
    const stopped = tasks.filter((t) => t.status === 'cancelled' && t.cancelReason === 'budget_exhausted');
    if (stopped.length === 0) return null;
    const seedOf = (t: TaskView): TaskSeed | undefined => p.fixture.tasks.filter((s) => s.taskId === t.taskId && s.revision <= t.revision).sort((a, b) => b.revision - a.revision)[0];
    const owed = tasks.filter((t) => !NOT_OWED.includes(t.status));
    const requirementIds = sorted(owed.flatMap((t) => seedOf(t)?.requirementIds ?? []));
    const notDelivered: NotDelivered = {
      tasks: owed.map((t) => ({ taskId: t.taskId, revision: t.revision, status: t.status, budgetStopped: stopped.includes(t) })),
      requirementIds,
      acceptanceCheckIds: sorted(owed.flatMap((t) => seedOf(t)?.acceptanceCheckIds ?? [])),
    };
    const deliveredRequirementIds = sorted(tasks.filter((t) => t.status === 'verified' || t.status === 'merged').flatMap((t) => seedOf(t)?.requirementIds ?? [])).filter((id) => !requirementIds.includes(id));
    return { notDelivered, notDeliveredHash: digest(notDelivered), deliveredRequirementIds, stopped: stopped.map((t) => ({ taskId: t.taskId, revision: t.revision })), stoppingTaskIds: tasks.filter((t) => t.status === 'running' && (p.fixture.budgetStopping?.[t.taskId] ?? Number.POSITIVE_INFINITY) * 1000 + FIXTURE_T0_MS <= timeOf(p)).map((t) => t.taskId) };
  }

  /** True when the recorded acceptance names every task the budget stopped, at the revision it was stopped at. */
  const acceptanceCovers = (run: RunView, stopped: ScopeAssessment['stopped']): boolean => run.reducedScope !== null && stopped.every((s) => run.reducedScope!.notDelivered.tasks.some((t) => t.taskId === s.taskId && t.revision === s.revision));

  /** What the real snapshot returns for resolved requests, newest first. */
  function historyOf(s: ProjectViewSnapshot): ProjectViewSnapshot['approvalHistory'] {
    return Object.values(s.approvals)
      .filter((a): a is typeof a & { state: 'granted' | 'denied' | 'expired' | 'superseded' } => a.state !== 'pending')
      .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '') || a.approvalId.localeCompare(b.approvalId))
      .slice(0, 50)
      .map((a) => ({ approvalId: a.approvalId, runId: a.runId, taskId: a.taskId, revision: a.taskRevision, outcome: a.state, approver: a.state === 'granted' || a.state === 'denied' ? 'demo-operator' : null, scopeHash: a.scopeHash, operation: a.operation, destination: a.destination, requestedAt: a.requestedAt, resolvedAt: a.resolvedAt, consumedAt: null, consumedBy: null }));
  }

  function snapshotOf(p: Project): ProjectViewSnapshot {
    const s = p.state.snapshot;
    const attempts = Object.fromEntries(
      Object.entries(s.attempts).map(([id, a]) => [id, a.outcome === 'running' && a.endedAt === null ? { ...a, lastHeartbeatAt: heartbeatAt(p, id, a.startedAt) } : a]),
    );
    const workers = Object.fromEntries(
      Object.entries(s.workers).map(([id, w]) => {
        const a = w.attemptId !== null ? attempts[w.attemptId] : undefined;
        if (!w.leaseHeld || !a) return [id, w];
        if (p.fixture.reportsActivity === false) return [id, { ...w, lastHeartbeatAt: a.lastHeartbeatAt }];
        const worked = a.lastHeartbeatAt === null ? 0 : Math.floor((Date.parse(a.lastHeartbeatAt) - Date.parse(a.startedAt)) / TOOL_STEP_MS);
        const latestAction = { tool: TOOL_CYCLE[worked % TOOL_CYCLE.length]!, summary: null, longRunning: false, at: isoOf(Date.parse(a.startedAt) + worked * TOOL_STEP_MS) };
        return [id, { ...w, lastHeartbeatAt: a.lastHeartbeatAt, latestAction }];
      }),
    );
    const routes = p.fixture.routes;
    const runs = Object.fromEntries(Object.entries(s.runs).map(([id, r]) => [id, {
      ...r, criteria: criteriaOf(p, id), evidence: evidenceOf(p, id), scopeAssessment: scopeAssessmentOf(p, id), policy: policyOf(p, r, workers),
      ...(routes ? { routePolicy: runRouteDefaultOf(routes, p.settings, id) } : {}),
    }]));
    const tasks = routes ? Object.fromEntries(Object.entries(s.tasks).map(([id, t]) => [id, { ...t, route: routeViewOf(p, t) }])) : s.tasks;
    return { ...s, runs, tasks, attempts, workers, modelCatalog: p.modelCatalog, modelAssignments: p.modelAssignments.map((a) => ({ ...a })), settings: [...withRouteLocks(p.fixture.routes ?? NO_ROUTES, p.settings), ...demoNames(Object.keys(workers), p.settings, DEMO_NAMED_AT)], meta: { ...s.meta, observedAt: isoOf(timeOf(p)) }, assistant: p.fixture.assistant, usage: [...p.fixture.usage], changeRequests: p.changeRequests.map((c) => ({ ...c })), approvalHistory: historyOf(s), limits: { maxConcurrentTotal: 2 },
      runners: [...new Set(Object.values(workers).map((w) => w.workerId))].sort().map((runnerId) => ({ runnerId, location: runnerId.includes('cloud') ? ('cloud' as const) : ('local' as const), label: null, lastSeenAt: isoOf(Date.parse(Object.values(workers).find((w) => w.workerId === runnerId)!.lastHeartbeatAt ?? isoOf(timeOf(p)))) })),
    };
  }

  function contextState(p: Project, runId: string) {
    return { routes: p.fixture.routes, criteria: p.criteria, planRevision: p.state.snapshot.runs[runId]?.planRevision ?? 0 };
  }

  function routeViewOf(p: Project, t: { taskId: string; runId: string }) {
    return taskRouteOf(p.fixture.routes ?? NO_ROUTES, p.settings, t.runId, t.taskId, p.routeRecords.get(t.taskId)?.[0]);
  }

  /** The demo run's effective policy, built the way the server builds it from its rows. Simulated; never a real limit. */
  function policyOf(p: Project, r: RunView, workers: ProjectViewSnapshot['workers']): BoundedAutonomy {
    const own = (field: string) => p.settings.find((x) => x.scope === 'run' && x.key === r.runId && x.field === field);
    const cloud = Object.values(workers).some((w) => w.execution === 'cloud');
    const narrowed = own('allowed_paths');
    const cloudOff = own('cloud_eligible')?.effective === false;
    const limit = own('budget_limit_usd')?.effective ?? r.budgetLimitUsd ?? p.fixture.budgetLimitUsd ?? null;
    return {
      allowedPaths: { value: narrowed && Array.isArray(narrowed.effective) ? (narrowed.effective as string[]) : [...DEMO_PLAN_PATHS], basis: 'configured' },
      planPaths: [...DEMO_PLAN_PATHS],
      cloudEligible: { value: cloud && !cloudOff, basis: 'configured' },
      cloudDestination: { value: cloud ? 'cloud-sandbox-demo' : null, basis: 'configured' },
      destinations: { value: [], basis: 'configured' },
      maxConcurrentWorkers: { value: 2, basis: 'configured' },
      repairAttempts: { value: 2, basis: 'configured' },
      attemptTimeoutSeconds: { value: 1800, basis: 'configured' },
      budgetLimitUsd: typeof limit === 'number' ? { value: limit, basis: 'configured' } : { value: 25, basis: 'recommended' },
      merge: { value: 'human', basis: 'configured' },
      schedulingPaused: { value: own('paused')?.desired === true, basis: 'configured' },
    };
  }

  const prng = mulberry32(0x5e1a);
  /** Claim tokens draw from their own sequence, so they never shift the demo's event ids. */
  const claimPrng = mulberry32(0xc1a1);
  type CommandEvent = 'task.delegated' | 'plan.accepted' | 'proposal.accepted' | 'task.cancel_requested' | 'task.ready' | 'approval.granted' | 'approval.denied' | 'task.cancelled' | 'task.reopened' | 'run.reduced_scope_accepted' | 'change.proposed' | 'run.created' | 'settings.changed' | 'settings.applied' | 'run.cancel_requested' | 'run.cancelled'
    | 'handover.requested' | 'attempt.failed' | 'attempt.fenced' | 'attempt.started' | 'attempt.route_changed' | 'checkpoint.recorded' | 'checkpoint.refused' | 'handover.decided' | 'inference.reported';
  /** Who the services record as the actor of each simulated type that is not a person's. */
  const SCHEDULER_TYPES: readonly CommandEvent[] = ['task.ready', 'attempt.started', 'attempt.route_changed', 'checkpoint.recorded'];
  const SYSTEM_TYPES: readonly CommandEvent[] = ['attempt.failed', 'attempt.fenced', 'checkpoint.refused'];
  const RUN_ADDRESSED: readonly CommandEvent[] = ['plan.accepted', 'run.created', 'settings.changed', 'settings.applied', 'run.cancel_requested', 'run.cancelled'];
  function appendCommandEvent(p: Project, taskId: string, type: CommandEvent, payload: Record<string, unknown>, o: { delayMs?: number; revisionStep?: number; attemptId?: string | null; system?: boolean; actor?: ProjectViewEvent['actor'] } = {}): void {
    const task = p.state.snapshot.tasks[taskId];
    const runId = RUN_ADDRESSED.includes(type) ? taskId : task?.runId ?? Object.keys(p.state.snapshot.runs)[0] ?? p.fixture.projectId;
    const at = isoOf(timeOf(p) + (o.delayMs ?? 0));
    const event: ProjectViewEvent = {
      schemaVersion: 1, eventId: seededId(prng, 'evt'), projectId: p.fixture.projectId, runId, taskId, attemptId: o.attemptId ?? null, type, sequence: 0,
      aggregateRevision: (task?.aggregateRevision ?? 0) + (o.revisionStep ?? 1), actor: o.actor ?? (type === 'task.delegated' ? PM_AGENT : undefined) ?? (o.system || SYSTEM_TYPES.includes(type) ? REAPER : SCHEDULER_TYPES.includes(type) ? SCHEDULER : type === 'task.reopened' || type === 'change.proposed' ? INTEGRATION : HUMAN),
      occurredAt: at, receivedAt: at, causationId: null, traceId: `trace_${p.fixture.projectId}`, payload, provenance: 'simulated',
    };
    p.pending.push(event);
    p.pending.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    release(p);
    flushAll(p);
  }

  const receipt = (key: string, over: Partial<CommandReceipt>): CommandReceipt => ({
    idempotencyKey: key, operationId: null, accepted: false, execution: 'rejected', rejection: null, replayed: false, simulated: true, ...over,
  });
  const rejected = (key: string, reason: NonNullable<CommandReceipt['rejection']>): CommandReceipt => receipt(key, { rejection: reason });

  /** The same order of checks as `POST /v1/projects/:id/model-assignments`. Reaches no running attempt: nothing here touches the event stream. */
  function setAssignment(p: Project, c: Extract<AuthorizedViewCommand, { command: 'assignment.set' }>, op: string): CommandReceipt {
    const { scope, key, selection } = c.args;
    const id = `${scope}:${key}`;
    const current = p.assignmentRevisions.get(id) ?? 0;
    if (c.expectedRevision !== current) return rejected(c.idempotencyKey, 'stale_revision');
    if (scope === 'task') {
      const task = p.state.snapshot.tasks[key];
      if (!task) return rejected(c.idempotencyKey, 'unknown_target');
      if (p.state.snapshot.runs[task.runId]?.pinnedModel) return rejected(c.idempotencyKey, 'trial_model_pinned');
      if (['verified', 'merged', 'cancelled', 'superseded'].includes(task.status)) return rejected(c.idempotencyKey, 'not_allowed');
    }
    if (selection !== null) {
      if (p.modelCatalog.status !== 'detected' || p.modelCatalog.providers.length === 0) return rejected(c.idempotencyKey, 'no_provider_detected');
      const provider = p.modelCatalog.providers.find((x) => x.provider === selection.provider);
      if (!provider) return rejected(c.idempotencyKey, 'unsupported_provider');
      const model = provider.models.find((x) => x.modelId === selection.model);
      if (!model) return rejected(c.idempotencyKey, 'unsupported_model');
      if (!model.allowedByPolicy) return rejected(c.idempotencyKey, 'model_not_allowed');
    }
    const revision = current + 1;
    p.assignmentRevisions.set(id, revision);
    const previous = p.modelAssignments.find((a) => a.scope === scope && a.key === key);
    p.modelAssignments = [...p.modelAssignments.filter((a) => !(a.scope === scope && a.key === key)), { scope, key, provider: selection?.provider ?? null, model: selection?.model ?? null, revision, updatedBy: 'demo-operator', updatedAt: isoOf(timeOf(p)), state: 'applying' }];
    // As on the server: saved now, in force once the simulated runner acknowledges it on its next heartbeat.
    const run = scope === 'task' ? p.state.snapshot.tasks[key]?.runId : Object.keys(p.state.snapshot.runs)[0];
    if (run) {
      appendCommandEvent(p, run, 'settings.changed', { scope: 'assignment', key: id, field: 'model', from: previous?.provider ? { provider: previous.provider, model: previous.model } : null, to: selection, revision, enforcer: 'runner' });
      appendCommandEvent(p, run, 'settings.applied', { scope: 'assignment', key: id, revision }, { delayMs: HEARTBEAT_STEP_MS, system: true });
    }
    return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'pending' });
  }

  /** The same order of checks as `POST /v1/projects/:id/settings`. A field the server enforces is in force in the save; one a runner holds waits for its heartbeat. */
  function setSetting(p: Project, c: Extract<AuthorizedViewCommand, { command: 'setting.set' }>, op: string): CommandReceipt {
    const { key } = c.args;
    // As the server: a name is saved trimmed.
    const change = (c.args.change.field === 'display_name' || c.args.change.field === 'pm_display_name') && typeof c.args.change.value === 'string'
      ? { ...c.args.change, value: c.args.change.value.trim() } as SettingChange : c.args.change;
    const snap = p.state.snapshot;
    let eventRun: string;
    if (change.scope === 'run' || change.scope === 'task') {
      const task = change.scope === 'task' ? snap.tasks[key] : undefined;
      if (change.scope === 'task' && !task) return rejected(c.idempotencyKey, 'unknown_target');
      const r = snap.runs[task ? task.runId : key];
      if (!r) return rejected(c.idempotencyKey, 'unknown_target');
      if (['merged', 'failed', 'cancelled'].includes(r.lifecycle) || r.cancel) return rejected(c.idempotencyKey, 'run_closed');
      // The data lock, as on the server: a cloud-capable override on a task with restricted data is refused.
      if (change.field === 'route_override' && change.value !== null && isCloudCapable(change.value) && routeLockOf(p.fixture.routes ?? NO_ROUTES, key)) return rejected(c.idempotencyKey, 'route_locked_restricted');
      eventRun = r.runId;
    } else {
      if (!snap.workers[key]) return rejected(c.idempotencyKey, 'unknown_target');
      const first = Object.keys(snap.runs)[0];
      if (!first) return rejected(c.idempotencyKey, 'unknown_target');
      eventRun = first;
    }
    // H11: a worker name follows the server's rules: 1-24 characters in any script, no control characters or secret shapes, unique among the workers.
    if (change.field === 'display_name' && change.value !== null) {
      const shown = [...p.settings, ...demoNames(Object.keys(snap.workers), p.settings, DEMO_NAMED_AT)].filter((x) => x.scope === 'runner' && x.field === 'display_name' && x.key !== key);
      const problem = workerNameProblem(change.value, shown.map((x) => String(x.desired)));
      if (problem) return rejected(c.idempotencyKey, problem);
    }
    // As the server (fix round 1, M1): a role is one of the project's roles, and only one worker is the Project Manager.
    if (change.field === 'role') {
      if (change.value === PROJECT_MANAGER_ROLE) {
        if (p.settings.some((x) => x.scope === 'runner' && x.field === 'role' && x.desired === PROJECT_MANAGER_ROLE && x.key !== key)) return rejected(c.idempotencyKey, 'role_pm_taken');
      } else if (!Object.values(snap.tasks).some((t) => t.role === change.value)) return rejected(c.idempotencyKey, 'role_unknown');
    }
    if (change.field === 'pm_display_name' && change.value !== null) {
      const problem = workerNameProblem(change.value, []);
      if (problem) return rejected(c.idempotencyKey, problem);
    }
    const row = p.settings.find((x) => x.scope === change.scope && x.key === key && x.field === change.field);
    // A demo name is shown as saved at revision 1, so a rename builds on it.
    const current = row?.desiredRevision ?? (change.field === 'display_name' && snap.workers[key] ? 1 : 0);
    if (c.expectedRevision !== current) return rejected(c.idempotencyKey, 'stale_revision');
    if (change.field === 'allowed_paths' && change.value.some((x) => !DEMO_PLAN_PATHS.includes(x))) return rejected(c.idempotencyKey, 'outside_plan_scope');
    if (change.field === 'slots' && change.value > 2) return rejected(c.idempotencyKey, 'outside_recorded_limits');
    const enforcer = SETTING_ENFORCER[change.field];
    const revision = current + 1;
    const at = isoOf(timeOf(p));
    const inForce = row ? (row.effectiveRevision >= row.desiredRevision ? row.desired : row.effective) : null;
    const next: SettingView = {
      scope: change.scope, key, field: change.field, desired: change.value, desiredRevision: revision, enforcer, updatedBy: 'demo-operator', updatedAt: at,
      ...(enforcer === 'server'
        ? { effective: change.value, effectiveRevision: revision, state: 'applied' as const, appliedAt: at }
        : { effective: inForce, effectiveRevision: row?.effectiveRevision ?? 0, state: 'applying' as const, appliedAt: row?.appliedAt ?? null }),
    };
    p.settings = [...p.settings.filter((x) => x !== row), next];
    if (change.field === 'paused' && change.value === false) releaseHeld(p);
    appendCommandEvent(p, eventRun, 'settings.changed', { scope: change.scope, key, field: change.field, from: row?.desired ?? null, to: change.value as SettingChange['value'], revision, enforcer });
    if (enforcer === 'runner') appendCommandEvent(p, eventRun, 'settings.applied', { scope: change.scope, key, field: change.field, revision }, { delayMs: HEARTBEAT_STEP_MS, system: true });
    return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: enforcer === 'server' ? 'applied' : 'pending' });
  }

  /** The same rule as `POST /v1/runs/:id/cancel`: running work is asked to stop, the rest is cancelled at once, and the run is cancelled when the last attempt ends. */
  function cancelRun(p: Project, c: Extract<AuthorizedViewCommand, { command: 'run.cancel' }>, op: string): CommandReceipt {
    const r = p.state.snapshot.runs[c.args.runId];
    if (!r) return rejected(c.idempotencyKey, 'unknown_target');
    if (c.expectedRevision !== r.planRevision) return rejected(c.idempotencyKey, 'stale_revision');
    if (['merged', 'failed', 'cancelled'].includes(r.lifecycle)) return rejected(c.idempotencyKey, 'run_closed');
    if (r.cancel || p.cancels.has(r.runId)) return rejected(c.idempotencyKey, 'cancel_pending');
    const tasks = Object.values(p.state.snapshot.tasks).filter((t) => t.runId === r.runId);
    const running = tasks.filter((t) => t.status === 'running');
    p.cancels.set(r.runId, { requestedAt: isoOf(timeOf(p)) });
    for (const t of running) {
      appendCommandEvent(p, t.taskId, 'task.cancel_requested', { operationId: op, attemptIds: t.activeAttemptId ? [t.activeAttemptId] : [], runCancelled: true });
      appendCommandEvent(p, t.taskId, 'task.cancelled', { reason: 'cancel_requested', operationId: op, runCancelled: true }, { delayMs: STOP_MS, revisionStep: 2, attemptId: t.activeAttemptId, system: true });
    }
    for (const t of tasks.filter((x) => IMMEDIATE_CANCEL.includes(x.status))) appendCommandEvent(p, t.taskId, 'task.cancelled', { operationId: op, runCancelled: true });
    appendCommandEvent(p, r.runId, 'run.cancel_requested', { operationId: op, stopping: running.map((t) => t.taskId) });
    appendCommandEvent(p, r.runId, 'run.cancelled', { operationId: op, lifecycle: 'cancelled' }, { delayMs: running.length > 0 ? STOP_MS : 0, system: true });
    return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: running.length > 0 ? 'cancel_requested' : 'applied' });
  }

  /** The server's delegation rule on the demo's state (`checkDelegation`, roles by `workerRoleOf`). Applied items are recorded as `task.delegated`. */
  function applyDemoDelegation(p: Project, runId: string, planRevision: number, assignments: readonly Record<string, unknown>[], by: 'agent' | 'human'): DelegationReceipt {
    const snap = p.state.snapshot;
    const run = snap.runs[runId]!;
    const all = assignments.map((a) => ({ taskId: String(a['taskId'] ?? ''), workerId: String(a['workerId'] ?? '') }));
    const off = p.settings.some((x) => x.scope === 'run' && x.key === runId && x.field === 'auto_delegate' && x.desired === false);
    if (by === 'agent' && off) return { applied: [], refused: all.map((a) => ({ ...a, reason: 'auto_delegate_off' })), autoDelegate: false, simulated: true };
    const tasks = Object.values(snap.tasks).filter((t) => t.runId === runId).map((t) => ({
      taskId: t.taskId, role: t.role ?? '', status: t.status, maxAttempts: demoMaxAttempts(run),
      attemptsUsed: t.attemptIds.filter((id) => snap.attempts[id]?.outcome !== 'interrupted').length,
    }));
    const workers = Object.keys(snap.workers).map((id) => ({ workerId: id, role: demoRoleOf(snap, p.settings, id), enabled: !p.settings.some((x) => x.scope === 'runner' && x.key === id && x.field === 'enabled' && x.desired === false) }));
    const checked = checkDelegation({ planRevision: run.planRevision, tasks, workers }, { planRevision, assignments: assignments as never });
    for (const a of checked.apply) appendCommandEvent(p, a.taskId, 'task.delegated', { workerId: a.workerId, planRevision, revision: snap.tasks[a.taskId]?.revision ?? 1 }, { actor: by === 'agent' ? PM_AGENT : HUMAN });
    return { applied: checked.apply, refused: checked.refuse, autoDelegate: !off, simulated: true };
  }

  function run(p: Project, c: AuthorizedViewCommand): CommandReceipt {
    const snap = p.state.snapshot;
    const op = `op_${seededId(prng, 'sim')}`;
    if (c.command === 'assignment.set') return setAssignment(p, c, op);
    if (c.command === 'setting.set') return setSetting(p, c, op);
    if (c.command === 'run.cancel') return cancelRun(p, c, op);
    // As the server: the record's effective mode, fallback and conformance come from the policy, not the report. Metadata only.
    if (c.command === 'route.report') {
      const task = snap.tasks[c.args.taskId];
      if (!task) return rejected(c.idempotencyKey, 'unknown_target');
      const recordId = `${c.args.taskId}.route_${c.args.report.requestId}`;
      // As the server: one served context backs one call.
      const ctx = c.args.report.contextId;
      if (ctx !== undefined && [...p.reportContexts.entries()].some(([req, v]) => v.contextId === ctx && req !== c.args.report.requestId)) return rejected(c.idempotencyKey, 'stale_revision');
      const earlier = p.routeRecords.get(c.args.taskId) ?? [];
      if (earlier.some((x) => x.recordId === recordId)) return receipt(c.idempotencyKey, { operationId: recordId, accepted: true, execution: 'applied', replayed: true });
      const record = routeRecordOf({ routes: p.fixture.routes ?? NO_ROUTES, settings: p.settings, runId: task.runId, taskId: task.taskId, taskRevision: task.revision, recordId, at: isoOf(timeOf(p)), report: c.args.report });
      p.routeRecords.set(task.taskId, [record, ...earlier]);
      p.reportContexts.set(c.args.report.requestId, { taskId: task.taskId, contextId: c.args.report.contextId ?? null, locked: record.locked });
      appendCommandEvent(p, task.taskId, 'inference.reported', { revision: task.revision, record }, { revisionStep: 0 });
      return receipt(c.idempotencyKey, { operationId: recordId, accepted: true, execution: 'applied' });
    }
    // Mirrors the owner route: a new run, in planning, with no plan. The demo has no recorded ceiling to enforce.
    if (c.command === 'run.start_new') {
      const runId = `run_${seededId(prng, 'sim')}`;
      appendCommandEvent(p, runId, 'run.created', { title: c.args.title, lifecycle: 'planning' });
      return receipt(c.idempotencyKey, { operationId: runId, accepted: true, execution: 'applied' });
    }
    if (c.command === 'run.accept_reduced_scope' || c.command === 'run.reverify' || c.command === 'run.open_pull_request') {
      const r = snap.runs[c.args.runId];
      if (!r) return rejected(c.idempotencyKey, 'unknown_target');
      if (c.command === 'run.accept_reduced_scope') {
        if (c.expectedRevision !== r.planRevision) return rejected(c.idempotencyKey, 'stale_revision');
        const assessed = scopeAssessmentOf(p, r.runId);
        if (!assessed) return rejected(c.idempotencyKey, 'not_budget_stopped');
        if (assessed.stoppingTaskIds.length > 0) return rejected(c.idempotencyKey, 'cancel_pending');
        if (acceptanceCovers(r, assessed.stopped)) return rejected(c.idempotencyKey, 'already_accepted');
        if (c.args.notDeliveredHash !== assessed.notDeliveredHash) return rejected(c.idempotencyKey, 'reduced_scope_changed');
        appendCommandEvent(p, r.runId, 'run.reduced_scope_accepted', { decisionId: `dec_${seededId(prng, 'sim')}`, notDelivered: assessed.notDelivered, deliveredRequirementIds: assessed.deliveredRequirementIds, ...(c.args.note !== undefined ? { note: c.args.note } : {}) });
        return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'applied' });
      }
      if (c.command === 'run.reverify') {
        if (c.expectedRevision !== r.planRevision) return rejected(c.idempotencyKey, 'stale_revision');
        const blocked = Object.values(snap.tasks).filter((t) => t.runId === r.runId && t.status === 'blocked' && isReverifiableReason(t.statusReason));
        if (blocked.length === 0) return rejected(c.idempotencyKey, 'nothing_to_reverify');
        const spent = (t: TaskView): number => p.reverifyCounts.get(`${t.taskId}:${t.revision}`) ?? 0;
        if (blocked.some((t) => spent(t) >= REVERIFY_LIMIT)) return rejected(c.idempotencyKey, 'reverify_limit_reached');
        for (const t of blocked) {
          p.reverifyCounts.set(`${t.taskId}:${t.revision}`, spent(t) + 1);
          appendCommandEvent(p, t.taskId, 'task.reopened', { reason: 'reverify_requested', status: 'verifying', requestedBy: 'demo-operator' });
        }
        return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'applied' });
      }
      if (r.lifecycle !== 'ready_for_review') return rejected(c.idempotencyKey, 'run_not_ready');
      const assessed = scopeAssessmentOf(p, r.runId);
      if (assessed && !acceptanceCovers(r, assessed.stopped)) return rejected(c.idempotencyKey, 'reduced_scope_not_accepted');
      const prior = p.changeRequests.find((x) => x.runId === r.runId);
      if (prior?.status === 'open') return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'applied' });
      if (prior && prior.status !== 'closed' && prior.status !== 'stale_candidate') return rejected(c.idempotencyKey, 'run_already_merged');
      const number = (prior?.prNumber ?? 11) + 1;
      const url = `https://github.com/selarikru-demo/feedback-board/pull/${number}`;
      p.changeRequests = [...p.changeRequests.filter((x) => x.runId !== r.runId), { runId: r.runId, prNumber: number, url, status: 'open', candidateSha: 'c'.repeat(40), baseRef: 'main', observedHeadSha: 'c'.repeat(40), mergeCommitSha: null, observedAt: isoOf(timeOf(p)), outOfDate: null }];
      appendCommandEvent(p, r.runId, 'change.proposed', { prNumber: number, url });
      return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'applied' });
    }
    if (c.command === 'task.cancel' || c.command === 'task.retry') {
      const task = snap.tasks[c.args.taskId];
      if (!task) return rejected(c.idempotencyKey, 'unknown_target');
      if (task.aggregateRevision !== c.expectedRevision) return rejected(c.idempotencyKey, 'stale_revision');
      if (c.command === 'task.cancel') {
        if (task.status === 'running') {
          if (task.cancelRequested) return receipt(c.idempotencyKey, { operationId: task.cancelRequested.operationId, accepted: true, execution: 'cancel_requested' });
          appendCommandEvent(p, task.taskId, 'task.cancel_requested', { operationId: op, attemptIds: task.activeAttemptId ? [task.activeAttemptId] : [] });
          // Termination is confirmed separately and later, when the runner stops, as in the real system.
          appendCommandEvent(p, task.taskId, 'task.cancelled', { reason: 'cancel_requested', operationId: op }, { delayMs: 2000, revisionStep: 2, attemptId: task.activeAttemptId, system: true });
          return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'cancel_requested' });
        }
        if (!IMMEDIATE_CANCEL.includes(task.status)) return rejected(c.idempotencyKey, 'not_allowed');
        appendCommandEvent(p, task.taskId, 'task.cancelled', { operationId: op });
        return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'applied' });
      }
      if (task.status !== 'failed') return rejected(c.idempotencyKey, 'not_allowed');
      appendCommandEvent(p, task.taskId, 'task.ready', { reason: 'retry_requested' });
      return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'applied' });
    }
    const approval = snap.approvals[c.args.approvalId];
    if (!approval) return rejected(c.idempotencyKey, 'unknown_target');
    const task = approval.taskId ? snap.tasks[approval.taskId] : undefined;
    // The same order of checks as `POST /v1/approvals/:id/resolve`.
    const expired = approvalStateAt(approval, timeOf(p)) === 'expired';
    if (!expired && approval.state !== 'pending') return rejected(c.idempotencyKey, 'approval_already_resolved');
    if (expired && c.command === 'approval.grant') return rejected(c.idempotencyKey, 'approval_expired');
    if (approval.scopeHash !== c.args.scopeHash) return rejected(c.idempotencyKey, 'scope_mismatch');
    if (task && approval.taskRevision !== task.revision) return rejected(c.idempotencyKey, 'stale_revision');
    if (task && task.status !== 'awaiting_approval' && approval.state !== 'expired') return rejected(c.idempotencyKey, 'stale_revision');
    if ((task?.aggregateRevision ?? 0) !== c.expectedRevision) return rejected(c.idempotencyKey, 'stale_revision');
    // A grant is re-judged: a row naming no operation cannot be judged, and one that could not take effect is not offered.
    if (c.command === 'approval.grant' && (approval.operation === null || approvalUnavailableReason(approval.operation) !== null)) return rejected(c.idempotencyKey, 'policy_denied');
    appendCommandEvent(p, approval.taskId ?? approval.runId, c.command === 'approval.grant' ? 'approval.granted' : 'approval.denied', {
      approvalId: approval.approvalId, scopeHash: approval.scopeHash, actionHash: `action-${approval.approvalId}`,
    });
    return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'applied' });
  }

  // Simulated sources compiled by the same domain code the server runs. Reads touch no network.
  const brain = createDemoBrain((id) => snapshotOf(project(id)), (id) => new Date(timeOf(project(id))).toISOString());
  // The skill library and the stack read each other: the resolver needs the stack, and the stack's Skills axis names the reviewed bindings.
  const skills = createDemoSkills({ nowIso: (id) => new Date(timeOf(project(id))).toISOString(), snapshotOf: (id) => snapshotOf(project(id)), stackOf: (id) => stack.document(id) });
  const stack = createDemoStack((id) => new Date(timeOf(project(id))).toISOString(), (id) => skills.forStack(id));
  const product = createDemoProduct((id) => snapshotOf(project(id)), (id) => new Date(timeOf(project(id))).toISOString());
  const handover = createDemoHandover({
    snapshotOf: (id) => snapshotOf(project(id)), nowMs: (id) => timeOf(project(id)),
    emit: (id, taskId, type, payload, o) => appendCommandEvent(project(id), taskId, type, payload, { ...(o.delayMs !== undefined ? { delayMs: o.delayMs } : {}), ...(o.revisionStep !== undefined ? { revisionStep: o.revisionStep } : {}), attemptId: o.attemptId ?? null }),
  });

  return {
    mode: 'mock',
    clock,
    clockFor(projectId) {
      const p = projects.get(projectId);
      if (!p) throw fail('unknown_project', `no mock project ${projectId}`);
      return { nowMs: () => timeOf(p) };
    },
    pendingCount: (projectId) => projects.get(projectId)?.pending.length ?? 0,
    listProjects: () => [...projects.values()].map(({ fixture }) => ({ projectId: fixture.projectId, fixtureId: fixture.id, name: fixture.name, description: fixture.description })),

    async getSnapshot(projectId) {
      return snapshotOf(project(projectId));
    },

    getBrain: (projectId) => brain.get(project(projectId).fixture.projectId),
    getBrainSource: (projectId, sourceId, revision) => brain.source(project(projectId).fixture.projectId, sourceId, revision),
    getAttemptContext: (projectId, attemptId) => brain.context(project(projectId).fixture.projectId, attemptId),
    brainAction: (projectId, action) => brain.act(project(projectId).fixture.projectId, action),
    getStack: (projectId) => stack.get(project(projectId).fixture.projectId),
    stackAction: (projectId, request) => stack.act(project(projectId).fixture.projectId, request),
    getSkills: (projectId) => skills.get(project(projectId).fixture.projectId),
    skillAction: (projectId, action) => skills.act(project(projectId).fixture.projectId, action),
    getAttemptSkills: (projectId, attemptId) => skills.attempt(project(projectId).fixture.projectId, attemptId),
    getProduct: (projectId) => product.get(project(projectId).fixture.projectId),
    productAction: (projectId, action) => product.act(project(projectId).fixture.projectId, action),
    getHandovers: (projectId) => handover.get(project(projectId).fixture.projectId),
    handoverAction: (projectId, action) => handover.act(project(projectId).fixture.projectId, action),
    getHandoverDiff: (projectId, taskId, checkpointId, path) => handover.diff(project(projectId).fixture.projectId, taskId, checkpointId, path),

    /** One task's route, as fresh as the mock's own rows: the effective policy, the lock, the suggestion, and every record, newest first. Simulated. */
    planBriefSample: (projectId) => demoPlanBriefNotes(projectId),

    async getTaskRoute(projectId, taskId) {
      const p = project(projectId);
      const t = p.state.snapshot.tasks[taskId];
      if (!t) throw fail('unavailable', `no task ${taskId} in this project`);
      return { taskId, revision: t.revision, runId: t.runId, route: routeViewOf(p, t), records: [...(p.routeRecords.get(taskId) ?? [])] };
    },

    /** What the demo's task agents read: simulated, with a bundle built by the domain code for the asked destination. */
    async getTaskContext(projectId, taskId, destination, callOverride, contextId) {
      const p = project(projectId);
      const t = p.state.snapshot.tasks[taskId];
      if (!t) throw fail('unavailable', `no task ${taskId} in this project`);
      const call = callOverride ? RoutePolicyModeSchema.safeParse(callOverride) : null;
      if (call && !call.success) throw fail('invalid_event', 'callOverride must be a route mode');
      checkDestination(destination, routeViewOf(p, t), routeLockOf(p.fixture.routes ?? NO_ROUTES, t.taskId), call?.data ?? null);
      const served = demoTaskContext(contextState(p, t.runId), t, destination);
      if (contextId) p.contextLabels.set(contextId, strongerLabel(served.task.classification, served.bundle.claims.length === 0 ? 'public' : (served.bundle.contentLabel ?? 'restricted')));
      return served;
    },

    /** Counts only, refused like the context: the demo's input size for one destination. */
    async getTaskContextSize(projectId, taskId, destination) {
      const p = project(projectId);
      const t = p.state.snapshot.tasks[taskId];
      if (!t) throw fail('unavailable', `no task ${taskId} in this project`);
      checkDestination(destination, routeViewOf(p, t), routeLockOf(p.fixture.routes ?? NO_ROUTES, t.taskId), null);
      const c = demoTaskContext(contextState(p, t.runId), t, destination);
      const inputChars = c.task.title.length + (c.task.description?.length ?? 0) + c.task.criteria.reduce((n, x) => n + x.text.length, 0) + c.bundle.claims.reduce((n, x) => n + x.text.length + x.heading.length, 0);
      return { taskId, destination, hasChange: c.change !== null, inputChars };
    },

    // H12: AI step checkpoints, with the server's refusals: the storage split, the task's lock, a locked call record, a restricted served context, secrets.
    async saveAiCheckpoint(projectId, checkpoint) {
      offlineCheck();
      const p = project(projectId);
      const parsed = AiCheckpointSchema.safeParse(checkpoint);
      if (!parsed.success) throw fail('unavailable', 'invalid_request: not a checkpoint');
      const cp = parsed.data;
      if (cp.projectId !== projectId) throw fail('unavailable', 'checkpoint_project_mismatch: this checkpoint names another project');
      // Fix round 3 (R3): as the server, only the send claim moves a checkpoint to sending.
      if (cp.status === 'sending') throw fail('unavailable', 'invalid_request: a save cannot set a checkpoint sending; claim it first');
      const own = serverCheckpointRefusal(cp);
      if (own === 'checkpoint_secret') throw fail('unavailable', 'checkpoint_secret: this checkpoint carries something shaped like a credential');
      const restricted = (): DataSourceException => fail('unavailable', 'checkpoint_restricted: this checkpoint holds restricted data, so it stays in this browser');
      if (own !== null) throw restricted();
      if (!p.state.snapshot.tasks[cp.taskId]) throw fail('unavailable', 'task_not_found: no such task');
      if (routeLockOf(p.fixture.routes ?? NO_ROUTES, cp.taskId)) throw restricted();
      if (cp.routeRecordId !== null) {
        const rec = (p.routeRecords.get(cp.taskId) ?? []).find((r) => r.requestId === cp.routeRecordId);
        if (rec && (rec.locked || rec.inputLabel === 'restricted' || rec.inputLabel === 'secret')) throw restricted();
      }
      if (cp.inputs.contextId !== null) {
        const label = p.contextLabels.get(cp.inputs.contextId);
        if (label !== undefined && !['public', 'internal'].includes(label)) throw restricted();
      }
      const prior = p.aiCheckpoints.get(cp.checkpointId);
      if (prior && prior.taskId !== cp.taskId) throw fail('unavailable', 'checkpoint_not_found: no such checkpoint');
      if (prior && !['running', 'waiting', 'sending'].includes(prior.status) && prior.status !== cp.status) throw fail('unavailable', `checkpoint_closed: this step was already ${prior.status.replace(/_/g, ' ')}`);
      // Fix round 2 (N4): as the server, a row being sent takes a save only from the claiming tab's token, and only to what a send ends in.
      // Fix round 3 (R4): and, as the server, another tab may close a claim left for more than 30 minutes as abandoned without the token.
      const staleClaim = prior?.status === 'sending' && cp.status === 'abandoned' && timeOf(p) - Date.parse(prior.updatedAt) > 30 * 60_000;
      if (prior?.status === 'sending' && !staleClaim && !(cp.claimToken !== undefined && cp.claimToken === p.claimTokens.get(cp.checkpointId) && ['sent', 'waiting', 'moved_to_device', 'abandoned'].includes(cp.status))) {
        throw fail('unavailable', 'checkpoint_claimed: another tab is sending this step');
      }
      p.claimTokens.delete(cp.checkpointId);
      const { claimToken: _token, ...stored } = cp;
      void _token;
      p.aiCheckpoints.set(cp.checkpointId, { ...stored, escalatedAt: prior?.escalatedAt ?? null });
    },
    async listAiCheckpoints(projectId) {
      offlineCheck();
      const p = project(projectId);
      // Fix round 3 (R4): as the server, each row is judged again by its task's lock now; an unknown task is withheld.
      return [...p.aiCheckpoints.values()].filter((c) => p.state.snapshot.tasks[c.taskId] !== undefined && routeLockOf(p.fixture.routes ?? NO_ROUTES, c.taskId) === null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => ({ ...c }));
    },
    async claimAiCheckpointSend(projectId, checkpointId) {
      offlineCheck();
      const p = project(projectId);
      const cp = p.aiCheckpoints.get(checkpointId);
      if (!cp) throw fail('unavailable', 'checkpoint_not_found: no such checkpoint');
      if (cp.status !== 'waiting') throw fail('unavailable', `checkpoint_claimed: this step is ${cp.status.replace(/_/g, ' ')}, not waiting`);
      const next = { ...cp, status: 'sending' as const, updatedAt: isoOf(timeOf(p)) };
      p.aiCheckpoints.set(checkpointId, next);
      const claimToken = seededId(claimPrng, 'claim').replace(/[^A-Za-z0-9_-]/g, '_').padEnd(24, '0').slice(0, 48);
      p.claimTokens.set(checkpointId, claimToken);
      return { ...next, claimToken };
    },
    async claimAiCheckpointEscalation(projectId, checkpointId) {
      offlineCheck();
      const p = project(projectId);
      const cp = p.aiCheckpoints.get(checkpointId);
      if (!cp) throw fail('unavailable', 'checkpoint_not_found: no such checkpoint');
      const routes = p.fixture.routes ?? NO_ROUTES;
      const lock = routeLockOf(routes, cp.taskId);
      const override = p.settings.find((s) => s.scope === 'task' && s.key === cp.taskId && s.field === 'route_override')?.desired ?? null;
      const mode = effectiveRoutePolicy({ call: null, task: (override as never) ?? null, run: runRouteDefaultOf(routes, p.settings, cp.runId).value, lock }).mode;
      const d = escalationDecision(cp, { mode, lock: lock !== null });
      if (!d.ok) throw fail('unavailable', `escalation_refused: ${d.reason}`);
      const next = { ...cp, escalatedAt: isoOf(timeOf(p)) };
      p.aiCheckpoints.set(checkpointId, next);
      return { ...next };
    },

    /**
     * H11: the Project Manager's delegation, simulated with the server's rule (`checkDelegation`): only the accepted plan's tasks, to enabled workers of the task's
     * role, from a recorded pmDelegate call. Applied ones are recorded as `task.delegated` by agent:pm. Demo data, never evidence.
     */
    async delegate(projectId, runId, request) {
      const p = project(projectId);
      const snap = p.state.snapshot;
      const run = snap.runs[runId];
      if (!run) throw fail('unavailable', `run_not_found: no run ${runId}`);
      const rec = (p.routeRecords.get(request.subjectTaskId) ?? []).find((r) => r.requestId === request.routeRecordId);
      if (!rec || rec.stepKind !== 'pmDelegate' || rec.status !== 'ok') throw fail('unavailable', 'route_record_missing: there is no record of the delegation call');
      // The server's backstop (H5's guard), as the server runs it: a locked call, or one whose served context held restricted data or is unknown, is refused.
      if (rec.locked) throw fail('unavailable', 'proposal_from_restricted_call: Restricted work stays on this device');
      const call = p.reportContexts.get(request.routeRecordId);
      const servedLabel = call?.contextId ? p.contextLabels.get(call.contextId) : undefined;
      if (servedLabel === undefined || !['public', 'internal'].includes(servedLabel)) throw fail('unavailable', 'proposal_from_restricted_context: this came from a call whose context held restricted data, or that the demo cannot vouch for');
      // Bound to the call: its own output, under the plan revision it read and that is still in force, once.
      if (rec.outputSha256 !== delegationOutputSha256(request.assignments)) throw fail('unavailable', 'delegation_output_mismatch: these are not the assignments the call produced');
      if (rec.planRevision !== request.planRevision || rec.planRevision !== run.planRevision) throw fail('unavailable', 'plan_revision_changed: the plan changed since the call');
      const print = JSON.stringify(request);
      const used = p.usedDelegations.get(request.routeRecordId);
      if (used) {
        if (used.print === print) return used.result;
        throw fail('unavailable', 'route_record_used: this call already authorised a delegation');
      }
      const result = applyDemoDelegation(p, runId, request.planRevision, request.assignments, 'agent');
      p.usedDelegations.set(request.routeRecordId, { print, result });
      return result;
    },

    /**
     * H11 fix round 1 (I4): the owner accepts a Project Manager plan, judged as the server judges it (the pmPlan call's record and served context). The demo keeps
     * its own tasks: a simulated `plan.accepted` moves the run's plan revision, so delegation can follow under it. Demo data, never evidence.
     */
    async acceptPmPlan(projectId, runId, request) {
      const p = project(projectId);
      const run = p.state.snapshot.runs[runId];
      if (!run) throw fail('unavailable', `run_not_found: no run ${runId}`);
      const rec = (p.routeRecords.get(request.subjectTaskId) ?? []).find((r) => r.requestId === request.routeRecordId);
      if (!rec || rec.stepKind !== 'pmPlan' || rec.status !== 'ok') throw fail('unavailable', 'route_record_missing: there is no record of the plan call');
      if (rec.locked) throw fail('unavailable', 'proposal_from_restricted_call: Restricted work stays on this device');
      const call = p.reportContexts.get(request.routeRecordId);
      const servedLabel = call?.contextId ? p.contextLabels.get(call.contextId) : undefined;
      if (servedLabel === undefined || !['public', 'internal'].includes(servedLabel)) throw fail('unavailable', 'proposal_from_restricted_context: this came from a call whose context held restricted data, or that the demo cannot vouch for');
      if (request.expectedPlanRevision !== run.planRevision) throw fail('unavailable', 'stale_revision: the plan changed since the Project Manager drafted this');
      // The server's mapping (fix round 2, I4): `revises` makes the next revision of that task, a task without it is new, T-key dependencies map to the final ids,
      // and tasks the plan does not mention stay as they are.
      // Bound to the call's output, as on the server (fix round 3): the plan must be the one its record hashed.
      if (rec.outputSha256 !== sha256Hex(canonicalJson(request.plan))) throw fail('unavailable', 'plan_output_mismatch: this is not the plan the Project Manager call produced');
      // The demo's real plan paths (it has no per-role paths), so a path outside them is refused, as is any path that is not plain (fix round 3, N3).
      const existing = Object.values(p.state.snapshot.tasks).filter((t) => t.runId === runId && t.status !== 'cancelled' && t.status !== 'superseded')
        .map((t) => ({ taskId: t.taskId, revision: t.revision, role: t.role ?? '', locked: (t.route?.lock ?? routeLockOf(p.fixture.routes ?? NO_ROUTES, t.taskId)) !== null, allowedPaths: [...DEMO_PLAN_PATHS] }));
      const projectRoles = [...new Set(Object.values(p.state.snapshot.tasks).map((t) => t.role).filter((r): r is string => typeof r === 'string'))];
      const mapped = mapPmPlan(request.plan.tasks as never, existing, { newTaskId: (i) => `${runId}.pm-${seededId(prng, 't')}-${i + 1}`, allowedPaths: DEMO_PLAN_PATHS, projectRoles });
      if (!mapped.ok) throw fail('unavailable', `${mapped.reason}: the plan's ${mapped.key} cannot be accepted`);
      const planRevision = run.planRevision + 1;
      const taskIds = mapped.items.map((m) => m.taskId);
      appendCommandEvent(p, runId, 'plan.accepted', { planRevision, taskIds, acceptedFor: 'demo-operator', replanned: mapped.items.filter((m) => m.revises).map((m) => m.taskId), pmPlan: mapped.items }, { revisionStep: planRevision, system: true });
      return { planRevision, taskIds, simulated: true };
    },

    /** H11 fix round 1 (I3): the owner's own assignment, from Action items, through the same plan rule, recorded as the owner. Simulated. */
    async assign(projectId, runId, request) {
      const p = project(projectId);
      if (!p.state.snapshot.runs[runId]) throw fail('unavailable', `run_not_found: no run ${runId}`);
      return applyDemoDelegation(p, runId, request.planRevision, request.assignments, 'human');
    },

    /** The demo's replan path for an accepted criteria proposal. Simulated: the reworded criteria are kept for the next read, and a simulated `plan.accepted` moves the plan. */
    async reviseTaskCriteria(projectId, request) {
      const p = project(projectId);
      const r = CriteriaRevisionRequestSchema.parse(request);
      const t = p.state.snapshot.tasks[r.taskId];
      if (!t) throw fail('unavailable', `no task ${r.taskId} in this project`);
      const state = contextState(p, t.runId);
      // An agent's criteria, as on the server: refused when that call read restricted context, or the demo cannot vouch for what it read.
      if (r.routeRecordId) {
        const call = p.reportContexts.get(r.routeRecordId);
        const servedLabel = call?.contextId ? p.contextLabels.get(call.contextId) : undefined;
        if (call?.locked) throw fail('unavailable', 'proposal_from_restricted_call: Restricted work is applied by the local runner on this device');
        if (!call || servedLabel === undefined || !['public', 'internal'].includes(servedLabel)) throw fail('unavailable', 'proposal_from_restricted_context: these criteria came from a call whose context held restricted data');
      }
      p.criteria.set(t.taskId, reviseDemoCriteria(state, t, r.expectedPlanRevision, r.criteria));
      // As the server's plan route: a new plan revision, the task back to planned at its next revision, and `plan.accepted` on the stream. Simulated.
      const planRevision = state.planRevision + 1;
      appendCommandEvent(p, t.runId, 'plan.accepted', { planRevision, taskIds: [t.taskId], acceptedFor: 'demo-operator', replanned: [t.taskId] }, { revisionStep: planRevision, system: true });
      return { planRevision, taskIds: [t.taskId], simulated: true };
    },

    /** The demo's base files for the patch agent. Simulated. */
    async getTaskFiles(projectId, taskId) {
      const p = project(projectId);
      const t = p.state.snapshot.tasks[taskId];
      if (!t) throw fail('unavailable', `no task ${taskId} in this project`);
      return demoBaseFiles(contextState(p, t.runId), t);
    },

    /** A demo proposal as it is now: the demo has no runner, so an accepted one stays waiting. */
    async getProposalState(projectId, _taskId, proposalId) {
      return project(projectId).acceptedProposals.get(proposalId)?.receipt ?? null;
    },

    /** The demo's listing of a task's files. Simulated. */
    async listTaskFiles(projectId, taskId) {
      const p = project(projectId);
      const t = p.state.snapshot.tasks[taskId];
      if (!t) throw fail('unavailable', `no task ${taskId} in this project`);
      return demoFileListing(contextState(p, t.runId), t);
    },

    /** The demo's accept: the server's checks and a simulated `proposal.accepted` with ids and hashes. The demo has no runner, so nothing is applied and the task has no new change. */
    async acceptPatchProposal(projectId, proposal, idempotencyKey) {
      const p = project(projectId);
      const t = p.state.snapshot.tasks[proposal.taskId];
      if (!t) throw fail('unavailable', `no task ${proposal.taskId} in this project`);
      // As the server: the same key reads the proposal as it is now; another key for a proposal still waiting is refused (the demo has no runner, so it never fails).
      const prior = p.acceptedProposals.get(proposal.proposalId);
      if (prior && prior.key === idempotencyKey) return prior.receipt;
      if (prior) throw fail('unavailable', 'proposal_already_accepted: this proposal is already waiting for the runner');
      const receipt = acceptDemoProposal(contextState(p, t.runId), t, proposal);
      // The server's backstop, mirrored: the call that produced it must be recorded, not locked, and its served context no stronger than internal.
      const call = p.reportContexts.get(proposal.routeRecordId);
      if (call?.locked) throw fail('unavailable', 'proposal_from_restricted_call: Restricted work is applied by the local runner on this device');
      const servedLabel = call?.contextId ? p.contextLabels.get(call.contextId) : undefined;
      if (!call || call.taskId !== t.taskId || servedLabel === undefined || !['public', 'internal'].includes(servedLabel)) throw fail('unavailable', 'proposal_from_restricted_context: this came from a call whose context held restricted data, or whose context the demo cannot vouch for');
      p.acceptedProposals.set(proposal.proposalId, { key: idempotencyKey, receipt });
      appendCommandEvent(p, t.taskId, 'proposal.accepted', { proposalId: receipt.proposalId, routeRecordId: proposal.routeRecordId, revision: t.revision, baseSha: proposal.baseSha, digest: receipt.digest, fileCount: receipt.fileCount }, { revisionStep: 0 });
      return receipt;
    },

    async getRunFailures(projectId, runId) {
      const p = project(projectId);
      if (!p.state.snapshot.runs[runId]) throw fail('unavailable', `no run ${runId} in this project`);
      const evidence = evidenceOf(p, runId);
      const failed = evidence?.criteria.filter((c) => c.state === 'failed') ?? [];
      // Fixture text, angle brackets included, because real failure text is not ours to trust and must render as text.
      return { candidateSha: evidence?.candidate?.sha ?? null, available: true, failures: failed.map((c) => ({ criterionId: c.criterionId, test: `${c.criterionId} acceptance`, status: 'failed' as const, message: 'AssertionError: expected <li> to contain "Saved" (simulated)' })) };
    },

    subscribe(projectId, afterCursor, onEvent, onError) {
      let p: Project;
      try {
        p = project(projectId);
      } catch (e) {
        const detail = e instanceof DataSourceException ? e.detail : { code: 'unavailable' as const, message: 'unavailable', retryable: true };
        queueMicrotask(() => onError(detail));
        return () => {};
      }
      const parsed = CursorSchema.safeParse(afterCursor);
      if (!parsed.success || cursorToSequence(afterCursor) > p.released.length) {
        queueMicrotask(() => onError({ code: 'invalid_cursor', message: 'cursor is not a position in this project\'s event stream', retryable: false }));
        return () => {};
      }
      const sub: Subscriber = { cursor: cursorToSequence(afterCursor), onEvent, onError, active: true };
      p.subscribers.add(sub);
      // Replay is asynchronous so a caller can finish wiring before the first event arrives.
      queueMicrotask(() => flush(p, sub));
      return () => {
        sub.active = false;
        p.subscribers.delete(sub);
      };
    },

    async execute(command) {
      const parsed = AuthorizedViewCommandSchema.safeParse(command);
      const key = (command as { idempotencyKey?: unknown } | null)?.idempotencyKey;
      if (!parsed.success) return rejected(typeof key === 'string' ? key : 'invalid', 'invalid_command');
      const c = parsed.data;
      if (closed) throw fail('disconnected', 'the mock data source is disconnected');
      // Ids are namespaced per fixture, so a target matches at most one project.
      const owner = [...projects.values()].find((p) => ('projectId' in c.args ? p.fixture.projectId === c.args.projectId : 'taskId' in c.args ? Boolean(p.state.snapshot.tasks[c.args.taskId]) : 'runId' in c.args ? Boolean(p.state.snapshot.runs[c.args.runId]) : Boolean(p.state.snapshot.approvals[c.args.approvalId])));
      if (!owner) return rejected(c.idempotencyKey, 'unknown_target');
      const seen = owner.receipts.get(c.idempotencyKey);
      if (seen) return { ...seen, replayed: true };
      const r = run(owner, c);
      owner.receipts.set(c.idempotencyKey, r);
      return r;
    },

    async openTerminal(session: AuthorizedTerminalRequest): Promise<TerminalChannel> {
      const parsed = AuthorizedTerminalRequestSchema.safeParse(session);
      if (!parsed.success) throw fail('unauthorized', 'invalid terminal request');
      const req = parsed.data;
      const p = [...projects.values()].find((x) => x.state.snapshot.attempts[req.attemptId]?.taskId === req.taskId);
      if (!p) throw fail('unknown_project', 'no such attempt');
      const attempt = p.state.snapshot.attempts[req.attemptId]!;
      const lines = [
        `[demo] simulated output for ${attempt.attemptId} (attempt ${attempt.number})`,
        '[demo] this is fixture text, not a real terminal',
        `[demo] runner ${attempt.runnerId ?? 'unknown'}`,
      ].slice(-TERMINAL_MAX_LINES);
      const lineHandlers = new Set<(line: string) => void>();
      const stateHandlers = new Set<(state: TerminalState) => void>();
      let open = true;
      const state: TerminalState = { status: attempt.endedAt !== null ? 'ended' : 'live', reason: null, lastLineAt: attempt.endedAt ?? attempt.lastHeartbeatAt ?? attempt.startedAt, dropped: 0 };
      return {
        channelId: `term_${attempt.attemptId}`,
        simulated: true,
        onLine(handler) {
          lineHandlers.add(handler);
          queueMicrotask(() => {
            for (const line of lines) if (open && lineHandlers.has(handler)) handler(line);
          });
          return () => lineHandlers.delete(handler);
        },
        onState(handler) {
          stateHandlers.add(handler);
          queueMicrotask(() => { if (open && stateHandlers.has(handler)) handler(state); });
          return () => stateHandlers.delete(handler);
        },
        close() {
          open = false;
          lineHandlers.clear();
          stateHandlers.clear();
        },
      };
    },

    openTerminalControl(): TerminalControlChannel {
      const state: TerminalControlState = { phase: 'refused', reason: 'demo', echo: null };
      return { simulated: true, onState: (h) => { queueMicrotask(() => h(state)); return () => undefined; }, onInput: () => () => undefined, send: () => undefined, interrupt: () => undefined, close: () => undefined };
    },

    disconnect() {
      closed = true;
      stopTicking();
      for (const p of projects.values()) {
        for (const s of p.subscribers) s.active = false;
        p.subscribers.clear();
      }
    },
  };
}

/** H11: the demo's workers have names, as an owner would give them. Shown as saved settings until the owner renames one (their own setting then wins). Demo data. */
const DEMO_NAMED_AT = new Date(FIXTURE_T0_MS).toISOString();
const DEMO_NAMES = ['Aisyah', 'Ravi', 'Mei Ling', 'Daniel', 'Siti', 'Arif', 'Kavitha', 'Hafiz'] as const;
function demoNames(workerIds: readonly string[], saved: readonly SettingView[], at: string): SettingView[] {
  const taken: string[] = [];
  return [...workerIds].sort().flatMap((key) => {
    if (saved.some((x) => x.scope === 'runner' && x.key === key && x.field === 'display_name')) return [];
    const name = demoNameFor(key, taken);
    taken.push(name);
    return [{
      scope: 'runner' as const, key, field: 'display_name' as const, desired: name, effective: name, desiredRevision: 1, effectiveRevision: 1,
      enforcer: 'server' as const, state: 'applied' as const, updatedBy: 'demo-operator', updatedAt: at, appliedAt: at,
    }];
  });
}

/**
 * H11 fix round 1 (M8): a demo worker's name is a function of its id (a fixed hash into the list), so it stays the same whatever other workers exist. Only when two
 * ids land on the same name does the later one (by id) take the next free one.
 */
export function demoNameFor(workerId: string, taken: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of workerId) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  for (let i = 0; i < DEMO_NAMES.length; i++) {
    const name = DEMO_NAMES[(h + i) % DEMO_NAMES.length]!;
    if (!taken.includes(name)) return name;
  }
  return DEMO_NAMES[h % DEMO_NAMES.length]!;
}

/**
 * M5 (fix round 2): a demo task's attempt limit, as its plan sets it: the run's repair limit plus the first attempt (the server reads the task spec's maxAttempts,
 * which the plan builds the same way). Unknown: the cap.
 */
export function demoMaxAttempts(run: Pick<RunView, 'policy'>): number {
  const repairs = run.policy?.repairAttempts?.value;
  return typeof repairs === 'number' ? Math.min(MAX_ATTEMPTS_CAP, repairs + 1) : MAX_ATTEMPTS_CAP;
}

/** H11: the Project Manager's actor on its own delegations. */
const PM_AGENT = { kind: 'agent', id: 'pm' } as const;

/** A demo worker's role, by the rule the server uses (`workerRoleOf`): its role setting, else the role of the task it last claimed. */
function demoRoleOf(snap: ProjectViewSnapshot, settings: readonly SettingView[], workerId: string): string | null {
  return workerRoleOf(workerId,
    settings.filter((x) => x.scope === 'runner').map((x) => ({ workerId: x.key, field: x.field, value: x.desired })),
    Object.values(snap.attempts).map((a) => ({ workerId: a.runnerId ?? '', role: snap.tasks[a.taskId]?.role ?? null, at: a.startedAt })));
}
