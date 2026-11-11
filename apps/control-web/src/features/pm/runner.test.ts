import { describe, expect, it, vi } from 'vitest';
import type { ProjectViewSnapshot, TaskRouteRead } from '@selarikru/view-protocol';
import { snapshotOf, task } from '../overview/testing.ts';
import { delegationAssignments, ownerTurnLabelAfter, planScopeFor, questionLabelFor, runPmStep, type PmDeps, type PmRequest } from './runner.ts';

const lock = { label: 'restricted' as const, reason: 'x' };
const route = (over: Partial<TaskRouteRead['route']> = {}) => ({ effective: 'PREFER_IN_CLOUD', source: 'run', runDefault: 'PREFER_IN_CLOUD', override: null, overrideRevision: 0, lock: null, suggestion: null, lastObserved: null, ...over }) as never;

function snap(): ProjectViewSnapshot {
  const s = snapshotOf({ tasks: [task('t1', { title: 'Add posting', role: 'backend', route: route() }), task('t2', { title: 'PATIENT-LIST export', role: 'backend', route: route({ lock }) })] });
  return s;
}

function deps(over: Partial<PmDeps> = {}, read: TaskRouteRead['route'] = route()): PmDeps & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { pmAnswer: [], pmResearch: [], pmPlan: [], pmDelegate: [], context: [] };
  const result = (kind: string) => async (input: unknown) => { calls[kind]!.push(input); return { kind, locked: false, proposal: { status: 'ok', data: {} }, report: null } as never; };
  return {
    calls, projectId: 'p', snapshot: snap,
    catalog: { pmAnswer: result('pmAnswer'), pmResearch: result('pmResearch'), pmPlan: result('pmPlan'), pmDelegate: result('pmDelegate') } as never,
    getTaskRoute: async (taskId) => ({ taskId, revision: 1, runId: 'run', route: read, records: [] }) as never,
    getTaskContext: vi.fn(async (taskId: string) => { calls['context']!.push(taskId); return { task: { title: 'Add posting', description: null, criteria: [], allowedPaths: ['src'], classification: 'internal' }, bundle: null } as never; }),
    webResearch: () => true,
    ...over,
  };
}
const req = (over: Partial<PmRequest> = {}): PmRequest => ({ kind: 'pmAnswer', subjectTaskId: 't1', question: 'Q?', questionClassification: 'internal', history: [], callOverride: null, ...over });

