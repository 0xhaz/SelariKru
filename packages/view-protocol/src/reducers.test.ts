import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, checkEventAuthority, type Actor, type EventType } from '@selarikru/domain';
import {
  DataSourceException, PROJECTED_EVENT_TYPES, ProjectViewEventSchema, ProjectViewSnapshotSchema, RunViewSchema, applyEvent, applyEvents, approvalStateAt, effectiveWorkerHealth, emptySnapshot,
  carryResolvedApprovals, isBudgetStopped, mergeDecisionFacts, mergeLiveness, mergeRunLifecycle, projectionFromSnapshot, startProjection, sumUsage, usageFor, verifiedCounts,
  type DataSourceError, type EngineeringDataSource, type ProjectViewEvent, type ProjectViewSnapshot, type ProjectionState, type TaskView, type UsageEntry, type UsageFigure,
} from './index.ts';

const T0 = Date.parse('2026-11-16T09:00:00.000Z');
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();
const SCHED: Actor = { kind: 'scheduler', id: 'scheduler' };
const WORKER: Actor = { kind: 'worker', id: 'runner_a' };
const HUMAN: Actor = { kind: 'human', id: 'u' };
const INTEGRATION: Actor = { kind: 'integration', id: 'integration' };

/** A project the server already told us about: one run, tasks planned at revision 1. Events never describe these. */
function task(taskId: string, over: Partial<TaskView> = {}): TaskView {
  return {
    taskId, runId: 'r1', revision: 1, aggregateRevision: 0, title: taskId, role: null, dependsOn: null, status: 'planned', statusReason: null, placementBlock: null,
    cancelRequested: null, cancelReason: null, supersededByRevision: null, attemptIds: [], activeAttemptId: null, enteredStatusAt: at(0), latestEvidence: null, ...over,
  };
}
function base(tasks: string[] = ['t1'], provenance: 'simulated' | 'observed' = 'simulated'): ProjectionState {
  const s = emptySnapshot({ projectId: 'p1', observedAt: at(0), provenance });
  return projectionFromSnapshot({
    ...s,
    runs: { r1: { runId: 'r1', lifecycle: 'running', planRevision: 1, latestEvidence: null, criteria: null, evidence: null, reducedScope: null, scopeAssessment: null, pinnedModel: null } },
    tasks: Object.fromEntries(tasks.map((t) => [t, task(t)])),
  });
}
let rev = 0;
/** Next event for a state: the sequence follows the state's cursor, so tests read as a stream. */
function nx(state: ProjectionState, type: EventType, sec: number, over: Partial<ProjectViewEvent> = {}): ProjectViewEvent {
  const sequence = Number(state.snapshot.meta.cursor) + 1;
  rev += 1;
  return {
    schemaVersion: 1, eventId: `evt_${sequence}_${rev}`, projectId: 'p1', runId: 'r1', taskId: 't1', attemptId: null, type, sequence, aggregateRevision: rev, actor: SCHED,
    occurredAt: at(sec), receivedAt: at(sec), causationId: null, traceId: 'trace', payload: {}, provenance: state.snapshot.meta.provenance, ...over,
  };
}
/** Folds a script of [type, sec, overrides] against a state, each event numbered from the live cursor. */
function run(state: ProjectionState, script: Array<[EventType, number, Partial<ProjectViewEvent>?]>): ProjectionState {
  let s = state;
  for (const [type, sec, over] of script) {
    const r = applyEvent(s, nx(s, type, sec, over));
    if (r.outcome === 'resync') throw new Error(`unexpected resync (${r.reason}) at ${type}`);
    s = r.state;
  }
  return s;
}
const STARTED: [EventType, number, Partial<ProjectViewEvent>] = ['attempt.started', 3, { attemptId: 'a1', payload: { fence: 1, attemptNumber: 1, runnerId: 'runner_a', location: 'local', modelRoute: 'cloud' }, actor: SCHED }];
const running = (): ProjectionState => run(base(), [['task.ready', 2, { payload: { reason: 'dependencies_satisfied' } }], STARTED, ['placement.decided', 3, { attemptId: 'a1', payload: { target: 'local' } }]]);

