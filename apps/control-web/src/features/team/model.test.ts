import { describe, expect, it } from 'vitest';
import { effectiveWorkerHealth, type UsageEntry } from '@selarikru/view-protocol';
import { NOW, fixtureSnapshot, iso, snapshotOf, task, worker } from '../overview/testing.ts';
import { buildTeam, filterRows, sortRows, type TeamRow } from './model.ts';

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
    const snapshot = snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a', activity: null, latestAction: { tool: 'npm', summary: null, longRunning: false, at: iso(1) } })] });
    expect(row(buildTeam(snapshot, NOW, NOW), 'w').activity).toEqual({ label: 'Activity not reported', tone: 'neutral', reported: false, stale: false, since: null, tool: null });
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
    expect(r.health).toMatchObject({ state: 'no_lease', tone: 'neutral' });
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

  it('a runner loss fixture keeps the worker and task, and invents no activity', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('runner-loss');
    const r = row(buildTeam(snapshot, nowMs, nowMs), 'runner_local_1');
    expect(r.health.state).toBe('disconnected');
    expect(r.stale).toBe(true);
    expect(r.activity).toMatchObject({ label: 'Activity not reported', reported: false });
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
    expect(ids(filterRows(model.rows, { runtime: 'cloud', role: 'all', blockedOnly: false }))).toEqual(['decide']);
    expect(ids(filterRows(model.rows, { runtime: 'all', role: 'backend', blockedOnly: false }))).toEqual(['lost', 'calm']);
    expect(ids(filterRows(model.rows, { runtime: 'all', role: 'all', blockedOnly: true }))).toEqual(['decide']);
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
    expect(r.detail.blockers[0]!.text).toContain('Allow documentation domain');
    expect(r.detail.permissions).toHaveLength(1);
    expect(r.detail.permissions[0]).toMatchObject({ state: 'Pending', reasonCode: 'allow_documentation_domain' });
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
    expect(summary({ lastHeartbeatAt: iso(45) })).toBe('Connected; no heartbeat for 45s');
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
    expect(model.summary).toBe('2 workers seen: 1 assigned, 1 idle. Slot limit not reported.');
  });

  it('marks the summary as last confirmed when stale', () => {
    const model = buildTeam(snapshotOf({ tasks: [task('a')], workers: [worker('w', { taskId: 'a' })] }), NOW, null, { stale: true, lastConfirmedMs: NOW - 5_000 });
    expect(model.summary).toBe('Last confirmed: 1 worker seen: 1 assigned. Slot limit not reported.');
  });

  it('marks simulated data so it never reads as evidence', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('healthy-parallel-work');
    expect(buildTeam(snapshot, nowMs, nowMs).simulated).toBe(true);
  });
});
