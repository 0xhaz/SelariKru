import { describe, expect, it } from 'vitest';
import { applyEvent, mergeLiveness, projectionFromSnapshot, type ProjectViewEvent } from '@selarikru/view-protocol';
import { buildOverview } from './model.ts';
import { NOW, fixtureSnapshot, iso, snapshotOf, task, worker } from './testing.ts';

const criteria = (s: Parameters<typeof buildOverview>[0], now = NOW) => buildOverview(s, now, now).delivery.criteriaLabel;

describe('delivery', () => {
  it('shows "n of m criteria verified", never a percentage', () => {
    const snapshot = snapshotOf({ criteria: { verified: 2, total: 7 }, tasks: [task('a', { status: 'verified' }), task('b'), task('c'), task('d', { status: 'superseded' })] });
    const model = buildOverview(snapshot, NOW, NOW);
    expect(model.delivery.criteriaLabel).toBe('2 of 7 criteria verified');
    expect(model.delivery.criteriaNote).toBeNull();
    expect(model.delivery.segments.filter((c) => c === 'verified')).toHaveLength(2);
    expect(model.delivery.segments).toHaveLength(7);
    expect(JSON.stringify(model)).not.toMatch(/\d+\s?%/);
  });

  it('heartbeat never increments verified criteria', async () => {
    const running = snapshotOf({ criteria: { verified: 0, total: 1 }, tasks: [task('a', { activeAttemptId: 'att', status: 'running' })], workers: [worker('w', { taskId: 'a', attemptId: 'att' })] });
    running.attempts['att'] = { attemptId: 'att', taskId: 'a', number: 1, fence: 1, outcome: 'running', exitReason: null, runnerId: 'w', startedAt: iso(60), endedAt: null, lastHeartbeatAt: iso(30), assignment: null };
    expect(criteria(running)).toBe('0 of 1 criteria verified');

    // A heartbeat by event.
    const heartbeat: ProjectViewEvent = {
      schemaVersion: 1, eventId: 'e1', projectId: 'p', runId: 'run', taskId: 'a', attemptId: 'att', type: 'attempt.heartbeat', sequence: 1, aggregateRevision: 2,
      actor: { kind: 'worker', id: 'w' }, occurredAt: iso(0), receivedAt: iso(0), causationId: null, traceId: 't', payload: { fence: 1, activity: 'testing' }, provenance: 'observed',
    };
    const after = applyEvent(projectionFromSnapshot(running), heartbeat);
    expect(after.outcome).toBe('applied');
    expect(criteria(after.state.snapshot)).toBe('0 of 1 criteria verified');

    // A heartbeat by snapshot refresh, which is how they really arrive.
    const fresher = structuredClone(running);
    fresher.attempts['att']!.lastHeartbeatAt = iso(0);
    const merged = mergeLiveness(projectionFromSnapshot(running), fresher);
    expect(merged.snapshot.attempts['att']!.lastHeartbeatAt).toBe(iso(0));
    expect(criteria(merged.snapshot)).toBe('0 of 1 criteria verified');
  });

  it('falls back to tasks, with a visible qualifier, when per-criterion evidence is not connected', () => {
    const { delivery } = buildOverview(snapshotOf({ tasks: [task('a', { status: 'verified' }), task('b')] }), NOW, NOW);
    expect(delivery.criteriaLabel).toBe('1 of 2 tasks verified');
    expect(delivery.criteriaNote).toMatch(/per-criterion evidence is not connected/i);
  });

  it('counts only the run shown, not every run in the project', () => {
    const snapshot = snapshotOf({ tasks: [task('a', { status: 'verified', runId: 'old' }), task('b', { status: 'verified' }), task('c')] });
    snapshot.runs = { old: { runId: 'old', lifecycle: 'merged', planRevision: 1, latestEvidence: null, criteria: null, evidence: null, reducedScope: null, scopeAssessment: null, pinnedModel: null }, ...snapshot.runs };
    const { delivery } = buildOverview(snapshot, NOW, NOW);
    expect(delivery.criteriaLabel).toBe('1 of 2 tasks verified');
    expect(delivery.tasks.map((t) => t.taskId)).toEqual(['c', 'b']);
  });

  it('keeps budget-cancelled work in the task fallback and leaves superseded work out', () => {
    const { delivery } = buildOverview(snapshotOf({ tasks: [task('a', { status: 'verified' }), task('b', { status: 'cancelled', cancelReason: 'budget_exhausted' }), task('c', { status: 'superseded' }), task('d', { status: 'cancelled' })] }), NOW, NOW);
    expect(delivery.criteriaLabel).toBe('1 of 2 tasks verified');
    expect(delivery.segments).toHaveLength(2);
  });

  it('never marks work as filled unless it is verified', () => {
    const { delivery } = buildOverview(snapshotOf({ tasks: [task('a'), task('b', { status: 'awaiting_approval' }), task('c', { status: 'ready' })] }), NOW, NOW);
    expect(delivery.segments).not.toContain('verified');
  });

  it('leaves review items and closed tasks out of the top blocker', async () => {
    const merge = await fixtureSnapshot('merge-flow');
    expect(buildOverview(merge.snapshot, merge.nowMs, merge.nowMs).delivery.blocker).toBeNull();
    const costs = await fixtureSnapshot('unknown-costs');
    expect(buildOverview(costs.snapshot, costs.nowMs, costs.nowMs).delivery.blocker).toBeNull();
  });

  it('names the top blocker on the critical path, and says so when there is none', async () => {
    const blocked = await fixtureSnapshot('policy-block');
    expect(buildOverview(blocked.snapshot, blocked.nowMs, blocked.nowMs).delivery.blocker).toMatch(/Export restricted feedback/);
    const healthy = await fixtureSnapshot('healthy-parallel-work');
    expect(buildOverview(healthy.snapshot, healthy.nowMs, healthy.nowMs).delivery.blocker).toBeNull();
  });

  it('uses the design section 9 wording for task states', () => {
    const rows = buildOverview(snapshotOf({ tasks: [task('a', { status: 'verified' }), task('b', { status: 'superseded', supersededByRevision: 3 }), task('c', { status: 'ready' })] }), NOW, NOW).delivery.tasks;
    expect(rows.map((r) => r.statusLabel)).toEqual(['Queued', 'Verified; awaiting merge', 'Superseded by revision 3']);
  });
});

