import {
  AuthorizedTerminalRequestSchema, AuthorizedViewCommandSchema, CursorSchema, DataSourceException, TERMINAL_MAX_LINES, applyEvent, approvalStateAt, cursorToSequence, emptySnapshot,
  isoOf, projectionFromSnapshot, sequenceToCursor,
  type AuthorizedTerminalRequest, type AuthorizedViewCommand, type Clock, type CommandReceipt, type DataSourceError, type EngineeringDataSource, type ProjectViewEvent,
  type ProjectViewSnapshot, type ProjectionState, type RunView, type TaskView, type TerminalChannel,
} from '@selarikru/view-protocol';
import type { VirtualClock } from './clock.ts';
import { FIXTURE_T0_MS, HUMAN, REAPER, SCHEDULER, type Fixture, type TaskSeed } from './builder.ts';
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
      fixture, pending: [...fixture.events], released: [], subscribers: new Set(), receipts: new Map(),
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
      const run = snap.runs[event.runId] ?? { runId: event.runId, lifecycle: 'running' as const, planRevision: 0, latestEvidence: null, criteria: null };
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
      if (seed) applied = { ...event, payload: { ...event.payload, approvalId: seed.approvalId, scopeHash: seed.scopeHash, expiresAt: seed.expiresAt } };
    }
    const result = applyEvent(p.state, applied);
    if (result.outcome === 'resync' || result.outcome === 'duplicate') throw new Error(`mock fixture ${p.fixture.id} is inconsistent at ${event.type}: ${result.outcome}`);
    p.state = result.state;
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
    const live = Object.values(p.state.snapshot.tasks).filter((t) => t.runId === runId && t.status !== 'superseded' && t.status !== 'cancelled');
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

  function snapshotOf(p: Project): ProjectViewSnapshot {
    const s = p.state.snapshot;
    const attempts = Object.fromEntries(
      Object.entries(s.attempts).map(([id, a]) => [id, a.outcome === 'running' && a.endedAt === null ? { ...a, lastHeartbeatAt: heartbeatAt(p, id, a.startedAt) } : a]),
    );
    const workers = Object.fromEntries(
      Object.entries(s.workers).map(([id, w]) => {
        const a = w.attemptId !== null ? attempts[w.attemptId] : undefined;
        return [id, w.leaseHeld && a ? { ...w, lastHeartbeatAt: a.lastHeartbeatAt } : w];
      }),
    );
    const runs = Object.fromEntries(Object.entries(s.runs).map(([id, r]) => [id, { ...r, criteria: criteriaOf(p, id) }]));
    return { ...s, runs, attempts, workers, meta: { ...s.meta, observedAt: isoOf(timeOf(p)) }, assistant: p.fixture.assistant, usage: [...p.fixture.usage] };
  }

  const prng = mulberry32(0x5e1a);
  type CommandEvent = 'task.cancel_requested' | 'task.ready' | 'approval.granted' | 'approval.denied' | 'task.cancelled';
  function appendCommandEvent(p: Project, taskId: string, type: CommandEvent, payload: Record<string, unknown>, o: { delayMs?: number; revisionStep?: number; attemptId?: string | null; system?: boolean } = {}): void {
    const task = p.state.snapshot.tasks[taskId];
    const runId = task?.runId ?? Object.keys(p.state.snapshot.runs)[0] ?? p.fixture.projectId;
    const at = isoOf(timeOf(p) + (o.delayMs ?? 0));
    const event: ProjectViewEvent = {
      schemaVersion: 1, eventId: seededId(prng, 'evt'), projectId: p.fixture.projectId, runId, taskId, attemptId: o.attemptId ?? null, type, sequence: 0,
      aggregateRevision: (task?.aggregateRevision ?? 0) + (o.revisionStep ?? 1), actor: o.system ? REAPER : type === 'task.ready' ? SCHEDULER : HUMAN,
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

  function run(p: Project, c: AuthorizedViewCommand): CommandReceipt {
    const snap = p.state.snapshot;
    const op = `op_${seededId(prng, 'sim')}`;
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
    if ((task?.aggregateRevision ?? 0) !== c.expectedRevision) return rejected(c.idempotencyKey, 'stale_revision');
    if (approval.scopeHash !== c.args.scopeHash) return rejected(c.idempotencyKey, 'scope_mismatch');
    if (approvalStateAt(approval, timeOf(p)) === 'expired') return rejected(c.idempotencyKey, 'approval_expired');
    if (approval.state !== 'pending') return rejected(c.idempotencyKey, 'not_allowed');
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
      const owner = [...projects.values()].find((p) => ('taskId' in c.args ? Boolean(p.state.snapshot.tasks[c.args.taskId]) : Boolean(p.state.snapshot.approvals[c.args.approvalId])));
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
      const handlers = new Set<(line: string) => void>();
      let open = true;
      return {
        channelId: `term_${attempt.attemptId}`,
        simulated: true,
        onLine(handler) {
          handlers.add(handler);
          queueMicrotask(() => {
            for (const line of lines) if (open && handlers.has(handler)) handler(line);
          });
          return () => handlers.delete(handler);
        },
        close() {
          open = false;
          handlers.clear();
        },
      };
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
