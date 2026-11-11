import { describe, expect, it } from 'vitest';
import { delegationOutputSha256 } from '@selarikru/domain';
import type { ProjectViewEvent } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, demoNameFor, fixtureTime, scoped } from '../src/index.ts';

const id = (local: string) => scoped('feature-delivery', local);
const report = (requestId: string, over: Record<string, unknown> = {}) => ({
  kind: 'route' as const, requestId, stepKind: 'pmDelegate' as const, callOverride: null, requestedMode: 'PREFER_ON_DEVICE' as const, observedSource: 'ON_DEVICE' as const, status: 'ok' as const,
  model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 640, firstOutputMs: null }, validation: 'passed' as const, blockedReason: null, ...over,
});

async function setup() {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  const f = buildFixture('feature-delivery');
  const first = await ds.getSnapshot(f.projectId);
  const events: ProjectViewEvent[] = [];
  ds.subscribe(f.projectId, first.meta.cursor, (e) => events.push(e), () => undefined);
  const runId = Object.keys(first.runs)[0]!;
  const run = first.runs[runId]!;
  const subject = id('web');
  const task = Object.values(first.tasks).find((t) => t.runId === runId && ['planned', 'ready', 'blocked'].includes(t.status))!;
  const worker = Object.keys(first.workers).find((w) => { const held = first.workers[w]!.taskId; return held ? first.tasks[held]?.role === task.role : false; }) ?? Object.keys(first.workers)[0]!;
  const assignments = [{ taskId: task.taskId, workerId: worker, why: 'free' }];
  /** A recorded pmDelegate call, served a context first (as the PM runner does), bound to its output and the plan revision. */
  const record = async (requestId: string, over: Record<string, unknown> = {}, served: 'local' | 'cloud' = 'local') => {
    const contextId = `ctx_${requestId}`;
    await ds.getTaskContext!(f.projectId, subject, served, null, contextId);
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: requestId, args: { projectId: f.projectId, taskId: subject, report: report(requestId, { contextId, outputSha256: delegationOutputSha256(assignments), planRevision: run.planRevision, ...over }) } });
  };
  const req = (routeRecordId: string, over: Record<string, unknown> = {}) => ({ planRevision: run.planRevision, subjectTaskId: subject, routeRecordId, assignments, ...over });
  return { ds, f, events, runId, run, subject, task, worker, assignments, record, req };
}