describe('reducers', () => {
  it('reducers are pure and deduplicate by event ID', () => {
    const start = base();
    const before = JSON.stringify(start);
    const evs = [nx(start, 'task.ready', 2), { ...nx(start, STARTED[0], 3, STARTED[2]), sequence: 2 }];
    const s1 = applyEvents(start, evs).state;
    const s2 = applyEvents(start, evs).state;
    expect(JSON.stringify(start)).toBe(before);
    expect(s1.snapshot).toEqual(s2.snapshot);
    expect(ProjectViewSnapshotSchema.safeParse(s1.snapshot).success).toBe(true);
    expect(s1.snapshot.tasks['t1']).toMatchObject({ status: 'running', activeAttemptId: 'a1' });
    const last = nx(s1, 'task.ready', 9);
    const once = applyEvent(s1, last);
    const twice = applyEvent(once.state, last); // same event id again
    expect(twice.outcome).toBe('duplicate');
    expect(twice.state).toBe(once.state);
  });

  it('sequence gap triggers resync', () => {
    const s = run(base(), [['task.ready', 2]]);
    const skipped = applyEvent(s, { ...nx(s, 'task.blocked', 3, { payload: { reason: 'x' } }), sequence: Number(s.snapshot.meta.cursor) + 2 });
    expect(skipped).toMatchObject({ outcome: 'resync', reason: 'gap' });
    expect(skipped.state).toBe(s); // never patched across a gap
  });

  it('a redelivered event (sequence at or below the cursor) is a no-op duplicate, not a resync', () => {
    const s = run(base(), [['task.ready', 2], STARTED]);
    const old = nx(s, 'task.ready', 2);
    const r = applyEvent(s, { ...old, sequence: 1, eventId: 'evt_never_seen' });
    expect(r.outcome).toBe('duplicate');
    expect(r.state).toBe(s);
  });

  it('a simulated event never merges into observed state', () => {
    const s = base(['t1'], 'observed');
    expect(applyEvent(s, { ...nx(s, 'task.ready', 1), provenance: 'simulated' })).toMatchObject({ outcome: 'resync', reason: 'provenance_mismatch' });
  });

  it('handles every real domain event name, and the events pass the envelope contract', () => {
    expect([...PROJECTED_EVENT_TYPES].sort()).toEqual([...EVENT_TYPES].sort());
    let s = base();
    for (const type of EVENT_TYPES) {
      const e = nx(s, type, Number(s.snapshot.meta.cursor), { attemptId: 'a1', payload: { approvalId: 'ap1' } });
      expect(ProjectViewEventSchema.safeParse(e).success, type).toBe(true);
      const r = applyEvent(s, e);
      // plan.accepted on a run that has tasks needs a snapshot; every other type applies or is ignored.
      expect(r.outcome === 'applied' || r.outcome === 'ignored' || (r.outcome === 'resync' && type === 'plan.accepted'), type).toBe(true);
      s = r.outcome === 'resync' ? s : r.state;
    }
  });

  it('applies attempt events only to the active attempt and current fence', () => {
    const s = running();
    const stale = applyEvent(s, nx(s, 'attempt.failed', 20, { attemptId: 'old', payload: { fence: 1, reason: 'x' } }));
    expect(stale.outcome).toBe('ignored');
    expect(stale.state.snapshot.meta.cursor).toBe(String(Number(s.snapshot.meta.cursor) + 1)); // the sequence was still received
    const lowFence = applyEvent(stale.state, nx(stale.state, 'attempt.failed', 21, { attemptId: 'a1', payload: { fence: 0, reason: 'x' } }));
    expect(lowFence.outcome).toBe('ignored'); // fence 0 is below the attempt's fence 1
    expect(lowFence.state.snapshot.tasks['t1']!.status).toBe('running');
  });

  it('keeps execution and model route on separate axes, and unknown stays unknown', () => {
    expect(running().snapshot.workers['runner_a']).toMatchObject({ execution: 'local', modelRoute: 'cloud', activity: null });
    const bare = run(base(), [['task.ready', 1], ['attempt.started', 2, { attemptId: 'a9', payload: {} }]]);
    expect(Object.values(bare.snapshot.workers)[0]).toMatchObject({ execution: 'unknown', modelRoute: 'unknown', activity: null });
  });

  it('events for an unknown task or a newer revision need a snapshot; dependsOn and revision are never guessed', () => {
    const s = base();
    expect(applyEvent(s, nx(s, 'task.ready', 1, { taskId: 'ghost' }))).toMatchObject({ outcome: 'resync', reason: 'unknown_task' });
    expect(applyEvent(s, nx(s, 'task.ready', 1, { payload: { revision: 3 } }))).toMatchObject({ outcome: 'resync', reason: 'unknown_revision' });
    expect(s.snapshot.tasks['t1']!.dependsOn).toBeNull();
    expect(Object.keys(applyEvent(s, nx(s, 'task.ready', 1, { taskId: 'ghost' })).state.snapshot.tasks)).toEqual(['t1']);
  });

  it('a lost lease keeps the last activity and shows disconnected; an interrupted attempt does not fail the task', () => {
    let s = running();
    s = run(s, [['attempt.failed', 80, { attemptId: 'a1', actor: { kind: 'system', id: 'lease_reaper' }, payload: { fence: 1, reason: 'lease_expired', outcome: 'interrupted' } }]]);
    expect(s.snapshot.workers['runner_a']).toMatchObject({ availability: 'offline', health: 'disconnected' });
    expect(s.snapshot.attempts['a1']).toMatchObject({ outcome: 'interrupted', exitReason: 'lease_expired' });
    expect(s.snapshot.tasks['t1']!.status).toBe('running'); // until the follow-up task.ready
    s = run(s, [['task.ready', 80, { attemptId: 'a1', payload: { reason: 'lease_expired' } }]]);
    expect(s.snapshot.tasks['t1']!.status).toBe('ready');
  });

  it('attempt_timeout with outcome failed projects as failed', () => {
    const s = run(running(), [['attempt.failed', 90, { attemptId: 'a1', actor: { kind: 'system', id: 'lease_reaper' }, payload: { fence: 1, reason: 'attempt_timeout', outcome: 'failed' } }]]);
    expect(s.snapshot.attempts['a1']).toMatchObject({ outcome: 'failed', exitReason: 'attempt_timeout' });
    expect(s.snapshot.tasks['t1']!.status).toBe('failed');
    expect(s.snapshot.workers['runner_a']).toMatchObject({ availability: 'idle', health: 'healthy' });
  });

  it('budget_exhausted cancel is named, a cancel request is not a cancel, and a cancelled task takes no further events', () => {
    let s = running();
    s = run(s, [['task.cancel_requested', 30, { actor: HUMAN, payload: { operationId: 'op1' } }]]);
    expect(s.snapshot.tasks['t1']).toMatchObject({ status: 'running', cancelRequested: { operationId: 'op1' } });
    s = run(s, [['task.cancelled', 35, { attemptId: 'a1', actor: { kind: 'system', id: 'lease_reaper' }, payload: { reason: 'budget_exhausted' } }]]);
    expect(s.snapshot.tasks['t1']).toMatchObject({ status: 'cancelled', cancelReason: 'budget_exhausted', cancelRequested: null });
    expect(s.snapshot.workers['runner_a']).toMatchObject({ availability: 'idle', activity: null });
    for (const type of ['task.ready', 'attempt.started', 'verification.passed', 'task.blocked'] as const) {
      const r = applyEvent(s, nx(s, type, 40, { attemptId: 'a2', payload: { fence: 2 } }));
      expect(r.outcome, type).toBe('ignored');
      expect(r.state.snapshot.tasks['t1']!.status, type).toBe('cancelled');
    }
  });

  it('task.reopened reads the real payload: blocked names a resource conflict', () => {
    const verified = run(base(), [['task.ready', 1], ['verification.passed', 2, { actor: { kind: 'verifier', id: 'v' } }]]);
    const open = run(verified, [['task.reopened', 3, { actor: INTEGRATION, payload: { reason: 'r', candidateIds: [], status: 'verifying' } }]]);
    expect(open.snapshot.tasks['t1']!.status).toBe('verifying');
    const blocked = run(verified, [['task.reopened', 3, { actor: INTEGRATION, payload: { reason: 'r', candidateIds: [], status: 'blocked', blocked: 'resource_conflict:db' } }]]);
    expect(blocked.snapshot.tasks['t1']).toMatchObject({ status: 'blocked', statusReason: 'resource_conflict:db' });
  });

  it('a verification verdict gives the attempt its real outcome; failure then repair is ready, not stuck failed', () => {
    let s = run(running(), [['attempt.completed', 50, { attemptId: 'a1', actor: WORKER, payload: { fence: 1 } }]]);
    expect(s.snapshot.attempts['a1']!.outcome).toBe('running'); // waiting for the verdict
    s = run(s, [
      ['verification.failed', 90, { attemptId: 'a1', actor: { kind: 'verifier', id: 'v' }, payload: { checkId: 'ci:unit', summary: '3 failed' } }],
      ['task.ready', 90, { attemptId: 'a1', payload: { reason: 'repair_scheduled' } }],
    ]);
    expect(s.snapshot.attempts['a1']).toMatchObject({ outcome: 'failed' });
    expect(s.snapshot.tasks['t1']).toMatchObject({ status: 'ready', statusReason: 'repair_scheduled' });
    expect(s.snapshot.checks['ci:unit']!.state).toBe('failed');
  });
});

describe('approvals', () => {
  it('a real approval.requested (no approvalId) resyncs; request then grant converges once the snapshot supplies the approval', async () => {
    const s0 = running();
    const request = nx(s0, 'approval.requested', 10, { attemptId: 'a1', payload: { fence: 1, reason: 'allow_domain' } });
    expect(applyEvent(s0, request)).toMatchObject({ outcome: 'resync', reason: 'missing_approval_id' });

    // The server's snapshot after the request: task awaiting, approval pending, worker released.
    const serverAfterRequest = applyEvent(s0, { ...request, payload: { ...request.payload, approvalId: 'ap1', scopeHash: 'h' } }).state;
    const snapshots = [s0.snapshot, serverAfterRequest.snapshot];
    let served = 0;
    let push: ((e: ProjectViewEvent) => void) | null = null;
    const source: EngineeringDataSource = {
      mode: 'mock',
      getSnapshot: async () => snapshots[Math.min(served++, 1)]!,
      subscribe: (_p, _c, onEvent) => { push = onEvent; return () => { push = null; }; },
      execute: async () => { throw new Error('unused'); }, openTerminal: async () => { throw new Error('unused'); }, disconnect: () => {},
    };
    const session = startProjection(source, 'p1', { onState: () => {}, onError: () => {} }, NO_REFRESH());
    await settle();
    push!(request); // the real event, without an approval id
    await settle();
    expect(session.resyncCount()).toBe(1);
    const grant = nx(serverAfterRequest, 'approval.granted', 20, { actor: HUMAN, payload: { approvalId: 'ap1', scopeHash: 'h', actionHash: 'x' } });
    push!(grant);
    const final = session.state()!.snapshot;
    expect(final.tasks['t1']!.status).toBe('ready');
    expect(final.approvals['ap1']!.state).toBe('granted');
    expect(Object.values(final.workers)[0]).toMatchObject({ activity: null, blockedByApprovalId: null, availability: 'idle' });
    session.stop();
  });

  it('uses approvalId, scopeHash and expiresAt when the server sends them; a past expiry reads as expired, never granted', () => {
    let s = running();
    s = run(s, [['approval.requested', 10, { attemptId: 'a1', payload: { fence: 1, approvalId: 'ap1', scopeHash: 'h', reason: 'needs_domain', expiresAt: at(100) } }]]);
    const w = s.snapshot.workers['runner_a']!;
    expect(w).toMatchObject({ activity: 'waiting_human', leaseHeld: false, blockedByApprovalId: 'ap1' });
    expect(effectiveWorkerHealth(w, T0 + 3_600_000, T0 + 3_600_000).health).toBe('healthy'); // no lease, no heartbeat verdict
    const ap = s.snapshot.approvals['ap1']!;
    expect(approvalStateAt(ap, T0 + 50_000)).toBe('pending');
    expect(approvalStateAt(ap, T0 + 100_000)).toBe('expired');
    expect(ap.state).toBe('pending');
  });
});

