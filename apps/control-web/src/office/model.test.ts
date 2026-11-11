import { describe, expect, it } from 'vitest';
import type { ChangeRequestView } from '@selarikru/view-protocol';
import { NOW, approval, fixtureSnapshot, iso, snapshotOf, task, worker } from '../features/overview/testing.ts';
import { buildTeam } from '../features/team/model.ts';
import { buildOfficeWorld, robotState } from './model.ts';
import { buildEvidence } from '../features/evidence/model.ts';

const rowOf = (snapshot: ReturnType<typeof snapshotOf>, id: string, opts: Parameters<typeof buildTeam>[3] = {}, liveness: number | null = NOW) =>
  buildTeam(snapshot, NOW, liveness, opts).rows.find((r) => r.workerId === id)!;

describe('robot state, from the worker and the task it holds', () => {
  it('idle when the worker has no task', () => {
    const s = snapshotOf({ workers: [worker('w', { availability: 'idle', activity: null, leaseHeld: false })] });
    expect(robotState(rowOf(s, 'w'), s)).toBe('idle');
  });

  it('working while it codes on a running task', () => {
    const s = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a' })] });
    expect(robotState(rowOf(s, 'w'), s)).toBe('working');
  });

  it('needs input while it waits on a person, and while its task awaits approval', () => {
    const s = snapshotOf({ tasks: [task('a', { status: 'awaiting_approval' })], workers: [worker('w', { taskId: 'a', activity: 'waiting_human', blockedByApprovalId: 'ap' })], approvals: [approval('ap', { taskId: 'a' })] });
    expect(robotState(rowOf(s, 'w'), s)).toBe('needs_input');
  });

  it('in review while its task is verifying', () => {
    const s = snapshotOf({ tasks: [task('a', { status: 'verifying' })], workers: [worker('w', { taskId: 'a', activity: 'testing' })] });
    expect(robotState(rowOf(s, 'w'), s)).toBe('in_review');
  });

  it('verified once its task is verified or merged', () => {
    for (const status of ['verified', 'merged'] as const) {
      const s = snapshotOf({ tasks: [task('a', { status })], workers: [worker('w', { taskId: 'a' })] });
      expect(robotState(rowOf(s, 'w'), s), status).toBe('verified');
    }
  });

  it('blocked on a policy block or a dependency, never idle', () => {
    const s = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', activity: 'blocked_policy', stateReason: 'model_not_allowed' })] });
    expect(robotState(rowOf(s, 'w'), s)).toBe('blocked');
  });

  it('offline when the worker is lost, never working', () => {
    const s = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', lastHeartbeatAt: iso(200), enteredStateAt: iso(300) })] });
    expect(robotState(rowOf(s, 'w'), s)).toBe('offline');
  });

  it('unknown while the session is stale, even if its task reads verified: a stale reading is not a current fact', () => {
    const s = snapshotOf({ tasks: [task('a', { status: 'verified' })], workers: [worker('w', { taskId: 'a' })] });
    expect(robotState(rowOf(s, 'w', { stale: true, lastConfirmedMs: NOW - 5_000 }, null), s)).toBe('unknown');
  });
});

