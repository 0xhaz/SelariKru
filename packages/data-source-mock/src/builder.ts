import type { Actor, EventType } from '@selarikru/domain';
import type { AssistantView, ChangeRequestView, ModelAssignmentView, ModelCatalogView, ProjectViewEvent, UsageEntry, UsageFigure } from '@selarikru/view-protocol';
import { mulberry32, seededId } from './prng.ts';

/** Every fixture starts from this instant (the first day of the interface milestone). Fixed, so fixtures never depend on the wall clock. */
export const FIXTURE_T0_MS = Date.parse('2026-11-16T09:00:00.000Z');
export const fixtureTime = (sec: number): string => new Date(FIXTURE_T0_MS + sec * 1000).toISOString();

export const SCHEDULER: Actor = { kind: 'scheduler', id: 'scheduler' };
export const SYSTEM: Actor = { kind: 'system', id: 'control-plane' };
export const HUMAN: Actor = { kind: 'human', id: 'demo-operator' };
export const VERIFIER: Actor = { kind: 'verifier', id: 'verifier' };
export const INTEGRATION: Actor = { kind: 'integration', id: 'integration' };
export const REAPER: Actor = { kind: 'system', id: 'lease_reaper' };
export const runnerActor = (runnerId: string): Actor => ({ kind: 'worker', id: runnerId });

export type FixtureId =
  | 'healthy-parallel-work' | 'human-wait' | 'policy-block' | 'runner-loss' | 'long-build-stall'
  | 'contract-change' | 'failed-ci' | 'expired-approval' | 'unknown-costs' | 'no-data'
  /** Not one of the ten named scenarios: the verified-to-merged path, for run lifecycle. */
  | 'merge-flow'
  /** Not one of the ten named scenarios: a plan with real dependencies across stages, for the Pipeline graph. */
  | 'feature-delivery'
  /** Not named scenarios: one state each, for the Decisions screen. */
  | 'decision-queue' | 'changed-request' | 'budget-stop' | 'integration-blocked' | 'merge-review' | 'merged-sha-mismatch'
  /** Not a named scenario: a benchmark trial, whose one model cannot be changed. */
  | 'benchmark-trial';

/** What a live snapshot knows about a task that events do not say. The mock plays the server: it seeds these when the plan is accepted. */
export interface TaskSeed {
  readonly taskId: string;
  readonly revision: number;
  /** The plan revision that introduced this task revision. */
  readonly planRevision: number;
  readonly title: string;
  readonly role: string;
  readonly dependsOn: readonly string[];
  /** How many acceptance criteria this task covers. Null means this scene has no per-criterion evidence. */
  readonly criteria: number | null;
  /** Requirement and acceptance-check ids this task carries: what a stopped task leaves undelivered. */
  readonly requirementIds: readonly string[];
  readonly acceptanceCheckIds: readonly string[];
}

/** An approval's id, scope and expiry are on the server, not yet in `approval.requested`. The mock attaches them to the matching task's request. */
export interface ApprovalSeed {
  readonly approvalId: string;
  readonly taskId: string | null;
  readonly scopeHash: string;
  readonly reason: string;
  readonly expiresAt: string;
  readonly operation: string | null;
  readonly destination: string | null;
}

/** Heartbeats stop at `fromSec` and resume at `toSec` (never when null). Heartbeats are not events: this shapes the snapshot's liveness only. */
export interface Silence {
  readonly fromSec: number;
  readonly toSec: number | null;
}

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
  readonly tasks: readonly TaskSeed[];
  readonly approvals: readonly ApprovalSeed[];
  readonly silences: Readonly<Record<string, Silence>>;
  /** What the provider has said about a run's pull request. Reconciliation has no event, so this is snapshot data. */
  readonly changeRequests?: readonly ChangeRequestView[];
  /** Tasks with a budget stop in flight, by when it began. A real stop writes a command row and no event until the task is cancelled, so this is snapshot data. */
  readonly budgetStopping?: Readonly<Record<string, number>>;
  /** False: the runners here report no tool, the case a screen must still say honestly. Default true. */
  readonly reportsActivity?: boolean;
  /** What the harness adapters report. Default `DEMO_CATALOG`. Simulated like everything here. */
  readonly modelCatalog?: ModelCatalogView;
  readonly modelAssignments?: readonly ModelAssignmentView[];
}

