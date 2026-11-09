import { describe, expect, it } from 'vitest';
import { effectiveWorkerHealth, type AttemptView, type TaskView, type UsageEntry } from '@selarikru/view-protocol';
import { NOW, fixtureSnapshot, iso, snapshotOf, task, worker } from '../overview/testing.ts';
import { taskTarget } from './assignments.ts';
import { classifyBlock, explain } from '../overview/attention.ts';
import { NO_FILTER, buildTeam, filterRows, sortRows, type TeamRow } from './model.ts';

const row = (model: ReturnType<typeof buildTeam>, id: string): TeamRow => model.rows.find((r) => r.workerId === id)!;
const cost = (entryId: string, quantity: string | null, provenance: 'observed' | 'estimated' | 'unavailable'): UsageEntry => ({ entryId, runId: 'run', taskId: 'a', attemptId: 'att', figure: { metric: 'cost_usd', quantity, provenance, source: 'rate_card' } });

describe('three separate signals', () => {
  it('reports activity, health and results independently', () => {
    const snapshot = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', activity: 'testing' })] });
    const r = row(buildTeam(snapshot, NOW, NOW), 'w');
    expect(r.activity).toMatchObject({ label: 'Testing', reported: true });
    expect(r.health).toMatchObject({ state: 'healthy', label: 'Healthy' });
    expect(r.results).toMatchObject({ known: false, label: 'No results yet' });
  });

  it('null activity is a single muted "Activity not reported", with no time or tool beside it', () => {
    const snapshot = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', activity: null, latestAction: null })] });
    expect(row(buildTeam(snapshot, NOW, NOW), 'w').activity).toEqual({ label: 'Activity not reported', tone: 'neutral', reported: false, stale: false, since: null, tool: null });
  });

  it('a reported tool shows as itself, once, and says nothing about planning or coding', () => {
    const snapshot = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', activity: null, latestAction: { tool: 'Edit', summary: null, longRunning: false, at: iso(1) } })] });
    expect(row(buildTeam(snapshot, NOW, NOW), 'w').activity).toMatchObject({ label: 'Using Edit', reported: true, tool: null });
  });

  it('a running check is reported as running, never as a passing result', () => {
    const snapshot = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a' })], checks: { c: { checkId: 'c', taskId: 'a', state: 'running', summary: 'lint', updatedAt: iso(2), evidenceRef: 'e' } } });
    expect(row(buildTeam(snapshot, NOW, NOW), 'w').results).toMatchObject({ known: true, label: 'Check running', tone: 'active' });
  });

  it('a healthy heartbeat is not a result and a failed check is not a health problem', () => {
    const snapshot = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a' })], checks: { c: { checkId: 'c', taskId: 'a', state: 'failed', summary: '3 of 41 failed', updatedAt: iso(2), evidenceRef: 'e' } } });
    const r = row(buildTeam(snapshot, NOW, NOW), 'w');
    expect(r.health.state).toBe('healthy');
    expect(r.results).toMatchObject({ known: true, label: 'Failed', tone: 'danger', detail: '3 of 41 failed' });
  });
});