describe('plan revisions and run-level events', () => {
  it('plan.accepted on a run that already has tasks needs a snapshot; on an empty run it only moves the run', () => {
    const withTasks = base();
    expect(applyEvent(withTasks, nx(withTasks, 'plan.accepted', 1, { taskId: 'r1', payload: { planRevision: 2, taskIds: ['t1'] } }))).toMatchObject({ outcome: 'resync', reason: 'plan_revision' });
    const empty = projectionFromSnapshot(emptySnapshot({ projectId: 'p1', observedAt: at(0), provenance: 'simulated' }));
    const r = applyEvent(empty, nx(empty, 'plan.accepted', 1, { taskId: 'r1', payload: { planRevision: 1 } }));
    expect(r.outcome).toBe('applied');
    expect(r.state.snapshot.runs['r1']).toMatchObject({ planRevision: 1, lifecycle: 'running' });
    expect(r.state.snapshot.tasks).toEqual({}); // task identity, revision and title come from a snapshot
  });

  it('run-scoped events (taskId is the run id) never create tasks and do not disturb verified counts', () => {
    let s = run(base(['t1', 't2']), [['task.ready', 1], ['verification.passed', 2]]);
    expect(verifiedCounts(s.snapshot)).toEqual({ verified: 1, total: 2 });
    const before = Object.keys(s.snapshot.tasks);
    s = run(s, [
      ['change.proposed', 5, { taskId: 'r1', actor: INTEGRATION, payload: { prUrl: 'x' } }],
      ['candidate.assembled', 6, { taskId: 'r1', actor: INTEGRATION, payload: { candidateId: 'c1' } }],
      ['candidate.failed', 7, { taskId: 'r1', actor: INTEGRATION, payload: { reason: 'conflict' } }],
      ['approval.requested', 8, { taskId: 'r1', actor: SCHED, payload: { approvalId: 'apr_run', scopeHash: 's' } }],
      ['approval.granted', 9, { taskId: 'r1', actor: HUMAN, payload: { approvalId: 'apr_run' } }],
      ['change.merged', 10, { taskId: 'r1', actor: INTEGRATION, payload: {} }],
    ]);
    expect(Object.keys(s.snapshot.tasks)).toEqual(before);
    expect(verifiedCounts(s.snapshot)).toEqual({ verified: 1, total: 2 });
    expect(s.snapshot.runs['r1']!.latestEvidence).toMatchObject({ kind: 'change.merged' });
    expect(s.snapshot.checks['candidate:r1']).toMatchObject({ state: 'failed', taskId: null });
    expect(s.snapshot.approvals['apr_run']).toMatchObject({ state: 'granted', taskId: null });
    expect(s.snapshot.tasks['t1']!.status).toBe('verified'); // not merged by a run-level merge event
  });

  it('every event used in these tests passes the domain actor allowlist', () => {
    const s = base();
    expect(checkEventAuthority({ ...nx(s, 'task.ready', 1), actor: SCHED }).ok).toBe(true);
  });
});

const fig = (quantity: string | null, provenance: UsageFigure['provenance'], metric: UsageFigure['metric'] = 'cost_usd'): UsageFigure => ({ metric, quantity, provenance, source: 't' });

describe('usage', () => {
  it('unknown is never zero: an unavailable figure makes the total unknown', () => {
    const t = sumUsage([fig('1.50', 'observed'), fig(null, 'unavailable')]);
    expect(t.total).toBeNull();
    expect(t.provenance).toBe('unavailable');
    expect(t.knownSubtotal).toBe('1.5');
    expect(t.unavailableCount).toBe(1);
    expect(sumUsage([fig(null, 'unavailable')])).toMatchObject({ total: null, knownSubtotal: null });
    expect(sumUsage([])).toMatchObject({ total: null, provenance: 'unavailable' });
  });
  it('sums known figures exactly and reports the weakest provenance', () => {
    expect(sumUsage([fig('0.1', 'observed'), fig('0.2', 'observed')])).toMatchObject({ total: '0.3', provenance: 'observed' });
    expect(sumUsage([fig('1', 'observed'), fig('2.000001', 'estimated')])).toMatchObject({ total: '3.000001', provenance: 'estimated' });
  });
  it('scopes entries and ignores other metrics', () => {
    const entries: UsageEntry[] = [
      { entryId: 'u1', runId: 'r1', taskId: 't1', attemptId: 'a1', figure: fig('1', 'observed') },
      { entryId: 'u2', runId: 'r1', taskId: 't2', attemptId: null, figure: fig(null, 'unavailable') },
      { entryId: 'u3', runId: 'r1', taskId: 't1', attemptId: 'a1', figure: fig('5', 'observed', 'input_tokens') },
    ];
    expect(usageFor(entries, 'cost_usd', { taskId: 't1' }).total).toBe('1');
    expect(usageFor(entries, 'cost_usd', { runId: 'r1' }).total).toBeNull();
  });
});

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A scheduler the test drives by hand. */
function sched() {
  const timers: Array<{ fn: () => void; ms: number; on: boolean }> = [];
  return {
    every: (fn: () => void, ms: number) => { const t = { fn, ms, on: true }; timers.push(t); return () => { t.on = false; }; },
    fire: (pred: (ms: number) => boolean = () => true) => { for (const t of [...timers]) if (t.on && pred(t.ms)) t.fn(); },
    active: () => timers.filter((t) => t.on).map((t) => t.ms),
  };
}
const NO_REFRESH = () => ({ every: sched().every, clock: { nowMs: () => T0 }, refreshMs: 0 });

/** A fake server that holds a state, serves snapshots with live heartbeat times, and delivers real events. */
function fakeServer(initial: ProjectViewSnapshot, hooks: { heartbeatAt(attemptId: string): string | null }) {
  let snapshot = initial;
  let push: ((e: ProjectViewEvent) => void) | null = null;
  let pushErr: ((e: DataSourceError) => void) | null = null;
  let live = 0;
  const errors: DataSourceError[] = [];
  let fetched = 0;
  const subscribes: string[] = [];
  const control: { failures: number; error: unknown } = { failures: 0, error: null };
  const source: EngineeringDataSource = {
    mode: 'mock',
    getSnapshot: async () => {
      fetched += 1;
      if (control.failures > 0) { control.failures -= 1; throw control.error ?? new Error('outage'); }
      const attempts = Object.fromEntries(Object.entries(snapshot.attempts).map(([id, a]) => [id, a.outcome === 'running' && a.endedAt === null ? { ...a, lastHeartbeatAt: hooks.heartbeatAt(id) } : a]));
      return { ...snapshot, attempts };
    },
    subscribe: (_p, after, onEvent, onError) => { subscribes.push(after); live += 1; push = onEvent; pushErr = onError; let off = false; return () => { if (off) return; off = true; live -= 1; if (push === onEvent) push = null; }; },
    execute: async () => { throw new Error('unused'); }, openTerminal: async () => { throw new Error('unused'); }, disconnect: () => {},
  };
  return { source, errors, subscribes, control, streamError: (e: DataSourceError) => pushErr?.(e), liveSubscriptions: () => live, setSnapshot: (s: ProjectViewSnapshot) => { snapshot = s; }, emit: (e: ProjectViewEvent) => push?.(e), fetched: () => fetched };
}