describe('fleet', () => {
  it('derives health from heartbeat age, not the stored field', () => {
    const snapshot = snapshotOf({ workers: [worker('w', { health: 'healthy', lastHeartbeatAt: iso(70) })] });
    expect(buildOverview(snapshot, NOW, NOW).fleet.rows[0]!.health).toMatchObject({ state: 'disconnected', label: 'Connection lost' });
  });

  it('reads health as unknown when our liveness data is stale', () => {
    const snapshot = snapshotOf({ workers: [worker('w', { lastHeartbeatAt: iso(70) })] });
    expect(buildOverview(snapshot, NOW, null).fleet.rows[0]!.health).toMatchObject({ state: 'unknown', label: 'Health unknown' });
  });

  it('reports a null activity as not reported, and quietly', () => {
    const [row] = buildOverview(snapshotOf({ workers: [worker('a', { activity: null })] }), NOW, NOW).fleet.rows;
    expect(row!.activity).toMatchObject({ label: 'Activity not reported', reported: false });
  });

  it('counts a loss seen at the last confirmed time, while each row still reads health unknown', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('runner-loss');
    const { fleet } = buildOverview(snapshot, nowMs + 300_000, null, { lastConfirmedMs: nowMs, stale: true });
    expect(fleet.summary.lost).toBe(1);
    expect(fleet.rows[0]!.health.state).toBe('unknown');
  });

  it('renders a null activity as unknown, and an idle worker as idle', () => {
    const rows = buildOverview(snapshotOf({ workers: [worker('a', { activity: null }), worker('b', { activity: null, availability: 'idle', leaseHeld: false })] }), NOW, NOW).fleet.rows;
    expect(rows.map((r) => r.activity.label)).toEqual(['Activity not reported', 'Idle']);
  });

  it('counts waiting separately from working, and a healthy wait is not urgent', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('human-wait');
    const { fleet } = buildOverview(snapshot, nowMs, nowMs);
    expect(fleet.summary).toEqual({ working: 1, waiting: 1, idle: 0, lost: 0 });
    expect(fleet.rows.find((r) => r.activity.label === 'Needs you')!.activity.tone).toBe('warning');
  });

  it('keeps execution and inference as separate fields', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('healthy-parallel-work');
    const rows = buildOverview(snapshot, nowMs, nowMs).fleet.rows;
    // H9 fix round 1 (H1): with coding workers off, a worker applies accepted changes with no model: its model route is none, its execution unchanged.
    expect(rows.map((r) => [r.execution, r.modelRoute])).toEqual([['local', 'none'], ['cloud', 'none']]);
  });
});

describe('usage', () => {
  it('keeps unknown unknown: an incomplete sum has no total, only a labelled lower bound', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('unknown-costs');
    const { usage } = buildOverview(snapshot, nowMs, nowMs);
    expect(usage.spend).toMatchObject({ total: null, provenance: 'unavailable', knownSubtotal: '3.74', unavailableCount: 1 });
  });

  it('reports an estimated total as estimated', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('healthy-parallel-work');
    expect(buildOverview(snapshot, nowMs, nowMs).usage.spend).toMatchObject({ total: '0.79', provenance: 'estimated' });
  });

  it('labels an unused assistant as not used, and never as a location', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('no-data');
    expect(buildOverview(snapshot, nowMs, nowMs).usage.assistant).toEqual({ requested: 'Not used yet', observed: null });
  });
});