describe('health goes only through effectiveWorkerHealth', () => {
  it('derives disconnected from a silent heartbeat even when the stored health says healthy', () => {
    const w = worker('w', { taskId: 'a', health: 'healthy', lastHeartbeatAt: iso(70) });
    expect(effectiveWorkerHealth(w, NOW, NOW).health).toBe('disconnected');
    expect(row(buildTeam(snapshotOf({ tasks: [task('a')], workers: [w] }), NOW, NOW), 'w').health.state).toBe('disconnected');
  });

  it('does not call a worker with no lease healthy: there is no heartbeat to say so', () => {
    const r = row(buildTeam(snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', leaseHeld: false, activity: 'waiting_human' })] }), NOW, NOW), 'w');
    expect(r.health).toMatchObject({ state: 'no_lease', label: 'No active attempt', tone: 'neutral' });
    expect(r.health.label).not.toMatch(/healthy/i);
  });

  it('a session that is not live cannot call any worker healthy', () => {
    const snapshot = snapshotOf({ tasks: [task('a')], workers: [worker('held', { taskId: 'a' }), worker('free', { leaseHeld: false, activity: null, availability: 'idle' })] });
    const model = buildTeam(snapshot, NOW, null, { stale: true, lastConfirmedMs: NOW - 5_000 });
    expect(model.rows.map((r) => r.health.state)).toEqual(['unknown', 'unknown']);
    expect(model.rows.every((r) => r.stale)).toBe(true);
    expect(model.stale).toBe(true);
  });
});

describe('location axes', () => {
  it('keeps execution and model route independent for every pairing', () => {
    const workers = (['local', 'cloud'] as const).flatMap((execution) => (['device', 'cloud', 'unknown'] as const).map((modelRoute) => worker(`${execution}-${modelRoute}`, { execution, modelRoute })));
    const model = buildTeam(snapshotOf({ workers }), NOW, NOW);
    for (const w of workers) expect(row(model, w.workerId)).toMatchObject({ execution: w.execution, modelRoute: w.modelRoute });
  });
});

describe('stale and disconnected workers', () => {
  it('keeps the last confirmed activity, labels it stale, and says when it was confirmed', () => {
    const lastHeartbeatAt = iso(70);
    const r = row(buildTeam(snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', activity: 'coding', lastHeartbeatAt })] }), NOW, NOW), 'w');
    expect(r.stale).toBe(true);
    expect(r.lastConfirmedAt).toBe(lastHeartbeatAt);
    expect(r.activity).toMatchObject({ label: 'Coding', stale: true, tone: 'neutral' });
    expect(r.task?.title).toBe('Task a');
    expect(r.health.label).toBe('Connection lost');
  });

  it('falls back to when the state began if no heartbeat was ever recorded', () => {
    const r = row(buildTeam(snapshotOf({ workers: [worker('w', { lastHeartbeatAt: null, health: 'disconnected', availability: 'offline', leaseHeld: false, enteredStateAt: iso(90) })] }), NOW, NOW), 'w');
    expect(r.lastConfirmedAt).toBe(iso(90));
  });

  it('a runner loss fixture keeps the worker, the task and its last reported tool, and invents nothing newer', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('runner-loss');
    const r = row(buildTeam(snapshot, nowMs, nowMs), 'runner_local_1');
    expect(r.health.state).toBe('disconnected');
    expect(r.stale).toBe(true);
    expect(r.activity).toMatchObject({ label: 'Using Edit', reported: true, stale: true });
    expect(r.task?.title).toBe('Feedback API');
  });
});

describe('results come from recorded evidence', () => {
  it('an idle worker keeps the verdict of the work it last did, naming that task', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('unknown-costs');
    const r = row(buildTeam(snapshot, nowMs, nowMs), 'runner_cloud_1');
    expect(r.task).toBeNull();
    expect(r.lastTask?.title).toBe('Feedback list UI');
    expect(r.results).toMatchObject({ known: true, label: 'Passed', detail: 'Feedback list UI: all checks passed' });
  });

  it('finished work with no verdict says it is unverified', () => {
    const snapshot = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', latestEvidence: { kind: 'attempt.completed', ref: 'e', at: iso(3) } })] });
    expect(row(buildTeam(snapshot, NOW, NOW), 'w').results).toMatchObject({ known: true, label: 'Not verified yet', tone: 'neutral' });
  });
});

describe('usage', () => {
  it('shows spend with its provenance and treats unavailable as unknown, never zero', () => {
    const base = { tasks: [task('a')], workers: [worker('w', { taskId: 'a' })] };
    const spend = (usage: UsageEntry[]) => row(buildTeam({ ...snapshotOf(base), usage }, NOW, NOW), 'w').spend;
    expect(spend([])).toBeNull();
    expect(spend([cost('1', '0.42', 'estimated')])).toEqual({ value: '$0.42', provenance: 'estimated', note: null });
    expect(spend([cost('1', '0.42', 'observed')])).toEqual({ value: '$0.42', provenance: 'observed', note: null });
    expect(spend([cost('1', '1.24', 'estimated'), cost('2', null, 'unavailable')])).toEqual({ value: 'Unavailable', provenance: 'unavailable', note: 'At least $1.24 known' });
    expect(spend([cost('1', null, 'unavailable')])).toEqual({ value: 'Unavailable', provenance: 'unavailable', note: null });
  });

  it('lists each figure in the drawer with its source, and an unavailable figure stays unavailable', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('unknown-costs');
    const figures = row(buildTeam(snapshot, nowMs, nowMs), 'runner_cloud_1').detail.usage;
    const spend = figures.find((f) => f.metric === 'Model spend')!;
    expect(spend).toMatchObject({ value: 'Unavailable', provenance: 'unavailable', source: 'harness_report' });
    expect(JSON.stringify(figures)).not.toContain('$0');
  });
});

describe('fleet order and filters', () => {
  const snapshot = snapshotOf({
    tasks: [task('a', { role: 'backend', title: 'Zebra' }), task('b', { role: 'frontend', title: 'Apple' }), task('c', { role: 'backend', title: 'Mango' })],
    workers: [
      worker('calm', { taskId: 'a', execution: 'local', latestAction: { tool: 't', summary: null, longRunning: false, at: iso(1) } }),
      worker('decide', { taskId: 'b', execution: 'cloud', activity: 'waiting_human', leaseHeld: false, blockedByApprovalId: 'x', enteredStateAt: iso(20) }),
      worker('lost', { taskId: 'c', execution: 'unknown', lastHeartbeatAt: iso(120), enteredStateAt: iso(200) }),
    ],
  });
  const model = buildTeam(snapshot, NOW, NOW);
  const ids = (rows: readonly TeamRow[]) => rows.map((r) => r.workerId);

  it('sorts by attention by default, with lost work above a decision above ordinary work', () => {
    expect(ids(model.rows)).toEqual(['lost', 'decide', 'calm']);
  });

  it('sorts by role, task, runtime and last progress', () => {
    expect(ids(sortRows(model.rows, 'task'))).toEqual(['decide', 'lost', 'calm']);
    expect(ids(sortRows(model.rows, 'role'))).toEqual(['calm', 'lost', 'decide']);
    expect(ids(sortRows(model.rows, 'runtime'))).toEqual(['decide', 'calm', 'lost']);
    expect(ids(sortRows(model.rows, 'progress'))).toEqual(['calm', 'decide', 'lost']);
  });

  it('filters by runtime, role and blockers', () => {
    expect(ids(filterRows(model.rows, { provider: 'all', runtime: 'cloud', role: 'all', run: 'all', blockedOnly: false }))).toEqual(['decide']);
    expect(ids(filterRows(model.rows, { provider: 'all', runtime: 'all', role: 'backend', run: 'all', blockedOnly: false }))).toEqual(['lost', 'calm']);
    expect(ids(filterRows(model.rows, { provider: 'all', runtime: 'all', role: 'all', run: 'all', blockedOnly: true }))).toEqual(['decide']);
  });

  it('counts blockers from approvals, dependencies and placement', () => {
    const blocked = snapshotOf({ tasks: [task('a', { placementBlock: 'policy_denied:x' })], workers: [worker('w', { taskId: 'a', blockedByApprovalId: 'x', blockedByTaskIds: ['b', 'c'] })] });
    expect(row(buildTeam(blocked, NOW, NOW), 'w').blockers).toBe(4);
  });
});

describe('inspector detail', () => {
  it('names the blocking approval and dependency in plain words', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('human-wait');
    const r = row(buildTeam(snapshot, nowMs, nowMs), 'runner_local_1');
    expect(r.detail.blockers[0]).toMatchObject({ kind: 'Waiting on a person' });
    expect(r.detail.blockers[0]!.text).toContain('Worker-supplied reason: Backfilling rewrites');
    expect(r.detail.permissions).toHaveLength(1);
    expect(r.detail.permissions[0]).toMatchObject({ state: 'Pending', reasonCode: 'Backfilling rewrites every row of the feedback table.' });
  });

  it('dependencies are listed by name and unknown dependencies stay unknown', () => {
    const known = snapshotOf({ tasks: [task('a', { dependsOn: ['b'] }), task('b', { title: 'Contract', status: 'ready' })], workers: [worker('w', { taskId: 'a' })] });
    expect(row(buildTeam(known, NOW, NOW), 'w').detail.task!.dependencies).toEqual([{ taskId: 'b', title: 'Contract', status: 'Queued' }]);
    const unknown = snapshotOf({ tasks: [task('a', { dependsOn: null })], workers: [worker('w', { taskId: 'a' })] });
    expect(row(buildTeam(unknown, NOW, NOW), 'w').detail.task!.dependencies).toBeNull();
  });

  it('builds a newest-first timeline from recorded facts and never includes heartbeats', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('failed-ci', 40_000);
    const timeline = row(buildTeam(snapshot, nowMs, nowMs), 'runner_local_1').detail.timeline;
    const times = timeline.map((e) => e.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(timeline.some((e) => /Check failed/.test(e.label))).toBe(true);
    expect(timeline.some((e) => /heartbeat/i.test(e.label))).toBe(false);
  });

  it('a summary says what is happening in plain language', () => {
    const summary = (over: Parameters<typeof worker>[1], tasks = [task('a')]) => row(buildTeam(snapshotOf({ tasks, workers: [worker('w', { taskId: 'a', ...over })] }), NOW, NOW), 'w').detail.summary;
    expect(summary({ lastHeartbeatAt: iso(45) })).toBe('Connected; no progress event for 45s');
    expect(summary({ lastHeartbeatAt: iso(70) })).toBe('Connection lost 1m 10s ago');
    expect(summary({ activity: 'testing', latestAction: { tool: 'vitest', summary: 'unit suite', longRunning: true, at: iso(1) } })).toBe('Testing: vitest, unit suite');
    expect(summary({ activity: null })).toBe('Assigned to Task a; activity not reported');
  });

  it('never claims Device for an unknown route, in the summary or anywhere else', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('unknown-costs');
    const r = row(buildTeam(snapshot, nowMs, nowMs), 'runner_cloud_1');
    expect(r.modelRoute).toBe('unknown');
    expect(JSON.stringify(r)).not.toMatch(/device/i);
  });
});