describe('session', () => {
  it('sequence gap triggers resync: the session refetches the snapshot and resubscribes after its cursor', async () => {
    const s0 = base();
    const later = run(s0, [['task.ready', 2], STARTED]);
    const f = fakeServer(s0.snapshot, { heartbeatAt: () => null });
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, NO_REFRESH());
    await settle();
    const ready = nx(s0, 'task.ready', 2);
    f.setSnapshot(later.snapshot);
    f.emit({ ...ready, sequence: 3 }); // cursor 0, sequence 3: gap
    await settle();
    expect(session.resyncCount()).toBe(1);
    expect(f.subscribes).toEqual(['0', later.snapshot.meta.cursor]);
    expect(session.state()!.snapshot.meta.cursor).toBe(later.snapshot.meta.cursor);
    session.stop();
  });

  it('redelivery of an event already folded into the snapshot does not refetch', async () => {
    const s0 = base();
    const later = run(s0, [['task.ready', 2], STARTED]);
    const f = fakeServer(later.snapshot, { heartbeatAt: () => null });
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, NO_REFRESH());
    await settle();
    const fetchedBefore = f.fetched();
    f.emit({ ...nx(s0, 'task.ready', 2), sequence: 1, eventId: 'evt_old' });
    f.emit({ ...nx(s0, 'task.ready', 2), sequence: 2, eventId: 'evt_old2' });
    await settle();
    expect(f.fetched()).toBe(fetchedBefore);
    expect(session.resyncCount()).toBe(0);
    // Still live: the next sequence applies.
    f.emit(nx(later, 'task.blocked', 9, { payload: { reason: 'x' } }));
    expect(session.state()!.snapshot.meta.cursor).toBe(String(Number(later.snapshot.meta.cursor) + 1));
    session.stop();
  });

  it('rejects a snapshot older than the projection and stays live', async () => {
    const s0 = base();
    const later = run(s0, [['task.ready', 2], STARTED]);
    const f = fakeServer(later.snapshot, { heartbeatAt: () => null });
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, NO_REFRESH());
    await settle();
    f.setSnapshot(s0.snapshot); // the server hands back an older view
    f.emit({ ...nx(later, 'task.ready', 3), sequence: Number(later.snapshot.meta.cursor) + 5 }); // gap forces a refetch
    await settle();
    expect(f.errors.map((e) => e.code)).toContain('snapshot_rejected');
    expect(session.state()!.snapshot.meta.cursor).toBe(later.snapshot.meta.cursor); // not moved backwards
    f.emit(nx(later, 'task.blocked', 9, { payload: { reason: 'x' } }));
    expect(session.state()!.snapshot.meta.cursor).toBe(String(Number(later.snapshot.meta.cursor) + 1));
    session.stop();
  });

  it('a source that keeps producing gaps is reported unavailable instead of looping', async () => {
    const s0 = base();
    const f = fakeServer(s0.snapshot, { heartbeatAt: () => null });
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, NO_REFRESH());
    for (let i = 0; i < 10; i += 1) {
      await settle();
      f.emit({ ...nx(s0, 'task.ready', 1), sequence: 50 + i, eventId: `g${i}` });
    }
    await settle();
    expect(f.errors.at(-1)).toMatchObject({ code: 'stream_dead' });
    expect(f.fetched()).toBeLessThan(10);
    session.stop();
  });

  it('liveness: with only real event types, a healthy attempt stays healthy across refreshes and a dead one goes stale', async () => {
    // Two running attempts, delivered by real events only (no heartbeat events exist). The server's snapshots carry the heartbeat times.
    let s = base(['t1', 't2']);
    s = run(s, [
      ['task.ready', 1], ['attempt.started', 2, { attemptId: 'alive', payload: { fence: 1, runnerId: 'runner_alive', location: 'local' } }],
      ['task.ready', 1, { taskId: 't2' }], ['attempt.started', 2, { taskId: 't2', attemptId: 'dead', payload: { fence: 1, runnerId: 'runner_dead', location: 'cloud' } }],
    ]);
    let nowSec = 2;
    const f = fakeServer(s.snapshot, { heartbeatAt: (id) => (id === 'alive' ? at(Math.floor(nowSec / 10) * 10) : at(2)) });
    let tickFn: (() => void) | null = null;
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { refreshMs: 10_000, clock: { nowMs: () => T0 + nowSec * 1000 }, every: (fn) => { tickFn = fn; return () => {}; } });
    await settle();
    const cursor = session.state()!.snapshot.meta.cursor;
    const health = (id: string) => effectiveWorkerHealth(session.state()!.snapshot.workers[id]!, T0 + nowSec * 1000, session.livenessAsOfMs()).health;
    for (nowSec = 12; nowSec <= 120; nowSec += 10) {
      tickFn!();
      await settle();
      expect(health('runner_alive'), `alive at ${nowSec}s`).toBe('healthy');
      if (nowSec - 2 >= 60) expect(health('runner_dead'), `dead at ${nowSec}s`).toBe('disconnected');
      else if (nowSec - 2 >= 30) expect(health('runner_dead'), `dead at ${nowSec}s`).toBe('suspected_stall');
      else expect(health('runner_dead'), `dead at ${nowSec}s`).toBe('healthy');
    }
    // Event-derived state and the cursor never moved because of a refresh.
    const st = session.state()!.snapshot;
    expect(st.meta.cursor).toBe(cursor);
    expect(st.tasks['t1']!.status).toBe('running');
    expect(st.tasks['t2']!.status).toBe('running');
    expect(f.errors).toEqual([]);
    session.stop();
  });

  it('mergeLiveness changes heartbeats only', () => {
    const s = running();
    const fresh: ProjectViewSnapshot = { ...s.snapshot, meta: { ...s.snapshot.meta, cursor: '99' }, attempts: { a1: { ...s.snapshot.attempts['a1']!, lastHeartbeatAt: at(50) } }, tasks: {} };
    const merged = mergeLiveness(s, fresh);
    expect(merged.snapshot.meta.cursor).toBe(s.snapshot.meta.cursor);
    expect(merged.snapshot.tasks).toBe(s.snapshot.tasks);
    expect(merged.snapshot.workers['runner_a']!.lastHeartbeatAt).toBe(at(50));
    expect(mergeLiveness(merged, { ...fresh, attempts: { a1: { ...fresh.attempts['a1']!, lastHeartbeatAt: at(10) } } })).toBe(merged); // older never wins
  });
});

