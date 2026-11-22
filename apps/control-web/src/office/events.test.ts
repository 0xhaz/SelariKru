import { describe, expect, it } from 'vitest';
import { effectsFor, errandFor, officeEvents, type OfficeEvent } from './events.ts';
import type { OfficeCue, OfficeWorld } from './model.ts';

/** A world with only what the event diff reads. */
function world(over: Partial<OfficeWorld> = {}, cues: Partial<OfficeCue>[] = [{}]): OfficeWorld {
  return {
    projectName: 'P', agents: cues.map((c, i) => ({ id: c.agentId ?? `w${i + 1}`, name: `W${i + 1}`, color: '#2fa39a', state: 'working', label: 'Working', taskTitle: null, ai: null })),
    planRunId: 'run', banner: null, runs: [], notes: [], leadLabel: 'PLAN', racks: [], running: 0, prs: [], parcels: [], verifying: false, cloudCall: false, summary: '',
    cues: cues.map((c, i) => ({ agentId: `w${i + 1}`, taskId: 't1', taskRevision: 1, runId: 'run', attemptId: null, attemptRunning: false, attemptOutcome: null, recordId: null, fellBackToCloud: false, cloudCall: false, deviceCall: false, needsYou: false, ...c })),
    resolvedApprovals: [], verdicts: [], delegations: [], epoch: 'p#1', pm: { id: null, name: 'Project Manager', busy: false },
    roof: { device: { place: 'device', count: 0, expected: [], observed: null, violation: null, locked: false, waiting: [] }, cloud: { place: 'cloud', count: 0, expected: [], observed: null, violation: null, locked: false, waiting: [] }, fellBack: null, fellBackCount: 0, summary: '', offline: false },
    ...over,
  };
}
const kinds = (es: readonly OfficeEvent[]) => es.map((e) => e.kind);

describe('office events, read from two worlds in a row (H7 fix: errands follow real events only)', () => {
  it('the first world raises nothing, and an unchanged world raises nothing', () => {
    expect(officeEvents(null, world())).toEqual([]);
    expect(officeEvents(world(), world())).toEqual([]);
  });

  it('an attempt starting is a claim; a new task revision is a replan', () => {
    expect(officeEvents(world(), world({}, [{ attemptId: 'a1', attemptRunning: true }]))).toEqual([{ kind: 'claimed', agentId: 'w1' }]);
    expect(officeEvents(world(), world({}, [{ taskRevision: 2 }]))).toEqual([{ kind: 'replanned', agentId: 'w1' }]);
  });

  it('an attempt that ends well publishes its change; a cloud call starting and ending; a recorded fallback to the cloud', () => {
    const running = world({}, [{ attemptId: 'a1', attemptRunning: true }]);
    expect(officeEvents(running, world({}, [{ attemptId: 'a1', attemptOutcome: 'succeeded' }]))).toEqual([{ kind: 'published', agentId: 'w1' }]);
    expect(officeEvents(running, world({}, [{ attemptId: 'a1', attemptOutcome: 'failed' }]))).toEqual([]);
    expect(officeEvents(world(), world({}, [{ cloudCall: true }]))).toEqual([{ kind: 'cloudCallStarted', agentId: 'w1' }]);
    expect(officeEvents(world({}, [{ cloudCall: true }]), world())).toEqual([{ kind: 'cloudCallEnded', agentId: 'w1' }]);
    expect(officeEvents(world(), world({}, [{ deviceCall: true }]))).toEqual([{ kind: 'deviceCallStarted', agentId: 'w1' }]);
    expect(officeEvents(world({}, [{ deviceCall: true }]), world())).toEqual([{ kind: 'deviceCallEnded', agentId: 'w1' }]);
    expect(officeEvents(world(), world({}, [{ recordId: 'r1', fellBackToCloud: true }]))).toEqual([{ kind: 'fellBackToCloud', agentId: 'w1' }]);
    // A record that did not fall back is not a fallback.
    expect(officeEvents(world(), world({}, [{ recordId: 'r1' }]))).toEqual([]);
  });

  it('asking you and being answered, from the worker state and the approval history', () => {
    expect(officeEvents(world(), world({}, [{ needsYou: true }]))).toEqual([{ kind: 'needsYou', agentId: 'w1' }]);
    expect(officeEvents(world({}, [{ needsYou: true }]), world({ resolvedApprovals: [{ approvalId: 'ap', taskId: 't1' }] }))).toEqual([{ kind: 'answered', agentId: 'w1' }]);
    // An answer for a task no worker holds moves no one.
    expect(officeEvents(world(), world({ resolvedApprovals: [{ approvalId: 'ap', taskId: 'zz' }] }))).toEqual([]);
  });

  it('pull requests opening and merging, for the workers on that run; candidates passing or failing at the gate', () => {
    const pr = { num: 7, runId: 'run', authorId: null, verification: 'unverified' as const, merged: false, closed: false };
    expect(officeEvents(world(), world({ prs: [pr] }))).toEqual([{ kind: 'prOpened', agentIds: ['w1'], num: 7 }]);
    expect(officeEvents(world({ prs: [pr] }), world({ prs: [{ ...pr, merged: true }] }))).toEqual([{ kind: 'prMerged', agentIds: ['w1'], num: 7 }]);
    const parcel = { id: 'run:abc', label: 'ABC', stage: 'to_gate' as const };
    expect(officeEvents(world({ parcels: [parcel] }), world({ parcels: [{ ...parcel, stage: 'verified' }] }))).toEqual([{ kind: 'verified', parcelId: 'run:abc' }]);
  });
});

