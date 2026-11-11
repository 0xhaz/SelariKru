import { describe, expect, it, vi } from 'vitest';
import type { AiCheckpoint } from '@selarikru/domain';
import type { AgentResult, AssistantProposal } from '@selarikru/inference-firebase-web';
import type { ProjectViewSnapshot, TaskAgentContext, TaskRouteRead, TaskRouteView } from '@selarikru/view-protocol';
import { snapshotOf, task } from '../overview/testing.ts';
import { createCheckpointEngine, type CheckpointEngineDeps, type CheckpointRunner } from './engine.ts';
import { memoryDeviceStore } from './device-store.ts';

const CANARY = 'CANARY-H12-PATIENT-LIST-91c2';
const route = (over: Partial<TaskRouteView> = {}): TaskRouteView => ({
  effective: 'ONLY_IN_CLOUD', source: 'task', runDefault: 'PREFER_ON_DEVICE', override: 'ONLY_IN_CLOUD', overrideRevision: 1, lock: null, suggestion: null, lastObserved: null, ...over,
}) as TaskRouteView;
const context = (over: Partial<TaskAgentContext> = {}): TaskAgentContext => ({
  taskId: 't1', revision: 1, runId: 'run', planRevision: 1, destination: 'cloud',
  task: { title: 'Search', description: null, criteria: [{ id: 'AC-1', text: 'Finds' }], allowedPaths: ['src'], classification: 'internal' },
  bundle: { schemaVersion: 1, destination: 'cloud', taskId: 't1', compilationVersion: null, generator: { id: 'g', version: '1' }, watermark: 0, sourceHead: 0, indexLag: 0, recordsPending: false, compiledAt: null, pinned: [], claims: [], omissions: [], contentLabel: 'internal' },
  change: null, simulated: true, ...over,
}) as TaskAgentContext;
const proposal = (over: Partial<AssistantProposal> = {}): AssistantProposal => ({
  trust: 'untrusted_proposal', status: 'ok', operation: 'suggestCriteria', data: {}, requestId: 'req_1', requestedMode: 'ONLY_IN_CLOUD', observedSource: 'IN_CLOUD', rawInferenceSource: null,
  model: { cloudModel: 'm', sdkVersion: '12.5.0' }, timing: { totalMs: 1, firstOutputMs: null }, usage: { status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null },
  validation: { status: 'passed', errors: [] }, payloadSha256: null, allowedRequirementIds: [], blockedReason: null, errorName: null, errorCode: null,
  route: { taskId: 't1', stepKind: 'criteria', callOverride: null, effectiveMode: 'ONLY_IN_CLOUD', policySource: 'task', locked: false, fellBack: false, conformance: 'conforms', requestModeMismatch: false }, input: { chars: 900, budgetChars: 6000, overDeviceBudget: false },
  ...over,
}) as AssistantProposal;
const result = (p: AssistantProposal, kind = 'criteria', locked = false): AgentResult => ({ kind, proposal: p, report: { requestId: p.requestId } as never, reported: 'sent', omissions: [], locked } as unknown as AgentResult);
const offline = (kind = 'criteria') => result(proposal({ status: 'blocked', blockedReason: 'offline', observedSource: 'UNKNOWN', requestId: 'req_off' }), kind);

function snap(over: { budget?: { value: number | null; basis: string } } = {}): ProjectViewSnapshot {
  const s = snapshotOf({ tasks: [task('t1', { title: 'Search index', status: 'planned', route: route() }), task('t2', { title: 'PATIENT export', status: 'planned', route: route({ lock: { label: 'restricted', reason: 'r' } as never }) })] });
  const policy = { budgetLimitUsd: over.budget ?? { value: 10, basis: 'configured' } } as never;
  return { ...s, runs: { run: { ...s.runs['run']!, policy } } };
}

