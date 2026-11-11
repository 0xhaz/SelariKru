import { describe, expect, it } from 'vitest';
import { ProjectViewSnapshotSchema, type ProjectViewEvent, type ProjectViewSnapshot } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime } from '../src/index.ts';

const setup = async () => {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  const f = buildFixture('healthy-parallel-work');
  const first = await ds.getSnapshot(f.projectId);
  const runId = Object.keys(first.runs)[0]!;
  const events: ProjectViewEvent[] = [];
  ds.subscribe(f.projectId, first.meta.cursor, (e) => events.push(e), () => undefined);
  return { ds, projectId: f.projectId, runId, events, snap: (): Promise<ProjectViewSnapshot> => ds.getSnapshot(f.projectId) };
};
const setting = (s: ProjectViewSnapshot, key: string, field: string) => s.settings.find((x) => x.key === key && x.field === field);

describe('mock settings follow the real save-then-acknowledge rule', () => {
  it('a pause is pending, reads as applying, and is applied only after a simulated heartbeat acknowledges it', async () => {
    const { ds, projectId, runId, events, snap } = await setup();
    const r = await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'p1', args: { projectId, key: runId, change: { scope: 'run', field: 'paused', value: true } } });
    expect(r).toMatchObject({ accepted: true, execution: 'pending', simulated: true });
    expect(setting(await snap(), runId, 'paused')).toMatchObject({ desired: true, state: 'applying', desiredRevision: 1, effectiveRevision: 0 });
    expect((await snap()).runs[runId]!.policy!.schedulingPaused.value).toBe(true);
    expect(events.map((e) => e.type)).toContain('settings.changed');
    ds.clock.advance(9_000);
    expect(setting(await snap(), runId, 'paused')!.state).toBe('applying');
    ds.clock.advance(1_000);
    expect(setting(await snap(), runId, 'paused')).toMatchObject({ effective: true, state: 'applied', effectiveRevision: 1 });
    expect(events.map((e) => e.type)).toContain('settings.applied');
    expect(ProjectViewSnapshotSchema.safeParse(await snap()).success).toBe(true);
  });

  it('a stale revision is refused, and a path outside the plan cannot be granted', async () => {
    const { ds, projectId, runId } = await setup();
    await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'a', args: { projectId, key: runId, change: { scope: 'run', field: 'paused', value: true } } });
    expect(await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'b', args: { projectId, key: runId, change: { scope: 'run', field: 'paused', value: false } } })).toMatchObject({ accepted: false, rejection: 'stale_revision' });
    expect(await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'c', args: { projectId, key: runId, change: { scope: 'run', field: 'allowed_paths', value: ['infra'] } } })).toMatchObject({ accepted: false, rejection: 'outside_plan_scope' });
  });

  it('a narrowed path is the server\'s to enforce, so it is applied in the save', async () => {
    const { ds, projectId, runId, snap } = await setup();
    const r = await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'a', args: { projectId, key: runId, change: { scope: 'run', field: 'allowed_paths', value: ['src'] } } });
    expect(r.execution).toBe('applied');
    expect(setting(await snap(), runId, 'allowed_paths')).toMatchObject({ state: 'applied', effective: ['src'] });
    expect((await snap()).runs[runId]!.policy!.allowedPaths).toEqual({ value: ['src'], basis: 'configured' });
  });

  it('a model assignment is applying until the simulated runner acknowledges it', async () => {
    const { ds, projectId, snap } = await setup();
    const r = await ds.execute({ command: 'assignment.set', expectedRevision: 0, idempotencyKey: 'm', args: { projectId, scope: 'role', key: 'backend', selection: { provider: 'anthropic', model: 'claude-haiku-5-5' } } });
    expect(r.execution).toBe('pending');
    expect((await snap()).modelAssignments.find((a) => a.key === 'backend')!.state).toBe('applying');
    ds.clock.advance(10_000);
    expect((await snap()).modelAssignments.find((a) => a.key === 'backend')!.state).toBe('applied');
  });

  it('a run cancel reads as requested until its running attempts have ended', async () => {
    const { ds, projectId, runId, snap } = await setup();
    const before = await snap();
    const r = await ds.execute({ command: 'run.cancel', expectedRevision: before.runs[runId]!.planRevision, idempotencyKey: 'c', args: { runId } });
    expect(r).toMatchObject({ accepted: true, execution: 'cancel_requested' });
    expect((await snap()).runs[runId]).toMatchObject({ lifecycle: 'running', cancel: { requestedBy: expect.any(String) } });
    ds.clock.advance(2_000);
    expect((await snap()).runs[runId]!.lifecycle).toBe('cancelled');
    expect(await ds.execute({ command: 'run.cancel', expectedRevision: before.runs[runId]!.planRevision, idempotencyKey: 'd', args: { runId } })).toMatchObject({ accepted: false, rejection: 'run_closed' });
  });
});

