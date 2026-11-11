import { DataSourceException } from '@selarikru/view-protocol';
import { describe, expect, it } from 'vitest';
import { createLiveDataSource } from '../src/index.ts';

const bundle = (destination: string, taskId = 't1') => ({
  schemaVersion: 1, destination, taskId, compilationVersion: null, generator: { id: 'g', version: '1' }, watermark: 0, sourceHead: 0, indexLag: 0, recordsPending: false, compiledAt: null, pinned: [], claims: [], omissions: [],
});
const spec = { taskId: 't1', revision: 1, title: 'Search', requirementIds: ['FB-1'], criteria: [{ id: 'FB-1', text: 'Finds by title' }, { id: 'FB-2', text: 'Finds by body' }], allowedPaths: ['src'] };
const context = (destination = 'cloud', over: Record<string, unknown> = {}) => ({
  taskId: 't1', revision: 1, runId: 'r1', planRevision: 3, destination,
  task: { title: 'Search', description: null, criteria: spec.criteria, allowedPaths: ['src'], classification: 'internal' }, bundle: bundle(destination), change: null, spec, simulated: false, ...over,
});

type Call = { url: string; method: string; body: unknown };
function source(answers: ((call: Call) => { status: number; body: unknown })[]) {
  const calls: Call[] = [];
  const s = createLiveDataSource({
    baseUrl: 'http://x', getToken: async () => 't',
    fetch: (async (url: string, init?: RequestInit) => {
      const call = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      const a = answers[calls.length - 1]!(call);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as unknown as typeof fetch,
  });
  return { s, calls };
}

describe('live task context and criteria revisions (H4)', () => {
  it('reads the context for the asked destination and refuses one served for another', async () => {
    const ok = source([() => ({ status: 200, body: context('cloud') })]);
    const read = await ok.s.getTaskContext!('p', 't1', 'cloud');
    expect(ok.calls[0]!.url).toBe('http://x/v1/projects/p/tasks/t1/context?destination=cloud');
    expect(read).toMatchObject({ destination: 'cloud', bundle: { destination: 'cloud' } });
    const wrong = source([() => ({ status: 200, body: context('local') })]);
    await expect(wrong.s.getTaskContext!('p', 't1', 'cloud')).rejects.toBeInstanceOf(DataSourceException);
  });

  it('a criteria revision goes through the replan path: a new revision (one above the current) of the task spec with its criteria reworded, at the plan revision read', async () => {
    const live = source([() => ({ status: 200, body: context('local') }), () => ({ status: 201, body: { planRevision: 4, taskIds: ['t1'] } })]);
    const done = await live.s.reviseTaskCriteria!('p', { taskId: 't1', expectedPlanRevision: 3, idempotencyKey: 'k1', criteria: [{ id: 'FB-1', text: 'Finds by title, ignoring case' }] });
    expect(done).toEqual({ planRevision: 4, taskIds: ['t1'], simulated: false });
    expect(live.calls[1]).toMatchObject({ url: 'http://x/v1/runs/r1/plan-revisions', method: 'POST' });
    expect(live.calls[1]!.body).toEqual({ expectedRevision: 3, idempotencyKey: 'k1', tasks: [{ ...spec, revision: 2, criteria: [{ id: 'FB-1', text: 'Finds by title, ignoring case' }, { id: 'FB-2', text: 'Finds by body' }] }] });
  });

  it('refuses a criterion the task does not have, a plan that moved, and a context with no spec, before anything is sent', async () => {
    const unknown = source([() => ({ status: 200, body: context('local') })]);
    await expect(unknown.s.reviseTaskCriteria!('p', { taskId: 't1', expectedPlanRevision: 3, idempotencyKey: 'k', criteria: [{ id: 'FB-9', text: 'x' }] })).rejects.toBeInstanceOf(DataSourceException);
    expect(unknown.calls).toHaveLength(1);
    const moved = source([() => ({ status: 200, body: context('local', { planRevision: 4 }) })]);
    await expect(moved.s.reviseTaskCriteria!('p', { taskId: 't1', expectedPlanRevision: 3, idempotencyKey: 'k', criteria: [{ id: 'FB-1', text: 'x' }] })).rejects.toThrow(/stale_revision/);
    const nospec = source([() => ({ status: 200, body: { ...context('local'), spec: undefined } })]);
    await expect(nospec.s.reviseTaskCriteria!('p', { taskId: 't1', expectedPlanRevision: 3, idempotencyKey: 'k', criteria: [{ id: 'FB-1', text: 'x' }] })).rejects.toBeInstanceOf(DataSourceException);
  });

  it('a refused plan revision is an error with the server\'s reason, never a result', async () => {
    const live = source([() => ({ status: 200, body: context('local') }), () => ({ status: 409, body: { error: { code: 'stale_revision', message: 'moved' } } })]);
    await expect(live.s.reviseTaskCriteria!('p', { taskId: 't1', expectedPlanRevision: 3, idempotencyKey: 'k', criteria: [{ id: 'FB-1', text: 'x' }] })).rejects.toBeInstanceOf(DataSourceException);
  });

  it('passes this call\'s override, so the server can check the destination against the route', async () => {
    const ok = source([() => ({ status: 200, body: context('cloud') })]);
    await ok.s.getTaskContext!('p', 't1', 'cloud', 'ONLY_IN_CLOUD');
    expect(ok.calls[0]!.url).toBe('http://x/v1/projects/p/tasks/t1/context?destination=cloud&callOverride=ONLY_IN_CLOUD');
  });

  it('refuses to revise a restricted task from a browser proposal, before anything is sent; the server stays the authority', async () => {
    const restricted = source([() => ({ status: 200, body: context('local', { task: { ...context('local').task, classification: 'restricted' } }) })]);
    await expect(restricted.s.reviseTaskCriteria!('p', { taskId: 't1', expectedPlanRevision: 3, idempotencyKey: 'k', criteria: [{ id: 'FB-1', text: 'x' }] })).rejects.toThrow(/restricted/);
    expect(restricted.calls).toHaveLength(1);
  });
});
