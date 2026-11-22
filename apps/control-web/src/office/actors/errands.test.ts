import { describe, expect, it } from 'vitest';
import { ErrandQueue, PM_TRIP_CAP, pmErrands, type PmPlan } from './errands.ts';
import type { OfficeWorld } from '../model.ts';

describe('a robot\'s errands run one at a time (H7 fix)', () => {
  it('runs errands in order, a step at a time, and is idle when done', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'plan', linger: 1 }, { to: 'seat' }]);
    q.push([{ to: 'prs', linger: 1 }, { to: 'seat' }]);
    expect(q.current()?.to).toBe('plan');
    q.arrived(0);
    expect(q.current()?.to).toBe('plan');
    q.tick(1.1);
    expect(q.current()?.to).toBe('seat');
    q.arrived(1.1);
    q.tick(1.2);
    expect(q.current()?.to).toBe('prs');
    q.arrived(1.2); q.tick(2.3); q.arrived(2.3); q.tick(2.4);
    expect(q.current()).toBeNull();
  });

  it('a held step waits on the roof until it is released, then the next errand runs', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'roofCloud', hold: 'call' }]);
    q.push([{ to: 'prs' }]);
    q.arrived(0);
    q.tick(60);
    expect(q.current()).toEqual({ to: 'roofCloud', hold: 'call' });
    q.release('call');
    expect(q.current()?.to).toBe('seat');
    q.arrived(61); q.tick(61);
    expect(q.current()?.to).toBe('prs');
  });

  it('a worker that needs you drops its walks and stays at its desk', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'prs', linger: 1 }, { to: 'seat' }]);
    q.needsYou();
    expect(q.current()?.to).toBe('seat');
    q.arrived(0); q.tick(0.1);
    expect(q.current()).toBeNull();
  });

  it('under reduced motion a robot is placed where its errands end, with nothing walked', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'plan', linger: 1 }, { to: 'seat' }]);
    expect(q.settle()).toBe('seat');
    expect(q.current()).toBeNull();
    q.push([{ to: 'roofCloud', hold: 'call' }]);
    expect(q.settle()).toBe('roofCloud');
    expect(q.current()).toEqual({ to: 'roofCloud', hold: 'call' });
  });

  it('round 3: clear() drops everything, held roof steps included, so a loop never leaves a robot on the roof', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'roofCloud', hold: 'call' }]);
    q.push([{ to: 'prs' }]);
    q.arrived(0);
    q.clear();
    expect(q.current()).toBeNull();
    expect(q.there).toBe(false);
  });

  it('round 3: a held roof step is released when the world says the worker has no cloud call', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'roofCloud', hold: 'call' }]);
    q.arrived(0);
    q.follow({ cloudCall: false });
    expect(q.current()?.to).toBe('seat');
    const kept = new ErrandQueue();
    kept.push([{ to: 'roofCloud', hold: 'call' }]);
    kept.follow({ cloudCall: true });
    expect(kept.current()).toEqual({ to: 'roofCloud', hold: 'call' });
  });
});

/** A world with only what the PM's errands read (P1). */
function pmWorld(over: Partial<OfficeWorld> = {}, workers: readonly string[] = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']): OfficeWorld {
  return {
    projectName: 'P', agents: [], planRunId: 'run', planRevision: 1, banner: null, runs: [], notes: [], leadLabel: 'PLAN', racks: [], running: 0, prs: [], parcels: [], verifying: false, cloudCall: false, summary: '',
    cues: workers.map((agentId) => ({ agentId, taskId: null, taskRevision: null, runId: 'run', attemptId: null, attemptRunning: false, attemptOutcome: null, recordId: null, fellBackToCloud: false, cloudCall: false, deviceCall: false, needsYou: false })),
    resolvedApprovals: [], verdicts: [], delegations: [], epoch: 'p#1', pm: { id: null, name: 'Project Manager', busy: false }, meeting: { pm: false, why: null, agentIds: [] },
    roof: { device: { place: 'device', count: 0, expected: [], observed: null, violation: null, locked: false, waiting: [] }, cloud: { place: 'cloud', count: 0, expected: [], observed: null, violation: null, locked: false, waiting: [] }, fellBack: null, fellBackCount: 0, summary: '', offline: false },
    ...over,
  } as OfficeWorld;
}
const delegation = (taskId: string, workerId: string, at = '2026-11-22T10:00:00.000Z') => ({ taskId, workerId, planRevision: 2, at });
const places = (plan: PmPlan) => plan.errands.map((e) => e.map((s) => (s.agentId ? `${s.to}:${s.agentId}` : s.to)));

