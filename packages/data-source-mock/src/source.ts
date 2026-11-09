import {
  AuthorizedTerminalRequestSchema, AuthorizedViewCommandSchema, CursorSchema, DataSourceException, TERMINAL_MAX_LINES, applyEvent, approvalStateAt, cursorToSequence, emptySnapshot,
  isoOf, projectionFromSnapshot, sequenceToCursor,
  isReverifiableReason,
  type AuthorizedTerminalRequest, type AuthorizedViewCommand, type ChangeRequestView, type Clock, type ModelAssignmentView, type ModelCatalogView, type CommandReceipt, type DataSourceError, type EngineeringDataSource, type NotDelivered, type ProjectViewEvent,
  type ProjectViewSnapshot, type ProjectionState, type RunView, type ScopeAssessment, type TaskView, type TerminalChannel, type TerminalControlChannel, type TerminalControlState, type TerminalState,
} from '@selarikru/view-protocol';
import { approvalUnavailableReason, criterionDescription } from '@selarikru/domain';
import type { VirtualClock } from './clock.ts';
import { DEMO_CATALOG, FIXTURE_T0_MS, HUMAN, INTEGRATION, REAPER, SCHEDULER, type Fixture, type TaskSeed } from './builder.ts';
import { buildDemoFixtures } from './fixtures.ts';
import { mulberry32, seededId } from './prng.ts';

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
}

export interface MockOptions {
  readonly clock: VirtualClock;
  /** Defaults to the ten named fixtures. */
  readonly fixtures?: readonly Fixture[];
}

export interface MockDataSource extends EngineeringDataSource {
  readonly mode: 'mock';
  readonly clock: VirtualClock;
  /** The clock a project's UI should read: the shared virtual clock shifted to that fixture's start time. */
  clockFor(projectId: string): Clock;
  listProjects(): readonly { projectId: string; fixtureId: Fixture['id']; name: string; description: string }[];
}

/** The same lists the real cancel route uses: a running task gets a cancel request, these cancel at once, anything else is refused. */
const IMMEDIATE_CANCEL: readonly string[] = ['planned', 'ready', 'awaiting_approval', 'blocked', 'verifying'];
const HEARTBEAT_STEP_MS = 10_000;
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
  const timeOf = (p: Project): number => clock.nowMs() + p.fixture.startSec * 1000;
  const projects = new Map<string, Project>();
  let closed = false;

  for (const fixture of options.fixtures ?? buildDemoFixtures()) {
    projects.set(fixture.projectId, {
      fixture, pending: [...fixture.events], released: [], subscribers: new Set(), receipts: new Map(), changeRequests: [...(fixture.changeRequests ?? [])], reverifyCounts: new Map(),
      modelCatalog: fixture.modelCatalog ?? DEMO_CATALOG, modelAssignments: [...(fixture.modelAssignments ?? [])], assignmentRevisions: new Map((fixture.modelAssignments ?? []).map((a) => [`${a.scope}:${a.key}`, a.revision])),
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
      for (const id of ids) {
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

  function release(p: Project): void {
    const now = timeOf(p);
    while (p.pending[0] && Date.parse(p.pending[0].occurredAt) <= now) accept(p, p.pending.shift()!);
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
    const runs = Object.fromEntries(Object.entries(s.runs).map(([id, r]) => [id, { ...r, criteria: criteriaOf(p, id), evidence: evidenceOf(p, id), scopeAssessment: scopeAssessmentOf(p, id) }]));
    return { ...s, runs, attempts, workers, modelCatalog: p.modelCatalog, modelAssignments: p.modelAssignments.map((a) => ({ ...a })), meta: { ...s.meta, observedAt: isoOf(timeOf(p)) }, assistant: p.fixture.assistant, usage: [...p.fixture.usage], changeRequests: p.changeRequests.map((c) => ({ ...c })), approvalHistory: historyOf(s), limits: { maxConcurrentTotal: 2 },
      runners: [...new Set(Object.values(workers).map((w) => w.workerId))].sort().map((runnerId) => ({ runnerId, location: runnerId.includes('cloud') ? ('cloud' as const) : ('local' as const), label: null, lastSeenAt: isoOf(Date.parse(Object.values(workers).find((w) => w.workerId === runnerId)!.lastHeartbeatAt ?? isoOf(timeOf(p)))) })),
    };
  }

  const prng = mulberry32(0x5e1a);
  type CommandEvent = 'task.cancel_requested' | 'task.ready' | 'approval.granted' | 'approval.denied' | 'task.cancelled' | 'task.reopened' | 'run.reduced_scope_accepted' | 'change.proposed';
  function appendCommandEvent(p: Project, taskId: string, type: CommandEvent, payload: Record<string, unknown>, o: { delayMs?: number; revisionStep?: number; attemptId?: string | null; system?: boolean } = {}): void {
    const task = p.state.snapshot.tasks[taskId];
    const runId = task?.runId ?? Object.keys(p.state.snapshot.runs)[0] ?? p.fixture.projectId;
    const at = isoOf(timeOf(p) + (o.delayMs ?? 0));
    const event: ProjectViewEvent = {
      schemaVersion: 1, eventId: seededId(prng, 'evt'), projectId: p.fixture.projectId, runId, taskId, attemptId: o.attemptId ?? null, type, sequence: 0,
      aggregateRevision: (task?.aggregateRevision ?? 0) + (o.revisionStep ?? 1), actor: o.system ? REAPER : type === 'task.ready' ? SCHEDULER : type === 'task.reopened' || type === 'change.proposed' ? INTEGRATION : HUMAN,
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
    p.modelAssignments = [...p.modelAssignments.filter((a) => !(a.scope === scope && a.key === key)), { scope, key, provider: selection?.provider ?? null, model: selection?.model ?? null, revision, updatedBy: 'demo-operator', updatedAt: isoOf(timeOf(p)) }];
    return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'applied' });
  }

  function run(p: Project, c: AuthorizedViewCommand): CommandReceipt {
    const snap = p.state.snapshot;
    const op = `op_${seededId(prng, 'sim')}`;
    if (c.command === 'assignment.set') return setAssignment(p, c, op);
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
      p.changeRequests = [...p.changeRequests.filter((x) => x.runId !== r.runId), { runId: r.runId, prNumber: number, url, status: 'open', candidateSha: 'c'.repeat(40), baseRef: 'main', observedHeadSha: 'c'.repeat(40), mergeCommitSha: null, observedAt: isoOf(timeOf(p)) }];
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

  return {
    mode: 'mock',
    clock,
    clockFor(projectId) {
      const p = projects.get(projectId);
      if (!p) throw fail('unknown_project', `no mock project ${projectId}`);
      return { nowMs: () => timeOf(p) };
    },
    listProjects: () => [...projects.values()].map(({ fixture }) => ({ projectId: fixture.projectId, fixtureId: fixture.id, name: fixture.name, description: fixture.description })),

    async getSnapshot(projectId) {
      return snapshotOf(project(projectId));
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
