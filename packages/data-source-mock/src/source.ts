import {
  AuthorizedTerminalRequestSchema, AuthorizedViewCommandSchema, DataSourceException, TERMINAL_MAX_LINES, applyEvent, approvalStateAt, emptySnapshot, isoOf,
  projectionFromSnapshot, cursorToSequence, CursorSchema,
  type AuthorizedTerminalRequest, type AuthorizedViewCommand, type CommandReceipt, type DataSourceError, type EngineeringDataSource, type ProjectViewEvent,
  type Clock, type ProjectViewSnapshot, type ProjectionState, type TerminalChannel,
} from '@selarikru/view-protocol';
import type { VirtualClock } from './clock.ts';
import { HUMAN, SCHEDULER, type Fixture } from './builder.ts';
import { buildAllFixtures } from './fixtures.ts';
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

const fail = (code: DataSourceError['code'], message: string, retryable = false): DataSourceException => new DataSourceException({ code, message, retryable });

/**
 * A deterministic in-memory EngineeringDataSource. It holds every fixture as a project, releases events as the injected virtual clock
 * advances, and answers commands with simulated receipts. It imports no runtime or provider client and never touches the network.
 * Everything it returns is labelled `simulated`; none of it is evidence.
 */
export function createMockDataSource(options: MockOptions): MockDataSource {
  const { clock } = options;
  const timeOf = (p: Project): number => clock.nowMs() + p.fixture.startSec * 1000;
  const projects = new Map<string, Project>();
  let closed = false;

  for (const fixture of options.fixtures ?? buildAllFixtures()) {
    const project: Project = {
      fixture,
      pending: [...fixture.events],
      released: [],
      state: projectionFromSnapshot(emptySnapshot({ projectId: fixture.projectId, observedAt: isoOf(clock.nowMs() + fixture.startSec * 1000), provenance: 'simulated' })),
      subscribers: new Set(),
      receipts: new Map(),
    };
    projects.set(fixture.projectId, project);
  }

  const tick = (): void => {
    for (const p of projects.values()) {
      release(p);
      flushAll(p);
    }
  };

  function accept(p: Project, event: ProjectViewEvent): void {
    const numbered = { ...event, sequence: p.released.length + 1 };
    const result = applyEvent(p.state, numbered);
    if (result.outcome === 'resync' || result.outcome === 'duplicate') throw new Error(`mock fixture ${p.fixture.id} is inconsistent: ${result.outcome}`);
    p.state = result.state;
    p.released.push(numbered);
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

  // Seed the first snapshot: every event due at the clock's start. The clock starts at the fixture's start time.
  for (const p of projects.values()) release(p);
  const stopTicking = clock.onTick(tick);

  const project = (projectId: string): Project => {
    if (closed) throw fail('disconnected', 'the mock data source is disconnected');
    const p = projects.get(projectId);
    if (!p) throw fail('unknown_project', `no mock project ${projectId}`);
    return p;
  };

  function snapshotOf(p: Project): ProjectViewSnapshot {
    const s = p.state.snapshot;
    return { ...s, meta: { ...s.meta, observedAt: isoOf(timeOf(p)) }, assistant: p.fixture.assistant, usage: [...p.fixture.usage] };
  }

  const prng = mulberry32(0x5e1a);
  function appendCommandEvent(p: Project, taskId: string, type: 'task.cancel_requested' | 'task.ready' | 'approval.granted' | 'approval.denied' | 'task.cancelled', payload: Record<string, unknown>, delayMs = 0, revisionStep = 1): void {
    const task = p.state.snapshot.tasks[taskId];
    const runId = task?.runId ?? Object.keys(p.state.snapshot.runs)[0] ?? 'run_demo';
    const at = isoOf(timeOf(p) + delayMs);
    const event: ProjectViewEvent = {
      schemaVersion: 1, eventId: seededId(prng, 'evt'), projectId: p.fixture.projectId, runId, taskId, attemptId: null, type, sequence: 0,
      aggregateRevision: (task?.aggregateRevision ?? 0) + revisionStep, actor: type === 'task.ready' || type === 'task.cancelled' ? SCHEDULER : HUMAN,
      occurredAt: at, receivedAt: at, causationId: null, traceId: `trace_${p.fixture.projectId}`, payload, provenance: 'simulated',
    };
    // Commands are the future of the stream: keep it ordered by time, then insertion.
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
        if (['merged', 'cancelled', 'superseded'].includes(task.status) || task.cancelRequested) return rejected(c.idempotencyKey, 'not_allowed');
        appendCommandEvent(p, task.taskId, 'task.cancel_requested', { operationId: op });
        // Termination is confirmed separately and later, as in the real system.
        appendCommandEvent(p, task.taskId, 'task.cancelled', { reason: 'cancel_requested', operationId: op }, 2000, 2);
        return receipt(c.idempotencyKey, { operationId: op, accepted: true, execution: 'cancel_requested' });
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
    appendCommandEvent(p, approval.taskId ?? approval.runId, c.command === 'approval.grant' ? 'approval.granted' : 'approval.denied', { approvalId: approval.approvalId, scopeHash: approval.scopeHash });
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
      // The target project is the one holding the task or approval.
      const c = parsed.data;
      const owner = [...projects.values()].find((p) =>
        'taskId' in c.args ? Boolean(p.state.snapshot.tasks[c.args.taskId]) : Boolean(p.state.snapshot.approvals[c.args.approvalId]),
      );
      if (closed) throw fail('disconnected', 'the mock data source is disconnected');
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
