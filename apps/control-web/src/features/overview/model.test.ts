import { describe, expect, it } from 'vitest';
import { applyEvent, mergeLiveness, projectionFromSnapshot, type ProjectViewEvent } from '@selarikru/view-protocol';
import { buildOverview } from './model.ts';
import { NOW, fixtureSnapshot, iso, snapshotOf, task, worker } from './testing.ts';

const criteria = (s: Parameters<typeof buildOverview>[0], now = NOW) => buildOverview(s, now, now).delivery.criteriaLabel;

describe('delivery', () => {
  it('shows "n of m criteria verified", never a percentage', () => {
    const snapshot = snapshotOf({ tasks: [task('a', { status: 'verified' }), task('b'), task('c'), task('d', { status: 'superseded' })] });
    const model = buildOverview(snapshot, NOW, NOW);
    expect(model.delivery.criteriaLabel).toBe('1 of 3 criteria verified');
    expect(JSON.stringify(model)).not.toMatch(/\d+\s?%/);
  });

  it('heartbeat never increments verified criteria', async () => {
    const running = snapshotOf({ tasks: [task('a', { activeAttemptId: 'att', status: 'running' })], workers: [worker('w', { taskId: 'a', attemptId: 'att' })] });
    running.attempts['att'] = { attemptId: 'att', taskId: 'a', number: 1, fence: 1, outcome: 'running', exitReason: null, runnerId: 'w', startedAt: iso(60), endedAt: null, lastHeartbeatAt: iso(30) };
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

  it('renders a null activity as unknown, and an idle worker as idle', () => {
    const rows = buildOverview(snapshotOf({ workers: [worker('a', { activity: null }), worker('b', { activity: null, availability: 'idle', leaseHeld: false })] }), NOW, NOW).fleet.rows;
    expect(rows.map((r) => r.activity.label)).toEqual(['Activity unknown', 'Idle']);
  });

  it('counts waiting separately from working, and a healthy wait is not urgent', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('human-wait');
    const { fleet } = buildOverview(snapshot, nowMs, nowMs);
    expect(fleet.summary).toEqual({ working: 1, waiting: 1, idle: 0, lost: 0 });
    expect(fleet.rows.find((r) => r.activity.label === 'Needs decision')!.activity.tone).toBe('warning');
  });

  it('keeps execution and inference as separate fields', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('healthy-parallel-work');
    const rows = buildOverview(snapshot, nowMs, nowMs).fleet.rows;
    expect(rows.map((r) => [r.execution, r.modelRoute])).toEqual([['local', 'cloud'], ['cloud', 'cloud']]);
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
    expect(buildOverview(human.snapshot, human.nowMs, human.nowMs).headline).toMatch(/^1 item needs you\. Start with /);
    const healthy = await fixtureSnapshot('healthy-parallel-work');
    expect(buildOverview(healthy.snapshot, healthy.nowMs, healthy.nowMs).headline).toBe('Nothing needs you right now.');
  });

  it('does not count information as needing the operator', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('long-build-stall');
    expect(buildOverview(snapshot, nowMs, nowMs).headline).toBe('Nothing needs you right now.');
  });

  it('flags an empty project and invents nothing for it', async () => {
    const { snapshot, nowMs } = await fixtureSnapshot('no-data');
    const model = buildOverview(snapshot, nowMs, nowMs);
    expect(model.empty).toBe(true);
    expect(model.fleet.rows).toEqual([]);
    expect(model.delivery.total).toBe(0);
  });
});
