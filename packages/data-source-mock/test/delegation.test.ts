import { describe, expect, it } from 'vitest';
import type { ProjectViewEvent } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime, scoped } from '../src/index.ts';

const id = (local: string) => scoped('feature-delivery', local);
const report = (requestId: string) => ({
  kind: 'route' as const, requestId, stepKind: 'pmDelegate' as const, callOverride: null, requestedMode: 'PREFER_ON_DEVICE' as const, observedSource: 'ON_DEVICE' as const, status: 'ok' as const,
  model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 640, firstOutputMs: null }, validation: 'passed' as const, blockedReason: null,
});

describe('the demo\'s Project Manager delegation (H11)', () => {
  it('applies only from a recorded pmDelegate call, only inside the accepted plan, records agent:pm, and honours auto-delegate off', async () => {
    const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
    const f = buildFixture('feature-delivery');
    const first = await ds.getSnapshot(f.projectId);
    const events: ProjectViewEvent[] = [];
    ds.subscribe(f.projectId, first.meta.cursor, (e) => events.push(e), () => undefined);
    const runId = Object.keys(first.runs)[0]!;
    const run = first.runs[runId]!;
    const subject = id('web');
    const task = Object.values(first.tasks).find((t) => t.runId === runId && ['planned', 'ready', 'blocked'].includes(t.status))!;
    const worker = Object.keys(first.workers).find((w) => {
      const held = first.workers[w]!.taskId;
      return held ? first.tasks[held]?.role === task.role : false;
    }) ?? Object.keys(first.workers)[0]!;
    const req = { planRevision: run.planRevision, subjectTaskId: subject, routeRecordId: 'req-pm-1', assignments: [{ taskId: task.taskId, workerId: worker, why: 'free' }] };

    // No record of the call: nothing applies.
    await expect(ds.delegate!(f.projectId, runId, req)).rejects.toThrow(/route_record_missing/);
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'pm1', args: { projectId: f.projectId, taskId: subject, report: report('req-pm-1') } });

    // A field the plan cannot authorise refuses the proposal whole; so does an older plan revision.
    const widened = await ds.delegate!(f.projectId, runId, { ...req, assignments: [{ ...req.assignments[0]!, allowedPaths: ['**'] }] });
    expect(widened.applied).toEqual([]);
    expect(widened.refused[0]).toMatchObject({ reason: 'outside_plan_field' });
    const stale = await ds.delegate!(f.projectId, runId, { ...req, planRevision: run.planRevision + 1 });
    expect(stale.applied).toEqual([]);
    expect(stale.refused[0]).toMatchObject({ reason: 'plan_revision_not_accepted' });
    const unknown = await ds.delegate!(f.projectId, runId, { ...req, assignments: [{ taskId: 'not-in-plan', workerId: worker }] });
    expect(unknown.refused[0]).toMatchObject({ reason: 'task_not_in_plan' });

    const ok = await ds.delegate!(f.projectId, runId, req);
    expect(ok).toMatchObject({ simulated: true, autoDelegate: true });
    expect(ok.applied).toEqual([{ taskId: task.taskId, workerId: worker }]);
    // The event records the agent and the accepted plan revision; the snapshot carries the delegation.
    await expect.poll(() => events.find((x) => x.type === 'task.delegated')).toMatchObject({ actor: { kind: 'agent', id: 'pm' }, payload: { workerId: worker, planRevision: run.planRevision } });

    await ds.execute({ command: 'setting.set', expectedRevision: 0, idempotencyKey: 'off', args: { projectId: f.projectId, key: runId, change: { scope: 'run', field: 'auto_delegate', value: false } } });
    const off = await ds.delegate!(f.projectId, runId, req);
    expect(off).toMatchObject({ applied: [], autoDelegate: false });
    expect(off.refused[0]).toMatchObject({ reason: 'auto_delegate_off' });
  });
});