describe('the demo\'s Project Manager delegation (H11)', () => {
  it('applies only from a recorded pmDelegate call, only inside the accepted plan, records agent:pm, and honours auto-delegate off', async () => {
    const { ds, f, events, runId, run, task, worker, assignments, record, req } = await setup();
    await expect(ds.delegate!(f.projectId, runId, req('req-pm-1'))).rejects.toThrow(/route_record_missing/);
    await record('req-pm-1');
    const ok = await ds.delegate!(f.projectId, runId, req('req-pm-1'));
    expect(ok).toMatchObject({ simulated: true, autoDelegate: true });
    expect(ok.applied).toEqual([{ taskId: task.taskId, workerId: worker }]);
    await expect.poll(() => events.find((x) => x.type === 'task.delegated')).toMatchObject({ actor: { kind: 'agent', id: 'pm' }, payload: { workerId: worker, planRevision: run.planRevision } });

    await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'off', args: { projectId: f.projectId, key: runId, change: { scope: 'run', field: 'auto_delegate', value: false } } });
    await record('req-pm-2');
    const off = await ds.delegate!(f.projectId, runId, req('req-pm-2'));
    expect(off).toMatchObject({ applied: [], autoDelegate: false });
    expect(off.refused[0]).toMatchObject({ reason: 'auto_delegate_off' });
    expect(assignments).toHaveLength(1);
  });

  it('I1: only the call\'s own output, under the plan revision it used, once', async () => {
    const { ds, f, runId, run, worker, record, req } = await setup();
    await record('req-a');
    await expect(ds.delegate!(f.projectId, runId, req('req-a', { assignments: [{ taskId: 'x', workerId: worker }] }))).rejects.toThrow(/delegation_output_mismatch/);
    await expect(ds.delegate!(f.projectId, runId, req('req-a', { planRevision: run.planRevision + 1 }))).rejects.toThrow(/plan_revision_changed/);
    const first = await ds.delegate!(f.projectId, runId, req('req-a'));
    expect(await ds.delegate!(f.projectId, runId, req('req-a'))).toEqual(first);
    await expect(ds.delegate!(f.projectId, runId, req('req-a', { subjectTaskId: req('req-a').subjectTaskId, assignments: [...req('req-a').assignments] , planRevision: run.planRevision, extra: 1 } as never))).rejects.toThrow(/route_record_used/);
  });

  it('M7: the same guard as the server: a locked call, or one served restricted or no context, is refused', async () => {
    const { ds, f, runId, record, req } = await setup();
    await record('req-locked', { inputLabel: 'restricted' });
    await expect(ds.delegate!(f.projectId, runId, req('req-locked'))).rejects.toThrow(/proposal_from_restricted_call/);
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'noctx', args: { projectId: f.projectId, taskId: req('x').subjectTaskId, report: report('req-noctx', { outputSha256: delegationOutputSha256(req('x').assignments), planRevision: req('x').planRevision }) } });
    await expect(ds.delegate!(f.projectId, runId, req('req-noctx'))).rejects.toThrow(/proposal_from_restricted_context/);
  });

  it('I2/I3: the owner assigns through the same rule as the owner; a worker with no known role is refused as worker_role_unset', async () => {
    const { ds, f, events, runId, run, task, worker } = await setup();
    const r = await ds.assign!(f.projectId, runId, { planRevision: run.planRevision, assignments: [{ taskId: task.taskId, workerId: worker }] });
    expect(r.applied).toEqual([{ taskId: task.taskId, workerId: worker }]);
    await expect.poll(() => events.find((x) => x.type === 'task.delegated')?.actor).toMatchObject({ kind: 'human' });
    const unknown = await ds.assign!(f.projectId, runId, { planRevision: run.planRevision, assignments: [{ taskId: task.taskId, workerId: 'runner_never_seen' }] });
    expect(unknown.refused[0]!.reason).toBe('worker_unknown');
  });

  it('M8: demo names are a function of the worker id alone, not of which other workers exist', async () => {
    const a = await setup();
    const names = (await a.ds.getSnapshot(a.f.projectId)).settings.filter((s) => s.field === 'display_name');
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.desired).toBe(demoNameFor(n.key, []));
    expect(demoNameFor('runner_local_1', [])).toBe(demoNameFor('runner_local_1', ['runner_zzz', 'runner_aaa']));
  });

  it('I4: a Project Manager plan is accepted from a recorded, unlocked pmPlan call: the plan revision moves on, and delegation can follow under it', async () => {
    const { ds, f, runId, run, subject, assignments } = await setup();
    const plan = { tasks: [{ key: 'T1', title: 'API', description: 'Add the route.', role: 'backend', requirementIds: ['FB-01'], paths: ['src/api'], dependsOn: [] }] };
    const req = { expectedPlanRevision: run.planRevision, subjectTaskId: subject, routeRecordId: 'req-plan', plan, idempotencyKey: 'plan-1' };
    await expect(ds.acceptPmPlan!(f.projectId, runId, req)).rejects.toThrow(/route_record_missing/);
    await ds.getTaskContext!(f.projectId, subject, 'local', null, 'ctx_plan');
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'rp', args: { projectId: f.projectId, taskId: subject, report: report('req-plan', { stepKind: 'pmPlan', contextId: 'ctx_plan' }) } });
    const r = await ds.acceptPmPlan!(f.projectId, runId, req);
    expect(r).toMatchObject({ planRevision: run.planRevision + 1, simulated: true });
    await expect.poll(async () => (await ds.getSnapshot(f.projectId)).runs[runId]!.planRevision).toBe(run.planRevision + 1);
    expect(assignments).toHaveLength(1);
  });
});
