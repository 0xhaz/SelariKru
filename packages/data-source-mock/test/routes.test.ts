import { describe, expect, it } from 'vitest';
import { ProjectViewSnapshotSchema, type ProjectViewEvent, type ProjectViewSnapshot } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime, scoped } from '../src/index.ts';

const setup = async () => {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  const f = buildFixture('feature-delivery');
  const first = await ds.getSnapshot(f.projectId);
  const events: ProjectViewEvent[] = [];
  ds.subscribe(f.projectId, first.meta.cursor, (e) => events.push(e), () => undefined);
  return { ds, projectId: f.projectId, runId: Object.keys(first.runs)[0]!, events, snap: (): Promise<ProjectViewSnapshot> => ds.getSnapshot(f.projectId) };
};
const id = (local: string) => scoped('feature-delivery', local);
const report = (over: Record<string, unknown> = {}) => ({
  kind: 'route' as const, requestId: 'req-demo-1', stepKind: 'patch' as const, callOverride: null, requestedMode: 'PREFER_ON_DEVICE' as const, observedSource: 'ON_DEVICE' as const, status: 'ok' as const,
  model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 640, firstOutputMs: null }, validation: 'passed' as const, blockedReason: null, ...over,
});

describe('mock route policy', () => {
  it('the demo shows all four modes, one locked task, one fallback and one unknown source', async () => {
    const { snap, runId } = await setup();
    const s = await snap();
    expect(ProjectViewSnapshotSchema.safeParse(s).success).toBe(true);
    const routes = Object.values(s.tasks).map((t) => t.route!);
    expect(routes.every((r) => r !== undefined)).toBe(true);
    expect(new Set(routes.map((r) => r.effective))).toEqual(new Set(['ONLY_ON_DEVICE', 'PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD']));
    const locked = routes.filter((r) => r.lock !== null);
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ effective: 'ONLY_ON_DEVICE', source: 'lock', suggestion: { rule: 'restricted', locked: true } });
    expect(routes.filter((r) => r.lastObserved?.fellBack === true)).toHaveLength(1);
    expect(routes.filter((r) => r.lastObserved?.observedSource === 'UNKNOWN')).toHaveLength(1);
    expect(routes.every((r) => r.lastObserved === null || r.lastObserved.reportedBy === 'browser')).toBe(true);
    expect(s.runs[runId]!.routePolicy).toEqual({ value: 'PREFER_ON_DEVICE', origin: 'onboarding', revision: 0 });
    // A task without an override shows the run default and its suggestion.
    const plain = routes.find((r) => r.source === 'run')!;
    expect(plain).toMatchObject({ effective: 'PREFER_ON_DEVICE', override: null });
    expect(plain.suggestion.reason.length).toBeGreaterThan(10);
  });

  it('a task override is a task setting, the locked task refuses a cloud mode, and the run default moves every task without one', async () => {
    const { ds, projectId, runId, snap, events } = await setup();
    const r = await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'o1', args: { projectId, key: id('search'), change: { scope: 'task', field: 'route_override', value: 'ONLY_IN_CLOUD' } } });
    expect(r).toMatchObject({ accepted: true, execution: 'applied', simulated: true });
    expect((await snap()).tasks[id('search')]!.route).toMatchObject({ effective: 'ONLY_IN_CLOUD', source: 'task', overrideRevision: 1 });
    expect(events.find((e) => e.type === 'settings.changed')).toMatchObject({ actor: { kind: 'human' }, payload: { scope: 'task', key: id('search'), field: 'route_override' } });
    expect(await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'o2', args: { projectId, key: id('e2e'), change: { scope: 'task', field: 'route_override', value: 'PREFER_ON_DEVICE' } } }))
      .toMatchObject({ accepted: false, rejection: 'route_locked_restricted' });
    expect(await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'o3', args: { projectId, key: runId, change: { scope: 'run', field: 'route_policy', value: 'PREFER_IN_CLOUD' } } })).toMatchObject({ accepted: true });
    const s = await snap();
    expect(s.runs[runId]!.routePolicy).toEqual({ value: 'PREFER_IN_CLOUD', origin: 'setting', revision: 1 });
    expect(s.tasks[id('review')]!.route).toMatchObject({ effective: 'PREFER_IN_CLOUD', source: 'run' });
    expect(s.tasks[id('e2e')]!.route).toMatchObject({ effective: 'ONLY_ON_DEVICE', source: 'lock' });
  });

  it('the locked task is not one headed to a cloud worker', async () => {
    const { snap } = await setup();
    const s = await snap();
    const locked = Object.values(s.tasks).filter((t) => t.route?.lock);
    expect(locked.map((t) => t.taskId)).toEqual([id('e2e')]);
    expect(locked[0]!.placementBlock).toBeNull();
    expect(Object.values(s.workers).some((w) => w.taskId === id('e2e') && w.execution === 'cloud')).toBe(false);
  });

  it('getTaskRoute reads the route fresh with its whole history, newest first', async () => {
    const { ds, projectId } = await setup();
    const before = await ds.getTaskRoute!(projectId, id('web'));
    expect(before).toMatchObject({ taskId: id('web'), route: { effective: 'PREFER_ON_DEVICE' } });
    expect(before.records).toHaveLength(1);
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'h1', args: { projectId, taskId: id('web'), report: report({ requestId: 'req-h1' }) } });
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'h2', args: { projectId, taskId: id('web'), report: report({ requestId: 'req-h2' }) } });
    const after = await ds.getTaskRoute!(projectId, id('web'));
    expect(after.records.map((r) => r.requestId)).toEqual(['req-h2', 'req-h1', before.records[0]!.requestId]);
    await expect(ds.getTaskRoute!(projectId, 'nope')).rejects.toThrow();
  });

  it('a replay of any earlier request is the same record, not only of the latest', async () => {
    const { ds, projectId, events } = await setup();
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'a', args: { projectId, taskId: id('web'), report: report({ requestId: 'req-a' }) } });
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'b', args: { projectId, taskId: id('web'), report: report({ requestId: 'req-b' }) } });
    expect(await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'c', args: { projectId, taskId: id('web'), report: report({ requestId: 'req-a' }) } })).toMatchObject({ accepted: true, replayed: true });
    expect((await ds.getTaskRoute!(projectId, id('web'))).records).toHaveLength(3);
    expect(events.filter((e) => e.type === 'inference.reported')).toHaveLength(2);
  });

  it('a locked override shows as locked in the settings list, never contradicting the route', async () => {
    const { ds, projectId, snap } = await setup();
    // Saved device only is not overridden; the lock overrides nothing it allows.
    await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'd', args: { projectId, key: id('e2e'), change: { scope: 'task', field: 'route_override', value: 'ONLY_ON_DEVICE' } } });
    expect((await snap()).settings.find((x) => x.key === id('e2e'))).toMatchObject({ state: 'applied', effective: 'ONLY_ON_DEVICE' });
    await ds.execute({ command: 'setting.set', expectedRevision: 1, idempotencyKey: 'e', args: { projectId, key: id('e2e'), change: { scope: 'task', field: 'route_override', value: null } } });
    expect((await snap()).settings.find((x) => x.key === id('e2e'))).toMatchObject({ state: 'locked', effective: 'ONLY_ON_DEVICE' });
  });

  it('a reported route record becomes the last observed source, worked out like the server', async () => {
    const { ds, projectId, snap, events } = await setup();
    const r = await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'r1', args: { projectId, taskId: id('review'), report: report({ observedSource: 'IN_CLOUD' }) } });
    expect(r).toMatchObject({ accepted: true, execution: 'applied' });
    expect((await snap()).tasks[id('review')]!.route!.lastObserved).toMatchObject({ observedSource: 'IN_CLOUD', effectiveMode: 'PREFER_ON_DEVICE', fellBack: true, conformance: 'conforms', reportedBy: 'browser' });
    expect(events.filter((e) => e.type === 'inference.reported')).toHaveLength(1);
    // The locked task records a cloud answer as a violation, whatever the call asked for.
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'r2', args: { projectId, taskId: id('e2e'), report: report({ requestId: 'req-demo-2', callOverride: 'ONLY_IN_CLOUD', observedSource: 'IN_CLOUD' }) } });
    expect((await snap()).tasks[id('e2e')]!.route!.lastObserved).toMatchObject({ effectiveMode: 'ONLY_ON_DEVICE', policySource: 'lock', locked: true, conformance: 'violation' });
    // And a forged device answer to a cloud request is one too: the request counts.
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'r4', args: { projectId, taskId: id('e2e'), report: report({ requestId: 'req-demo-4', callOverride: 'ONLY_IN_CLOUD', requestedMode: 'ONLY_IN_CLOUD', observedSource: 'ON_DEVICE' }) } });
    expect((await snap()).tasks[id('e2e')]!.route!.lastObserved).toMatchObject({ conformance: 'violation', requestModeMismatch: true });
    expect(await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'r3', args: { projectId, taskId: 'nope', report: report() } })).toMatchObject({ accepted: false, rejection: 'unknown_target' });
  });

  it('a fixture without routes leaves them unreported', async () => {
    const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
    const s = await ds.getSnapshot(buildFixture('healthy-parallel-work').projectId);
    expect(Object.values(s.tasks).every((t) => t.route === undefined)).toBe(true);
  });
});