describe('evidence', () => {
  it('lists checks and run evidence, never attempt starts or heartbeats', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('failed-ci');
    const { evidence } = buildOverview(snapshot, nowMs, nowMs);
    expect(evidence.map((e) => e.stateLabel)).toEqual(['Failed']);
    expect(evidence[0]!.summary).toBe('3 of 41 tests failed');
  });

  it('is flagged simulated when the snapshot is not observed', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('failed-ci');
    expect(buildOverview(snapshot, nowMs, nowMs).simulated).toBe(true);
    expect(buildOverview(snapshotOf({}), NOW, NOW).simulated).toBe(false);
  });
});

describe('headline and empty project', () => {
  it('says plainly how many things need the operator', async () => {
    const human = await fixtureSnapshot('human-wait');
    expect(buildOverview(human.snapshot, human.nowMs, human.nowMs).headline).toBe('1 item needs you.');
    const healthy = await fixtureSnapshot('healthy-parallel-work');
    expect(buildOverview(healthy.snapshot, healthy.nowMs, healthy.nowMs).headline).toBeNull();
  });

  it('never reassures over stale data', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('healthy-parallel-work');
    const model = buildOverview(snapshot, nowMs + 300_000, null, { lastConfirmedMs: nowMs, stale: true });
    expect(model.headline).toBe('Worker connections are unknown. Showing the last confirmed state.');
    expect(model.attentionCount).toBe('Attention unknown');
    expect(model.announcement).not.toMatch(/\b0\b/);
  });

  it('counts stale items as of the last confirmed state', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('runner-loss');
    const model = buildOverview(snapshot, nowMs + 300_000, null, { lastConfirmedMs: nowMs, stale: true });
    expect(model.headline).toBe('1 item needed you at the last confirmed state. Worker connections are unknown.');
    expect(model.attentionCount).toBe('1 item at last confirmed state');
    expect(model.attentionBadge).toBe('1?');
  });

  it('gives an aggregate count for the header', async () => {
    const blocked = await fixtureSnapshot('policy-block');
    expect(buildOverview(blocked.snapshot, blocked.nowMs, blocked.nowMs).attentionCount).toBe('2 need attention');
    const healthy = await fixtureSnapshot('healthy-parallel-work');
    expect(buildOverview(healthy.snapshot, healthy.nowMs, healthy.nowMs).attentionCount).toBeNull();
    expect(buildOverview(healthy.snapshot, healthy.nowMs, healthy.nowMs).attentionBadge).toBeNull();
    const lost = await fixtureSnapshot('runner-loss');
    expect(buildOverview(lost.snapshot, lost.nowMs, lost.nowMs).attentionCount).toBe('1 needs attention');
  });

  it('does not count Scheduler-owned waits as needing the operator', () => {
    expect(buildOverview(snapshotOf({ tasks: [task('a', { status: 'ready', placementBlock: 'no_free_slot' })] }), NOW, NOW).needsYou).toBe(0);
  });

  it('counts a budget stop on an open run: the operator chooses to fund it or accept reduced scope', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('unknown-costs');
    expect(buildOverview(snapshot, nowMs, nowMs).needsYou).toBe(1);
  });

  it('does not count information as needing the operator', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('long-build-stall');
    expect(buildOverview(snapshot, nowMs, nowMs).headline).toBeNull();
  });

  it('flags an empty project and invents nothing for it', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('no-data');
    const model = buildOverview(snapshot, nowMs, nowMs);
    expect(model.empty).toBe(true);
    expect(model.fleet.rows).toEqual([]);
    expect(model.delivery.total).toBe(0);
  });
});

describe('a snapshot shaped like the real route', () => {
  it('a budget stop with no cancel reason keeps its criteria unmet and asks for a decision', () => {
    const s = snapshotOf({ tasks: [task('a', { status: 'verified' }), task('b', { status: 'cancelled', cancelReason: null })] });
    s.runs['run'] = { ...s.runs['run']!, scopeAssessment: { notDelivered: { tasks: [], requirementIds: [], acceptanceCheckIds: [] }, notDeliveredHash: 'h', deliveredRequirementIds: [], stopped: [{ taskId: 'b', revision: 1 }], stoppingTaskIds: [] } };
    const m = buildOverview(s, NOW, NOW);
    expect(m.needsYou).toBe(1);
    expect(m.delivery.segments).toContain('held');
    expect(m.delivery.criteriaLabel).toMatch(/^1 of 2/);
  });
});
