import type { Actor, EventType } from '@selarikru/domain';
import type { AssistantView, ProjectViewEvent, UsageEntry, UsageFigure } from '@selarikru/view-protocol';
import { mulberry32, seededId } from './prng.ts';

/** Every fixture starts from this instant (the first day of the interface milestone). Fixed, so fixtures never depend on the wall clock. */
export const FIXTURE_T0_MS = Date.parse('2026-11-16T09:00:00.000Z');
export const fixtureTime = (sec: number): string => new Date(FIXTURE_T0_MS + sec * 1000).toISOString();

export const SCHEDULER: Actor = { kind: 'scheduler', id: 'scheduler' };
export const HUMAN: Actor = { kind: 'human', id: 'demo-operator' };
export const VERIFIER: Actor = { kind: 'verifier', id: 'verifier' };
export const REAPER: Actor = { kind: 'system', id: 'lease_reaper' };
export const runnerActor = (runnerId: string): Actor => ({ kind: 'worker', id: runnerId });

export type FixtureId =
  | 'healthy-parallel-work' | 'human-wait' | 'policy-block' | 'runner-loss' | 'long-build-stall'
  | 'contract-change' | 'failed-ci' | 'expired-approval' | 'unknown-costs' | 'no-data';

export interface Fixture {
  readonly id: FixtureId;
  readonly name: string;
  readonly description: string;
  readonly projectId: string;
  /** Seconds after the fixture epoch at which the virtual clock starts. Events at or before it are in the first snapshot; later ones stream in. */
  readonly startSec: number;
  readonly events: readonly ProjectViewEvent[];
  readonly usage: readonly UsageEntry[];
  readonly assistant: AssistantView;
}

interface EmitOptions {
  taskId?: string;
  attemptId?: string | null;
  actor?: Actor;
  payload?: Record<string, unknown>;
  /** Events written in the same transaction share an aggregate revision (as `attempt.started` and `placement.decided` do). */
  bump?: boolean;
}

/** Builds a deterministic, ordered event stream out of real domain event names. Ids come from the seeded PRNG. */
export class FixtureBuilder {
  readonly events: ProjectViewEvent[] = [];
  private readonly next: () => number;
  private readonly revisions = new Map<string, number>();

  constructor(
    readonly projectId: string,
    readonly runId: string,
    seed: number,
  ) {
    this.next = mulberry32(seed);
  }

  emit(type: EventType, sec: number, o: EmitOptions = {}): this {
    const taskId = o.taskId ?? this.runId;
    const rev = (this.revisions.get(taskId) ?? 0) + (o.bump === false ? 0 : 1);
    this.revisions.set(taskId, rev);
    const at = fixtureTime(sec);
    this.events.push({
      schemaVersion: 1, eventId: seededId(this.next, 'evt'), projectId: this.projectId, runId: this.runId, taskId, attemptId: o.attemptId ?? null,
      type, sequence: this.events.length + 1, aggregateRevision: rev, actor: o.actor ?? SCHEDULER, occurredAt: at, receivedAt: at,
      causationId: null, traceId: `trace_${this.projectId}`, payload: o.payload ?? {}, provenance: 'simulated',
    });
    return this;
  }

  run(planRevision = 1): this {
    return this.emit('run.created', 0, { actor: HUMAN, payload: { lifecycle: 'planning' } }).emit('plan.accepted', 1, { payload: { planRevision, lifecycle: 'running' } });
  }

  ready(taskId: string, sec: number, title: string, role: string, extra: Record<string, unknown> = {}): this {
    return this.emit('task.ready', sec, { taskId, payload: { title, role, reason: 'dependencies_satisfied', ...extra } });
  }

  start(taskId: string, attemptId: string, sec: number, runnerId: string, location: 'local' | 'cloud', modelRoute: 'device' | 'cloud' | 'unknown', n = 1, fence = n): this {
    return this.emit('attempt.started', sec, { taskId, attemptId, payload: { fence, attemptNumber: n, runnerId, location, modelRoute } })
      .emit('placement.decided', sec, {
        taskId, attemptId, bump: false,
        payload: { target: location, reason: location === 'local' ? 'local_slot_free' : 'execution_cloud', modelRoute, ...(location === 'cloud' ? { destination: 'sandbox-cloud' } : {}) },
      });
  }

  beat(taskId: string, attemptId: string, runnerId: string, sec: number, payload: Record<string, unknown> = {}, fence = 1): this {
    return this.emit('attempt.heartbeat', sec, { taskId, attemptId, actor: runnerActor(runnerId), bump: false, payload: { fence, ...payload } });
  }

  /** Heartbeats every 10 s (the real interval) from `from` to `to`, inclusive. */
  beats(taskId: string, attemptId: string, runnerId: string, from: number, to: number, payload: (sec: number) => Record<string, unknown> = () => ({}), fence = 1): this {
    for (let s = from; s <= to; s += 10) this.beat(taskId, attemptId, runnerId, s, payload(s), fence);
    return this;
  }

  /** Sorted by time then insertion order, with sequences renumbered from 1: the order a real feed would deliver. */
  build(): ProjectViewEvent[] {
    return this.events
      .map((e, i) => ({ e, i }))
      .sort((a, b) => Date.parse(a.e.occurredAt) - Date.parse(b.e.occurredAt) || a.i - b.i)
      .map(({ e }, i) => ({ ...e, sequence: i + 1 }));
  }
}

export const figure = (metric: UsageFigure['metric'], quantity: string | null, provenance: UsageFigure['provenance'], source: string): UsageFigure => ({ metric, quantity, provenance, source });

export function usageEntry(runId: string, taskId: string | null, attemptId: string | null, fig: UsageFigure): UsageEntry {
  return { entryId: `usg_${taskId ?? runId}_${attemptId ?? 'all'}_${fig.metric}`, runId, taskId, attemptId, figure: fig };
}