describe('mock pause holds the fixture\'s scripted attempt starts', () => {
  const make = async () => {
    const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
    const f = buildFixture('human-wait');
    const s0 = await ds.getSnapshot(f.projectId);
    return { ds, projectId: f.projectId, runId: Object.keys(s0.runs)[0]!, attempts: async () => Object.keys((await ds.getSnapshot(f.projectId)).attempts).length };
  };

  it('no attempt starts while paused, and the held start happens after resume', async () => {
    const free = await make();
    const before = await free.attempts();
    free.ds.clock.advance(70_000);
    expect(await free.attempts()).toBe(before + 1);

    const { ds, projectId, runId, attempts } = await make();
    await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'p', args: { projectId, key: runId, change: { scope: 'run', field: 'paused', value: true } } });
    ds.clock.advance(70_000);
    expect(await attempts()).toBe(before);
    await ds.execute({ command: 'setting.set', expectedRevision: 1, idempotencyKey: 'r', args: { projectId, key: runId, change: { scope: 'run', field: 'paused', value: false } } });
    expect(await attempts()).toBe(before);
    ds.clock.advance(1_000);
    expect(await attempts()).toBe(before + 1);
    expect(ProjectViewSnapshotSchema.safeParse(await ds.getSnapshot(projectId)).success).toBe(true);
  });

  it('seeded assignments are reported as in force, not left unknown', async () => {
    const { ds, projectId } = await make();
    for (const a of (await ds.getSnapshot(projectId)).modelAssignments) expect(a.state).toBe('applied');
  });
});

describe('H11 fix round 1: names and roles in the demo follow the server', () => {
  it('M1: a role is one of the project\'s roles, and only one worker is the Project Manager; M2: names are saved trimmed', async () => {
    const { ds, projectId, snap } = await setup();
    const s = await snap();
    const [a, b] = Object.keys(s.workers);
    const role = Object.values(s.tasks).find((t) => t.role)!.role!;
    const set = (key: string, change: Record<string, unknown>, expectedRevision = 0) => ds.execute({ command: 'setting.set', expectedRevision, idempotencyKey: `k${Math.random()}`, args: { projectId, key, change: change as never } });
    expect(await set(a!, { scope: 'runner', field: 'role', value: 'designer' })).toMatchObject({ accepted: false, rejection: 'role_unknown' });
    expect(await set(a!, { scope: 'runner', field: 'role', value: role })).toMatchObject({ accepted: true });
    expect(await set(b!, { scope: 'runner', field: 'role', value: 'project_manager' })).toMatchObject({ accepted: true });
    expect(await set(a!, { scope: 'runner', field: 'role', value: 'project_manager' }, 1)).toMatchObject({ accepted: false, rejection: 'role_pm_taken' });
    expect(await set(a!, { scope: 'runner', field: 'display_name', value: '  Nurul  ' }, 1)).toMatchObject({ accepted: true });
    expect(setting(await snap(), a!, 'display_name')).toMatchObject({ desired: 'Nurul' });
    expect(await set(b!, { scope: 'runner', field: 'display_name', value: 'nurul ' }, 1)).toMatchObject({ accepted: false, rejection: 'name_taken' });
  });
});
