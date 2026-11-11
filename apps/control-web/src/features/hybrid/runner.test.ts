import { describe, expect, it, vi } from 'vitest';
import { AgentCatalog, type AgentCallRequest, type AssistantProposal, type CallSpec } from '@selarikru/inference-firebase-web';
import { DataSourceException, type TaskAgentContext, type TaskRouteRead, type TaskRouteView } from '@selarikru/view-protocol';
import { AGENT_ACTIONS } from './model.ts';
import { runAgentStep, type AgentRunnerDeps } from './runner.ts';

const route = (over: Partial<TaskRouteView> = {}): TaskRouteView => ({
  effective: 'PREFER_ON_DEVICE', source: 'run', runDefault: 'PREFER_ON_DEVICE', override: null, overrideRevision: 0, lock: null,
  suggestion: { mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', reason: 'r', locked: false }, lastObserved: null, ...over,
});
const read = (r: TaskRouteView): TaskRouteRead => ({ taskId: 't1', revision: 1, runId: 'r1', route: r, records: [] });
const DIFF = ['diff --git a/src/t1/a.ts b/src/t1/a.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/t1/a.ts', '@@ -0,0 +1,1 @@', '+export const A = 1;', ''].join('\n');
const context = (destination: 'local' | 'cloud'): TaskAgentContext => ({
  taskId: 't1', revision: 1, runId: 'r1', planRevision: 1, destination,
  task: { title: 'Search', description: null, criteria: [{ id: 'AC-1', text: 'Finds by title' }], allowedPaths: ['src/t1'], classification: 'internal' },
  bundle: { schemaVersion: 1, destination, taskId: 't1', compilationVersion: null, generator: { id: 'g', version: '1' }, watermark: 0, sourceHead: 0, indexLag: 0, recordsPending: false, compiledAt: null, pinned: [], claims: [], omissions: [] },
  change: { diff: DIFF, files: [{ path: 'src/t1/a.ts', classification: 'internal' }] }, simulated: true,
});
const blocked = { trust: 'untrusted_proposal', status: 'blocked', data: null, requestId: 'q', requestedMode: null, observedSource: 'UNKNOWN', rawInferenceSource: null, model: { cloudModel: '', sdkVersion: '' },
  timing: { totalMs: 0, firstOutputMs: null }, usage: { status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null }, validation: { status: 'not_run', errors: [] }, payloadSha256: null,
  allowedRequirementIds: [], blockedReason: 'device_unavailable', errorName: null, errorCode: null, route: null } as unknown as AssistantProposal;

function harness(r: TaskRouteView = route(), over: Partial<AgentRunnerDeps> = {}) {
  const calls: { spec: CallSpec; req: AgentCallRequest }[] = [];
  const adapter = { runAgent: vi.fn(async (spec: CallSpec, req: AgentCallRequest) => { calls.push({ spec, req }); return { ...blocked, operation: spec.op }; }) };
  const contexts: string[] = [];
  const deps: AgentRunnerDeps = {
    projectId: 'p',
    getTaskRoute: vi.fn(async () => read(r)),
    getTaskContext: vi.fn(async (_taskId: string, destination: 'local' | 'cloud', callOverride?: string | null) => { contexts.push(callOverride ? `${destination}+${callOverride}` : destination); return context(destination); }),
    catalog: new AgentCatalog(adapter),
    failedCheck: () => ({ checkId: 'ci:t1', output: 'expected 2, got 3' }),
    ...over,
  };
  return { deps, calls, contexts, adapter };
}

describe('every task step passes its route on the call path', () => {
  it.each(AGENT_ACTIONS.map((a) => a.kind))('%s names its task, its step kind and this call\'s override', async (kind) => {
    const h = harness();
    const out = await runAgentStep(h.deps, { taskId: 't1', kind, callOverride: 'ONLY_ON_DEVICE' });
    expect(out.kind).toBe('result');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.req.route).toEqual({ taskId: 't1', stepKind: kind, callOverride: 'ONLY_ON_DEVICE' });
    expect(h.calls[0]!.req.projectId).toBe('p');
  });
});