function setup(over: Partial<CheckpointEngineDeps> = {}, routeNow: () => TaskRouteView = () => route()) {
  const device = memoryDeviceStore();
  const server = { saved: [] as AiCheckpoint[], rows: new Map<string, AiCheckpoint>(), claims: 0 };
  let online = true;
  let snapshot = snap();
  const deps: CheckpointEngineDeps = {
    projectId: 'p', ownerKey: 'owner_1', device,
    server: {
      saveAiCheckpoint: async (_p, cp) => { server.saved.push(structuredClone(cp)); server.rows.set(cp.checkpointId, { ...cp, escalatedAt: server.rows.get(cp.checkpointId)?.escalatedAt ?? null }); },
      listAiCheckpoints: async () => [...server.rows.values()],
      claimAiCheckpointEscalation: async (_p, id) => {
        const cp = server.rows.get(id)!;
        if (cp.escalatedAt) throw new Error('escalation_refused: already_escalated');
        server.claims += 1;
        const next = { ...cp, escalatedAt: '2026-11-12T00:05:00.000Z' };
        server.rows.set(id, next);
        return next;
      },
    },
    getTaskRoute: async (taskId) => ({ taskId, revision: 1, runId: 'run', route: taskId === 't2' ? route({ lock: { label: 'restricted', reason: 'r' } as never, effective: 'ONLY_ON_DEVICE' }) : routeNow(), records: [] }) as TaskRouteRead,
    getTaskContext: async () => context(),
    snapshot: () => snapshot,
    isOnline: () => online,
    now: () => new Date('2026-11-12T00:00:00.000Z'),
    ...over,
  };
  const engine = createCheckpointEngine(deps);
  const runs: unknown[] = [];
  const runner: CheckpointRunner = {
    run: vi.fn(async (req) => {
      runs.push(req);
      const rec = engine.begin({ taskId: req.taskId, stepKind: req.kind, callOverride: req.callOverride, ...(req.resume ? { resumeOf: req.resume.checkpointId, resumedAs: req.resume.kind } : {}) });
      rec.stage({ stage: 'context', context: context(), contextId: 'ctx_2' });
      const r = result(proposal({ requestId: 'req_resumed' }), req.kind);
      rec.stage({ stage: req.kind === 'patch' ? 'patch' : 'criteria', result: r });
      const outcome = { kind: 'result' as const, result: r, context: context(), simulated: true };
      await rec.finish(outcome);
      return outcome;
    }),
    pm: vi.fn(),
  };
  engine.attach(runner);
  return { engine, device, server, deps, runs, runner, setOnline: (v: boolean) => { online = v; }, setSnap: (s: ProjectViewSnapshot) => { snapshot = s; } };
}

/** A step that ran offline: the context was read, then the adapter refused it as offline. */
async function pauseOffline(h: ReturnType<typeof setup>, taskId = 't1', kind: 'criteria' | 'patch' = 'criteria', ctx = context()) {
  const rec = h.engine.begin({ taskId, stepKind: kind, callOverride: null });
  rec.stage({ stage: 'context', context: ctx, contextId: 'ctx_1' });
  const r = offline(kind);
  rec.stage({ stage: kind === 'patch' ? 'patch' : 'criteria', result: r });
  await rec.finish({ kind: 'result', result: r, context: ctx, simulated: true });
  return rec.id;
}