describe('the Project Manager runner (H11 fix round 1)', () => {
  it('H1: a locked task of the plan is marked restricted, so a cloud prompt lists only its id, role and status', () => {
    const scope = planScopeFor(snap(), 'run');
    expect(scope.tasks.find((t) => t.taskId === 't2')).toMatchObject({ restricted: true });
    expect(scope.tasks.find((t) => t.taskId === 't1')!.restricted).toBe(false);
  });

  it('H2: a question about a locked task is restricted whatever the checkbox says', () => {
    expect(questionLabelFor(snap().tasks['t2']!, false)).toBe('restricted');
    expect(questionLabelFor(snap().tasks['t1']!, false)).toBe('internal');
    expect(questionLabelFor(snap().tasks['t1']!, true)).toBe('restricted');
  });

  it('H2: the runner raises the label itself when the subject task is locked', async () => {
    const d = deps({}, route({ lock }));
    await runPmStep(d, req({ subjectTaskId: 't2' }));
    expect((d.calls['pmAnswer']![0] as { questionClassification: string }).questionClassification).toBe('restricted');
  });

  it('I5: research reads no task context and sends no bundle; it needs the owner\'s web research grant; it never overrides device only', async () => {
    const d = deps();
    await runPmStep(d, req({ kind: 'pmResearch' }));
    expect(d.calls['context']).toEqual([]);
    expect((d.calls['pmResearch']![0] as { bundle: unknown; history: unknown[] }).bundle).toBeNull();
    expect((d.calls['pmResearch']![0] as { history: unknown[] }).history).toEqual([]);
    expect(await runPmStep(deps({ webResearch: () => false }), req({ kind: 'pmResearch' }))).toEqual({ kind: 'refused', code: 'research_not_granted' });
    expect(await runPmStep(deps({}, route({ override: 'ONLY_ON_DEVICE', effective: 'ONLY_ON_DEVICE', source: 'task' })), req({ kind: 'pmResearch' }))).toEqual({ kind: 'refused', code: 'research_device_only' });
  });

  it('fix round 2 (I5): research is refused when the route without the call override is device only, whether set on the task or as the run default', async () => {
    expect(await runPmStep(deps({}, route({ effective: 'ONLY_ON_DEVICE', source: 'run', runDefault: 'ONLY_ON_DEVICE' })), req({ kind: 'pmResearch' }))).toEqual({ kind: 'refused', code: 'research_device_only' });
  });

  it('fix round 2 (I2): the plan scope resolves roles with workerRoleOf: a saved role wins, else the last claimed task\'s role', () => {
    const s = snap();
    s.workers = { w1: { workerId: 'w1', taskId: null } as never, w2: { workerId: 'w2', taskId: null } as never };
    s.attempts = { a1: { attemptId: 'a1', taskId: 't1', runnerId: 'w1', startedAt: '2026-11-10T00:00:00Z' } as never };
    s.settings = [{ scope: 'runner', key: 'w2', field: 'role', desired: 'frontend', effective: 'frontend' } as never];
    const w = planScopeFor(s, 'run').workers;
    expect(w.find((x) => x.workerId === 'w1')!.role).toBe('backend');
    expect(w.find((x) => x.workerId === 'w2')!.role).toBe('frontend');
  });

  it('fix round 2 (M-b): a question whose call came back locked is relabelled restricted, even when the snapshot did not yet show the lock', () => {
    expect(ownerTurnLabelAfter('internal', { kind: 'result', result: { locked: true } } as never)).toBe('restricted');
    expect(ownerTurnLabelAfter('internal', { kind: 'result', result: { locked: false } } as never)).toBe('internal');
    expect(ownerTurnLabelAfter('internal', { kind: 'refused', code: 'x' })).toBe('internal');
  });

  it('fix round 2 (M-c): the delegation POST carries no reasons', () => {
    expect(delegationAssignments([{ taskId: 't1', workerId: 'w1', why: 'x' }, { taskId: 't2', workerId: 'w2', allowedPaths: ['/'] }])).toEqual([{ taskId: 't1', workerId: 'w1' }, { taskId: 't2', workerId: 'w2', allowedPaths: ['/'] }]);
  });

  it('fix round 2 (I4): a plan call is given the run\'s current tasks', async () => {
    const d = deps();
    await runPmStep(d, req({ kind: 'pmPlan' }));
    expect((d.calls['pmPlan']![0] as { plan: { tasks: { taskId: string }[] } }).plan.tasks.map((t) => t.taskId)).toEqual(['t1', 't2']);
  });
});

describe('H12 step 0: the plan scope reads each listed task\'s route again just before it is built', () => {
  const unlockedSnap = (): ProjectViewSnapshot => snapshotOf({ tasks: [task('t1', { title: 'Add posting', role: 'backend', route: route() }), task('t2', { title: 'PATIENT-LIST export', role: 'backend', route: route() })] });
  for (const kind of ['pmPlan', 'pmDelegate'] as const) {
    it(`${kind}: a sibling that became locked after the snapshot is withheld, and a sibling whose read fails counts as locked`, async () => {
      const reads: string[] = [];
      const d = deps({
        snapshot: () => { const x = unlockedSnap(); x.tasks['t3'] = { ...x.tasks['t1']!, taskId: 't3', title: 'Third' }; return x; },
        getTaskRoute: async (taskId) => {
          reads.push(taskId);
          if (taskId === 't3') throw new Error('offline');
          return { taskId, revision: 1, runId: 'run', route: taskId === 't2' ? route({ lock }) : route(), records: [] } as never;
        },
      });
      await runPmStep(d, req({ kind }));
      const scope = (d.calls[kind]![0] as { plan: { tasks: { taskId: string; restricted?: boolean }[] } }).plan;
      expect(scope.tasks.find((t) => t.taskId === 't2')!.restricted).toBe(true);
      expect(scope.tasks.find((t) => t.taskId === 't3')!.restricted).toBe(true);
      expect(scope.tasks.find((t) => t.taskId === 't1')!.restricted).toBe(false);
      expect(reads).toEqual(expect.arrayContaining(['t2', 't3']));
    });
  }
});