describe('the context bundle is fetched for the destination the route allows', () => {
  const dest = async (r: TaskRouteView, callOverride: 'ONLY_ON_DEVICE' | 'ONLY_IN_CLOUD' | null = null) => {
    const h = harness(r);
    await runAgentStep(h.deps, { taskId: 't1', kind: 'criteria', callOverride });
    return h.contexts;
  };
  it('cloud for any cloud-capable route, local only for a device-only one', async () => {
    expect(await dest(route())).toEqual(['cloud']);
    expect(await dest(route({ effective: 'PREFER_IN_CLOUD', override: 'PREFER_IN_CLOUD', source: 'task' }))).toEqual(['cloud']);
    expect(await dest(route({ effective: 'ONLY_ON_DEVICE', override: 'ONLY_ON_DEVICE', source: 'task' }))).toEqual(['local']);
    expect(await dest(route(), 'ONLY_ON_DEVICE')).toEqual(['local+ONLY_ON_DEVICE']);
    expect(await dest(route({ effective: 'ONLY_ON_DEVICE', runDefault: 'ONLY_ON_DEVICE' }), 'ONLY_IN_CLOUD')).toEqual(['cloud+ONLY_IN_CLOUD']);
  });
  it('a locked task gets the device bundle even with a cloud call override', async () => {
    expect(await dest(route({ effective: 'ONLY_ON_DEVICE', source: 'lock', override: 'ONLY_IN_CLOUD', lock: { label: 'restricted', reason: 'r' } }), 'ONLY_IN_CLOUD')).toEqual(['local+ONLY_IN_CLOUD']);
  });
  it('the task is labelled for the policy grant, and a cloud grant covers public and internal only', async () => {
    const h = harness();
    await runAgentStep(h.deps, { taskId: 't1', kind: 'criteria', callOverride: null });
    const req = h.calls[0]!.req;
    expect(req.sources).toEqual([{ id: 'task:t1', classification: 'internal' }]);
    expect(req.policy?.destinations).toEqual([{ destination: 'firebase-ai-logic-cloud', purpose: 'inference', classifications: ['public', 'internal'] }]);
  });
});

describe('a step that cannot run is refused before any model call', () => {
  it('a route that cannot be read', async () => {
    const h = harness(route(), { getTaskRoute: async () => { throw new Error('down'); } });
    expect(await runAgentStep(h.deps, { taskId: 't1', kind: 'criteria', callOverride: null })).toEqual({ kind: 'refused', code: 'route_fetch_failed' });
    expect(h.adapter.runAgent).not.toHaveBeenCalled();
  });
  it('a context that cannot be read', async () => {
    const h = harness(route(), { getTaskContext: async () => { throw new Error('down'); } });
    expect(await runAgentStep(h.deps, { taskId: 't1', kind: 'criteria', callOverride: null })).toEqual({ kind: 'refused', code: 'context_unavailable' });
    expect(h.adapter.runAgent).not.toHaveBeenCalled();
  });
  it('a context the source refused keeps the refusal\'s code; only a read that failed is context_unavailable', async () => {
    const refusedWith = (message: string) => harness(route(), { getTaskContext: async () => { throw new DataSourceException({ code: 'unavailable', message, retryable: false }); } });
    expect(await runAgentStep(refusedWith('context_destination_refused: device only').deps, { taskId: 't1', kind: 'criteria', callOverride: null })).toEqual({ kind: 'refused', code: 'context_destination_refused' });
    expect(await runAgentStep(refusedWith('task_spec_unreadable: x').deps, { taskId: 't1', kind: 'criteria', callOverride: null })).toEqual({ kind: 'refused', code: 'task_spec_unreadable' });
    expect(await runAgentStep(refusedWith('the server is down').deps, { taskId: 't1', kind: 'criteria', callOverride: null })).toEqual({ kind: 'refused', code: 'context_unavailable' });
  });
  it('a review with no change and an explanation with no failed check', async () => {
    const none = harness(route(), { getTaskContext: async (_t, d) => ({ ...context(d), change: null }), failedCheck: () => null });
    expect(await runAgentStep(none.deps, { taskId: 't1', kind: 'review', callOverride: null })).toEqual({ kind: 'refused', code: 'no_change' });
    expect(await runAgentStep(none.deps, { taskId: 't1', kind: 'triage', callOverride: null })).toEqual({ kind: 'refused', code: 'no_failed_check' });
    expect(none.adapter.runAgent).not.toHaveBeenCalled();
  });
});

