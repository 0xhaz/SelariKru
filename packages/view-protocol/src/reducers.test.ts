import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, checkEventAuthority, type Actor, type EventType } from '@selarikru/domain';
import {
  PROJECTED_EVENT_TYPES, ProjectViewEventSchema, ProjectViewSnapshotSchema, applyEvent, applyEvents, approvalStateAt, effectiveWorkerHealth, emptySnapshot,
  projectionFromSnapshot, startProjection, sumUsage, usageFor,
  type DataSourceError, type EngineeringDataSource, type ProjectViewEvent, type ProjectViewSnapshot, type UsageEntry, type UsageFigure,
} from './index.ts';

const T0 = Date.parse('2026-11-16T09:00:00.000Z');
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();
const SCHED: Actor = { kind: 'scheduler', id: 'scheduler' };
const WORKER: Actor = { kind: 'worker', id: 'runner_a' };

let seq = 0;
let rev = 0;
function ev(type: EventType, sec: number, over: Partial<ProjectViewEvent> = {}): ProjectViewEvent {
  seq += 1;
  rev += 1;
  return {
    schemaVersion: 1, eventId: `evt_${seq}`, projectId: 'p1', runId: 'r1', taskId: 't1', attemptId: null, type, sequence: seq, aggregateRevision: rev,
    actor: SCHED, occurredAt: at(sec), receivedAt: at(sec), causationId: null, traceId: 'trace', payload: {}, provenance: 'simulated', ...over,
  };
}
const reset = (): void => {
  seq = 0;
  rev = 0;
};
const fresh = () => {
  return projectionFromSnapshot(emptySnapshot({ projectId: 'p1', observedAt: at(0), provenance: 'simulated' }));
};
function running(): { events: ProjectViewEvent[] } {
  reset();
  return {
    events: [
      ev('run.created', 0, { taskId: 'r1' }),
      ev('plan.accepted', 1, { taskId: 'r1', payload: { planRevision: 1 } }),
      ev('task.ready', 2, { payload: { title: 'Build API' } }),
      ev('attempt.started', 3, { attemptId: 'a1', payload: { fence: 1, attemptNumber: 1, runnerId: 'runner_a', location: 'local' } }),
      ev('placement.decided', 3, { attemptId: 'a1', payload: { target: 'local', reason: 'local_slot_free', modelRoute: 'cloud' } }),
    ],
  };
}

