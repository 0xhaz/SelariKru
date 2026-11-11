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
    const r = await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'o1', args: { projectId, key: id('e2e'), change: { scope: 'task', field: 'route_override', value: 'ONLY_IN_CLOUD' } } });
    expect(r).toMatchObject({ accepted: true, execution: 'applied', simulated: true });
    expect((await snap()).tasks[id('e2e')]!.route).toMatchObject({ effective: 'ONLY_IN_CLOUD', source: 'task', overrideRevision: 1 });
    expect(events.find((e) => e.type === 'settings.changed')).toMatchObject({ actor: { kind: 'human' }, payload: { scope: 'task', key: id('e2e'), field: 'route_override' } });
    expect(await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'o2', args: { projectId, key: id('search'), change: { scope: 'task', field: 'route_override', value: 'PREFER_ON_DEVICE' } } }))
      .toMatchObject({ accepted: false, rejection: 'route_locked_restricted' });
    expect(await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'o3', args: { projectId, key: runId, change: { scope: 'run', field: 'route_policy', value: 'PREFER_IN_CLOUD' } } })).toMatchObject({ accepted: true });
    const s = await snap();
    expect(s.runs[runId]!.routePolicy).toEqual({ value: 'PREFER_IN_CLOUD', origin: 'setting', revision: 1 });
    expect(s.tasks[id('review')]!.route).toMatchObject({ effective: 'PREFER_IN_CLOUD', source: 'run' });
    expect(s.tasks[id('search')]!.route).toMatchObject({ effective: 'ONLY_ON_DEVICE', source: 'lock' });
  });

  it('a reported route record becomes the last observed source, worked out like the server', async () => {
    const { ds, projectId, snap, events } = await setup();
    const r = await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'r1', args: { projectId, taskId: id('review'), report: report({ observedSource: 'IN_CLOUD' }) } });
    expect(r).toMatchObject({ accepted: true, execution: 'applied' });
    expect((await snap()).tasks[id('review')]!.route!.lastObserved).toMatchObject({ observedSource: 'IN_CLOUD', effectiveMode: 'PREFER_ON_DEVICE', fellBack: true, conformance: 'conforms', reportedBy: 'browser' });
    expect(events.filter((e) => e.type === 'inference.reported')).toHaveLength(1);
    // The locked task records a cloud answer as a violation, whatever the call asked for.
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'r2', args: { projectId, taskId: id('search'), report: report({ requestId: 'req-demo-2', callOverride: 'ONLY_IN_CLOUD', observedSource: 'IN_CLOUD' }) } });
    expect((await snap()).tasks[id('search')]!.route!.lastObserved).toMatchObject({ effectiveMode: 'ONLY_ON_DEVICE', policySource: 'lock', locked: true, conformance: 'violation' });
    expect(await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'r3', args: { projectId, taskId: 'nope', report: report() } })).toMatchObject({ accepted: false, rejection: 'unknown_target' });
  });

  it('a fixture without routes leaves them unreported', async () => {
    const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
    const s = await ds.getSnapshot(buildFixture('healthy-parallel-work').projectId);
    expect(Object.values(s.tasks).every((t) => t.route === undefined)).toBe(true);
  });
});