describe('team as a whole', () => {
  it('has no rows and no invented roster for an empty project', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('no-data');
    const model = buildTeam(snapshot, nowMs, nowMs);
    expect(model.rows).toEqual([]);
    expect(model.summary).toBeNull();
  });

  it('summarises the fleet and says the slot limit is not reported', () => {
    const model = buildTeam(snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a' }), worker('i', { availability: 'idle', activity: null, leaseHeld: false })] }), NOW, NOW);
    expect(model.summary).toBe('2 workers seen: 1 assigned, 1 idle.');
  });

  it('marks the summary as last confirmed when stale', () => {
    const model = buildTeam(snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a' })] }), NOW, null, { stale: true, lastConfirmedMs: NOW - 5_000 });
    expect(model.summary).toBe('Last confirmed: 1 worker seen: 1 assigned.');
  });

  it('marks simulated data so it never reads as evidence', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('healthy-parallel-work');
    expect(buildTeam(snapshot, nowMs, nowMs).simulated).toBe(true);
  });
});

const attemptOf = (id: string, over: Partial<AttemptView> = {}): AttemptView => ({ attemptId: id, taskId: 'a', number: 1, fence: 1, outcome: 'running', exitReason: null, runnerId: 'w', startedAt: iso(30), endedAt: null, lastHeartbeatAt: iso(5), assignment: null, ...over });
const check = (id: string, state: 'running' | 'passed' | 'failed', secondsAgo: number, summary: string) => ({ checkId: id, taskId: 'a', state, summary, updatedAt: iso(secondsAgo), evidenceRef: `ev-${id}` });

