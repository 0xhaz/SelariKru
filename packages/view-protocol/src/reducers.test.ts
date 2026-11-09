import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, checkEventAuthority, type Actor, type EventType } from '@selarikru/domain';
import {
  PROJECTED_EVENT_TYPES, ProjectViewEventSchema, ProjectViewSnapshotSchema, applyEvent, applyEvents, approvalStateAt, effectiveWorkerHealth, emptySnapshot,
  mergeLiveness, projectionFromSnapshot, startProjection, sumUsage, usageFor, verifiedCounts,
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
    runs: { r1: { runId: 'r1', lifecycle: 'running', planRevision: 1, latestEvidence: null } },
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
    const session = startProjection(source, 'p1', { onState: () => {}, onError: () => {} }, { refreshMs: 0 });
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
    expect(effectiveWorkerHealth(w, T0 + 3_600_000).health).toBe('healthy'); // no lease, no heartbeat verdict
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
    const r = applyEvent(empty, nx(empty, 'plan.accepted', 1, { taskId: 'r1', payload: { planRevision: 1, taskIds: ['t1'] } }));
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

/** A fake server that holds a state, serves snapshots with live heartbeat times, and delivers real events. */
function fakeServer(initial: ProjectViewSnapshot, hooks: { heartbeatAt(attemptId: string): string | null }) {
  let snapshot = initial;
  let push: ((e: ProjectViewEvent) => void) | null = null;
  const errors: DataSourceError[] = [];
  let fetched = 0;
  const subscribes: string[] = [];
  const source: EngineeringDataSource = {
    mode: 'mock',
    getSnapshot: async () => {
      fetched += 1;
      const attempts = Object.fromEntries(Object.entries(snapshot.attempts).map(([id, a]) => [id, a.outcome === 'running' && a.endedAt === null ? { ...a, lastHeartbeatAt: hooks.heartbeatAt(id) } : a]));
      return { ...snapshot, attempts };
    },
    subscribe: (_p, after, onEvent) => { subscribes.push(after); push = onEvent; return () => { if (push === onEvent) push = null; }; },
    execute: async () => { throw new Error('unused'); }, openTerminal: async () => { throw new Error('unused'); }, disconnect: () => {},
  };
  return { source, errors, subscribes, setSnapshot: (s: ProjectViewSnapshot) => { snapshot = s; }, emit: (e: ProjectViewEvent) => push?.(e), fetched: () => fetched };
}

describe('session', () => {
  it('sequence gap triggers resync: the session refetches the snapshot and resubscribes after its cursor', async () => {
    const s0 = base();
    const later = run(s0, [['task.ready', 2], STARTED]);
    const f = fakeServer(s0.snapshot, { heartbeatAt: () => null });
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { refreshMs: 0 });
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
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { refreshMs: 0 });
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
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { refreshMs: 0 });
    await settle();
    f.setSnapshot(s0.snapshot); // the server hands back an older view
    f.emit({ ...nx(later, 'task.ready', 3), sequence: Number(later.snapshot.meta.cursor) + 5 }); // gap forces a refetch
    await settle();
    expect(f.errors.at(-1)).toMatchObject({ code: 'unavailable' });
    expect(session.state()!.snapshot.meta.cursor).toBe(later.snapshot.meta.cursor); // not moved backwards
    f.emit(nx(later, 'task.blocked', 9, { payload: { reason: 'x' } }));
    expect(session.state()!.snapshot.meta.cursor).toBe(String(Number(later.snapshot.meta.cursor) + 1));
    session.stop();
  });

  it('a source that keeps producing gaps is reported unavailable instead of looping', async () => {
    const s0 = base();
    const f = fakeServer(s0.snapshot, { heartbeatAt: () => null });
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { refreshMs: 0 });
    for (let i = 0; i < 10; i += 1) {
      await settle();
      f.emit({ ...nx(s0, 'task.ready', 1), sequence: 50 + i, eventId: `g${i}` });
    }
    await settle();
    expect(f.errors.at(-1)).toMatchObject({ code: 'unavailable' });
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
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) }, { refreshMs: 10_000, every: (fn) => { tickFn = fn; return () => {}; } });
    await settle();
    const cursor = session.state()!.snapshot.meta.cursor;
    const health = (id: string) => effectiveWorkerHealth(session.state()!.snapshot.workers[id]!, T0 + nowSec * 1000).health;
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