describe('the checkpoint engine (H12)', () => {
  it('a step that needs the cloud while offline is saved as offline: waiting for connection, on the server and on this device; not an error', async () => {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    const cp = h.engine.store.getState().checkpoints[id]!;
    expect(cp).toMatchObject({ status: 'waiting', stopReason: 'offline', continuation: 'cloud_capable', stage: 'criteria', routeRecordId: 'req_off' });
    expect(h.server.rows.get(id)).toMatchObject({ status: 'waiting' });
    expect((await h.device.list('owner_1', 'p')).map((c) => c.checkpointId)).toEqual([id]);
  });

  it('storage split, canary: a restricted checkpoint (a locked call, a restricted question) never reaches the server; it stays on this device', async () => {
    const h = setup();
    const rec = h.engine.begin({ taskId: 't1', stepKind: 'pmAnswer', callOverride: null, texts: [{ who: 'owner', text: `about ${CANARY}`, classification: 'restricted' }] });
    rec.stage({ stage: 'context', context: context(), contextId: 'ctx_1' });
    await rec.finish({ kind: 'result', result: result(proposal({ requestId: 'req_pm' }), 'pmAnswer', true), context: context(), planRevision: 1, runId: 'run' } as never, { who: 'pm', text: `reply ${CANARY}`, classification: 'restricted' });
    const locked = h.engine.begin({ taskId: 't2', stepKind: 'criteria', callOverride: null });
    locked.stage({ stage: 'context', context: context({ taskId: 't2', task: { ...context().task, classification: 'restricted' } }), contextId: 'ctx_3' });
    await locked.finish({ kind: 'result', result: result(proposal({ requestId: 'req_l' }), 'criteria', true), context: context(), simulated: true } as never);
    expect(JSON.stringify(h.server.saved)).not.toContain(CANARY);
    expect(h.server.saved.filter((c) => c.taskId === 't2' || c.stepKind === 'pmAnswer')).toEqual([]);
    const kept = await h.device.list('owner_1', 'p');
    expect(kept.map((c) => c.stepKind).sort()).toEqual(['criteria', 'pmAnswer']);
    expect(kept.find((c) => c.stepKind === 'pmAnswer')!.partial!.texts.map((t) => t.classification)).toEqual(['restricted', 'restricted']);
  });

  it('inside the accepted plan, it is sent on its own after reconnecting, recorded as "after_reconnect", never a fallback', async () => {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    h.setOnline(true);
    await h.engine.reconnect();
    expect(h.runs).toEqual([expect.objectContaining({ taskId: 't1', kind: 'criteria', resume: expect.objectContaining({ checkpointId: id, kind: 'after_reconnect' }) })]);
    expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'sent', resumedAs: 'after_reconnect' });
  });

  it('outside the accepted plan it waits for the owner: "Resume in cloud?"', async () => {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    const s = snap();
    h.setSnap({ ...s, runs: { run: { ...s.runs['run']!, planRevision: 2 } } });
    h.setOnline(true);
    await h.engine.reconnect();
    expect(h.runs).toEqual([]);
    expect(h.engine.store.getState().asks[id]).toBe('resume');
    await h.engine.resume(id);
    expect(h.runs).toHaveLength(1);
  });

  it('re-validation refuses to send when the route, the lock, the inputs or the budget changed, and says why', async () => {
    const cases: [string, Parameters<typeof setup>[0], () => TaskRouteView, string[]][] = [
      ['route', {}, () => route({ override: 'PREFER_IN_CLOUD', effective: 'PREFER_IN_CLOUD' }), ['route_changed']],
      ['lock', {}, () => route({ lock: { label: 'restricted', reason: 'r' } as never }), ['route_changed', 'locked']],
      ['inputs', { getTaskContext: async () => context({ bundle: { ...context().bundle, claims: [{ key: 'criterion:AC-1' }] as never } }) }, () => route(), ['inputs_changed']],
      ['budget', {}, () => route(), ['budget_missing']],
    ];
    for (const [name, over, routeNow, problems] of cases) {
      const h = setup(over, routeNow);
      h.setOnline(false);
      const id = await pauseOffline(h);
      if (name === 'budget') h.setSnap(snap({ budget: { value: 25, basis: 'recommended' } }));
      h.setOnline(true);
      await h.engine.reconnect();
      expect(h.runs, name).toEqual([]);
      expect(h.engine.store.getState().problems[id], name).toEqual(problems);
    }
  });

  it('the offline queue survives a reload: a new engine over the same device store and server lists it and sends it on reconnect', async () => {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    const again = createCheckpointEngine({ ...h.deps, server: null, isOnline: () => true });
    const runs: unknown[] = [];
    again.attach({ ...h.runner, run: vi.fn(async (req) => { runs.push(req); return { kind: 'refused', code: 'x', simulated: true }; }) } as never);
    await again.load();
    expect(again.store.getState().checkpoints[id]).toMatchObject({ status: 'waiting', stopReason: 'offline' });
    await again.reconnect();
    expect(runs).toEqual([expect.objectContaining({ resume: expect.objectContaining({ checkpointId: id }) })]);
  });

  describe('escalation', () => {
    const localFailed = async (h: ReturnType<typeof setup>, taskId = 't1') => {
      const rec = h.engine.begin({ taskId, stepKind: 'patch', callOverride: null });
      rec.stage({ stage: 'context', context: context({ taskId }), contextId: 'ctx_1' });
      rec.stage({ stage: 'file_choice', files: [{ path: 'src/a.ts', sha256: 'a'.repeat(64) }] });
      const r = result(proposal({ status: 'invalid', observedSource: 'ON_DEVICE', requestedMode: 'PREFER_ON_DEVICE', validation: { status: 'failed', errors: ['/diff diff_does_not_apply'] }, route: { ...proposal().route!, effectiveMode: 'PREFER_ON_DEVICE' } }), 'patch');
      rec.stage({ stage: 'reask', result: r });
      await rec.finish({ kind: 'result', result: r, context: context({ taskId }), simulated: true });
      return rec.id;
    };
    const localFirst = () => route({ override: null, effective: 'PREFER_ON_DEVICE', source: 'run' });

    it('a local result that failed its checks continues in the cloud from its stage, once, inside the plan: same files, the issue codes', async () => {
      const h = setup({}, localFirst);
      const id = await localFailed(h);
      expect(h.runs).toEqual([expect.objectContaining({ kind: 'patch', callOverride: 'ONLY_IN_CLOUD', resume: { checkpointId: id, kind: 'escalated', files: [{ path: 'src/a.ts', sha256: 'a'.repeat(64) }], priorIssues: ['/diff diff_does_not_apply'] } })]);
      expect(h.server.claims).toBe(1);
      expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'escalated', resumedAs: 'escalated' });
      // Never twice: asking again is refused by the one-time claim.
      await h.engine.escalate(id);
      expect(h.runs).toHaveLength(1);
    });

    it('never on Local only, and never on locked data', async () => {
      const only = setup({}, () => route({ override: 'ONLY_ON_DEVICE', effective: 'ONLY_ON_DEVICE' }));
      const id = await localFailed(only);
      expect(only.runs).toEqual([]);
      expect(only.engine.store.getState().problems[id]).toEqual(['not_local_first']);
      const locked = setup({}, localFirst);
      const lid = await localFailed(locked, 't2');
      expect(locked.runs).toEqual([]);
      expect(locked.server.claims).toBe(0);
      expect(locked.engine.store.getState().problems[lid]).toEqual(['locked']);
    });

    it('outside the plan it waits for the owner', async () => {
      const h = setup({}, localFirst);
      const s = snap();
      h.setSnap({ ...s, runs: { run: { ...s.runs['run']!, planRevision: 3 } } });
      const id = await localFailed(h);
      expect(h.runs).toEqual([]);
      expect(h.engine.store.getState().asks[id]).toBe('escalate');
    });
  });

  it('Move to device only runs it on the device; Drop closes it', async () => {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    await h.engine.moveToDevice(id);
    expect(h.runs).toEqual([expect.objectContaining({ callOverride: 'ONLY_ON_DEVICE', resume: expect.objectContaining({ kind: 'device_only' }) })]);
    const other = await pauseOffline(h);
    await h.engine.drop(other);
    expect(h.engine.store.getState().checkpoints[other]).toMatchObject({ status: 'dropped' });
  });
});
