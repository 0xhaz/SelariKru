import { describe, expect, it } from 'vitest';
import { TaskAgentContextSchema } from '@selarikru/view-protocol';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime, scoped } from '../src/index.ts';

const setup = async () => {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  const f = buildFixture('feature-delivery');
  const first = await ds.getSnapshot(f.projectId);
  return { ds, projectId: f.projectId, runId: Object.keys(first.runs)[0]!, first };
};
const id = (local: string) => scoped('feature-delivery', local);

describe('mock task context for the agents (H4)', () => {
  it('serves simulated context for the asked destination, with the task\'s label, criteria and allowed paths', async () => {
    const { ds, projectId } = await setup();
    const c = TaskAgentContextSchema.parse(await ds.getTaskContext!(projectId, id('search'), 'cloud'));
    expect(c).toMatchObject({ taskId: id('search'), destination: 'cloud', simulated: true, bundle: { destination: 'cloud', taskId: id('search') } });
    expect(c.task.title).toBe('Search index');
    expect(c.task.classification).toBe('internal');
    expect(c.task.criteria.length).toBeGreaterThan(0);
    expect(c.task.allowedPaths.length).toBeGreaterThan(0);
    expect((await ds.getTaskContext!(projectId, id('e2e'), 'local')).task.classification).toBe('restricted');
  });

  it('a task with work on record has a change to review; one without has none', async () => {
    const { ds, projectId } = await setup();
    const api = await ds.getTaskContext!(projectId, id('api'), 'cloud');
    expect(api.change).not.toBeNull();
    expect(api.change!.diff).toMatch(/^diff --git /);
    expect(api.change!.files.every((f) => api.task.allowedPaths.some((p) => f.path.startsWith(p)))).toBe(true);
    expect((await ds.getTaskContext!(projectId, id('review'), 'cloud')).change).toBeNull();
  });

  it('a criteria revision rewords the task\'s criteria for the next read, refuses unknown criteria and a moved plan, and says it is simulated', async () => {
    const { ds, projectId, first } = await setup();
    const t = id('search');
    const before = await ds.getTaskContext!(projectId, t, 'local');
    expect(before.planRevision).toBe(first.runs[before.runId]!.planRevision);
    const plan = first.runs[before.runId]!.planRevision;
    const c1 = before.task.criteria[0]!;
    const done = await ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: plan, idempotencyKey: 'k1', criteria: [{ id: c1.id, text: 'Finds feedback by title, ignoring case' }] });
    expect(done).toMatchObject({ taskIds: [t], simulated: true });
    expect((await ds.getTaskContext!(projectId, t, 'cloud')).task.criteria[0]).toEqual({ id: c1.id, text: 'Finds feedback by title, ignoring case' });
    await expect(ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: plan, idempotencyKey: 'k2', criteria: [{ id: 'NOPE-1', text: 'x' }] })).rejects.toThrow();
    await expect(ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: plan + 7, idempotencyKey: 'k3', criteria: [{ id: c1.id, text: 'x' }] })).rejects.toThrow(/stale_revision/);
  });

  it('a restricted task\'s criteria are not revised from a browser proposal', async () => {
    const { ds, projectId, first } = await setup();
    const t = id('e2e');
    const c = await ds.getTaskContext!(projectId, t, 'local');
    await expect(ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: first.runs[c.runId]!.planRevision, idempotencyKey: 'k', criteria: [{ id: c.task.criteria[0]!.id, text: 'x' }] })).rejects.toThrow(/restricted/);
  });

  it('mirrors the live rules: only a replannable task is revised, and an accept moves the plan, so a second one at the old revision is stale', async () => {
    const { ds, projectId, first } = await setup();
    const api = await ds.getTaskContext!(projectId, id('api'), 'cloud');
    await expect(ds.reviseTaskCriteria!(projectId, { taskId: id('api'), expectedPlanRevision: api.planRevision, idempotencyKey: 'k', criteria: [{ id: api.task.criteria[0]!.id, text: 'x' }] })).rejects.toThrow(/task_not_replannable/);
    const t = id('search');
    const c = await ds.getTaskContext!(projectId, t, 'local');
    const plan = first.runs[c.runId]!.planRevision;
    const done = await ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: plan, idempotencyKey: 'k1', criteria: [{ id: c.task.criteria[0]!.id, text: 'Reworded once' }] });
    expect(done.planRevision).toBe(plan + 1);
    expect((await ds.getTaskContext!(projectId, t, 'local')).planRevision).toBe(plan + 1);
    await expect(ds.reviseTaskCriteria!(projectId, { taskId: t, expectedPlanRevision: plan, idempotencyKey: 'k2', criteria: [{ id: c.task.criteria[0]!.id, text: 'Reworded twice' }] })).rejects.toThrow(/stale_revision/);
  });

  it('refuses a cloud context when the route keeps the task on the device, as the server does', async () => {
    const { ds, projectId } = await setup();
    await expect(ds.getTaskContext!(projectId, id('e2e'), 'cloud')).rejects.toThrow(/context_destination_refused/);
    await expect(ds.getTaskContext!(projectId, id('e2e'), 'cloud', 'ONLY_IN_CLOUD')).rejects.toThrow(/context_destination_refused/);
    await expect(ds.getTaskContext!(projectId, id('integrate'), 'cloud')).rejects.toThrow(/context_destination_refused/);
    expect((await ds.getTaskContext!(projectId, id('integrate'), 'cloud', 'ONLY_IN_CLOUD')).destination).toBe('cloud');
  });
});