describe('fix round 1: blockers have one path', () => {
  const policyBlocked = () => worker('w', { taskId: null, availability: 'idle', activity: 'blocked_policy', leaseHeld: false, stateReason: 'policy_denied:restricted_data_cloud_destination' });

  it('a policy-blocked worker counts as blocked and shows under Blocked only', () => {
    const model = buildTeam(snapshotOf({ workers: [policyBlocked()] }), NOW, NOW);
    expect(row(model, 'w').blockers).toBe(1);
    expect(row(model, 'w').detail.blockers).toHaveLength(1);
    expect(row(model, 'w').detail.blockers[0]).toMatchObject({ kind: 'Blocked by policy' });
    expect(filterRows(model.rows, { provider: 'all', runtime: 'all', role: 'all', run: 'all', blockedOnly: true })).toHaveLength(1);
  });

  it('the row count always equals the drawer list', async () => {
    for (const id of ['human-wait', 'policy-block', 'contract-change', 'unknown-costs'] as const) {
      const { snapshot, nowMs } = await fixtureSnapshot(id);
      for (const r of buildTeam(snapshot, nowMs, nowMs).rows) expect(r.blockers).toBe(r.detail.blockers.length);
    }
  });

  it('an idle worker does not inherit a placement block from a task it no longer holds', () => {
    const snapshot = snapshotOf({ tasks: [task('a', { placementBlock: 'policy_denied:x' })], workers: [worker('w', { taskId: null, attemptId: null, availability: 'idle', activity: null, leaseHeld: false })] });
    snapshot.attempts['att'] = attemptOf('att', { outcome: 'failed', endedAt: iso(10) });
    const r = row(buildTeam(snapshot, NOW, NOW), 'w');
    expect(r.lastTask?.taskId).toBe('a');
    expect(r.blockers).toBe(0);
    expect(r.detail.blockers).toEqual([]);
  });
});