describe('reducers', () => {
  it('reducers are pure and deduplicate by event ID', () => {
    const { events } = running();
    const start = fresh();
    const frozenBefore = JSON.stringify(start);
    const a = applyEvents(start, events);
    const b = applyEvents(start, events);
    expect(JSON.stringify(start)).toBe(frozenBefore); // input untouched
    expect(a.state).toEqual(b.state); // same events, same state
    expect(a.outcome).toBe('applied');

    // Replaying an already-applied event id changes nothing, even though its sequence is now behind the cursor.
    const replay = applyEvent(a.state, events[3]!);
    expect(replay.outcome).toBe('duplicate');
    expect(replay.state).toBe(a.state);

    // Projection results are valid snapshots.
    expect(ProjectViewSnapshotSchema.safeParse(a.state.snapshot).success).toBe(true);
    expect(a.state.snapshot.tasks['t1']).toMatchObject({ status: 'running', title: 'Build API', activeAttemptId: 'a1' });
    // Frozen input: reducers must not mutate it.
    const deep = (o: unknown): void => {
      if (o && typeof o === 'object') {
        Object.freeze(o);
        Object.values(o).forEach(deep);
      }
    };
    deep(a.state);
    expect(() => applyEvent(a.state, ev('attempt.heartbeat', 13, { attemptId: 'a1', payload: { fence: 1 } }))).not.toThrow();
  });

  it('sequence gap triggers resync', () => {
    const { events } = running();
    const s = applyEvents(fresh(), events.slice(0, 2)).state;
    const skipped = applyEvent(s, events[3]!); // sequence 4 after 2
    expect(skipped).toMatchObject({ outcome: 'resync', reason: 'gap' });
    expect(skipped.state).toBe(s); // untouched: never patched across a gap
    const back = applyEvent(s, { ...events[0]!, eventId: 'evt_other' }); // sequence 1 again under another id
    expect(back).toMatchObject({ outcome: 'resync', reason: 'out_of_order' });
  });

  it('a simulated event never merges into observed state', () => {
    const s = projectionFromSnapshot(emptySnapshot({ projectId: 'p1', observedAt: at(0), provenance: 'observed' }));
    seq = 0;
    expect(applyEvent(s, ev('run.created', 0, { taskId: 'r1' }))).toMatchObject({ outcome: 'resync', reason: 'provenance_mismatch' });
  });

  it('handles every real domain event name and the envelope contract accepts the events', () => {
    expect([...PROJECTED_EVENT_TYPES].sort()).toEqual([...EVENT_TYPES].sort());
    reset();
    let state = fresh();
    for (const type of EVENT_TYPES) {
      const e = ev(type, seq, { attemptId: 'a1' });
      expect(ProjectViewEventSchema.safeParse(e).success, type).toBe(true);
      const r = applyEvent(state, e);
      expect(r.outcome === 'applied' || r.outcome === 'ignored', type).toBe(true);
      state = r.state;
    }
    expect(state.snapshot.meta.cursor).toBe(String(EVENT_TYPES.length));
  });

  it('applies attempt events only to the active attempt and current fence', () => {
    const { events } = running();
    const s = applyEvents(fresh(), events).state;
    const stale = applyEvent(s, ev('attempt.heartbeat', 20, { attemptId: 'old', payload: { fence: 1 } }));
    expect(stale.outcome).toBe('ignored');
    expect(stale.state.snapshot.meta.cursor).toBe(String(seq)); // the sequence was still received
    const lowFence = applyEvent(stale.state, ev('attempt.heartbeat', 21, { attemptId: 'a1', payload: { fence: 0 } }));
    expect(lowFence.outcome).toBe('ignored');
    const good = applyEvent(lowFence.state, ev('attempt.heartbeat', 22, { attemptId: 'a1', payload: { fence: 1, activity: 'coding' } }));
    expect(good.state.snapshot.workers['runner_a']).toMatchObject({ activity: 'coding', lastHeartbeatAt: at(22) });
  });

  it('keeps execution and model route on separate axes, and unknown stays unknown', () => {
    const s = applyEvents(fresh(), running().events).state.snapshot;
    expect(s.workers['runner_a']).toMatchObject({ execution: 'local', modelRoute: 'cloud' });
    reset();
    const bare = applyEvents(fresh(), [ev('task.ready', 0), ev('attempt.started', 1, { attemptId: 'a9', actor: WORKER, payload: {} })]).state.snapshot;
    expect(Object.values(bare.workers)[0]).toMatchObject({ execution: 'unknown', modelRoute: 'unknown' });
  });

  it('a heartbeat is not progress; a lost lease keeps the last activity and shows disconnected', () => {
    let s = applyEvents(fresh(), running().events).state;
    s = applyEvent(s, ev('attempt.heartbeat', 13, { attemptId: 'a1', payload: { fence: 1, activity: 'coding' } })).state;
    expect(s.snapshot.workers['runner_a']!.latestEvidence).toBeNull();
    const w = s.snapshot.workers['runner_a']!;
    expect(effectiveWorkerHealth(w, T0 + 20_000).health).toBe('healthy');
    expect(effectiveWorkerHealth(w, T0 + 13_000 + 30_000).health).toBe('suspected_stall');
    expect(effectiveWorkerHealth(w, T0 + 13_000 + 60_000).health).toBe('disconnected');
    s = applyEvent(s, ev('attempt.failed', 80, { attemptId: 'a1', payload: { reason: 'lease_expired', fence: 1 } })).state;
    expect(s.snapshot.workers['runner_a']).toMatchObject({ availability: 'offline', health: 'disconnected', activity: 'coding' });
    expect(s.snapshot.tasks['t1']!.status).toBe('failed');
  });

  it('budget_exhausted cancel is named, and a cancel request is not a cancel', () => {
    let s = applyEvents(fresh(), running().events).state;
    s = applyEvent(s, ev('task.cancel_requested', 30, { actor: { kind: 'human', id: 'u' }, payload: { operationId: 'op1' } })).state;
    expect(s.snapshot.tasks['t1']).toMatchObject({ status: 'running', cancelRequested: { operationId: 'op1' } });
    s = applyEvent(s, ev('task.cancelled', 35, { attemptId: 'a1', actor: { kind: 'system', id: 'lease_reaper' }, payload: { reason: 'budget_exhausted' } })).state;
    expect(s.snapshot.tasks['t1']).toMatchObject({ status: 'cancelled', cancelReason: 'budget_exhausted', cancelRequested: null });
    expect(s.snapshot.workers['runner_a']).toMatchObject({ availability: 'idle', activity: null });
  });

  it('approval waits release the lease, and a past expiry reads as expired, not granted', () => {
    let s = applyEvents(fresh(), running().events).state;
    s = applyEvent(s, ev('approval.requested', 10, { attemptId: 'a1', payload: { approvalId: 'ap1', scopeHash: 'h', reason: 'needs_domain', expiresAt: at(100) } })).state;
    const w = s.snapshot.workers['runner_a']!;
    expect(w).toMatchObject({ activity: 'waiting_human', leaseHeld: false, blockedByApprovalId: 'ap1' });
    expect(effectiveWorkerHealth(w, T0 + 3_600_000).health).toBe('healthy'); // no lease, no heartbeat verdict
    const ap = s.snapshot.approvals['ap1']!;
    expect(approvalStateAt(ap, T0 + 50_000)).toBe('pending');
    expect(approvalStateAt(ap, T0 + 100_000)).toBe('expired');
    s = applyEvent(s, ev('approval.granted', 20, { actor: { kind: 'human', id: 'u' }, payload: { approvalId: 'ap1' } })).state;
    expect(s.snapshot.tasks['t1']!.status).toBe('ready');
    expect(s.snapshot.approvals['ap1']!.state).toBe('granted');
  });

  it('every event used in these tests passes the domain actor allowlist', () => {
    expect(checkEventAuthority({ ...running().events[0]!, actor: SCHED }).ok).toBe(true);
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
    expect(sumUsage([])).toMatchObject({ total: null, provenance: 'unavailable' }); // nothing recorded is not 0 either
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

describe('session', () => {
  function fakeSource(snapshots: ProjectViewSnapshot[]) {
    let call = 0;
    let push: ((e: ProjectViewEvent) => void) | null = null;
    const errors: DataSourceError[] = [];
    const subscribes: string[] = [];
    const source: EngineeringDataSource = {
      mode: 'mock',
      getSnapshot: async () => snapshots[Math.min(call++, snapshots.length - 1)]!,
      subscribe: (_p, after, onEvent) => {
        subscribes.push(after);
        push = onEvent;
        return () => {
          if (push === onEvent) push = null;
        };
      },
      execute: async () => { throw new Error('unused'); },
      openTerminal: async () => { throw new Error('unused'); },
      disconnect: () => {},
    };
    return { source, errors, subscribes, emit: (e: ProjectViewEvent) => push?.(e), snapshotsFetched: () => call };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('sequence gap triggers resync: the session refetches the snapshot and resubscribes after its cursor', async () => {
    const { events } = running();
    const early = applyEvents(fresh(), events.slice(0, 2)).state.snapshot;
    const later = applyEvents(fresh(), events).state.snapshot;
    const f = fakeSource([early, later]);
    const states: string[] = [];
    const session = startProjection(f.source, 'p1', { onState: (s) => states.push(s.snapshot.meta.cursor), onError: (e) => f.errors.push(e) });
    await settle();
    f.emit(events[2]!); // sequence 3 after cursor 2: fine
    f.emit(events[4]!); // sequence 5 after 3: gap
    await settle();
    expect(session.resyncCount()).toBe(1);
    expect(f.snapshotsFetched()).toBe(2);
    expect(f.subscribes).toEqual(['2', '5']);
    expect(session.state()!.snapshot.meta.cursor).toBe('5');
    f.emit(events[4]!); // already folded into the snapshot: out of order, not applied twice
    session.stop();
  });

  it('a source that keeps producing gaps is reported unavailable instead of looping', async () => {
    const { events } = running();
    const early = applyEvents(fresh(), events.slice(0, 1)).state.snapshot;
    const f = fakeSource([early]);
    const session = startProjection(f.source, 'p1', { onState: () => {}, onError: (e) => f.errors.push(e) });
    for (let i = 0; i < 10; i += 1) {
      await settle();
      f.emit(events[4]!);
    }
    await settle();
    expect(f.errors.at(-1)).toMatchObject({ code: 'unavailable' });
    expect(f.snapshotsFetched()).toBeLessThan(10);
    session.stop();
  });
});
