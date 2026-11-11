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

  it('reads a task\'s input size for one destination: counts only, nothing else accepted', async () => {
    const ok = source([() => ({ status: 200, body: { taskId: 't1', destination: 'local', hasChange: false, inputChars: 120 } })]);
    expect(await ok.s.getTaskContextSize!('p', 't1', 'local')).toEqual({ taskId: 't1', destination: 'local', hasChange: false, inputChars: 120 });
    expect(ok.calls[0]!.url).toBe('http://x/v1/projects/p/tasks/t1/context-size?destination=local');
    const extra = source([() => ({ status: 200, body: { taskId: 't1', destination: 'local', hasChange: false, inputChars: 120, text: 'leak' } })]);
    await expect(extra.s.getTaskContextSize!('p', 't1', 'local')).rejects.toBeInstanceOf(DataSourceException);
    const refused = source([() => ({ status: 409, body: { error: { code: 'context_destination_refused', message: 'device only' } } })]);
    await expect(refused.s.getTaskContextSize!('p', 't1', 'cloud')).rejects.toThrow(/^context_destination_refused:/);
  });
});

describe('live accepted proposals, base files and the PR body (H5)', () => {
  const proposal = { proposalId: 'req_1', taskId: 't1', taskRevision: 1, baseSha: 'a'.repeat(40), routeRecordId: 'rr_1', diff: '--- /dev/null\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+x\n', results: [{ path: 'src/x.ts', sha256: 'b'.repeat(64), content: 'x\n' }] };
  const receipt = { proposalId: 'req_1', taskId: 't1', revision: 1, digest: 'c'.repeat(64), fileCount: 1, state: 'accepted', round: 1, lastFailure: null };

  it('posts the accepted proposal to the owner route and reads the receipt; a refusal keeps its code', async () => {
    const live = source([() => ({ status: 201, body: receipt })]);
    expect(await live.s.acceptPatchProposal!('p', proposal, 'k1')).toEqual({ ...receipt, simulated: false });
    expect(live.calls[0]).toMatchObject({ url: 'http://x/v1/projects/p/tasks/t1/proposals/accept', method: 'POST', body: { idempotencyKey: 'k1', proposal } });
    const refused = source([() => ({ status: 403, body: { error: { code: 'proposal_restricted', message: 'Restricted work is applied by the local runner on this device' } } })]);
    await expect(refused.s.acceptPatchProposal!('p', proposal, 'k1')).rejects.toThrow(/^proposal_restricted:/);
  });

  it('reads base files for the patch agent from the relay', async () => {
    const files = { taskId: 't1', revision: 1, baseSha: 'a'.repeat(40), files: [{ path: 'src/a.ts', content: 'a\n' }], omitted: [] };
    const live = source([() => ({ status: 200, body: files })]);
    expect(await live.s.getTaskFiles!('p', 't1', ['src'])).toEqual(files);
    expect(live.calls[0]).toMatchObject({ url: 'http://x/v1/projects/p/tasks/t1/files', method: 'POST', body: { paths: ['src'] } });
    const wrong = source([() => ({ status: 200, body: { ...files, taskId: 't2' } })]);
    await expect(wrong.s.getTaskFiles!('p', 't1')).rejects.toBeInstanceOf(DataSourceException);
  });

  it('lists a task\'s files from the relay, paths and sizes only, and keeps a refusal\'s code', async () => {
    const listing = { taskId: 't1', revision: 1, baseSha: 'a'.repeat(40), entries: [{ path: 'src/a.ts', size: 2 }], truncated: false };
    const live = source([() => ({ status: 200, body: listing })]);
    expect(await live.s.listTaskFiles!('p', 't1')).toEqual(listing);
    expect(live.calls[0]).toMatchObject({ url: 'http://x/v1/projects/p/tasks/t1/files/list', method: 'POST' });
    const none = source([() => ({ status: 409, body: { error: { code: 'no_checkout', message: 'This runner has no copy of the project; the proposal can only add new files' } } })]);
    await expect(none.s.listTaskFiles!('p', 't1')).rejects.toThrow(/^no_checkout:/);
  });

  it('sends the PR description with the open request', async () => {
    const live = source([() => ({ status: 200, body: { status: 'opened' } })]);
    await live.s.execute({ command: 'run.open_pull_request', expectedRevision: 1, idempotencyKey: 'k', args: { runId: 'r1', body: 'Add posting' } });
    expect(live.calls[0]).toMatchObject({ url: 'http://x/v1/runs/r1/pull-request', body: { body: 'Add posting' } });
  });
});