describe('each event\'s errand and effect', () => {
  it('maps every event to its walk, one errand of steps per event', () => {
    expect(errandFor({ kind: 'claimed', agentId: 'w1' }).map((s) => s.to)).toEqual(['plan', 'seat']);
    expect(errandFor({ kind: 'replanned', agentId: 'w1' }).map((s) => s.to)).toEqual(['plan', 'seat']);
    // Round 4: the roof errand goes to the box of the call; a fallback walks from the device box to the cloud box.
    expect(errandFor({ kind: 'cloudCallStarted', agentId: 'w1' })).toEqual([{ to: 'roofCloud', hold: 'call' }]);
    expect(errandFor({ kind: 'deviceCallStarted', agentId: 'w1' })).toEqual([{ to: 'roofDevice', hold: 'call' }]);
    expect(errandFor({ kind: 'fellBackToCloud', agentId: 'w1' }).map((s) => s.to)).toEqual(['roofDevice', 'roofCloud', 'seat']);
    expect(errandFor({ kind: 'published', agentId: 'w1' })).toEqual([{ to: 'drop', carry: true, linger: 0.6, emote: 'ok' }, { to: 'seat' }]);
    expect(errandFor({ kind: 'prOpened', agentIds: ['w1'], num: 7 }).map((s) => s.to)).toEqual(['prs', 'seat']);
    expect(errandFor({ kind: 'prMerged', agentIds: ['w1'], num: 7 })).toEqual([{ to: 'here', emote: 'heart', linger: 2 }]);
    expect(errandFor({ kind: 'needsYou', agentId: 'w1' })).toEqual([{ to: 'seat', emote: 'talk' }]);
    expect(errandFor({ kind: 'answered', agentId: 'w1' })).toEqual([{ to: 'here', emote: 'mail', linger: 2 }]);
    expect(errandFor({ kind: 'verified', parcelId: 'p' })).toEqual([]);
  });

  it('maps events to their effects: envelopes, the pass burst, CHANGES and the fly-back', () => {
    expect(effectsFor({ kind: 'needsYou', agentId: 'w1' })).toEqual([{ kind: 'envelope', from: { agent: 'w1' }, to: 'actions' }]);
    expect(effectsFor({ kind: 'answered', agentId: 'w1' })).toEqual([{ kind: 'envelope', from: 'plan', to: { agent: 'w1' } }]);
    expect(effectsFor({ kind: 'verified', parcelId: 'p' })).toEqual([{ kind: 'burst', at: 'gate' }, { kind: 'text', at: 'gate', text: 'VERIFIED', tone: 'pass' }]);
    expect(effectsFor({ kind: 'changes', parcelId: 'p', label: 'ABC', agentIds: ['w1'] })).toEqual([
      { kind: 'text', at: 'gate', text: 'CHANGES', tone: 'fail' }, { kind: 'gate', look: 'changes' }, { kind: 'flyBack', label: 'ABC', to: 'plan' },
    ]);
    expect(effectsFor({ kind: 'claimed', agentId: 'w1' })).toEqual([]);
  });
});

