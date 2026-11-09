/** Case: reject a DAG cycle. Through the owner route, the plan validator and Postgres; the scheduler then has nothing to dispatch. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { World } from './world.ts';

let w: World;
beforeAll(async () => { w = await World.create(); });
afterAll(async () => { await w.destroy(); });
beforeEach(async () => { await w.reset(); });

const dep = (taskId: string, revision = 1) => ({ taskId, revision, condition: 'artifact_verified' as const });

describe('a plan with a dependency cycle', () => {
  it('a three-task cycle is refused with its path, stores nothing, and leaves nothing to claim', async () => {
    const runId = await w.newRun();
    const res = await w.plan(runId, [
      w.task(runId, 'a', { dependencies: [dep('c')] }),
      w.task(runId, 'b', { dependencies: [dep('a')] }),
      w.task(runId, 'c', { dependencies: [dep('b')] }),
    ]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('plan_invalid');
    const cycle = res.body.error.details.find((e: { kind: string }) => e.kind === 'cycle');
    expect(cycle.path).toEqual(['a', 'c', 'b', 'a']);

    expect(await w.count('task_revisions')).toBe(0);
    expect(await w.count('task_status')).toBe(0);
    expect(await w.count('dependencies')).toBe(0);
    expect(await w.count('events', `type = 'plan.accepted'`)).toBe(0);
    expect(await w.lifecycle(runId)).toBe('planning');
    expect((await w.api().claim()).lease).toBeNull();
  });

  it('a self-dependency is a cycle too', async () => {
    const runId = await w.newRun();
    const res = await w.plan(runId, [w.task(runId, 'a', { dependencies: [dep('a')] })]);
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual(expect.arrayContaining([{ kind: 'cycle', path: ['a', 'a'] }]));
  });

  it('a replan that closes a loop is refused and the accepted plan stands', async () => {
    const runId = await w.newRun();
    expect((await w.plan(runId, [w.task(runId, 'a'), w.task(runId, 'b', { dependencies: [dep('a')] })])).status).toBe(201);

    const looped = await w.plan(runId, [
      w.task(runId, 'a', { revision: 2, dependencies: [dep('b', 2)] }),
      w.task(runId, 'b', { revision: 2, dependencies: [dep('a', 2)] }),
    ], 1);
    expect(looped.status).toBe(422);
    expect(looped.body.error.details.map((e: { kind: string }) => e.kind)).toContain('cycle');

    expect(await w.count('task_revisions')).toBe(2);
    expect(await w.count('task_revisions', 'revision = 2')).toBe(0);
    expect((await w.claim()).taskId).toBe('a');
  });

  it('a loop through a task left out of the submission cannot be smuggled in by a partial replan', async () => {
    const runId = await w.newRun();
    expect((await w.plan(runId, [w.task(runId, 'a'), w.task(runId, 'b', { dependencies: [dep('a')] })])).status).toBe(201);
    // a@2 waits on the stored b@1, which waits on a: a cycle only visible across revisions.
    const res = await w.plan(runId, [w.task(runId, 'a', { revision: 2, dependencies: [dep('b', 1)] })], 1);
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'missing_dependency', taskId: 'a', dependsOn: 'b' })]));
    expect(await w.count('task_revisions', 'revision = 2')).toBe(0);
  });

  it('control: the same tasks without the back edge are accepted', async () => {
    const runId = await w.newRun();
    const res = await w.plan(runId, [w.task(runId, 'a'), w.task(runId, 'b', { dependencies: [dep('a')] }), w.task(runId, 'c', { dependencies: [dep('b')] })]);
    expect(res.status).toBe(201);
  });
});