describe('the office world', () => {
  const snapshot = (): ReturnType<typeof snapshotOf> => {
    const s = snapshotOf({
      tasks: [task('a', { title: 'Add table' }), task('b', { status: 'verifying' }), task('c', { status: 'planned', role: 'frontend' }), task('d', { status: 'merged' }), task('e', { status: 'cancelled' })],
      workers: [worker('w1', { taskId: 'a' }), worker('w2', { taskId: 'b', activity: 'testing' }), worker('w3', { availability: 'idle', activity: null, leaseHeld: false })],
    });
    const cr: ChangeRequestView = { runId: 'run', prNumber: 12, url: 'https://example.test/pr/12', status: 'open', candidateSha: 'abc', baseRef: 'main', observedHeadSha: 'abc', mergeCommitSha: null, observedAt: iso(10), outOfDate: null };
    return { ...s, changeRequests: [cr] };
  };

  it('has one robot per worker, in the team panel order, each with a state word and a stable colour', () => {
    const s = snapshot();
    const team = buildTeam(s, NOW, NOW);
    const world = buildOfficeWorld(s, team, 'Clinic queue');
    // One robot per worker; a role no worker holds has a "not started" desk after them (no robot).
    expect(world.agents.filter((a) => !a.notStarted).map((a) => a.id)).toEqual(team.rows.map((r) => r.workerId));
    expect(world.agents.filter((a) => a.notStarted).map((a) => a.id)).toEqual(['role:frontend']);
    expect(world.agents.find((a) => a.id === 'w2')).toMatchObject({ state: 'in_review', label: 'In review' });
    expect(world.agents.find((a) => a.id === 'w3')).toMatchObject({ state: 'idle', label: 'Idle', taskTitle: null });
    const again = buildOfficeWorld(s, buildTeam(s, NOW + 1_000, NOW + 1_000), 'Clinic queue');
    expect(again.agents.map((a) => [a.id, a.color])).toEqual(world.agents.map((a) => [a.id, a.color]));
  });

  it('puts each live task on the plan wall in its column, and leaves ended ones off', () => {
    const world = buildOfficeWorld(snapshot(), buildTeam(snapshot(), NOW, NOW), 'Clinic queue');
    const col = Object.fromEntries(world.notes.map((n) => [n.taskId, n.column]));
    expect(col).toEqual({ a: 1, b: 2, c: 0, d: 3 });
    expect(world.notes.find((n) => n.taskId === 'a')?.ownerId).toBe('w1');
    expect(world.notes.find((n) => n.taskId === 'c')?.ownerId).toBeNull();
  });

  it('turns each pull request into a parcel, and the gate scans while a task verifies', () => {
    const world = buildOfficeWorld(snapshot(), buildTeam(snapshot(), NOW, NOW), 'Clinic queue');
    // No per-criterion evidence is connected for this run, so nothing says its candidate is verified: never inferred from the PR being open.
    expect(world.prs).toEqual([{ num: 12, runId: 'run', authorId: null, verification: 'unverified', merged: false, closed: false }]);
    expect(world.verifying).toBe(true);
  });

  it('a pull request is verified only by Evidence\'s rule (live candidate, a record that stands, every approved criterion passed) and only when it holds that candidate', () => {
    const candidate = { sha: 'abc', status: 'verified', live: true, baseSha: 'b', treeSha: null, target: 't', recordedAt: iso(20), recordId: 'r', recordValid: true, verifierHost: null, checkManifestSha256: null, verifierSha256: null, flaky: [] };
    const withRun = (over: { criteria?: { verified: number; total: number }; candidate?: Partial<typeof candidate>; outOfDate?: boolean }) => {
      const s = snapshot();
      s.runs['run'] = { ...s.runs['run']!, criteria: over.criteria ?? { verified: 2, total: 2 }, evidence: { candidate: { ...candidate, ...over.candidate }, criteria: ['FB-1', 'FB-2'].map((id) => ({ criterionId: id, description: null, state: 'passed' as const, verified: true, taskIds: [], check: null, candidateSha: 'abc' })) } };
      if (over.outOfDate) s.changeRequests = [{ ...s.changeRequests[0]!, outOfDate: { reason: 'main_moved', at: iso(5), rebuiltSha: null, rebuild: 'building' } }];
      return buildOfficeWorld(s, buildTeam(s, NOW, NOW), 'Clinic queue').prs[0]!.verification;
    };
    expect(withRun({})).toBe('verified');
    expect(withRun({ criteria: { verified: 1, total: 2 } })).toBe('unverified');
    expect(withRun({ criteria: { verified: 0, total: 0 } })).toBe('unverified');
    expect(withRun({ candidate: { sha: 'other' } })).toBe('unverified');
    expect(withRun({ candidate: { live: false } })).toBe('unverified');
    expect(withRun({ candidate: { recordValid: false } })).toBe('unverified');
    expect(withRun({ outOfDate: true })).toBe('out_of_date');
  });

  it('verified at reduced scope is verified, by the same rule Evidence uses', () => {
    const s = snapshot();
    const candidate = { sha: 'abc', status: 'verified', live: true, baseSha: 'b', treeSha: null, target: 't', recordedAt: iso(20), recordId: 'r', recordValid: true, verifierHost: null, checkManifestSha256: null, verifierSha256: null, flaky: [] };
    const crit = (id: string, state: 'passed' | 'not_delivered') => ({ criterionId: id, description: null, state, verified: state === 'passed', taskIds: [], check: null, candidateSha: 'abc' });
    s.runs['run'] = {
      ...s.runs['run']!, criteria: { verified: 1, total: 2 }, evidence: { candidate, criteria: [crit('FB-1', 'passed'), crit('FB-2', 'not_delivered')] },
      reducedScope: { acceptedAt: iso(30), acceptedBy: 'owner', notDelivered: { requirementIds: ['FB-2'] } } as never,
    };
    expect(buildEvidence(s, 'run')!.states[0]).toMatchObject({ value: 'Verified at reduced scope', established: true });
    expect(buildOfficeWorld(s, buildTeam(s, NOW, NOW), 'Clinic queue').prs[0]!.verification).toBe('verified');
  });

  it('only a recorded merge is merged: a merge of the wrong commit, or a stale pull request with a merge commit, is not', () => {
    const merged = (status: string, mergeCommitSha: string | null) => {
      const s = snapshot();
      s.changeRequests = [{ ...s.changeRequests[0]!, status, mergeCommitSha }];
      return buildOfficeWorld(s, buildTeam(s, NOW, NOW), 'Clinic queue').prs[0]!;
    };
    expect(merged('merged', 'm1').merged).toBe(true);
    expect(merged('merged_sha_mismatch', 'm1')).toMatchObject({ merged: false, verification: 'out_of_date' });
    expect(merged('stale_candidate', 'm1')).toMatchObject({ merged: false, verification: 'out_of_date' });
  });

  it('puts each run\'s live candidate on the belt, at the gate until Evidence says verified, and past it after', () => {
    const s = snapshot();
    const candidate = { sha: 'abcdef', status: 'assembled', live: true, baseSha: 'b', treeSha: null, target: 't', recordedAt: iso(20), recordId: 'r', recordValid: true, verifierHost: null, checkManifestSha256: null, verifierSha256: null, flaky: [] };
    const rows = (state: 'passed' | 'not_run') => ['FB-1', 'FB-2'].map((id) => ({ criterionId: id, description: null, state, verified: state === 'passed', taskIds: [], check: null, candidateSha: 'abcdef' }));
    s.runs['run'] = { ...s.runs['run']!, criteria: { verified: 0, total: 2 }, evidence: { candidate, criteria: rows('not_run') } };
    const at = () => buildOfficeWorld(s, buildTeam(s, NOW, NOW), 'Clinic queue').parcels;
    expect(at()).toEqual([{ id: 'run:abcdef', label: 'ABCD', stage: 'to_gate' }]);
    s.runs['run'] = { ...s.runs['run']!, criteria: { verified: 2, total: 2 }, evidence: { candidate, criteria: rows('passed') } };
    expect(at()[0]!.stage).toBe('verified');
    s.changeRequests = [{ ...s.changeRequests[0]!, candidateSha: 'abcdef', status: 'merged', mergeCommitSha: 'm' }];
    expect(at()[0]!.stage).toBe('merged');
    s.runs['run'] = { ...s.runs['run']!, evidence: { candidate: { ...candidate, live: false }, criteria: rows('passed') } };
    expect(at()).toEqual([]);
  });

  it('has one sandbox rack per worker, lit only while it holds an attempt with no end, a plan desk with no robot, and a phase banner for the run', () => {
    const s = snapshot();
    const attempt = (id: string, endedAt: string | null) => ({ attemptId: id, taskId: 'a', number: 1, fence: 1, outcome: endedAt ? 'succeeded' as const : 'running' as const, exitReason: null, runnerId: 'r', startedAt: iso(50), endedAt, lastHeartbeatAt: iso(1), assignment: null });
    s.attempts = { x1: attempt('x1', null), x2: attempt('x2', iso(5)) };
    s.workers['w1'] = { ...s.workers['w1']!, attemptId: 'x1' };
    s.workers['w2'] = { ...s.workers['w2']!, attemptId: 'x2' };
    const world = buildOfficeWorld(s, buildTeam(s, NOW, NOW), 'Clinic queue');
    // Working robots both, but only w1's attempt is still open; an idle worker with no attempt is dark.
    expect(Object.fromEntries(world.racks.map((r) => [r.agentId, r.running]))).toEqual({ w1: true, w2: false, w3: false });
    expect(world.running).toBe(1);
    expect(world.leadLabel).toBe('PLAN');
    expect(world.banner).toBe('run · plan rev 1');
    expect(world.runs).toEqual([{ runId: 'run', label: 'run · running' }]);
  });

  it('says what it shows in words, for the canvas label', () => {
    const world = buildOfficeWorld(snapshot(), buildTeam(snapshot(), NOW, NOW), 'Clinic queue');
    expect(world.summary).toBe('Office for Clinic queue: 3 workers. 1 working, 1 in review, 1 idle. 1 pull request. The team panel lists each worker. Team: Backend 1, Backend 2, Worker. 1 role not started (Frontend): an empty desk until a worker holds it. Roof: 0 tasks on this device, 0 in the cloud, 0 fell back.');
  });

  it('says so when there are no workers', () => {
    const s = snapshotOf({});
    expect(buildOfficeWorld(s, buildTeam(s, NOW, NOW), 'Clinic queue').summary).toBe('Office for Clinic queue: no workers yet. Roof: 0 tasks on this device, 0 in the cloud, 0 fell back.');
  });

  it('a demo fixture drives the office', async () => {
    const { snapshot: s, nowMs } = await fixtureSnapshot('human-wait');
    const world = buildOfficeWorld(s, buildTeam(s, nowMs, nowMs), 'Demo');
    expect(world.agents.length).toBeGreaterThan(0);
    expect(world.agents.some((a) => a.state === 'needs_input')).toBe(true);
  });
});