describe('fix round 1: last confirmed never predates the state it confirms', () => {
  const at = (over: Parameters<typeof worker>[1]) => row(buildTeam(snapshotOf({ workers: [worker('w', over)] }), NOW, NOW), 'w').lastConfirmedAt;

  it('a no-lease worker that is still reachable uses the later of heartbeat and state entry', () => {
    expect(at({ leaseHeld: false, availability: 'idle', activity: null, lastHeartbeatAt: iso(100), enteredStateAt: iso(20) })).toBe(iso(20));
    expect(at({ leaseHeld: false, availability: 'idle', activity: null, lastHeartbeatAt: iso(10), enteredStateAt: iso(20) })).toBe(iso(10));
  });

  it('a lease holder keeps its heartbeat time', () => {
    expect(at({ leaseHeld: true, lastHeartbeatAt: iso(25), enteredStateAt: iso(10) })).toBe(iso(25));
  });

  it('a lost worker keeps its heartbeat: the reaper entering the state confirms nothing about the worker', () => {
    expect(at({ leaseHeld: false, availability: 'offline', health: 'disconnected', activity: null, lastHeartbeatAt: iso(100), enteredStateAt: iso(20) })).toBe(iso(100));
  });

  it('holds on the fixtures the review measured', async () => {
    for (const id of ['human-wait', 'unknown-costs'] as const) {
      const { snapshot, nowMs } = await fixtureSnapshot(id);
      for (const w of Object.values(snapshot.workers)) {
        if (w.leaseHeld) continue;
        expect(Date.parse(row(buildTeam(snapshot, nowMs, nowMs), w.workerId).lastConfirmedAt)).toBeGreaterThanOrEqual(Date.parse(w.enteredStateAt));
      }
    }
  });
});

describe('fix round 1: a result says only what still holds', () => {
  const results = (t: Partial<TaskView>, checks: ReturnType<typeof check>[], attempt: Partial<AttemptView> = {}) => {
    const snapshot = snapshotOf({ tasks: [task('a', t)], workers: [worker('w', { taskId: 'a', attemptId: 'att' })], checks: Object.fromEntries(checks.map((c) => [c.checkId, c])) });
    snapshot.attempts['att'] = attemptOf('att', attempt);
    return row(buildTeam(snapshot, NOW, NOW), 'w');
  };

  it('a passed check on a reopened task is no longer green', () => {
    const r = results({ status: 'verifying', latestEvidence: { kind: 'task.reopened', ref: 'e', at: iso(2) } }, [check('c', 'passed', 10, 'ok')]);
    expect(r.results).toMatchObject({ label: 'Passed earlier; task now reopened', tone: 'neutral' });
    expect(r.detail.checks[0]).toMatchObject({ label: 'Passed earlier; task now reopened', tone: 'neutral' });
  });

  it('a passed check on a superseded task names that', () => {
    const r = results({ status: 'superseded', supersededByRevision: 2 }, [check('c', 'passed', 10, 'ok')]);
    expect(r.results.label).toBe('Passed earlier; task now superseded by revision 2');
    expect(r.results.tone).toBe('neutral');
  });

  it('stays Passed on a verified or merged task', () => {
    for (const status of ['verified', 'merged'] as const) expect(results({ status }, [check('c', 'passed', 10, 'ok')]).results).toMatchObject({ label: 'Passed', tone: 'success' });
  });

  it('marks a check older than the current attempt as earlier', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('failed-ci', 70_000);
    const r = row(buildTeam(snapshot, nowMs, nowMs), 'runner_local_1');
    expect(r.results).toMatchObject({ label: 'Failed earlier', tone: 'neutral' });
    expect(r.results.detail).toContain('Before attempt 2');
    expect(r.results.detail).toContain('3 of 41 tests failed');
    expect(r.detail.checks[0]).toMatchObject({ label: 'Failed earlier', tone: 'neutral' });
  });

  it('a newer pass does not mask a failed sibling from the same attempt', () => {
    expect(results({ status: 'verified' }, [check('new', 'passed', 5, 'lint ok'), check('old', 'failed', 15, 'unit failed')]).results).toMatchObject({ label: 'Failed', tone: 'danger', detail: 'unit failed' });
  });

  it('a pass beside a failure from before this attempt is not a bare Passed', () => {
    expect(results({ status: 'verified' }, [check('new', 'passed', 5, 'lint ok'), check('old', 'failed', 60, 'unit failed')]).results).toMatchObject({ label: 'Passed; an earlier check failed', tone: 'warning' });
  });
});

