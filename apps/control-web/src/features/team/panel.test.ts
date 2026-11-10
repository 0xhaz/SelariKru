import { describe, expect, it } from 'vitest';
import { NOW, approval, iso, snapshotOf, task, worker } from '../overview/testing.ts';
import { buildTeam, type TeamRow } from './model.ts';
import { panelOf } from './panel.ts';

const row = (model: ReturnType<typeof buildTeam>, id: string): TeamRow => model.rows.find((r) => r.workerId === id)!;

describe('worker presence for the team panel', () => {
  it('says idle for an idle worker, with time in state', () => {
    const r = row(buildTeam(snapshotOf({ workers: [worker('w', { availability: 'idle', activity: null, leaseHeld: false, enteredStateAt: iso(120) })] }), NOW, NOW), 'w');
    expect(r.presence).toMatchObject({ state: 'idle', label: 'Idle', since: '2m 0s' });
  });

  it('says working for an assigned worker and keeps what it is doing as detail', () => {
    const r = row(buildTeam(snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', activity: 'testing' })] }), NOW, NOW), 'w');
    expect(r.presence).toMatchObject({ state: 'working', label: 'Working', detail: 'Testing', tone: 'active' });
  });

  it('a worker with no reported activity is working, and the detail says activity was not reported', () => {
    const r = row(buildTeam(snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', activity: null, latestAction: null })] }), NOW, NOW), 'w');
    expect(r.presence).toMatchObject({ state: 'working', detail: 'Activity not reported' });
  });

  it('says needs you when a worker waits on a person', () => {
    const snapshot = snapshotOf({ tasks: [task('a', { status: 'awaiting_approval' })], workers: [worker('w', { taskId: 'a', activity: 'waiting_human', blockedByApprovalId: 'ap' })], approvals: [approval('ap', { taskId: 'a' })] });
    const r = row(buildTeam(snapshot, NOW, NOW), 'w');
    expect(r.presence).toMatchObject({ state: 'needs_you', label: 'Needs you', tone: 'warning' });
  });

  it('says blocked for a policy block and for a dependency wait, never idle', () => {
    const snapshot = snapshotOf({
      tasks: [task('a'), task('b', { status: 'ready' })],
      workers: [worker('p', { taskId: 'a', activity: 'blocked_policy', stateReason: 'model_not_allowed' }), worker('d', { taskId: 'b', activity: 'waiting_dependency', blockedByTaskIds: ['a'] })],
    });
    const model = buildTeam(snapshot, NOW, NOW);
    expect(row(model, 'p').presence).toMatchObject({ state: 'blocked', label: 'Blocked', tone: 'danger' });
    expect(row(model, 'd').presence).toMatchObject({ state: 'blocked', label: 'Blocked', detail: 'Waiting on Task a' });
  });

  it('says lost when the connection is lost or the worker is offline, never working', () => {
    const silent = worker('s', { lastHeartbeatAt: iso(200), enteredStateAt: iso(300) });
    const offline = worker('o', { availability: 'offline', activity: null, leaseHeld: false, health: 'disconnected', lastHeartbeatAt: iso(100) });
    const model = buildTeam(snapshotOf({ workers: [silent, offline] }), NOW, NOW);
    expect(row(model, 's').presence).toMatchObject({ state: 'lost', label: 'Lost', tone: 'danger' });
    expect(row(model, 'o').presence).toMatchObject({ state: 'lost', label: 'Lost' });
  });

  it('says unknown when stale, and the time is how long ago it was last confirmed', () => {
    const model = buildTeam(snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', lastHeartbeatAt: iso(30) })] }), NOW, null, { stale: true, lastConfirmedMs: NOW - 5_000 });
    expect(row(model, 'w').presence).toMatchObject({ state: 'unknown', label: 'Unknown', detail: 'Last confirmed: Coding', since: '30s ago' });
  });
});

describe('team panel model', () => {
  it('counts who needs you, lists every worker in attention order, and names the task and recorded model', () => {
    const snapshot = snapshotOf({
      tasks: [task('a', { title: 'Add table' }), task('b', { status: 'awaiting_approval', title: 'Feedback API' })],
      workers: [
        worker('w1', { taskId: 'a', attemptId: 'x', assignment: { provider: 'anthropic', model: 'claude-sonnet-5-5', source: 'role' } }),
        worker('w2', { taskId: 'b', activity: 'waiting_human', blockedByApprovalId: 'ap' }),
        worker('w3', { availability: 'idle', activity: null, leaseHeld: false }),
      ],
      approvals: [approval('ap', { taskId: 'b' })],
    });
    const panel = panelOf(buildTeam(snapshot, NOW, NOW), false);
    expect(panel.needsYou).toBe(1);
    expect(panel.summary).toBe('3 workers, 1 needs you');
    expect(panel.rows.map((r) => r.workerId)).toEqual(['w2', 'w1', 'w3']);
    expect(panel.rows[1]).toMatchObject({ role: 'Backend', task: 'Add table', model: 'claude-sonnet-5-5' });
    expect(panel.rows[0]).toMatchObject({ task: 'Feedback API', model: 'Model not recorded' });
    expect(panel.rows[2]).toMatchObject({ task: 'No task', role: 'Unassigned' });
  });

  it('under a stale session the count is unknown, and the last confirmed count is kept apart from it', () => {
    const snapshot = snapshotOf({
      tasks: [task('b', { status: 'awaiting_approval' })],
      workers: [worker('w2', { taskId: 'b', activity: 'waiting_human', blockedByApprovalId: 'ap' }), worker('w3', { availability: 'idle', activity: null, leaseHeld: false })],
      approvals: [approval('ap', { taskId: 'b' })],
    });
    const panel = panelOf(buildTeam(snapshot, NOW, null, { stale: true, lastConfirmedMs: NOW - 5_000 }), true);
    expect(panel.rows.every((r) => r.state === 'unknown')).toBe(true);
    expect(panel).toMatchObject({ needsYou: null, unknown: 0, confirmedNeedsYou: 1, summary: '2 workers, who needs you is unknown (1 when last confirmed)' });
  });

  it('a worker the server reports as unknown makes only its own row unknown; the rest are counted as current', () => {
    const snapshot = snapshotOf({
      tasks: [task('b', { status: 'awaiting_approval' }), task('c')],
      workers: [worker('w2', { taskId: 'b', activity: 'waiting_human', blockedByApprovalId: 'ap', leaseHeld: false }), worker('u', { taskId: 'c', lastHeartbeatAt: iso(5) })],
      approvals: [approval('ap', { taskId: 'b' })],
    });
    // Liveness that has not refreshed recently leaves a lease holder's health unknown, with the session itself still live. A worker holding no lease is unaffected.
    const team = buildTeam(snapshot, NOW, NOW - 120_000);
    const u = team.rows.find((r) => r.workerId === 'u')!;
    expect(u.presence.state).toBe('unknown');
    const panel = panelOf(team, false);
    expect(panel).toMatchObject({ needsYou: 1, unknown: 1, summary: '2 workers, 1 needs you, 1 unknown' });
  });

  it('with nobody waiting, the summary says so rather than showing zero as a warning', () => {
    const panel = panelOf(buildTeam(snapshotOf({ workers: [worker('w', { availability: 'idle', activity: null, leaseHeld: false })] }), NOW, NOW), false);
    expect(panel).toMatchObject({ needsYou: 0, summary: '1 worker, nobody needs you' });
  });

  it('an idle worker names its last task as last, not current', () => {
    const snapshot = snapshotOf({ tasks: [task('a', { status: 'verified', title: 'Add table', activeAttemptId: null })], workers: [worker('w', { availability: 'idle', activity: null, leaseHeld: false })] });
    (snapshot as { attempts: Record<string, unknown> }).attempts['x'] = { attemptId: 'x', taskId: 'a', number: 1, fence: 1, outcome: 'succeeded', exitReason: null, runnerId: 'w', startedAt: iso(100), endedAt: iso(80), lastHeartbeatAt: null, assignment: null };
    expect(panelOf(buildTeam(snapshot, NOW, NOW), false).rows[0]).toMatchObject({ task: 'Last: Add table' });
  });
});