describe('where each robot\'s AI call runs (H4)', () => {
  const route = (observed: 'ON_DEVICE' | 'IN_CLOUD' | null) => ({
    effective: 'PREFER_ON_DEVICE', source: 'run', runDefault: 'PREFER_ON_DEVICE', override: null, overrideRevision: 0, lock: null, suggestion: { mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', reason: 'r', locked: false },
    lastObserved: observed === null ? null : { recordId: 'r', taskId: 'a', taskRevision: 1, requestId: 'q', stepKind: 'patch', callOverride: null, requestedMode: 'PREFER_ON_DEVICE', effectiveMode: 'PREFER_ON_DEVICE', policySource: 'run', locked: false,
      observedSource: observed, fellBack: false, conformance: 'conforms', requestModeMismatch: false, status: 'ok', model: { cloudModel: 'm', sdkVersion: '1.0.0' }, timing: { totalMs: 1, firstOutputMs: null }, validation: 'passed', blockedReason: null, reportedBy: 'browser', trust: 'untrusted', reportedAt: iso(1) },
  }) as never;
  const s = snapshotOf({ tasks: [task('a', { route: route('ON_DEVICE') }), task('b', { route: route(null) })], workers: [worker('w1', { taskId: 'a' }), worker('w2', { taskId: 'b' })] });
  const team = buildTeam(s, NOW, NOW, {});

  it('a desk shows the device or cloud mark of its task\'s last call, and none before any call', () => {
    const w = buildOfficeWorld(s, team, 'P');
    expect(w.agents.find((a) => a.id === 'w1')!.ai).toEqual({ place: 'device', state: 'observed' });
    expect(w.summary).toMatch(/last AI call ran on this device/i);
    expect(w.agents.find((a) => a.id === 'w2')!.ai).toBeNull();
    expect(w.cloudCall).toBe(false);
  });

  it('a call that fell back is an observed cloud mark that says so, from the record only (H7)', () => {
    const fell = (r: ReturnType<typeof route>) => { const x = r as unknown as { lastObserved: Record<string, unknown> }; x.lastObserved = { ...x.lastObserved, fellBack: true }; return r; };
    const f = snapshotOf({ tasks: [task('a', { route: fell(route('IN_CLOUD')) })], workers: [worker('w1', { taskId: 'a' })] });
    const w = buildOfficeWorld(f, buildTeam(f, NOW, NOW, {}), 'P');
    expect(w.agents[0]!.ai).toEqual({ place: 'cloud', state: 'observed', fellBack: true });
    expect(w.summary).toMatch(/last AI call ran in the cloud \(fell back from this device\)/i);
    // A call in flight is a prediction: it never claims a fallback.
    const inFlight = buildOfficeWorld(f, buildTeam(f, NOW, NOW, {}), 'P', null, [{ taskId: 'a', place: 'device' }]);
    expect(inFlight.agents[0]!.ai).toEqual({ place: 'device', state: 'expected' });
  });

  it('a call in flight marks its desk with where it is going, and a cloud call lights the rooftop cloud deck', () => {
    const w = buildOfficeWorld(s, team, 'P', null, [{ taskId: 'b', place: 'cloud' }]);
    expect(w.agents.find((a) => a.id === 'w2')!.ai).toEqual({ place: 'cloud', state: 'expected' });
    expect(w.summary).toMatch(/headed to the cloud \(expected\)/i);
    expect(w.cloudCall).toBe(true);
    expect(w.summary).toMatch(/rooftop cloud deck is lit/i);
    expect(w.summary).not.toMatch(/AI calls in flight: .* in the cloud/i);
    const device = buildOfficeWorld(s, team, 'P', null, [{ taskId: 'a', place: 'device' }]);
    expect(device.cloudCall).toBe(false);
    expect(device.agents.find((a) => a.id === 'w1')!.ai).toEqual({ place: 'device', state: 'expected' });
    expect(device.summary).toMatch(/expected on this device/i);
  });

  it('a cloud call for a task no robot holds still lights the rack', () => {
    expect(buildOfficeWorld(s, team, 'P', null, [{ taskId: 'zzz', place: 'cloud' }]).cloudCall).toBe(true);
  });
});

describe('a desk mark whose call was blocked is cleared', () => {
  it('a blocked last record shows no mark, never the expected one', () => {
    const r = { effective: 'PREFER_ON_DEVICE', source: 'run', runDefault: 'PREFER_ON_DEVICE', override: null, overrideRevision: 0, lock: null, suggestion: { mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', reason: 'r', locked: false },
      lastObserved: { recordId: 'r', taskId: 'a', taskRevision: 1, requestId: 'q', stepKind: 'patch', callOverride: null, requestedMode: null, effectiveMode: 'PREFER_ON_DEVICE', policySource: 'run', locked: false, observedSource: 'UNKNOWN', fellBack: null, conformance: 'unverified', requestModeMismatch: false, status: 'blocked', model: { cloudModel: 'm', sdkVersion: '1.0.0' }, timing: { totalMs: 1, firstOutputMs: null }, validation: 'not_run', blockedReason: 'device_unavailable', reportedBy: 'browser', trust: 'untrusted', reportedAt: iso(1) } } as never;
    const s = snapshotOf({ tasks: [task('a', { route: r })], workers: [worker('w1', { taskId: 'a' })] });
    expect(buildOfficeWorld(s, buildTeam(s, NOW, NOW, {}), 'P').agents[0]!.ai).toBeNull();
  });
});

describe('what the office world records for its events (H7 fix round 2)', () => {
  it('a resolved approval counts as answered only when a person granted or denied it; expired and superseded do not', () => {
    const s = snapshotOf({ tasks: [task('a')], workers: [worker('w1', { taskId: 'a' })] });
    const entry = (approvalId: string, outcome: string, approver: string | null) => ({ approvalId, runId: 'run', taskId: 'a', revision: 1, outcome, approver, scopeHash: null, operation: null, destination: null, requestedAt: iso(9), resolvedAt: iso(5), consumedAt: null, consumedBy: null });
    s.approvalHistory = [entry('g', 'granted', 'owner'), entry('d', 'denied', 'owner'), entry('x', 'expired', null), entry('s', 'superseded', null), entry('n', 'granted', null)] as never;
    expect(buildOfficeWorld(s, buildTeam(s, NOW, NOW, {}), 'P').resolvedApprovals.map((a) => a.approvalId)).toEqual(['g', 'd']);
  });

  it('a verdict per run candidate: failed from a recorded failed criterion on it, rejected, or retired when replaced', () => {
    const s = snapshotOf({ tasks: [task('a')] });
    const cand = (over: Record<string, unknown>) => ({ sha: 'abc1234', status: 'assembled', live: true, baseSha: 'b', treeSha: null, target: 'main', recordedAt: iso(5), recordId: null, recordValid: false, verifierHost: null, checkManifestSha256: null, verifierSha256: null, flaky: [], ...over });
    const crit = (state: string) => ({ criterionId: 'AC-1', description: null, state, verified: false, taskIds: ['a'], check: null, candidateSha: 'abc1234' });
    const at = (candidate: unknown, criteria: unknown[]) => { s.runs['run'] = { ...s.runs['run']!, evidence: { candidate, criteria } as never }; return buildOfficeWorld(s, buildTeam(s, NOW, NOW, {}), 'P').verdicts; };
    expect(at(cand({}), [crit('not_run')])).toEqual([{ id: 'run:abc1234', label: 'ABC1', outcome: 'pending' }]);
    expect(at(cand({}), [crit('failed')])[0]!.outcome).toBe('failed');
    expect(at(cand({ live: false, status: 'rejected' }), [crit('failed')])[0]!.outcome).toBe('rejected');
    expect(at(cand({ live: false, status: 'replaced' }), [crit('failed')])[0]!.outcome).toBe('retired');
    expect(at(null, [])).toEqual([]);
  });
});

describe('the team in the office (H11)', () => {
  const setting = (key: string, field: string, value: unknown) => ({ scope: 'runner', key, field, desired: value, effective: value, desiredRevision: 1, effectiveRevision: 1, enforcer: 'server', state: 'applied', updatedBy: 'o', updatedAt: iso(9), appliedAt: iso(9) });

  it('desks show the owner-given name, the role on hover and in the summary as "<Name> · <Role>"', () => {
    const s = snapshotOf({ tasks: [task('a', { role: 'backend' })], workers: [worker('w1', { taskId: 'a' })] });
    s.settings = [setting('w1', 'display_name', 'Aisyah')] as never;
    const w = buildOfficeWorld(s, buildTeam(s, NOW, NOW, {}), 'P');
    expect(w.agents[0]).toMatchObject({ name: 'Aisyah', roleLabel: 'Backend', active: true });
    expect(w.summary).toContain('Aisyah · Backend');
  });

  it('a worker whose runner is lost, unknown or disabled keeps an empty, dimmed desk with its nameplate and no robot', () => {
    const s = snapshotOf({ workers: [worker('w1', { health: 'disconnected', leaseHeld: false, lastHeartbeatAt: iso(600) }), worker('w2'), worker('w3')] });
    s.settings = [setting('w3', 'enabled', false)] as never;
    const w = buildOfficeWorld(s, buildTeam(s, NOW, NOW, {}), 'P');
    const byId = new Map(w.agents.map((a) => [a.id, a]));
    expect(byId.get('w2')!.active).toBe(true);
    expect(byId.get('w3')!.active).toBe(false);
    expect(w.summary).toMatch(/inactive/);
  });

  it('the Project Manager sits at the PLAN desk, always there, and has no desk of its own; it is busy while the owner\'s PM call runs', () => {
    const s = snapshotOf({ workers: [worker('w1'), worker('pm1', { leaseHeld: false })] });
    s.settings = [setting('pm1', 'role', 'project_manager'), setting('pm1', 'display_name', 'Puan Rahmah')] as never;
    const w = buildOfficeWorld(s, buildTeam(s, NOW, NOW, {}), 'P', null, [{ taskId: 'x', place: 'device', stepKind: 'pmAnswer' }]);
    expect(w.agents.map((a) => a.id)).toEqual(['w1']);
    expect(w.pm).toEqual({ id: 'pm1', name: 'Puan Rahmah', busy: true });
    const none = buildOfficeWorld(snapshotOf({}), buildTeam(snapshotOf({}), NOW, NOW, {}), 'P');
    expect(none.pm).toEqual({ id: null, name: 'Project Manager', busy: false });
  });

  it('M10: a role of the run with no worker gets a "not started" desk with the role nameplate and no robot; the PM\'s name comes from Settings before any worker holds it', () => {
    const s = snapshotOf({ tasks: [task('a', { role: 'backend' }), task('b', { role: 'frontend' })], workers: [worker('w1', { taskId: 'a' })] });
    s.settings = [{ ...setting('run', 'pm_display_name', 'Puan Zara'), scope: 'run' }] as never;
    const w = buildOfficeWorld(s, buildTeam(s, NOW, NOW, {}), 'P');
    const placeholder = w.agents.find((a) => a.id === 'role:frontend');
    expect(placeholder).toMatchObject({ name: 'Frontend', roleLabel: 'Frontend', active: false, notStarted: true });
    expect(w.agents.find((a) => a.id === 'w1')!.notStarted).toBeUndefined();
    expect(w.pm.name).toBe('Puan Zara');
    expect(w.summary).toContain('1 role not started');
  });

  it('a delegation is on the worker\'s cue, from the record', () => {
    const s = snapshotOf({ tasks: [task('a', { delegation: { workerId: 'w1', planRevision: 2, actor: 'agent', at: iso(3) } })], workers: [worker('w1', { taskId: 'a' })] });
    expect(buildOfficeWorld(s, buildTeam(s, NOW, NOW, {}), 'P').cues[0]).toMatchObject({ delegatedAt: iso(3), delegatedPlanRevision: 2 });
  });
});