describe('fix round 1: wording and scope', () => {
  it('filters by run and lists the runs seen', () => {
    const model = buildTeam(snapshotOf({ tasks: [task('a'), task('b', { runId: 'run-2' })], workers: [worker('x', { taskId: 'a' }), worker('y', { taskId: 'b' })] }), NOW, NOW);
    expect(model.runs).toEqual(['run', 'run-2']);
    expect(filterRows(model.rows, { provider: 'all', runtime: 'all', role: 'all', run: 'run-2', blockedOnly: false }).map((r) => r.workerId)).toEqual(['y']);
  });

  it('explains how an attempt ended, with no raw code in the default tab', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('human-wait');
    expect(row(buildTeam(snapshot, nowMs, nowMs), 'runner_local_1').detail.task!.attempt).toBe('Attempt 1, interrupted. Approval requested.');
  });

  it('lists only real results as artifacts', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('healthy-parallel-work');
    expect(row(buildTeam(snapshot, nowMs, nowMs), 'runner_local_1').detail.artifacts).toEqual([]);
  });

  it('mentions the slot limit only when a worker is waiting for capacity', () => {
    const waiting = buildTeam(snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', activity: 'waiting_resource' })] }), NOW, NOW);
    expect(waiting.summary).toBe('1 worker seen: 1 waiting. Slot limit not reported.');
  });
});