describe('P1: the Project Manager\'s errands, read from two worlds in a row', () => {
  it('a meeting starting sends the PM to the shared table, and the meeting ending sends it back to its desk', () => {
    const calm = pmWorld();
    const meeting = pmWorld({ meeting: { pm: true, why: 'review', agentIds: ['w1'] } });
    expect(places(pmErrands(calm, meeting))).toEqual([['pmTable']]);
    expect(places(pmErrands(meeting, calm))).toEqual([['pmHome']]);
  });

  it('a plan revision accepted for the same run sends it to the plan board, with a talk emote there, then home', () => {
    const plan = pmErrands(pmWorld(), pmWorld({ planRevision: 2 }));
    expect(places(plan)).toEqual([['pmBoard', 'pmHome']]);
    expect(plan.errands[0]![0]).toMatchObject({ emote: 'talk' });
    expect(plan.errands[0]![0]!.linger).toBeGreaterThan(0);
    // Another run on the plan wall is not an acceptance.
    expect(places(pmErrands(pmWorld(), pmWorld({ planRunId: 'run2', planRevision: 2 })))).toEqual([]);
  });

  it('a delegation sends it to that worker, with a talk emote there, then back', () => {
    const plan = pmErrands(pmWorld(), pmWorld({ delegations: [delegation('t1', 'w2')] }));
    expect(places(plan)).toEqual([['pmDelegate:w2', 'pmHome']]);
    expect(plan.errands[0]![0]).toMatchObject({ emote: 'talk' });
    expect(plan.deskEnvelopes).toEqual([]);
    // A delegation to a worker that is not in the office moves no one.
    expect(places(pmErrands(pmWorld(), pmWorld({ delegations: [delegation('t1', 'ghost')] })))).toEqual([]);
  });

  it('several delegations make one trip per worker, in order; past four queued trips the rest get only an envelope from the desk', () => {
    const next = pmWorld({ delegations: [delegation('t1', 'w1'), delegation('t2', 'w2'), delegation('t3', 'w1'), delegation('t4', 'w3'), delegation('t5', 'w4'), delegation('t6', 'w5'), delegation('t7', 'w6')] });
    const plan = pmErrands(pmWorld(), next);
    expect(places(plan).map((e) => e[0])).toEqual(['pmDelegate:w1', 'pmDelegate:w2', 'pmDelegate:w3', 'pmDelegate:w4']);
    expect(PM_TRIP_CAP).toBe(4);
    expect(plan.deskEnvelopes).toEqual(['w5', 'w6']);
    // Trips already queued count against the cap.
    const busy = pmErrands(pmWorld(), pmWorld({ delegations: [delegation('t1', 'w1'), delegation('t2', 'w2')] }), 3);
    expect(places(busy).map((e) => e[0])).toEqual(['pmDelegate:w1']);
    expect(busy.deskEnvelopes).toEqual(['w2']);
  });

  it('the first frame, and a new epoch, replay nothing: no walk for what was already there', () => {
    const full = pmWorld({ planRevision: 3, meeting: { pm: true, why: 'plan', agentIds: [] }, delegations: [delegation('t1', 'w1')] });
    expect(pmErrands(null, full)).toEqual({ errands: [], deskEnvelopes: [] });
    expect(pmErrands(pmWorld({ epoch: 'p#0' }), full)).toEqual({ errands: [], deskEnvelopes: [] });
  });

  it('no errand starts unless an event caused it: an unchanged world, or one that changed elsewhere, sends it nowhere', () => {
    const w = pmWorld({ delegations: [delegation('t1', 'w1')], meeting: { pm: true, why: 'review', agentIds: ['w1'] } });
    expect(pmErrands(w, w)).toEqual({ errands: [], deskEnvelopes: [] });
    expect(pmErrands(w, { ...w, pm: { ...w.pm, busy: true }, summary: 'changed', verifying: true })).toEqual({ errands: [], deskEnvelopes: [] });
    // A delegation seen before is not seen again.
    expect(pmErrands(w, { ...w, delegations: [...w.delegations!] })).toEqual({ errands: [], deskEnvelopes: [] });
  });
});

describe('P1: the queue helpers the PM uses', () => {
  it('counts queued errands that go to a place, and drops a trailing walk home when more is queued', () => {
    const q = new ErrandQueue();
    q.push([{ to: 'pmDelegate', agentId: 'w1' }, { to: 'pmHome' }]);
    q.push([{ to: 'pmDelegate', agentId: 'w2' }, { to: 'pmHome' }]);
    expect(q.count('pmDelegate')).toBe(2);
    expect(q.skipTrailing('pmHome')).toBe(false);
    q.arrived(0); q.tick(0);
    expect(q.current()?.to).toBe('pmHome');
    expect(q.skipTrailing('pmHome')).toBe(true);
    expect(q.current()).toMatchObject({ to: 'pmDelegate', agentId: 'w2' });
    q.arrived(1); q.tick(1);
    // The last walk home stays: nothing else is queued.
    expect(q.skipTrailing('pmHome')).toBe(false);
    expect(q.current()?.to).toBe('pmHome');
  });
});