describe('session survival', () => {
  const at0 = (cursor: number): ProjectViewSnapshot => ({ ...base().snapshot, meta: { ...base().snapshot.meta, cursor: String(cursor) } });
  const gap = (cursor: number): ProjectViewEvent => ({ ...nx(base(), 'task.ready', 1), sequence: cursor + 2, eventId: `gap_${cursor}` });

  it('many spaced resyncs, each moving the cursor forward, stay live', async () => {
    const f = fakeServer(at0(0), { heartbeatAt: () => null });
    const timers = sched();
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { every: timers.every, clock: { nowMs: () => T0 }, refreshMs: 0 });
    await settle();
    for (let cursor = 0; cursor < 30; cursor += 3) {
      f.setSnapshot(at0(cursor + 2)); // the snapshot is at the gap event's sequence: progress
      f.emit(gap(cursor));
      await settle();
      f.setSnapshot(at0(cursor + 3));
    }
    expect(session.resyncCount()).toBe(10);
    expect(session.status()).toBe('live');
    expect(f.errors.filter((e) => e.code === 'stream_dead')).toEqual([]);
    session.stop();
  });

  it('one failed snapshot during a resync is retried with backoff and the stream resumes from the new cursor', async () => {
    const f = fakeServer(at0(0), { heartbeatAt: () => null });
    const timers = sched();
    const statuses: string[] = [];
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e), onStatus: (s) => statuses.push(s) }, { every: timers.every, clock: { nowMs: () => T0 }, refreshMs: 0, retryBaseMs: 1000 });
    await settle();
    f.control.failures = 1;
    f.emit(gap(0));
    await settle();
    expect(session.status()).toBe('reconnecting');
    expect(timers.active()).toEqual([1000]);
    f.setSnapshot(at0(7));
    timers.fire((ms) => ms === 1000);
    await settle();
    expect(session.status()).toBe('live');
    expect(session.state()!.snapshot.meta.cursor).toBe('7');
    expect(f.subscribes.at(-1)).toBe('7');
    expect(statuses).toEqual(['reconnecting', 'live']);
    expect(timers.active()).toEqual([]); // the retry timer is gone
    session.stop();
  });

  it('backoff doubles up to a 30 s cap and then keeps retrying with no limit; a later success recovers', async () => {
    const f = fakeServer(at0(0), { heartbeatAt: () => null });
    const timers = sched();
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { every: timers.every, clock: { nowMs: () => T0 }, refreshMs: 0, retryBaseMs: 1000 });
    await settle();
    f.control.failures = 100;
    f.emit(gap(0));
    const delays: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      await settle();
      delays.push(...timers.active());
      timers.fire();
    }
    await settle();
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000, 30000]);
    expect(session.status()).toBe('reconnecting');
    expect(f.errors.some((e) => e.code === 'stream_dead')).toBe(false);
    f.control.failures = 0;
    f.setSnapshot(at0(9));
    timers.fire();
    await settle();
    expect(session.status()).toBe('live');
    expect(f.subscribes.at(-1)).toBe('9');
    session.stop();
  });

  it('a retryable stream error recovers through a snapshot with exactly one subscription, from the right cursor', async () => {
    const f = fakeServer(at0(4), { heartbeatAt: () => null });
    const timers = sched();
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { every: timers.every, clock: { nowMs: () => T0 }, refreshMs: 0 });
    await settle();
    f.setSnapshot(at0(6));
    f.streamError({ code: 'unavailable', message: 'stream dropped', retryable: true });
    expect(session.status()).toBe('reconnecting');
    expect(f.liveSubscriptions()).toBe(0);
    timers.fire();
    await settle();
    expect(session.status()).toBe('live');
    expect(f.liveSubscriptions()).toBe(1);
    expect(f.subscribes).toEqual(['4', '6']);
    session.stop();
  });

  it('invalid_cursor (the server said cursor_ahead) resynchronises from a snapshot at once', async () => {
    const f = fakeServer(at0(50), { heartbeatAt: () => null });
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, NO_REFRESH());
    await settle();
    f.setSnapshot(at0(8)); // the server was reset: its head is behind our cursor
    f.streamError({ code: 'invalid_cursor', message: 'cursor_ahead', retryable: false });
    await settle();
    expect(f.fetched()).toBe(2);
    expect(f.liveSubscriptions()).toBe(1);
    expect(f.errors.map((e) => e.code)).toContain('invalid_cursor');
    session.stop();
  });

  it('a terminal stream error (unauthorized) kills the session', async () => {
    const f = fakeServer(at0(1), { heartbeatAt: () => null });
    const timers = sched();
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { every: timers.every, clock: { nowMs: () => T0 }, refreshMs: 10_000 });
    await settle();
    f.streamError({ code: 'unauthorized', message: 'token rejected', retryable: false });
    expect(session.status()).toBe('dead');
    expect(f.errors.map((e) => e.code)).toEqual(['unauthorized', 'stream_dead']);
    expect(f.liveSubscriptions()).toBe(0);
    expect(timers.active()).toEqual([]);
    session.stop();
  });

  it('a source that calls back before subscribe returns cannot leak a subscription', async () => {
    const s0 = at0(0);
    let live = 0;
    let calls = 0;
    const source: EngineeringDataSource = {
      mode: 'mock',
      getSnapshot: async () => ({ ...s0, meta: { ...s0.meta, cursor: String(calls * 10) } }),
      subscribe: (_p, _after, onEvent) => {
        calls += 1;
        live += 1;
        if (calls === 1) onEvent({ ...nx(base(), 'task.ready', 1), sequence: 7, eventId: 'sync_gap' }); // synchronous, during subscribe: a gap
        let off = false;
        return () => { if (!off) { off = true; live -= 1; } };
      },
      execute: async () => { throw new Error('unused'); }, openTerminal: async () => { throw new Error('unused'); }, disconnect: () => {},
    };
    const session = startProjection(source, 'p1', { onState: () => {}, onError: () => {} }, NO_REFRESH());
    await settle();
    await settle();
    expect(live).toBe(1);
    session.stop();
    expect(live).toBe(0);
  });

  it('a snapshot stuck behind the event still terminates at the bound', async () => {
    const f = fakeServer(at0(5), { heartbeatAt: () => null });
    const timers = sched();
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { every: timers.every, clock: { nowMs: () => T0 }, refreshMs: 0 });
    await settle();
    for (let i = 0; i < 12 && session.status() !== 'dead'; i += 1) {
      f.emit(gap(5)); // the server never gets past 5
      await settle();
    }
    expect(session.status()).toBe('dead');
    expect(f.errors.at(-1)).toMatchObject({ code: 'stream_dead' });
    expect(f.fetched()).toBeLessThan(10);
    session.stop();
  });

  it('after death, refresh no longer changes heartbeats; before the first refresh and during an outage workers read unknown, not disconnected', async () => {
    let s = base(['t1']);
    s = run(s, [['task.ready', 1], ['attempt.started', 2, { attemptId: 'a1', payload: { fence: 1, runnerId: 'runner_a', location: 'local' } }]]);
    let beat = at(2);
    const f = fakeServer(s.snapshot, { heartbeatAt: () => beat });
    const timers = sched();
    let nowSec = 2;
    const clock = { nowMs: () => T0 + nowSec * 1000 };
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { every: timers.every, clock, refreshMs: 10_000 });
    await settle();
    const w = () => session.state()!.snapshot.workers['runner_a']!;
    expect(effectiveWorkerHealth(w(), clock.nowMs(), session.livenessAsOfMs()).health).toBe('healthy');

    // An outage: refreshes fail. 70 s later the heartbeat is old only because we could not look.
    f.control.failures = 100;
    nowSec = 72;
    await session.refresh();
    expect(f.errors.at(-1)).toMatchObject({ code: 'refresh_failed' });
    expect(effectiveWorkerHealth(w(), clock.nowMs(), session.livenessAsOfMs())).toMatchObject({ health: 'unknown' });
    expect(effectiveWorkerHealth(w(), clock.nowMs(), clock.nowMs()).health).toBe('disconnected'); // the naive reading the outage would have produced

    // The stream dies; refresh stops mutating anything.
    f.control.failures = 0;
    for (let i = 0; i < 8 && session.status() !== 'dead'; i += 1) { f.emit(gap(Number(session.state()!.snapshot.meta.cursor))); await settle(); }
    expect(session.status()).toBe('dead');
    const frozen = session.state();
    beat = at(51);
    nowSec = 60;
    await session.refresh();
    expect(session.state()).toBe(frozen);
    expect(w().lastHeartbeatAt).toBe(at(2));
    session.stop();
  });

  it('rejects an older snapshot with its own error code', async () => {
    const f = fakeServer(at0(9), { heartbeatAt: () => null });
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, NO_REFRESH());
    await settle();
    f.setSnapshot(at0(3));
    f.emit(gap(9));
    await settle();
    expect(f.errors.map((e) => e.code)).toContain('snapshot_rejected');
    expect(session.status()).toBe('live');
    session.stop();
  });
});