describe('Propose change chooses and reads base files, and re-asks once (H5)', () => {
  const invalid = (errors: string[]) => ({ ...blocked, status: 'invalid', blockedReason: null, validation: { status: 'failed', errors } }) as unknown as AssistantProposal;
  const listing = (paths: string[]) => ({ taskId: 't1', revision: 1, baseSha: 'a'.repeat(40), entries: paths.map((path) => ({ path, size: 10 })), truncated: false });
  const thirty = [...Array.from({ length: 29 }, (_, i) => `src/t1/widget${i}.ts`), 'src/t1/searchIndex.ts'];
  const filesFor = (paths: readonly string[]) => ({ taskId: 't1', revision: 1, baseSha: 'a'.repeat(40), files: paths.map((path) => ({ path, content: 'export const A = 1;\n' })), omitted: [] });

  it('lists the files under the allowed paths, chooses the relevant one by name out of 30, and reads only that', async () => {
    const getTaskFiles = vi.fn(async (_t: string, paths: readonly string[]) => filesFor(paths));
    const h = harness(route(), { listTaskFiles: vi.fn(async () => listing(thirty)), getTaskFiles });
    const out = await runAgentStep(h.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(out).toMatchObject({ kind: 'result', base: { sha: 'a'.repeat(40), revision: 1 }, filesNote: null });
    expect(getTaskFiles).toHaveBeenCalledWith('t1', ['src/t1/searchIndex.ts']);
  });

  it('when no name matches, the agent chooses from the listing', async () => {
    const getTaskFiles = vi.fn(async (_t: string, paths: readonly string[]) => filesFor(paths));
    const h = harness(route(), { listTaskFiles: async () => listing(['src/t1/alpha.ts', 'src/t1/beta.ts']), getTaskFiles });
    const pickFiles = vi.fn(async () => ({ paths: ['src/t1/beta.ts'], result: {} as never }));
    (h.deps.catalog as { pickFiles?: unknown }).pickFiles = pickFiles;
    await runAgentStep(h.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(pickFiles).toHaveBeenCalledTimes(1);
    expect(getTaskFiles).toHaveBeenCalledWith('t1', ['src/t1/beta.ts']);
  });

  it('a restricted task and a runner with no copy get no files and say which; any other failed listing refuses the step', async () => {
    const failing = (message: string) => harness(route(), { getTaskFiles: async () => filesFor([]), listTaskFiles: async () => { throw new DataSourceException({ code: 'unavailable', message, retryable: false }); } });
    expect(await runAgentStep(failing('files_restricted: stays here').deps, { taskId: 't1', kind: 'patch', callOverride: null })).toMatchObject({ kind: 'result', filesNote: 'restricted' });
    expect(await runAgentStep(failing('no_checkout: This runner has no copy of the project; the proposal can only add new files').deps, { taskId: 't1', kind: 'patch', callOverride: null })).toMatchObject({ kind: 'result', filesNote: 'no_checkout' });
    const down = failing('files_unavailable: no runner');
    expect(await runAgentStep(down.deps, { taskId: 't1', kind: 'patch', callOverride: null })).toEqual({ kind: 'refused', code: 'files_unavailable' });
    expect(down.adapter.runAgent).not.toHaveBeenCalled();
  });

  it('a patch the check refuses for line drift is asked again once, with the codes, as a new call; then it stops', async () => {
    const h = harness(route(), { listTaskFiles: async () => listing(thirty), getTaskFiles: async (_t, p) => filesFor(p) });
    h.adapter.runAgent.mockImplementation(async (spec: CallSpec, req: AgentCallRequest) => { h.calls.push({ spec, req }); return { ...invalid(['/files/0 diff_does_not_apply']), operation: spec.op } as never; });
    const out = await runAgentStep(h.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(h.calls).toHaveLength(2);
    expect(out).toMatchObject({ kind: 'result', reasked: 1 });
    const second = h.calls[1]!.spec.prompt({ cloudCapable: false } as never) as { prompt: string };
    expect(second.prompt).toContain('diff_does_not_apply');
  });

  it('a re-ask for a file the agent was not given chooses the files again, and may read different ones', async () => {
    const getTaskFiles = vi.fn(async (_t: string, paths: readonly string[]) => filesFor(paths));
    const h = harness(route(), { listTaskFiles: async () => listing(thirty), getTaskFiles });
    const pickFiles = vi.fn(async () => ({ paths: ['src/t1/widget3.ts'], result: {} as never }));
    (h.deps.catalog as { pickFiles?: unknown }).pickFiles = pickFiles;
    h.adapter.runAgent.mockImplementation(async (spec: CallSpec) => ({ ...invalid(['/files/0 diff_file_not_provided']), operation: spec.op }) as never);
    await runAgentStep(h.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(pickFiles).toHaveBeenCalledWith(expect.objectContaining({ priorIssues: ['/files/0 diff_file_not_provided'] }));
    expect(getTaskFiles.mock.calls.map((c) => c[1])).toEqual([['src/t1/searchIndex.ts'], ['src/t1/widget3.ts']]);
  });

  it('the limit is configurable: 0 never re-asks, and a refusal that is not line drift is not re-asked', async () => {
    const zero = harness(route(), { listTaskFiles: async () => listing(thirty), getTaskFiles: async (_t, p) => filesFor(p), reaskLimit: 0 });
    zero.adapter.runAgent.mockImplementation(async (spec: CallSpec) => ({ ...invalid(['/files/0 diff_does_not_apply']), operation: spec.op }) as never);
    await runAgentStep(zero.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(zero.adapter.runAgent).toHaveBeenCalledTimes(1);
    const outside = harness(route(), { listTaskFiles: async () => listing(thirty), getTaskFiles: async (_t, p) => filesFor(p) });
    outside.adapter.runAgent.mockImplementation(async (spec: CallSpec) => ({ ...invalid(['/files/0 path_outside_allowed']), operation: spec.op }) as never);
    await runAgentStep(outside.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(outside.adapter.runAgent).toHaveBeenCalledTimes(1);
  });
});

describe('fix round 5: each call names its own served context', () => {
  it('a re-ask reads the context again under a new id, so no context backs two calls', async () => {
    let n = 0;
    const ids: (string | undefined)[] = [];
    const h = harness(route(), { newContextId: () => `ctx_${(n += 1)}` });
    const read = h.deps.getTaskContext;
    h.deps = { ...h.deps, getTaskContext: async (t, d, o, id) => { ids.push(id); return read(t, d, o, id); } };
    h.adapter.runAgent.mockImplementation(async (spec: CallSpec, req: AgentCallRequest) => { h.calls.push({ spec, req }); return { ...blocked, status: 'invalid', blockedReason: null, validation: { status: 'failed', errors: ['/files/0 diff_does_not_apply'] }, operation: spec.op } as never; });
    await runAgentStep(h.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(ids).toEqual(['ctx_1', 'ctx_2']);
  });
});

describe('H12: stage checkpoints and resuming from a stage', () => {
  const listing = (paths: string[]) => ({ taskId: 't1', revision: 1, baseSha: 'a'.repeat(40), entries: paths.map((path) => ({ path, size: 10 })), truncated: false });
  const filesFor = (paths: readonly string[], content = 'export const A = 1;\n') => ({ taskId: 't1', revision: 1, baseSha: 'a'.repeat(40), files: paths.map((path) => ({ path, content })), omitted: [] });

  it('a step marks each stage boundary: the context, the file choice (paths and hashes, never contents), the patch', async () => {
    const stages: { stage: string; files?: unknown; contextId?: string }[] = [];
    const h = harness(route(), { listTaskFiles: async () => listing(['src/t1/searchIndex.ts']), getTaskFiles: async (_t, paths) => filesFor(paths), onStage: (m) => stages.push(m) });
    await runAgentStep(h.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(stages.map((s) => s.stage)).toEqual(['context', 'file_choice', 'patch']);
    expect(stages[1]!.files).toEqual([{ path: 'src/t1/searchIndex.ts', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(JSON.stringify(stages[1])).not.toContain('export const A');
    const single: string[] = [];
    await runAgentStep(harness(route(), { onStage: (m) => single.push(m.stage) }).deps, { taskId: 't1', kind: 'review', callOverride: null });
    expect(single).toEqual(['context', 'review']);
  });

  it('fix 1 (I3): the first stage mark carries the route the step read, lock included, before anything is written', async () => {
    const marks: { stage: string; route?: unknown }[] = [];
    const lock = { label: 'restricted', reason: 'downstream of a restricted task' };
    await runAgentStep(harness(route({ lock: lock as never, effective: 'ONLY_ON_DEVICE' }), { onStage: (m) => marks.push(m) }).deps, { taskId: 't1', kind: 'criteria', callOverride: null });
    expect(marks[0]).toMatchObject({ stage: 'context', route: { lock } });
  });

  it('a resumed patch continues from its stage: the same files (hashes checked), the earlier issue codes, no file choice; changed files refuse it', async () => {
    const marks: { files?: readonly { path: string; sha256: string | null }[] | undefined }[] = [];
    const first = harness(route(), { listTaskFiles: async () => listing(['src/t1/searchIndex.ts']), getTaskFiles: async (_t, paths) => filesFor(paths), onStage: (m) => marks.push(m) });
    await runAgentStep(first.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    const files = marks.find((m) => m.files)!.files!;
    const listTaskFiles = vi.fn(async () => listing(['src/t1/searchIndex.ts']));
    const h = harness(route(), { listTaskFiles, getTaskFiles: async (_t, paths) => filesFor(paths) });
    const pickFiles = vi.fn();
    (h.deps.catalog as { pickFiles?: unknown }).pickFiles = pickFiles;
    await runAgentStep(h.deps, { taskId: 't1', kind: 'patch', callOverride: 'ONLY_IN_CLOUD', resume: { checkpointId: 'ckp_0123456789ab', kind: 'escalated', files, priorIssues: ['/diff diff_does_not_apply'] } });
    expect(pickFiles).not.toHaveBeenCalled();
    expect(listTaskFiles).not.toHaveBeenCalled();
    expect(h.calls[0]!.spec.prompt({ mode: 'ONLY_IN_CLOUD', cloudCapable: true })).toMatchObject({ prompt: expect.stringContaining('diff_does_not_apply') });
    const changed = harness(route(), { listTaskFiles, getTaskFiles: async (_t, paths) => filesFor(paths, 'export const A = 2;\n') });
    expect(await runAgentStep(changed.deps, { taskId: 't1', kind: 'patch', callOverride: 'ONLY_IN_CLOUD', resume: { checkpointId: 'ckp_0123456789ab', kind: 'escalated', files, priorIssues: [] } })).toEqual({ kind: 'refused', code: 'inputs_changed' });
    expect(changed.adapter.runAgent).not.toHaveBeenCalled();
  });
});
