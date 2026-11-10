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
    expect(world.agents.map((a) => a.id)).toEqual(team.rows.map((r) => r.workerId));
    expect(world.agents.find((a) => a.id === 'w2')).toMatchObject({ state: 'in_review', label: 'Verifying' });
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
    expect(world.parcels).toEqual([{ num: 12, authorId: null, verification: 'unverified', merged: false, closed: false }]);
    expect(world.verifying).toBe(true);
  });

  it('a pull request is verified only by Evidence\'s rule (live candidate, a record that stands, every approved criterion passed) and only when it holds that candidate', () => {
    const candidate = { sha: 'abc', status: 'verified', live: true, baseSha: 'b', treeSha: null, target: 't', recordedAt: iso(20), recordId: 'r', recordValid: true, verifierHost: null, checkManifestSha256: null, verifierSha256: null, flaky: [] };
    const withRun = (over: { criteria?: { verified: number; total: number }; candidate?: Partial<typeof candidate>; outOfDate?: boolean }) => {
      const s = snapshot();
      s.runs['run'] = { ...s.runs['run']!, criteria: over.criteria ?? { verified: 2, total: 2 }, evidence: { candidate: { ...candidate, ...over.candidate }, criteria: ['FB-1', 'FB-2'].map((id) => ({ criterionId: id, description: null, state: 'passed' as const, verified: true, taskIds: [], check: null, candidateSha: 'abc' })) } };
      if (over.outOfDate) s.changeRequests = [{ ...s.changeRequests[0]!, outOfDate: { reason: 'main_moved', at: iso(5), rebuiltSha: null, rebuild: 'building' } }];
      return buildOfficeWorld(s, buildTeam(s, NOW, NOW), 'Clinic queue').parcels[0]!.verification;
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
    expect(buildOfficeWorld(s, buildTeam(s, NOW, NOW), 'Clinic queue').parcels[0]!.verification).toBe('verified');
  });

  it('only a recorded merge is merged: a merge of the wrong commit, or a stale pull request with a merge commit, is not', () => {
    const merged = (status: string, mergeCommitSha: string | null) => {
      const s = snapshot();
      s.changeRequests = [{ ...s.changeRequests[0]!, status, mergeCommitSha }];
      return buildOfficeWorld(s, buildTeam(s, NOW, NOW), 'Clinic queue').parcels[0]!;
    };
    expect(merged('merged', 'm1').merged).toBe(true);
    expect(merged('merged_sha_mismatch', 'm1')).toMatchObject({ merged: false, verification: 'out_of_date' });
    expect(merged('stale_candidate', 'm1')).toMatchObject({ merged: false, verification: 'out_of_date' });
  });

  it('says what it shows in words, for the canvas label', () => {
    const world = buildOfficeWorld(snapshot(), buildTeam(snapshot(), NOW, NOW), 'Clinic queue');
    expect(world.summary).toBe('Office for Clinic queue: 3 workers. 1 working, 1 verifying, 1 idle. 1 pull request. The team panel lists each worker.');
  });

  it('says so when there are no workers', () => {
    const s = snapshotOf({});
    expect(buildOfficeWorld(s, buildTeam(s, NOW, NOW), 'Clinic queue').summary).toBe('Office for Clinic queue: no workers yet.');
  });

  it('a demo fixture drives the office', async () => {
    const { snapshot: s, nowMs } = await fixtureSnapshot('human-wait');
    const world = buildOfficeWorld(s, buildTeam(s, nowMs, nowMs), 'Demo');
    expect(world.agents.length).toBeGreaterThan(0);
    expect(world.agents.some((a) => a.state === 'needs_input')).toBe(true);
  });
});