/** Claude only: no provider is listed that is not installed. Opus is marked not allowed so the demo can show a refused choice. */
export const DEMO_CATALOG: ModelCatalogView = {
  status: 'detected', detail: null, projectDefault: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  providers: [{
    provider: 'anthropic', label: 'Claude', harnessVersion: '2.1.316',
    models: [
      { modelId: 'claude-sonnet-5-5', label: 'Sonnet 5.5', route: 'cloud', allowedByPolicy: true, policyReason: null },
      { modelId: 'claude-haiku-5-5', label: 'Haiku 5.5', route: 'cloud', allowedByPolicy: true, policyReason: null },
      { modelId: 'claude-opus-5-5', label: 'Opus 5.5', route: 'cloud', allowedByPolicy: false, policyReason: 'model_not_allowed' },
    ],
  }],
};

/** Ids are namespaced per fixture so a command or terminal request can only ever match one project. */
export const scoped = (fixtureId: FixtureId, local: string): string => `${fixtureId}.${local}`;

interface EmitOptions {
  /** Local task name; omitted for run-level events. */
  task?: string;
  attempt?: string;
  actor?: Actor;
  payload?: Record<string, unknown>;
  /** Events written in the same transaction share an aggregate revision (as `attempt.started` and `placement.decided` do). */
  bump?: boolean;
}

/** Builds a deterministic, ordered stream of real domain events. Ids come from the seeded PRNG; local names are namespaced here. */
export class FixtureBuilder {
  readonly events: ProjectViewEvent[] = [];
  readonly projectId: string;
  readonly runId: string;
  readonly taskSeeds: TaskSeed[] = [];
  readonly approvalSeeds: ApprovalSeed[] = [];
  readonly silences: Record<string, Silence> = {};
  readonly budgetStopping: Record<string, number> = {};
  /** A benchmark trial's single model, when this fixture is one. */
  pinnedModel: { provider: string; model: string } | null = null;
  private readonly next: () => number;
  private readonly revisions = new Map<string, number>();

  constructor(readonly slug: FixtureId, seed: number) {
    this.projectId = `demo-${slug}`;
    this.runId = scoped(slug, 'run');
    this.next = mulberry32(seed);
  }

  id(local: string): string {
    return scoped(this.slug, local);
  }

  task(local: string, seed: { title: string; role: string; dependsOn?: string[]; revision?: number; planRevision?: number; criteria?: number; requirements?: string[]; checks?: string[] }): this {
    this.taskSeeds.push({
      taskId: this.id(local), revision: seed.revision ?? 1, planRevision: seed.planRevision ?? 1, title: seed.title, role: seed.role,
      dependsOn: (seed.dependsOn ?? []).map((d) => this.id(d)), criteria: seed.criteria ?? null, requirementIds: seed.requirements ?? [], acceptanceCheckIds: seed.checks ?? [],
    });
    return this;
  }

  approval(local: string, seed: { task: string | null; scopeHash: string; reason: string; expiresAtSec: number; operation?: string; destination?: string }): this {
    this.approvalSeeds.push({ approvalId: this.id(local), taskId: seed.task === null ? null : this.id(seed.task), scopeHash: seed.scopeHash, reason: seed.reason, expiresAt: fixtureTime(seed.expiresAtSec), operation: seed.operation ?? null, destination: seed.destination ?? null });
    return this;
  }

  /** A budget stop is in flight from `fromSec`; the fixture's later `task.cancelled` ends it. */
  stopping(taskLocal: string, fromSec: number): this {
    this.budgetStopping[this.id(taskLocal)] = fromSec;
    return this;
  }

  silence(attemptLocal: string, fromSec: number, toSec: number | null): this {
    this.silences[this.id(attemptLocal)] = { fromSec, toSec };
    return this;
  }