describe('first plan and terminal tasks', () => {
  it('the first plan.accepted that lists unknown tasks needs a snapshot, so the board is not empty until the first task event', () => {
    const empty = projectionFromSnapshot({ ...emptySnapshot({ projectId: 'p1', observedAt: at(0), provenance: 'simulated' }) });
    const r = applyEvent(empty, nx(empty, 'plan.accepted', 1, { taskId: 'r1', payload: { planRevision: 1, taskIds: ['t1', 't2'] } }));
    expect(r).toMatchObject({ outcome: 'resync', reason: 'unknown_task' });
    // With nothing listed there is nothing to wait for.
    expect(applyEvent(empty, nx(empty, 'plan.accepted', 1, { taskId: 'r1', payload: { planRevision: 1 } })).outcome).toBe('applied');
  });

  it('approval.granted on a cancelled task resolves the approval and frees the worker; the task stays cancelled', () => {
    let s = running();
    s = run(s, [
      ['approval.requested', 10, { attemptId: 'a1', payload: { fence: 1, approvalId: 'ap1', reason: 'x' } }],
      ['task.cancelled', 11, { actor: HUMAN, payload: { operationId: 'op' } }],
    ]);
    expect(s.snapshot.tasks['t1']!.status).toBe('cancelled');
    expect(s.snapshot.approvals['ap1']!.state).toBe('pending');
    s = run(s, [['approval.granted', 12, { actor: HUMAN, payload: { approvalId: 'ap1' } }]]);
    expect(s.snapshot.approvals['ap1']).toMatchObject({ state: 'granted', resolvedAt: at(12) });
    expect(s.snapshot.tasks['t1']!.status).toBe('cancelled');
    expect(s.snapshot.workers['runner_a']).toMatchObject({ blockedByApprovalId: null, availability: 'idle' });
  });

  it('a later attempt does not inherit an earlier attempt\'s model route', () => {
    let s = running();
    expect(s.snapshot.workers['runner_a']!.modelRoute).toBe('cloud');
    s = run(s, [
      ['attempt.failed', 20, { attemptId: 'a1', payload: { fence: 1, reason: 'attempt_timeout', outcome: 'failed' } }],
      ['task.ready', 21, {}],
      ['attempt.started', 22, { attemptId: 'a2', payload: { fence: 2, attemptNumber: 2, runnerId: 'runner_a', location: 'local' } }],
    ]);
    expect(s.snapshot.workers['runner_a']!.modelRoute).toBe('unknown');
  });
});

describe('run lifecycle comes from the refresh, not from events', () => {
  it('merges lifecycle from a snapshot at or past the cursor only, and touches nothing else', () => {
    const s = base();
    const fresh = (cursor: number, lifecycle: 'ready_for_review' | 'merged'): ProjectViewSnapshot => ({
      ...s.snapshot, meta: { ...s.snapshot.meta, cursor: String(cursor) }, runs: { r1: { ...s.snapshot.runs['r1']!, lifecycle } }, tasks: {},
    });
    const up = mergeRunLifecycle(s, fresh(0, 'ready_for_review'));
    expect(up.snapshot.runs['r1']!.lifecycle).toBe('ready_for_review');
    expect(up.snapshot.tasks).toBe(s.snapshot.tasks);
    expect(up.snapshot.meta.cursor).toBe('0');
    const ahead = run(s, [['task.ready', 1]]); // our cursor is 1
    expect(mergeRunLifecycle(ahead, fresh(0, 'merged'))).toBe(ahead); // an older snapshot cannot move it
  });
});

describe('run criteria schema', () => {
  const run = (criteria: unknown) => RunViewSchema.safeParse({ runId: 'r', lifecycle: 'running', planRevision: 1, latestEvidence: null, criteria });
  it('accepts null, equal and partial counts', () => {
    expect(run(null).success).toBe(true);
    expect(run({ verified: 3, total: 3 }).success).toBe(true);
    expect(run({ verified: 1, total: 3 }).success).toBe(true);
  });
  it('rejects more verified than exist', () => {
    expect(run({ verified: 4, total: 3 }).success).toBe(false);
  });
});

describe('verifiedCounts', () => {
  const snap = (statuses: { status: 'verified' | 'cancelled' | 'superseded'; cancelReason?: 'budget_exhausted' | 'cancel_requested' }[]) => {
    const tasks = Object.fromEntries(statuses.map((t, i) => [`t${i}`, { ...task(`t${i}`), status: t.status, cancelReason: t.cancelReason ?? null }]));
    return { ...base([]).snapshot, tasks };
  };
  it('keeps budget-cancelled work in the denominator, and drops other cancels and superseded work', () => {
    expect(verifiedCounts(snap([{ status: 'verified' }, { status: 'cancelled', cancelReason: 'budget_exhausted' }, { status: 'cancelled', cancelReason: 'cancel_requested' }, { status: 'superseded' }]))).toEqual({ verified: 1, total: 2 });
  });
});