describe('model assignment', () => {
  const emptyCatalog = { status: 'none' as const, detail: 'No runner has reported an installed harness.', projectDefault: null, providers: [] };

  it('assignment is recorded on the attempt and shown on the inference badge', () => {
    const w = worker('w', { taskId: 'a', attemptId: 'att', assignment: { provider: 'anthropic', model: 'claude-opus-5-5', source: 'role' }, modelRoute: 'cloud', execution: 'local' });
    const model = buildTeam(snapshotOf({ tasks: [task('a')], workers: [w] }), NOW, NOW);
    expect(row(model, 'w')).toMatchObject({ execution: 'local', modelRoute: 'cloud', assignment: { model: 'claude-opus-5-5' } });
  });

  it('a worker with no record is unknown for both route and provider, and never Device', () => {
    const w = worker('w', { taskId: 'a', attemptId: 'att', modelRoute: 'unknown', assignment: null });
    const model = buildTeam(snapshotOf({ tasks: [task('a')], workers: [w] }), NOW, NOW);
    expect(row(model, 'w')).toMatchObject({ modelRoute: 'unknown', assignment: null });
    expect(model.providers).toEqual([{ value: 'unknown', label: 'Not recorded' }]);
  });

  it('an idle worker\'s model is labelled as the previous attempt\'s', () => {
    const recorded = { provider: 'anthropic', model: 'claude-opus-5-5', source: 'role' as const };
    const idle = worker('w', { availability: 'idle', taskId: null, attemptId: null, assignment: recorded });
    expect(row(buildTeam(snapshotOf({ workers: [idle] }), NOW, NOW), 'w').modelDetail).toBe('claude-opus-5-5 (previous attempt)');
    const busy = worker('w', { taskId: 'a', attemptId: 'att', assignment: recorded });
    expect(row(buildTeam(snapshotOf({ tasks: [task('a')], workers: [busy] }), NOW, NOW), 'w').modelDetail).toBe('claude-opus-5-5');
  });

  it('a restricted task on a cloud model says plainly that it cannot run', () => {
    const code = 'restricted_requires_device_model:anthropic/claude-sonnet-5-5';
    expect(explain(code)).toMatch(/Only cloud models are available now, so this task cannot run/);
    expect(classifyBlock(code)).toBe('policy');
    expect(classifyBlock('model_not_on_runner:anthropic/x')).toBe('blocked');
  });

  it('filters by provider, and keeps the workers with no record behind Not recorded', () => {
    const a = worker('a1', { taskId: 'a', attemptId: 'x', assignment: { provider: 'anthropic', model: 'claude-sonnet-5-5', source: 'role' } });
    const none = worker('b1', { taskId: 'b', attemptId: 'y', assignment: null });
    const model = buildTeam(snapshotOf({ tasks: [task('a'), task('b')], workers: [a, none] }), NOW, NOW);
    expect(filterRows(model.rows, { ...NO_FILTER, provider: 'anthropic' }).map((r) => r.workerId)).toEqual(['a1']);
    expect(filterRows(model.rows, { ...NO_FILTER, provider: 'unknown' }).map((r) => r.workerId)).toEqual(['b1']);
    expect(filterRows(model.rows, NO_FILTER)).toHaveLength(2);
  });

  it('says so when no provider can be detected, and offers nothing', () => {
    const snap = { ...snapshotOf({ tasks: [task('a', { role: 'backend' })] }), modelCatalog: emptyCatalog };
    const { assignments } = buildTeam(snap, NOW, NOW);
    expect(assignments).toMatchObject({ available: false, statusText: emptyCatalog.detail, providers: [] });
  });

  it('never offers a provider the adapter did not declare, and marks policy refusals', () => {
    const snap = { ...snapshotOf({ tasks: [task('a', { role: 'backend' })] }), modelCatalog: { status: 'detected' as const, detail: null, projectDefault: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, providers: [{ provider: 'anthropic', label: 'Claude', harnessVersion: '2.1.316', models: [{ modelId: 'claude-sonnet-5-5', label: 'Sonnet 5.5', route: 'cloud' as const, allowedByPolicy: true, policyReason: null }, { modelId: 'claude-opus-5-5', label: 'Opus 5.5', route: 'cloud' as const, allowedByPolicy: false, policyReason: 'model_not_allowed' }] }] } };
    const { assignments } = buildTeam(snap, NOW, NOW);
    expect(assignments.available).toBe(true);
    expect(assignments.providers.map((p) => p.provider)).toEqual(['anthropic']);
    expect(assignments.providers[0]!.models[1]).toMatchObject({ allowed: false, refusal: expect.stringMatching(/Policy does not allow/) });
    expect(assignments.roles).toEqual([expect.objectContaining({ scope: 'role', key: 'backend', current: null, revision: 0, fallback: 'Using the project default: Sonnet 5.5', inherited: { provider: 'anthropic', model: 'claude-sonnet-5-5' } })]);
  });

  it('a removed assignment keeps its revision for the next change', () => {
    const snap = { ...snapshotOf({ tasks: [task('a', { role: 'backend' })] }), modelAssignments: [{ scope: 'role' as const, key: 'backend', provider: null, model: null, revision: 3, updatedBy: 'o', updatedAt: iso(9) }] };
    expect(buildTeam(snap, NOW, NOW).assignments.roles[0]).toMatchObject({ current: null, revision: 3 });
  });

  it('a task that can take no more attempts offers no override; a trial shows its pin', () => {
    const base = snapshotOf({ tasks: [task('a', { status: 'merged' }), task('b')] });
    expect(taskTarget(base.tasks['a']!, base)).toBeNull();
    const trial = { ...base, runs: { run: { ...base.runs['run']!, pinnedModel: { provider: 'anthropic', model: 'claude-sonnet-5-5' } } } };
    expect(taskTarget(trial.tasks['b']!, trial)).toMatchObject({ pinned: { provider: 'anthropic' } });
  });
});
