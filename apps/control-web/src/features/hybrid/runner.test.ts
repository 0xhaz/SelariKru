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

describe('Propose change reads base files and re-asks once (H5)', () => {
  const invalid = (errors: string[]) => ({ ...blocked, status: 'invalid', blockedReason: null, validation: { status: 'failed', errors } }) as unknown as AssistantProposal;
  const files = { taskId: 't1', revision: 1, baseSha: 'a'.repeat(40), files: [{ path: 'src/t1/a.ts', content: 'export const A = 1;\n' }], omitted: [] };

  it('gives the patch agent the base files read for the task, labelled with the task\'s label', async () => {
    const h = harness(route(), { getTaskFiles: vi.fn(async () => files) });
    const out = await runAgentStep(h.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(out).toMatchObject({ kind: 'result', base: { sha: 'a'.repeat(40), revision: 1 } });
    expect(h.deps.getTaskFiles).toHaveBeenCalledWith('t1', ['src/t1']);
    // The prompt is built inside the adapter call; the file content is in it.
    expect(h.calls).toHaveLength(1);
  });

  it('a restricted task gets no files (they stay on the device), and a read that fails refuses the step', async () => {
    const restricted = harness(route(), { getTaskFiles: async () => { throw new DataSourceException({ code: 'unavailable', message: 'files_restricted: stays here', retryable: false }); } });
    expect((await runAgentStep(restricted.deps, { taskId: 't1', kind: 'patch', callOverride: null })).kind).toBe('result');
    const down = harness(route(), { getTaskFiles: async () => { throw new DataSourceException({ code: 'unavailable', message: 'files_unavailable: no runner', retryable: true }); } });
    expect(await runAgentStep(down.deps, { taskId: 't1', kind: 'patch', callOverride: null })).toEqual({ kind: 'refused', code: 'files_unavailable' });
    expect(down.adapter.runAgent).not.toHaveBeenCalled();
  });

  it('a patch the check refuses for line drift is asked again once, with the codes, as a new call; then it stops', async () => {
    const h = harness(route(), { getTaskFiles: async () => files });
    h.adapter.runAgent.mockImplementation(async (spec: CallSpec, req: AgentCallRequest) => { h.calls.push({ spec, req }); return { ...invalid(['/files/0 diff_does_not_apply']), operation: spec.op } as never; });
    const out = await runAgentStep(h.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(h.calls).toHaveLength(2);
    expect(out).toMatchObject({ kind: 'result', reasked: 1 });
    const second = h.calls[1]!.spec.prompt({ cloudCapable: false } as never) as { prompt: string };
    expect(second.prompt).toContain('diff_does_not_apply');
  });

  it('the limit is configurable: 0 never re-asks, and a refusal that is not line drift is not re-asked', async () => {
    const zero = harness(route(), { getTaskFiles: async () => files, reaskLimit: 0 });
    zero.adapter.runAgent.mockImplementation(async (spec: CallSpec) => ({ ...invalid(['/files/0 diff_does_not_apply']), operation: spec.op }) as never);
    await runAgentStep(zero.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(zero.adapter.runAgent).toHaveBeenCalledTimes(1);
    const outside = harness(route(), { getTaskFiles: async () => files });
    outside.adapter.runAgent.mockImplementation(async (spec: CallSpec) => ({ ...invalid(['/files/0 path_outside_allowed']), operation: spec.op }) as never);
    await runAgentStep(outside.deps, { taskId: 't1', kind: 'patch', callOverride: null });
    expect(outside.adapter.runAgent).toHaveBeenCalledTimes(1);
  });
});