describe('round 2: no invented events', () => {
  it('a new epoch (the demo loop wraps, the fixture or project switches) dispatches nothing, however much changed', () => {
    const before = world({ epoch: 'p#1', parcels: [{ id: 'run:abc', label: 'ABC', stage: 'to_gate' }] }, [{ attemptId: null }]);
    const after = world({ epoch: 'p#2', parcels: [], verdicts: [{ id: 'run:abc', label: 'ABC', outcome: 'failed' }], resolvedApprovals: [{ approvalId: 'ap', taskId: 't1' }] }, [{ attemptId: 'a1', attemptRunning: true, needsYou: true }]);
    expect(officeEvents(before, after)).toEqual([]);
    expect(officeEvents(world({ epoch: 'p#1' }), world({ epoch: 'q#1' }, [{ needsYou: true }]))).toEqual([]);
  });

  it('CHANGES only on a recorded failed verification or a rejected candidate; a replaced candidate or evidence going away retires the parcel quietly', () => {
    const pending = { id: 'run:abc', label: 'ABC', outcome: 'pending' as const };
    const parcel = { id: 'run:abc', label: 'ABC', stage: 'to_gate' as const };
    // A real failure while the candidate stays live: CHANGES, and the tiffin goes back to the plan table.
    const failed = officeEvents(world({ parcels: [parcel], verdicts: [pending] }), world({ parcels: [parcel], verdicts: [{ ...pending, outcome: 'failed' }] }));
    expect(failed).toEqual([{ kind: 'changes', parcelId: 'run:abc', label: 'ABC', agentIds: ['w1'] }]);
    expect(kinds(officeEvents(world({ verdicts: [pending] }), world({ verdicts: [{ ...pending, outcome: 'rejected' }] })))).toEqual(['changes']);
    // Replaced, or evidence gone: nothing.
    expect(officeEvents(world({ parcels: [parcel], verdicts: [pending] }), world({ parcels: [], verdicts: [{ ...pending, outcome: 'retired' }] }))).toEqual([]);
    expect(officeEvents(world({ parcels: [parcel], verdicts: [pending] }), world({ parcels: [], verdicts: [] }))).toEqual([]);
    // A failure already recorded is not raised again.
    expect(officeEvents(world({ verdicts: [{ ...pending, outcome: 'failed' }] }), world({ verdicts: [{ ...pending, outcome: 'failed' }] }))).toEqual([]);
    expect(effectsFor(failed[0]!)[2]).toEqual({ kind: 'flyBack', label: 'ABC', to: 'plan' });
  });
});

describe('the Project Manager\'s events (H11)', () => {
  it('a delegation recorded for a worker\'s task is an event; its walk, envelope and emotes are the PM\'s errand (P1: pmErrands), not a worker errand or a scene effect', () => {
    const d = { taskId: 't9', workerId: 'w1', planRevision: 2, at: '2026-11-11T00:00:05Z' };
    const e = officeEvents(world({ delegations: [] }), world({ delegations: [d] }));
    expect(e).toEqual([{ kind: 'delegated', agentId: 'w1', planRevision: 2 }]);
    expect(errandFor(e[0]!)).toEqual([]);
    expect(effectsFor(e[0]!)).toEqual([]);
    // The same delegation again is not a new event.
    expect(officeEvents(world({ delegations: [d] }), world({ delegations: [d] }))).toEqual([]);
    // A delegation to a worker with no desk in the office (unknown) moves no one.
    expect(officeEvents(world({ delegations: [] }), world({ delegations: [{ ...d, workerId: 'nobody' }] }))).toEqual([]);
  });

  it('a newly accepted plan revision for the same run is an event (the PM\'s errand to the board, P1); another run or the same revision does nothing', () => {
    const e = officeEvents(world({ planRevision: 1 }), world({ planRevision: 2 }));
    expect(e).toEqual([{ kind: 'planAccepted', planRevision: 2 }]);
    expect(errandFor(e[0]!)).toEqual([]);
    expect(effectsFor(e[0]!)).toEqual([]);
    expect(officeEvents(world({ planRevision: 2 }), world({ planRevision: 2 }))).toEqual([]);
    expect(officeEvents(world({ planRevision: 1 }), world({ planRunId: 'other', planRevision: 2 }))).toEqual([]);
  });
});