  emit(type: EventType, sec: number, o: EmitOptions = {}): this {
    const taskId = o.task === undefined ? this.runId : this.id(o.task);
    const rev = (this.revisions.get(taskId) ?? 0) + (o.bump === false ? 0 : 1);
    this.revisions.set(taskId, rev);
    const at = fixtureTime(sec);
    this.events.push({
      schemaVersion: 1, eventId: seededId(this.next, 'evt'), projectId: this.projectId, runId: this.runId, taskId,
      attemptId: o.attempt === undefined ? null : this.id(o.attempt),
      type, sequence: this.events.length + 1, aggregateRevision: rev, actor: o.actor ?? SCHEDULER, occurredAt: at, receivedAt: at,
      causationId: null, traceId: `trace_${this.projectId}`, payload: o.payload ?? {}, provenance: 'simulated',
    });
    return this;
  }

  /** `run.created`, then `plan.accepted` with the real payload shape (revision, task ids, who accepted it). */
  plan(planRevision: number, tasks: readonly string[], sec = 1): this {
    if (planRevision === 1) this.emit('run.created', 0, { actor: HUMAN, ...(this.pinnedModel ? { payload: { pinnedModel: this.pinnedModel } } : {}) });
    return this.emit('plan.accepted', sec, { actor: SYSTEM, payload: { planRevision, taskIds: tasks.map((t) => this.id(t)), acceptedFor: 'demo-operator' } });
  }

  ready(task: string, sec: number, reason = 'dependencies_satisfied'): this {
    return this.emit('task.ready', sec, { task, payload: { reason } });
  }

  /** Claim: `attempt.started` then `placement.decided` in one revision. `modelRoute` is the one extra field (see the report). */
  start(task: string, attempt: string, sec: number, runnerId: string, location: 'local' | 'cloud', modelRoute: 'device' | 'cloud' | 'unknown', n = 1): this {
    return this.emit('attempt.started', sec, {
      task, attempt, payload: { fence: n, attemptNumber: n, runnerId, location, reservationId: `rsv_${attempt}_${n}`, amountUsd: 1, modelRoute, ...(modelRoute === 'cloud' ? { assignment: this.pinnedModel ? { ...this.pinnedModel, source: 'trial_pin' } : { provider: 'anthropic', model: 'claude-sonnet-5-5', source: 'role' } } : {}) },
    }).emit('placement.decided', sec, {
      task, attempt, bump: false,
      payload: { target: location, reason: location === 'local' ? 'local_slot_free' : 'execution_cloud', mode: 'local-first', runnerId, ...(location === 'cloud' ? { destination: 'sandbox-cloud' } : {}) },
    });
  }

  complete(task: string, attempt: string, sec: number, runnerId: string, fence = 1): this {
    return this.emit('attempt.completed', sec, { task, attempt, actor: runnerActor(runnerId), payload: { fence } });
  }

  /** The verifier's verdict. A failure is followed, in the same transaction, by `task.ready` (repair scheduled). */
  verdict(task: string, attempt: string, sec: number, outcome: 'passed' | 'failed', detail: { checkId: string; summary: string }): this {
    this.emit(outcome === 'passed' ? 'verification.passed' : 'verification.failed', sec, { task, attempt, actor: VERIFIER, payload: { ...detail } });
    return outcome === 'failed' ? this.emit('task.ready', sec, { task, attempt, bump: false, payload: { reason: 'repair_scheduled' } }) : this;
  }

  /** Sorted by time then insertion order, with sequences renumbered from 1: the order a real feed would deliver. */
  buildEvents(): ProjectViewEvent[] {
    return this.events
      .map((e, i) => ({ e, i }))
      .sort((a, b) => Date.parse(a.e.occurredAt) - Date.parse(b.e.occurredAt) || a.i - b.i)
      .map(({ e }, i) => ({ ...e, sequence: i + 1 }));
  }

  use(task: string | null, attempt: string | null, fig: UsageFigure): UsageEntry {
    return { entryId: `usg_${task ?? 'run'}_${attempt ?? 'all'}_${fig.metric}_${this.slug}`, runId: this.runId, taskId: task === null ? null : this.id(task), attemptId: attempt === null ? null : this.id(attempt), figure: fig };
  }
}

export const figure = (metric: UsageFigure['metric'], quantity: string | null, provenance: UsageFigure['provenance'], source: string): UsageFigure => ({ metric, quantity, provenance, source });