describe('decision facts', () => {
  const nd = { tasks: [{ taskId: 't1', revision: 1, status: 'cancelled', budgetStopped: true }], requirementIds: ['FB-02'], acceptanceCheckIds: ['chk-2'] };
  const change = { runId: 'r1', prNumber: 7, url: 'https://github.com/a/b/pull/7', status: 'merged_sha_mismatch', candidateSha: 'c'.repeat(40), baseRef: 'main', observedHeadSha: 'e'.repeat(40), mergeCommitSha: 'd'.repeat(40), observedAt: at(50) };
  const withFacts = (cursor: string, over: Partial<ProjectViewSnapshot> = {}): ProjectViewSnapshot => ({ ...base().snapshot, meta: { ...base().snapshot.meta, cursor }, ...over });

  it('approval.requested carries the operation and the structured destination', () => {
    const s = run(base(), [['approval.requested', 5, { payload: { approvalId: 'apr1', scopeHash: 'h', reason: 'needed for docs', operation: 'new_domain', destination: 'docs.example.com', destinationKind: 'network_host' } }]]);
    expect(s.snapshot.approvals['apr1']).toMatchObject({ operation: 'new_domain', destination: 'docs.example.com', requester: null });
    expect(ProjectViewSnapshotSchema.safeParse(s.snapshot).success).toBe(true);
  });

  it('task.blocked with approval_expired stores the approval as expired, never granted', () => {
    const s = run(base(), [['approval.requested', 5, { payload: { approvalId: 'apr1', scopeHash: 'h', reason: 'r', operation: 'breaking_api_change' } }], ['task.blocked', 9, { payload: { reason: 'approval_expired', approvalId: 'apr1' } }]]);
    expect(s.snapshot.approvals['apr1']!.state).toBe('expired');
    expect(approvalStateAt(s.snapshot.approvals['apr1']!, T0 + 9_000)).toBe('expired');
    expect(s.snapshot.tasks['t1']!.status).toBe('blocked');
  });

  it('run.reduced_scope_accepted sets reducedScope from the event', () => {
    const s = run(base(), [['run.reduced_scope_accepted', 5, { taskId: 'r1', actor: HUMAN, payload: { decisionId: 'dec1', notDelivered: nd, deliveredRequirementIds: ['FB-01'] } }]]);
    expect(s.snapshot.runs['r1']!.reducedScope).toMatchObject({ decisionId: 'dec1', notDelivered: nd, deliveredRequirementIds: ['FB-01'], acceptedAt: at(5), acceptedBy: 'u' });
  });

  it('a reduced-scope event the view cannot read asks for a snapshot instead of guessing', () => {
    const start = base();
    const r = applyEvent(start, nx(start, 'run.reduced_scope_accepted', 5, { taskId: 'r1', actor: HUMAN, payload: { decisionId: 'dec1' } }));
    expect(r.outcome).toBe('resync');
  });

  it('the refresh merges changeRequests, reducedScope and the scope assessment only from a snapshot at or past the cursor', () => {
    const s = base();
    const assessment = { notDelivered: nd, notDeliveredHash: 'h', deliveredRequirementIds: [], stopped: [{ taskId: 't1', revision: 1 }], stoppingTaskIds: [] };
    const fresh = withFacts('0', { changeRequests: [change], runs: { r1: { ...s.snapshot.runs['r1']!, scopeAssessment: assessment } } });
    const merged = mergeDecisionFacts(s, fresh);
    expect(merged.snapshot.changeRequests).toEqual([change]);
    expect(merged.snapshot.runs['r1']!.scopeAssessment).toEqual(assessment);
    expect(mergeDecisionFacts(merged, fresh)).toBe(merged);
    const ahead = { ...s, snapshot: { ...s.snapshot, meta: { ...s.snapshot.meta, cursor: '4' } } };
    expect(mergeDecisionFacts(ahead, fresh)).toBe(ahead);
  });

  it('merged_sha_mismatch reaches a live session through its refresh', async () => {
    const snaps: ProjectViewSnapshot[] = [withFacts('0'), withFacts('0', { changeRequests: [change] })];
    const source = { mode: 'mock', getSnapshot: async () => snaps.shift() ?? withFacts('0', { changeRequests: [change] }), subscribe: () => () => {}, execute: async () => { throw new Error('x'); }, openTerminal: async () => { throw new Error('x'); }, disconnect: () => {} } as unknown as EngineeringDataSource;
    const states: ProjectionState[] = [];
    const session = startProjection(source, 'p1', { onState: (s) => states.push(s), onError: () => {} }, { every: () => () => {}, clock: { nowMs: () => T0 }, refreshMs: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(session.state()!.snapshot.changeRequests).toEqual([]);
    await session.refresh();
    expect(session.state()!.snapshot.changeRequests).toEqual([change]);
    await session.resync();
    expect(session.state()!.snapshot.changeRequests).toEqual([change]);
    session.stop();
  });
});

describe('history and real-shape snapshots', () => {
  const entry = { approvalId: 'a1', runId: 'r1', taskId: 't1', revision: 1, outcome: 'denied' as const, approver: 'u', scopeHash: 's', operation: 'breaking_api_change', destination: null, requestedAt: at(1), resolvedAt: at(2), consumedAt: null, consumedBy: null };

  it('recognises a budget stop from the assessment when the task carries no cancel reason, and not a plain cancel', () => {
    const t = task('t1', { status: 'cancelled', cancelReason: null });
    const run = { scopeAssessment: { notDelivered: { tasks: [], requirementIds: [], acceptanceCheckIds: [] }, notDeliveredHash: 'h', deliveredRequirementIds: [], stopped: [{ taskId: 't1', revision: 1 }], stoppingTaskIds: [] }, reducedScope: null };
    expect(isBudgetStopped(t, run)).toBe(true);
    expect(isBudgetStopped(t, { scopeAssessment: null, reducedScope: null })).toBe(false);
    expect(isBudgetStopped(task('t1', { status: 'running' }), run)).toBe(false);
  });

  it('a resolved approval survives a snapshot replacement, and an open one comes only from the snapshot', () => {
    const a = (id: string, state: 'denied' | 'pending') => ({ approvalId: id, taskId: 't1', taskRevision: 1, runId: 'r1', scopeHash: 's', reason: null, operation: null, destination: null, requester: null, state, requestedAt: at(1), expiresAt: null, resolvedAt: state === 'denied' ? at(2) : null });
    const before = { ...base().snapshot, approvals: { done: a('done', 'denied'), open: a('open', 'pending') } };
    const fresh = base().snapshot;
    const kept = carryResolvedApprovals(before, fresh);
    expect(Object.keys(kept.approvals)).toEqual(['done']);
    expect(carryResolvedApprovals(null, fresh)).toBe(fresh);
  });

  it('an expired request carries as history only, so it can never build a card after a replan', () => {
    const lapsed = { approvalId: 'old', taskId: 't1', taskRevision: 1, runId: 'r1', scopeHash: 's', reason: null, operation: 'start_cloud_worker', destination: null, requester: null, state: 'expired' as const, requestedAt: at(1), expiresAt: at(2), resolvedAt: at(3) };
    const before = { ...base().snapshot, approvals: { old: lapsed } };
    const kept = carryResolvedApprovals(before, base().snapshot);
    expect(kept.approvals).toEqual({});
    expect(kept.approvalHistory).toEqual([expect.objectContaining({ approvalId: 'old', outcome: 'expired', approver: null, resolvedAt: at(3), operation: 'start_cloud_worker' })]);
    // Still listed by the server: the snapshot's row wins, and it is not recorded twice.
    const listed = { ...base().snapshot, approvals: { old: lapsed } };
    expect(carryResolvedApprovals(before, listed)).toBe(listed);
    const reported = { ...base().snapshot, approvalHistory: [{ ...entry, approvalId: 'old' }] };
    expect(carryResolvedApprovals(before, reported).approvalHistory).toHaveLength(1);
  });

  it('the refresh brings in new approval history', () => {
    const s = base();
    const fresh = { ...s.snapshot, approvalHistory: [entry] };
    const merged = mergeDecisionFacts(s, fresh);
    expect(merged.snapshot.approvalHistory).toEqual([entry]);
    expect(mergeDecisionFacts(merged, fresh)).toBe(merged);
  });
});

describe('model assignments on the projection', () => {
  const STARTED_WITH: [EventType, number, Partial<ProjectViewEvent>] = ['attempt.started', 3, { attemptId: 'a1', payload: { fence: 1, attemptNumber: 1, runnerId: 'runner_a', location: 'local', modelRoute: 'cloud', assignment: { provider: 'anthropic', model: 'claude-opus-5-5', source: 'role' } } }];

  it('assignment is recorded on the attempt and shown on the inference badge', () => {
    const state = run(base(), [STARTED_WITH]);
    const worker = state.snapshot.workers['runner_a']!;
    expect(worker).toMatchObject({ execution: 'local', modelRoute: 'cloud', assignment: { provider: 'anthropic', model: 'claude-opus-5-5', source: 'role' } });
    expect(state.snapshot.attempts['a1']!.assignment).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', source: 'role' });
  });

  it('an unreadable assignment leaves the provider unknown, and the route stays unknown', () => {
    const state = run(base(), [['attempt.started', 3, { attemptId: 'a1', payload: { fence: 1, attemptNumber: 1, runnerId: 'runner_a', location: 'local', assignment: { provider: 'anthropic' } } }]]);
    expect(state.snapshot.workers['runner_a']).toMatchObject({ assignment: null, modelRoute: 'unknown' });
  });

  it('a run created as a trial carries its pin', () => {
    const state = run(projectionFromSnapshot(emptySnapshot({ projectId: 'p1', observedAt: at(0), provenance: 'simulated' })), [['run.created', 1, { taskId: 'r1', payload: { pinnedModel: { provider: 'anthropic', model: 'claude-sonnet-5-5' } } }]]);
    expect(state.snapshot.runs['r1']!.pinnedModel).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('the refresh brings in a changed catalog and assignments', () => {
    const s = base();
    const a = { scope: 'role' as const, key: 'backend', provider: 'anthropic', model: 'claude-sonnet-5-5', revision: 1, updatedBy: 'owner', updatedAt: at(4) };
    const fresh = { ...s.snapshot, modelAssignments: [a], modelCatalog: { status: 'detected' as const, detail: null, projectDefault: null, providers: [] } };
    const merged = mergeDecisionFacts(s, fresh);
    expect(merged.snapshot.modelAssignments).toEqual([a]);
    expect(merged.snapshot.modelCatalog.status).toBe('detected');
    expect(mergeDecisionFacts(merged, fresh)).toBe(merged);
  });
});

describe('session: drops recover, permanent errors do not', () => {
  const at0 = (cursor: number): ProjectViewSnapshot => ({ ...base().snapshot, meta: { ...base().snapshot.meta, cursor: String(cursor) } });
  const start = (f: ReturnType<typeof fakeServer>, timers = sched(), refreshMs = 0) => startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { every: timers.every, clock: { nowMs: () => T0 }, refreshMs });

  it('a retryable disconnected is a drop, not a death: it reconnects and goes live', async () => {
    const f = fakeServer(at0(4), { heartbeatAt: () => null });
    const timers = sched();
    const session = start(f, timers);
    await settle();
    f.setSnapshot(at0(6));
    f.streamError({ code: 'disconnected', message: 'the connection dropped', retryable: true });
    expect(session.status()).toBe('reconnecting');
    expect(f.errors.some((e) => e.code === 'stream_dead')).toBe(false);
    timers.fire();
    await settle();
    expect(session.status()).toBe('live');
    expect(f.subscribes).toEqual(['4', '6']);
    session.stop();
  });

  it('a non-retryable disconnected, a closed source, ends the stream visibly', async () => {
    const f = fakeServer(at0(4), { heartbeatAt: () => null });
    const session = start(f);
    await settle();
    f.streamError({ code: 'disconnected', message: 'closed', retryable: false });
    expect(session.status()).toBe('dead');
    expect(f.errors.at(-1)!.code).toBe('stream_dead');
    session.stop();
  });

  it.each(['unauthorized', 'unknown_project', 'disconnected'] as const)('a %s from the first snapshot load ends the session instead of retrying forever', async (code) => {
    const f = fakeServer(at0(4), { heartbeatAt: () => null });
    f.control.failures = 9;
    f.control.error = new DataSourceException({ code, message: code, retryable: false });
    const timers = sched();
    const session = start(f, timers);
    await settle();
    expect(session.status()).toBe('dead');
    expect(f.errors.map((e) => e.code)).toEqual([code, 'stream_dead']);
    timers.fire();
    await settle();
    expect(f.control.failures).toBe(8); // no further attempt
    session.stop();
  });

  it('a retryable snapshot failure keeps its typed error and retries', async () => {
    const f = fakeServer(at0(4), { heartbeatAt: () => null });
    f.control.failures = 1;
    f.control.error = new DataSourceException({ code: 'disconnected', message: 'server restarting', retryable: true });
    const timers = sched();
    const session = start(f, timers);
    await settle();
    expect(session.status()).toBe('reconnecting');
    expect(f.errors.map((e) => e.code)).toEqual(['disconnected']);
    timers.fire();
    await settle();
    expect(session.status()).toBe('live');
    session.stop();
  });

  it('a successful refresh resets the backoff, so the next outage retries from the base', async () => {
    const delays: number[] = [];
    const cancelled = { current: [] as (() => void)[] };
    const f = fakeServer(at0(4), { heartbeatAt: () => null });
    const every = (fn: () => void, ms: number) => { delays.push(ms); cancelled.current.push(fn); return () => {}; };
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { every, clock: { nowMs: () => T0 }, refreshMs: 0, retryBaseMs: 1000 });
    await settle();
    f.streamError({ code: 'disconnected', message: 'drop', retryable: true });
    expect(delays.at(-1)).toBe(1000);
    cancelled.current.at(-1)!();
    await settle();
    f.streamError({ code: 'disconnected', message: 'drop', retryable: true });
    expect(delays.at(-1)).toBe(2000);
    cancelled.current.at(-1)!();
    await settle();
    await session.refresh();
    f.streamError({ code: 'disconnected', message: 'drop', retryable: true });
    expect(delays.at(-1)).toBe(1000);
    session.stop();
  });

  it('criteria follow a verdict at once rather than on the next 10 s refresh', async () => {
    const started = run(base(), [['task.ready', 2], STARTED]);
    const f = fakeServer(started.snapshot, { heartbeatAt: () => null });
    const session = start(f, sched(), 10_000);
    await settle();
    const verdict = nx(started, 'attempt.completed', 4);
    const passed = run(started, [['attempt.completed', 4]]);
    const event = nx(passed, 'verification.passed', 5);
    const counted = run(passed, [['verification.passed', 5]]);
    f.setSnapshot({ ...counted.snapshot, runs: Object.fromEntries(Object.entries(counted.snapshot.runs).map(([k, v]) => [k, { ...v, criteria: { verified: 1, total: 2 } }])) });
    f.emit(verdict);
    f.emit(event);
    await settle();
    await settle();
    expect(Object.values(session.state()!.snapshot.runs)[0]!.criteria).toEqual({ verified: 1, total: 2 });
    session.stop();
  });
});

describe('liveness carries runner activity and freshness', () => {
  const started = (): ProjectionState => run(base(), [['task.ready', 2], STARTED]);
  const withAction = (s: ProjectionState, tool: string, at: string): ProjectViewSnapshot => ({ ...s.snapshot, workers: Object.fromEntries(Object.entries(s.snapshot.workers).map(([k, w]) => [k, { ...w, latestAction: { tool, summary: null, longRunning: false, at } }])) });
  const worker = (s: ProjectionState) => Object.values(s.snapshot.workers)[0]!;

  it('a newer tool reaches the worker; an older one does not', () => {
    const s = started();
    const newer = mergeLiveness(s, withAction(s, 'Edit', '2099-01-01T00:00:10.000Z'));
    expect(worker(newer).latestAction?.tool).toBe('Edit');
    const older = mergeLiveness(newer, withAction(s, 'Read', '2099-01-01T00:00:05.000Z'));
    expect(worker(older).latestAction?.tool).toBe('Edit');
  });

  it('activity for another attempt stays with that attempt', () => {
    const s = started();
    const fresh = withAction(s, 'Edit', '2099-01-01T00:00:10.000Z');
    const other = { ...fresh, workers: Object.fromEntries(Object.entries(fresh.workers).map(([k, w]) => [k, { ...w, attemptId: 'someone-else' }])) };
    expect(worker(mergeLiveness(s, other)).latestAction).toBeNull();
  });

  it('runner freshness merges, and is the identity when unchanged', () => {
    const s = started();
    const runners = [{ runnerId: 'r', location: 'local' as const, label: null, lastSeenAt: '2099-01-01T00:00:00.000Z' }];
    const merged = mergeLiveness(s, { ...s.snapshot, runners });
    expect(merged.snapshot.runners).toEqual(runners);
    expect(mergeLiveness(merged, { ...merged.snapshot })).toBe(merged);
  });

  it('a budget stop written with no event still shows as a cancel request after a refresh', () => {
    const s = started();
    const taskId = Object.keys(s.snapshot.tasks)[0]!;
    const fresh = { ...s.snapshot, tasks: { ...s.snapshot.tasks, [taskId]: { ...s.snapshot.tasks[taskId]!, cancelRequested: { at: '2099-01-01T00:00:00.000Z', operationId: 'op' } } } };
    expect(mergeDecisionFacts(s, fresh).snapshot.tasks[taskId]!.cancelRequested).toMatchObject({ operationId: 'op' });
  });
});
