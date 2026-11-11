import { describe, expect, it } from 'vitest';
import { effectsFor, errandFor, officeEvents, type OfficeEvent } from './events.ts';
import type { OfficeCue, OfficeWorld } from './model.ts';

/** A world with only what the event diff reads. */
function world(over: Partial<OfficeWorld> = {}, cues: Partial<OfficeCue>[] = [{}]): OfficeWorld {
  return {
    projectName: 'P', agents: cues.map((c, i) => ({ id: c.agentId ?? `w${i + 1}`, name: `W${i + 1}`, color: '#2fa39a', state: 'working', label: 'Working', taskTitle: null, ai: null })),
    planRunId: 'run', banner: null, runs: [], notes: [], leadLabel: 'PLAN', racks: [], running: 0, prs: [], parcels: [], verifying: false, cloudCall: false, summary: '',
    cues: cues.map((c, i) => ({ agentId: `w${i + 1}`, taskId: 't1', taskRevision: 1, runId: 'run', attemptId: null, attemptRunning: false, attemptOutcome: null, recordId: null, fellBackToCloud: false, cloudCall: false, needsYou: false, ...c })),
    resolvedApprovals: [],
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
    expect(kinds(officeEvents(world({ parcels: [parcel] }), world({ parcels: [] })))).toEqual(['changes']);
    expect(officeEvents(world({ parcels: [parcel] }), world({ parcels: [] }))[0]).toMatchObject({ agentIds: ['w1'] });
  });
});

describe('each event\'s errand and effect', () => {
  it('maps every event to its walk, one errand of steps per event', () => {
    expect(errandFor({ kind: 'claimed', agentId: 'w1' }).map((s) => s.to)).toEqual(['plan', 'seat']);
    expect(errandFor({ kind: 'replanned', agentId: 'w1' }).map((s) => s.to)).toEqual(['plan', 'seat']);
    expect(errandFor({ kind: 'cloudCallStarted', agentId: 'w1' })).toEqual([{ to: 'roof', hold: 'cloud' }]);
    expect(errandFor({ kind: 'fellBackToCloud', agentId: 'w1' }).map((s) => s.to)).toEqual(['roof', 'seat']);
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
      { kind: 'text', at: 'gate', text: 'CHANGES', tone: 'fail' }, { kind: 'gate', look: 'changes' }, { kind: 'flyBack', label: 'ABC', to: { agent: 'w1' } },
    ]);
    expect(effectsFor({ kind: 'changes', parcelId: 'p', label: 'ABC', agentIds: [] })[2]).toEqual({ kind: 'flyBack', label: 'ABC', to: 'plan' });
    expect(effectsFor({ kind: 'claimed', agentId: 'w1' })).toEqual([]);
  });
});
