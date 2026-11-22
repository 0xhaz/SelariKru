import { describe, expect, it, vi } from 'vitest';
import { sha256Hex, type AiCheckpoint } from '@selarikru/domain';
import type { AgentResult, AssistantProposal } from '@selarikru/inference-firebase-web';
import type { ProjectViewSnapshot, TaskAgentContext, TaskRouteRead, TaskRouteView } from '@selarikru/view-protocol';
import { snapshotOf, task } from '../overview/testing.ts';
import { createCheckpointEngine, type CheckpointEngineDeps, type CheckpointRunner } from './engine.ts';
import { memoryDeviceStore } from './device-store.ts';

const CANARY = 'CANARY-H12-PATIENT-LIST-91c2';
const BASE_FILE = 'export const BASE = 1;\n';
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
  const server = { saved: [] as AiCheckpoint[], rows: new Map<string, AiCheckpoint>(), claims: 0, sends: 0, tokens: new Map<string, string>() };
  let online = true;
  let snapshot = snap();
  const deps: CheckpointEngineDeps = {
    projectId: 'p', ownerKey: 'owner_1', device,
    server: {
      saveAiCheckpoint: async (_p, cp) => {
        if (!online) throw new Error('unavailable: network error');
        // As the server (fix round 2, N4): a sending row takes a save only with its claim token.
        const prior = server.rows.get(cp.checkpointId);
        if (prior?.status === 'sending' && (cp.claimToken === undefined || cp.claimToken !== server.tokens.get(cp.checkpointId))) throw new Error('checkpoint_claimed: another tab is sending it');
        server.tokens.delete(cp.checkpointId);
        server.saved.push(structuredClone(cp));
        const { claimToken: _t, ...rest } = cp;
        void _t;
        server.rows.set(cp.checkpointId, { ...rest, escalatedAt: prior?.escalatedAt ?? null });
      },
      listAiCheckpoints: async () => [...server.rows.values()],
      claimAiCheckpointSend: async (_p, id) => {
        if (!online) throw new Error('unavailable: network error');
        const cp = server.rows.get(id);
        if (!cp) throw new Error('checkpoint_not_found: no such checkpoint');
        if (cp.status !== 'waiting') throw new Error(`checkpoint_claimed: ${cp.status}`);
        server.sends += 1;
        const next = { ...cp, status: 'sending' as const };
        server.rows.set(id, next);
        const token = `tok_${'x'.repeat(16)}${server.sends}`;
        server.tokens.set(id, token);
        return { ...next, claimToken: token };
      },
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
    getTaskFiles: async (_t, paths) => ({ taskId: 't1', revision: 1, baseSha: 'a'.repeat(40), files: paths.map((path) => ({ path, content: BASE_FILE })), omitted: [] }),
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

describe('fix 1 (H2): a paused patch step can be resumed; its files are read again and checked', () => {
  const A = 'export const A = 1;\n';
  const files = [{ path: 'src/a.ts', sha256: sha256Hex(A) }];
  const filesNow = (content: string) => ({ getTaskFiles: async (_t: string, paths: readonly string[]) => ({ taskId: 't1', revision: 1, baseSha: 'a'.repeat(40), files: paths.map((path) => ({ path, content })), omitted: [] }) });
  async function pausedPatch(h: ReturnType<typeof setup>, blockedReason: string) {
    const rec = h.engine.begin({ taskId: 't1', stepKind: 'patch', callOverride: null });
    rec.stage({ stage: 'context', context: context(), contextId: 'ctx_1' });
    rec.stage({ stage: 'file_choice', files });
    const r = result(proposal({ status: 'blocked', blockedReason, observedSource: 'UNKNOWN', requestId: 'req_p' }), 'patch');
    rec.stage({ stage: 'patch', result: r });
    await rec.finish({ kind: 'result', result: r, context: context() });
    return rec.id;
  }

  it('offline after the file choice, then reconnect: it is sent, with the same files', async () => {
    const h = setup(filesNow(A));
    h.setOnline(false);
    const id = await pausedPatch(h, 'offline');
    h.setOnline(true);
    await h.engine.reconnect();
    expect(h.engine.store.getState().problems[id]).toBeUndefined();
    expect(h.runs).toEqual([expect.objectContaining({ kind: 'patch', resume: expect.objectContaining({ checkpointId: id, kind: 'after_reconnect', files }) })]);
  });

  it('too large for the device on a cloud-capable route: the owner resumes it, and it is sent', async () => {
    const h = setup(filesNow(A));
    const id = await pausedPatch(h, 'input_too_large_for_device');
    expect(h.engine.store.getState().asks[id]).toBe('resume');
    await h.engine.resume(id);
    expect(h.runs).toEqual([expect.objectContaining({ kind: 'patch', resume: expect.objectContaining({ checkpointId: id }) })]);
  });

  it('M1: the owner resumes a step the cloud rate-limited or the budget stopped: recorded as owner_resume, not after_reconnect', async () => {
    for (const reason of ['cloud_rate_limited', 'budget'] as const) {
      const h = setup(filesNow(A));
      const id = await pausedPatch(h, reason);
      expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'waiting', stopReason: reason });
      await h.engine.resume(id);
      expect(h.runs).toEqual([expect.objectContaining({ kind: 'patch', resume: expect.objectContaining({ checkpointId: id, kind: 'owner_resume' }) })]);
      expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'sent', resumedAs: 'owner_resume' });
    }
  });

  it('a file that changed since the pause refuses it as inputs_changed; nothing is sent', async () => {
    const h = setup(filesNow('export const A = 2;\n'));
    h.setOnline(false);
    const id = await pausedPatch(h, 'offline');
    h.setOnline(true);
    await h.engine.reconnect();
    expect(h.runs).toEqual([]);
    expect(h.engine.store.getState().problems[id]).toEqual(['inputs_changed']);
  });
});

describe('fix 1 (I3): nothing is sent before the lock is known', () => {
  for (const [why, reason] of [['a predecessor', 'This task depends on a restricted task.'], ['a Brain source', 'A Brain source for this task is restricted.']] as const) {
    it(`canary: a task locked by ${why}, whose context and bundle read internal: no POST at any stage, and it stays device-only after a reload`, async () => {
      const h = setup();
      h.setOnline(false);
      const lockedRoute = route({ lock: { label: 'restricted', reason } as never, effective: 'ONLY_ON_DEVICE' });
      const rec = h.engine.begin({ taskId: 't1', stepKind: 'pmAnswer', callOverride: null, texts: [{ who: 'owner', text: CANARY, classification: 'internal' }] });
      rec.stage({ stage: 'context', context: context(), contextId: 'ctx_1', route: lockedRoute });
      const r = offline('pmAnswer');
      rec.stage({ stage: 'pm_turn', result: r });
      await rec.finish({ kind: 'result', result: r, context: context() });
      expect(h.server.saved).toEqual([]);
      const kept = await h.device.list('owner_1', 'p');
      expect(kept).toEqual([expect.objectContaining({ locked: true, deviceOnly: true })]);
      // A reload: the device-only mark is read back from the checkpoint itself, so a later write never goes to the server.
      const again = createCheckpointEngine({ ...h.deps });
      await again.load();
      expect(again.store.getState().deviceOnly[rec.id]).toBe(true);
    });
  }
});

describe('fix 2 (N1): Move to device only works offline', () => {
  it('offline, a server-stored checkpoint moved to device only runs on this device; its closing state syncs once reconnected', async () => {
    const h = setup();
    // Stored on the server while online: too large for the device on a cloud-capable route.
    const rec = h.engine.begin({ taskId: 't1', stepKind: 'criteria', callOverride: null });
    rec.stage({ stage: 'context', context: context(), contextId: 'ctx_1' });
    const r = result(proposal({ status: 'blocked', blockedReason: 'input_too_large_for_device', observedSource: 'UNKNOWN' }));
    await rec.finish({ kind: 'result', result: r, context: context() });
    const id = rec.id;
    expect(h.server.rows.get(id)).toMatchObject({ status: 'waiting' });
    h.setOnline(false);
    await h.engine.moveToDevice(id);
    expect(h.runs).toEqual([expect.objectContaining({ callOverride: 'ONLY_ON_DEVICE', resume: expect.objectContaining({ kind: 'device_only' }) })]);
    expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'moved_to_device' });
    // The server could not be told while offline; it is told once the connection is back.
    expect(h.server.rows.get(id)).toMatchObject({ status: 'waiting' });
    h.setOnline(true);
    await h.engine.reconnect();
    expect(h.server.rows.get(id)).toMatchObject({ status: 'moved_to_device' });
  });
});

describe('fix 2 (N2): a claim is released on every exit that is not a closing write', () => {
  it('a file changes between the re-check and the send: the row goes back to waiting with why, and a second Resume after the file is restored is sent', async () => {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    h.setOnline(true);
    let refuse = true;
    h.engine.attach({
      ...h.runner,
      run: async (req: Parameters<CheckpointRunner["run"]>[0]) => {
        h.runs.push(req);
        const rec = h.engine.begin({ taskId: req.taskId, stepKind: req.kind, callOverride: req.callOverride, ...(req.resume ? { resumeOf: req.resume.checkpointId, resumedAs: req.resume.kind } : {}) });
        if (refuse) { await rec.finish({ kind: 'refused', code: 'inputs_changed' }); return { kind: 'refused', code: 'inputs_changed' }; }
        return h.runner.run(req);
      },
    } as never);
    await h.engine.resume(id);
    expect(h.server.rows.get(id)).toMatchObject({ status: 'waiting' });
    expect(h.engine.store.getState().problems[id]).toEqual(['inputs_changed']);
    refuse = false;
    await h.engine.resume(id);
    expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'sent' });
    expect(h.server.rows.get(id)).toMatchObject({ status: 'sent' });
  });

  it('a PM checkpoint with no question to send goes back to waiting, not left sending', async () => {
    const h = setup();
    h.setOnline(false);
    const rec = h.engine.begin({ taskId: 't1', stepKind: 'pmAnswer', callOverride: null, texts: [] });
    rec.stage({ stage: 'context', context: context(), contextId: 'ctx_1' });
    const r = result(proposal({ status: 'blocked', blockedReason: 'offline', observedSource: 'UNKNOWN' }), 'pmAnswer');
    await rec.finish({ kind: 'result', result: r, context: context() });
    h.setOnline(true);
    await h.engine.reconnect();
    expect(h.runner.pm).not.toHaveBeenCalled();
    expect(h.server.rows.get(rec.id)).toMatchObject({ status: 'waiting' });
  });
});

describe('fix 2: an abandoned step can be run again from scratch', () => {
  it('Run again runs the step fresh (no resume, no claim) and takes it off the list', async () => {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    const cp = h.engine.store.getState().checkpoints[id]!;
    h.engine.store.setState((s) => ({ ...s, checkpoints: { ...s.checkpoints, [id]: { ...cp, status: 'abandoned' } } }));
    h.setOnline(true);
    await h.engine.runAgain(id);
    expect(h.runs).toEqual([{ taskId: 't1', kind: 'criteria', callOverride: null }]);
    expect(h.engine.store.getState().dismissed[id]).toBe(true);
  });
});

describe('fix 3: a dismissed abandoned step stays dismissed for this viewer, in localStorage, and the page works without it', () => {
  it('dismissed ids are kept per owner and project and read back by the next engine', async () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } };
    const h = setup({ storage });
    h.engine.dismiss('ckp_gone_000000001');
    const again = createCheckpointEngine({ ...h.deps, storage });
    expect(again.store.getState().dismissed['ckp_gone_000000001']).toBe(true);
    // Another project of the same owner does not share them.
    expect(createCheckpointEngine({ ...h.deps, projectId: 'other', storage }).store.getState().dismissed).toEqual({});
  });

  it('a storage that throws (private mode, blocked) changes nothing else', () => {
    const storage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const h = setup({ storage });
    expect(() => h.engine.dismiss('ckp_gone_000000001')).not.toThrow();
    expect(h.engine.store.getState().dismissed['ckp_gone_000000001']).toBe(true);
  });
});

describe('fix 1 (M1, M4, M6)', () => {
  it('M1: two resumes at once send it once: busy is set before the re-check, and the server claim refuses a second tab', async () => {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    h.setOnline(true);
    await Promise.all([h.engine.resume(id), h.engine.resume(id)]);
    expect(h.runs).toHaveLength(1);
    expect(h.server.sends).toBe(1);
    // Another tab already claimed it: this one does not send.
    const other = setup();
    other.setOnline(false);
    const oid = await pauseOffline(other);
    other.server.rows.set(oid, { ...other.server.rows.get(oid)!, status: 'sending' });
    other.setOnline(true);
    await other.engine.resume(oid);
    expect(other.runs).toEqual([]);
    expect(other.engine.store.getState().problems[oid]).toEqual(['claimed']);
  });

  it('M1: a waiting checkpoint the server does not have (kept only in IndexedDB, as after a reload against a server that lost it) is stored, then claimed and sent', async () => {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    h.server.rows.delete(id);
    h.setOnline(true);
    await h.engine.resume(id);
    expect(h.runs).toHaveLength(1);
    expect(h.server.sends).toBe(1);
  });

  it('M4: web research has no task context to check: its context check is not_applicable, and it is sent', async () => {
    const reads: string[] = [];
    const h = setup({ getTaskContext: async () => { reads.push('ctx'); return context(); } });
    h.setOnline(false);
    const rec = h.engine.begin({ taskId: 't1', stepKind: 'pmResearch', callOverride: 'ONLY_IN_CLOUD', texts: [{ who: 'owner', text: 'Which sort order do boards use?', classification: 'internal' }] });
    rec.stage({ stage: 'context', context: context(), contextId: 'ctx_1' });
    const r = result(proposal({ status: 'blocked', blockedReason: 'offline', observedSource: 'UNKNOWN' }), 'pmResearch');
    await rec.finish({ kind: 'result', result: r, context: context() });
    reads.length = 0;
    const s = snap();
    h.setSnap(s);
    h.setOnline(true);
    await h.engine.resume(rec.id);
    expect(reads).toEqual([]);
    expect(h.runner.pm).toHaveBeenCalledTimes(1);
  });

  it('M6: on load, a running checkpoint older than 30 minutes is closed as abandoned (here and on the server); closed ones older than 7 days are purged from this device', async () => {
    const h = setup({ now: () => new Date('2026-11-12T12:00:00.000Z') });
    const base = { projectId: 'p', taskId: 't1', taskRevision: 1, runId: 'run', planRevision: 1, stepKind: 'criteria' as const, stage: 'criteria' as const, callOverride: null, routeMode: 'ONLY_IN_CLOUD' as const, continuation: 'cloud_capable' as const, labels: ['internal' as const], locked: false, inputs: { contextId: null, bundleSha256: null, files: [], inputChars: null }, partial: null, stopReason: null, routeRecordId: null, escalatedAt: null, resumedAs: null };
    await h.device.put('owner_1', { ...base, checkpointId: 'ckp_stale_running1', status: 'running', createdAt: '2026-11-12T11:00:00.000Z', updatedAt: '2026-11-12T11:00:00.000Z' });
    await h.device.put('owner_1', { ...base, checkpointId: 'ckp_fresh_running1', status: 'running', createdAt: '2026-11-12T11:50:00.000Z', updatedAt: '2026-11-12T11:50:00.000Z' });
    await h.device.put('owner_1', { ...base, checkpointId: 'ckp_old_done_00001', status: 'done', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });
    await h.device.put('owner_1', { ...base, checkpointId: 'ckp_old_wait_00001', status: 'waiting', stopReason: 'offline', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });
    await h.engine.load();
    const kept = Object.fromEntries((await h.device.list('owner_1', 'p')).map((c) => [c.checkpointId, c.status]));
    expect(kept).toEqual({ ckp_stale_running1: 'abandoned', ckp_fresh_running1: 'running', ckp_old_wait_00001: 'waiting' });
    expect(h.server.rows.get('ckp_stale_running1')).toMatchObject({ status: 'abandoned' });
  });

  it('research notes and the reviewed plan brief are the owner\'s saved work, not finished steps: they are never purged, however old', async () => {
    const h = setup({ now: () => new Date('2026-11-22T12:00:00.000Z') });
    const base = { projectId: 'p', taskId: 't1', taskRevision: 1, runId: 'run', planRevision: 1, stage: 'context' as const, callOverride: null, routeMode: 'ONLY_ON_DEVICE' as const, continuation: 'device_only' as const, labels: ['internal' as const], locked: false, inputs: { contextId: null, bundleSha256: null, files: [], inputChars: null }, partial: null, stopReason: null, routeRecordId: null, escalatedAt: null, resumedAs: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
    await h.device.put('owner_1', { ...base, checkpointId: 'ckp_notes_old0001', stepKind: 'researchNotes' as never, status: 'done' } as never);
    await h.device.put('owner_1', { ...base, checkpointId: 'ckp_brief_old0001', stepKind: 'planBrief' as never, status: 'done' } as never);
    await h.engine.load();
    const kept = (await h.device.list('owner_1', 'p')).map((c) => c.checkpointId).sort();
    expect(kept).toEqual(['ckp_brief_old0001', 'ckp_notes_old0001']);
  });
});

describe('the checkpoint engine (H12)', () => {
  it('a step that needs the cloud while offline is saved as offline: waiting for connection, on the server and on this device; not an error', async () => {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    const cp = h.engine.store.getState().checkpoints[id]!;
    expect(cp).toMatchObject({ status: 'waiting', stopReason: 'offline', continuation: 'cloud_capable', stage: 'criteria', routeRecordId: 'req_off' });
    // Kept on this device while offline; the server cannot be reached, so it is told on reconnect (fix round 2, N1).
    expect((await h.device.list('owner_1', 'p')).map((c) => c.checkpointId)).toEqual([id]);
    expect(h.server.rows.has(id)).toBe(false);
    h.setOnline(true);
    await h.engine.reconnect();
    expect(h.server.rows.has(id)).toBe(true);
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
      rec.stage({ stage: 'file_choice', files: [{ path: 'src/a.ts', sha256: sha256Hex(BASE_FILE) }] });
      const r = result(proposal({ status: 'invalid', observedSource: 'ON_DEVICE', requestedMode: 'PREFER_ON_DEVICE', validation: { status: 'failed', errors: ['/diff diff_does_not_apply'] }, route: { ...proposal().route!, effectiveMode: 'PREFER_ON_DEVICE' } }), 'patch');
      rec.stage({ stage: 'reask', result: r });
      await rec.finish({ kind: 'result', result: r, context: context({ taskId }), simulated: true });
      return rec.id;
    };
    const localFirst = () => route({ override: null, effective: 'PREFER_ON_DEVICE', source: 'run' });

    it('a local result that failed its checks continues in the cloud from its stage, once, inside the plan: same files, the issue codes', async () => {
      const h = setup({}, localFirst);
      const id = await localFailed(h);
      expect(h.runs).toEqual([expect.objectContaining({ kind: 'patch', callOverride: 'ONLY_IN_CLOUD', resume: { checkpointId: id, kind: 'escalated', files: [{ path: 'src/a.ts', sha256: sha256Hex(BASE_FILE) }], priorIssues: ['/diff diff_does_not_apply'] } })]);
      expect(h.server.claims).toBe(1);
      expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'escalated', resumedAs: 'escalated' });
      // Never twice: asking again is refused by the one-time claim.
      await h.engine.escalate(id);
      expect(h.runs).toHaveLength(1);
    });

    it('fix 1 (H1): never for a call the owner pinned to this device, even on a Local first task', async () => {
      const h = setup({}, localFirst);
      const rec = h.engine.begin({ taskId: 't1', stepKind: 'patch', callOverride: 'ONLY_ON_DEVICE' });
      rec.stage({ stage: 'context', context: context(), contextId: 'ctx_1' });
      const r = result(proposal({ status: 'invalid', observedSource: 'ON_DEVICE', requestedMode: 'ONLY_ON_DEVICE', validation: { status: 'failed', errors: ['/diff diff_does_not_apply'] }, route: { ...proposal().route!, callOverride: 'ONLY_ON_DEVICE', effectiveMode: 'ONLY_ON_DEVICE' } }), 'patch');
      rec.stage({ stage: 'patch', result: r });
      await rec.finish({ kind: 'result', result: r, context: context() });
      expect(h.runs).toEqual([]);
      expect(h.server.claims).toBe(0);
      expect(h.engine.store.getState().problems[rec.id]).toEqual(['device_only']);
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

    it('fix 2 (N3): a budget block keeps why the step paused: no budget, it is not escalated (local_failed_checks, problem budget); with a budget it escalates, labelled escalated', async () => {
      const h = setup({}, localFirst);
      h.setSnap(snap({ budget: { value: 25, basis: 'recommended' } }));
      const id = await localFailed(h);
      expect(h.runs).toEqual([]);
      expect(h.server.claims).toBe(0);
      expect(h.engine.store.getState().problems[id]).toEqual(['budget_missing']);
      expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'waiting', stopReason: 'local_failed_checks', problems: ['budget_missing'] });
      expect(h.server.rows.get(id)).toMatchObject({ stopReason: 'local_failed_checks', problems: ['budget_missing'] });
      // The owner sets a budget: the step escalates, as an escalation, not as "Sent after reconnecting".
      h.setSnap(snap());
      await h.engine.reconnect();
      expect(h.runs).toEqual([expect.objectContaining({ callOverride: 'ONLY_IN_CLOUD', resume: expect.objectContaining({ kind: 'escalated' }) })]);
      expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'escalated', resumedAs: 'escalated' });
      expect(h.engine.store.getState().checkpoints[id]!.problems ?? []).toEqual([]);
    });

    it('fix 1 (I1): escalation is refused when the inputs changed since the pause', async () => {
      const h = setup({ getTaskContext: async () => context({ bundle: { ...context().bundle, claims: [{ key: 'criterion:AC-1' }] as never } }) }, localFirst);
      const id = await localFailed(h);
      expect(h.runs).toEqual([]);
      expect(h.engine.store.getState().problems[id]).toContain('inputs_changed');
    });

    it('fix 2 (N3): a cloud resume the budget blocks keeps its stop reason, offline, and records the budget as a problem', async () => {
      const h = setup();
      h.setOnline(false);
      const id = await pauseOffline(h);
      h.setSnap(snap({ budget: { value: null, basis: 'unresolved' } }));
      h.setOnline(true);
      await h.engine.reconnect();
      expect(h.runs).toEqual([]);
      expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ stopReason: 'offline', problems: ['budget_missing'] });
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

describe('H9 step 0 (F1): only a known refusal takes the server\'s copy; every other error is retried', () => {
  async function sendWithFailingSave(code: string) {
    const h = setup();
    h.setOnline(false);
    const id = await pauseOffline(h);
    h.setOnline(true);
    // The closing save ("sent") fails once with this error; the claim and the earlier saves go through.
    const save = h.deps.server!.saveAiCheckpoint!;
    let failed = 0;
    const engine = createCheckpointEngine({ ...h.deps, server: { ...h.deps.server!, saveAiCheckpoint: async (p, cp) => {
      if (cp.status === 'sent' && failed === 0) { failed += 1; throw new Error(code); }
      return save(p, cp);
    } } });
    engine.attach({ ...h.runner, run: vi.fn(async (req) => {
      const rec = engine.begin({ taskId: req.taskId, stepKind: req.kind, callOverride: req.callOverride, ...(req.resume ? { resumeOf: req.resume.checkpointId, resumedAs: req.resume.kind } : {}) });
      rec.stage({ stage: 'context', context: context(), contextId: 'ctx_2' });
      const r = result(proposal({ requestId: 'req_resumed' }));
      await rec.finish({ kind: 'result', result: r, context: context(), simulated: true });
      return r;
    }) });
    await engine.load();
    await engine.reconnect();
    return { h, engine, id, failed: () => failed };
  }

  it('a transient 500 on the final "sent" save is kept and retried on reconnect; it never becomes Abandoned', async () => {
    const { h, engine, id, failed } = await sendWithFailingSave('internal_error: the server failed');
    expect(failed()).toBe(1);
    expect(engine.store.getState().checkpoints[id]).toMatchObject({ status: 'sent' });
    expect(h.server.rows.get(id)).toMatchObject({ status: 'sending' });
    await engine.reconnect();
    expect(h.server.rows.get(id)).toMatchObject({ status: 'sent' });
    expect(engine.store.getState().checkpoints[id]).toMatchObject({ status: 'sent' });
  });

  it('a 401 on the final save is retried too, not replaced by the server\'s copy', async () => {
    const { h, engine, id } = await sendWithFailingSave('unauthorized: the token expired');
    expect(engine.store.getState().checkpoints[id]).toMatchObject({ status: 'sent' });
    await engine.reconnect();
    expect(h.server.rows.get(id)).toMatchObject({ status: 'sent' });
  });

  it('a known refusal (checkpoint_closed) still takes the server\'s copy', async () => {
    const { engine, id } = await sendWithFailingSave('checkpoint_closed: this checkpoint is closed');
    expect(engine.store.getState().checkpoints[id]).toMatchObject({ status: 'sending' });
  });
});

describe('H9 step 0 (F2): a server copy in waiting never replaces a closed local copy; unsynced writes survive a reload', () => {
  it('offline, move to device only, reload with the browser clock behind the server\'s: the step does not go back to the queue, and its closing state reaches the server', async () => {
    const h = setup();
    const rec = h.engine.begin({ taskId: 't1', stepKind: 'criteria', callOverride: null });
    rec.stage({ stage: 'context', context: context(), contextId: 'ctx_1' });
    const r = result(proposal({ status: 'blocked', blockedReason: 'input_too_large_for_device', observedSource: 'UNKNOWN' }));
    await rec.finish({ kind: 'result', result: r, context: context() });
    const id = rec.id;
    // The server's clock is ten minutes ahead of this browser's: its copy is stamped later.
    h.server.rows.set(id, { ...h.server.rows.get(id)!, updatedAt: '2026-11-12T00:10:00.000Z' });
    h.setOnline(false);
    await h.engine.moveToDevice(id);
    expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'moved_to_device' });
    // Reload: a new engine over the same device store and server.
    h.setOnline(true);
    const again = createCheckpointEngine({ ...h.deps, now: () => new Date('2026-11-12T00:01:00.000Z') });
    const runs: unknown[] = [];
    again.attach({ ...h.runner, run: vi.fn(async (req) => { runs.push(req); return { kind: 'refused', code: 'x' }; }) } as never);
    await again.load();
    expect(again.store.getState().checkpoints[id]).toMatchObject({ status: 'moved_to_device' });
    await again.reconnect();
    expect(runs).toEqual([]);
    expect(h.server.rows.get(id)).toMatchObject({ status: 'moved_to_device' });
  });
});

describe('H9: a step paused by the hosted demo\'s cloud call cap', () => {
  it('waits as a checkpoint with stop reason cloud_quota, and reconnecting never sends it', async () => {
    const h = setup();
    const rec = h.engine.begin({ taskId: 't1', stepKind: 'criteria', callOverride: null });
    rec.stage({ stage: 'context', context: context(), contextId: 'ctx_1' });
    const r = result(proposal({ status: 'blocked', blockedReason: 'cloud_quota', observedSource: 'UNKNOWN', requestId: 'req_q' }));
    await rec.finish({ kind: 'result', result: r, context: context(), simulated: true });
    expect(h.engine.store.getState().checkpoints[rec.id]).toMatchObject({ status: 'waiting', stopReason: 'cloud_quota', continuation: 'cloud_capable' });
    await h.engine.reconnect();
    expect(h.runs).toEqual([]);
    expect(h.engine.store.getState().asks[rec.id]).toBeUndefined();
  });
});

describe('H13: plan brief notes and checks', () => {
  const NOTES_CANARY = 'CANARY-H13-WARD-NAMES-5e1d';
  const notes = (label: 'internal' | 'restricted'): AiCheckpoint => ({
    checkpointId: `ckp_notes_${label}_00000001`, projectId: 'p', taskId: 't1', taskRevision: 1, runId: 'run', planRevision: 1, stepKind: 'researchNotes', stage: 'research_notes', callOverride: null,
    routeMode: null, continuation: 'device_only', labels: [label], locked: label === 'restricted', inputs: { contextId: null, bundleSha256: null, files: [], inputChars: 10 },
    partial: { issues: [], texts: [{ who: 'owner', text: `P|${NOTES_CANARY} ${label}`, classification: label }] }, stopReason: null, status: 'done', routeRecordId: null, escalatedAt: null, resumedAs: null,
    createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z',
  });

  it('storage split for notes: restricted notes stay on this device and never reach the server; internal ones are stored by both', async () => {
    const h = setup();
    await h.engine.keep(notes('restricted'));
    await h.engine.keep(notes('internal'));
    expect(JSON.stringify(h.server.saved)).not.toContain(`${NOTES_CANARY} restricted`);
    expect(JSON.stringify(h.server.saved)).toContain(`${NOTES_CANARY} internal`);
    expect((await h.device.list('owner_1', 'p')).map((c) => c.checkpointId).sort()).toEqual(['ckp_notes_internal_00000001', 'ckp_notes_restricted_00000001']);
    expect(h.engine.store.getState().deviceOnly['ckp_notes_restricted_00000001']).toBe(true);
  });

  const BRIEF_TEXT = [{ who: 'owner' as const, text: 'G\tA board.\nP1\tfact\tBoards sort by votes.', classification: 'internal' as const }];
  const verifyBlocked = () => result(proposal({ status: 'blocked', blockedReason: 'offline', observedSource: 'UNKNOWN', requestId: 'req_v', route: { taskId: 't1', stepKind: 'pmVerify', callOverride: 'ONLY_IN_CLOUD', effectiveMode: 'ONLY_IN_CLOUD', policySource: 'call', locked: false, fellBack: null, conformance: 'unverified', requestModeMismatch: false } as never }), 'pmVerify');
  async function pauseVerify(h: ReturnType<typeof setup>, sha: string) {
    const rec = h.engine.begin({ taskId: 't1', stepKind: 'pmVerify', callOverride: 'ONLY_IN_CLOUD', texts: BRIEF_TEXT, noContext: { runId: 'run', taskRevision: 1, planRevision: 1, labels: ['internal'], briefSha256: sha } });
    await rec.finish({ kind: 'result', result: verifyBlocked(), context: null });
    return rec.id;
  }

  it('offline, a check pauses as a checkpoint waiting for the connection; on reconnect it is re-validated and sent with its approved brief, after reconnecting', async () => {
    const SHA = 'b'.repeat(64);
    const withGrant = (): ProjectViewSnapshot => { const s = snap(); return { ...s, settings: [{ scope: 'run', key: 'run', field: 'web_research', desired: true } as never] }; };
    const h = setup({ currentBriefSha: () => SHA });
    h.setSnap(withGrant());
    h.setOnline(false);
    const id = await pauseVerify(h, SHA);
    expect(h.engine.store.getState().checkpoints[id]).toMatchObject({ status: 'waiting', stopReason: 'offline', continuation: 'cloud_capable', stepKind: 'pmVerify', inputs: { briefSha256: SHA } });
    expect(h.server.rows.get(id)).toBeUndefined();
    h.setOnline(true);
    await h.engine.reconnect();
    expect(h.runner.pm).toHaveBeenCalledTimes(1);
    expect(h.runner.pm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pmVerify', brief: { goal: 'A board.', items: [{ id: 'P1', kind: 'fact', text: 'Boards sort by votes.' }], uncertainties: [] }, briefSha256: SHA, resume: { checkpointId: id, kind: 'after_reconnect' } }));
  });

  it('editing the brief while the check is paused stops the automatic send (inputs changed); so does turning web research off', async () => {
    let current: string | null = 'b'.repeat(64);
    const h = setup({ currentBriefSha: () => current });
    h.setSnap({ ...snap(), settings: [{ scope: 'run', key: 'run', field: 'web_research', desired: true } as never] });
    h.setOnline(false);
    const id = await pauseVerify(h, 'b'.repeat(64));
    current = null;
    h.setOnline(true);
    await h.engine.reconnect();
    expect(h.runner.pm).not.toHaveBeenCalled();
    expect(h.engine.store.getState().problems[id]).toEqual(['inputs_changed']);
    current = 'b'.repeat(64);
    h.setSnap(snap());
    await h.engine.reconnect();
    expect(h.runner.pm).not.toHaveBeenCalled();
    expect(h.engine.store.getState().problems[id]).toEqual(['web_research_off']);
  });

  it('fix round 1 (H1): Move to device only and Escalate on a paused brief check or web research send nothing', async () => {
    const SHA = 'b'.repeat(64);
    const h = setup({ currentBriefSha: () => SHA });
    h.setOnline(false);
    const id = await pauseVerify(h, SHA);
    h.setOnline(true);
    await h.engine.moveToDevice(id);
    await h.engine.escalate(id);
    expect(h.runner.pm).not.toHaveBeenCalled();
    expect(h.engine.store.getState().checkpoints[id]!.status).toBe('waiting');
    const r = h.engine.begin({ taskId: 't1', stepKind: 'pmResearch', callOverride: 'ONLY_IN_CLOUD', texts: [{ who: 'owner', text: 'How do boards sort?', classification: 'internal' }] });
    r.stage({ stage: 'context', context: context(), contextId: 'ctx_r' });
    await r.finish({ kind: 'result', result: result(proposal({ status: 'blocked', blockedReason: 'offline', observedSource: 'UNKNOWN', requestId: 'req_r' }), 'pmResearch'), context: context() });
    await h.engine.moveToDevice(r.id);
    expect(h.runner.pm).not.toHaveBeenCalled();
  });

  it('fix round 1 (H2): notes kept on blur stay on this device; saved internal and then marked restricted, the server copy is deleted and the device copy is restricted', async () => {
    const h = setup();
    const deleted: string[] = [];
    (h.deps.server as { deleteAiCheckpoint?: (p: string, id: string) => Promise<void> }).deleteAiCheckpoint = async (_p, id) => { deleted.push(id); h.server.rows.delete(id); };
    const internal = notes('internal');
    // On blur: on this device only.
    await h.engine.keep(internal, { server: false });
    expect(h.server.saved).toEqual([]);
    expect((await h.device.list('owner_1', 'p')).map((c) => c.checkpointId)).toEqual([internal.checkpointId]);
    // Save notes: the label is settled, so it is stored by the server too.
    await h.engine.keep(internal, { server: true });
    expect(JSON.stringify([...h.server.rows.values()])).toContain(NOTES_CANARY);
    // Marked restricted: the same notes, now restricted. The server copy is deleted; the device copy is restricted.
    const restricted: AiCheckpoint = { ...internal, labels: ['restricted'], locked: true, partial: { issues: [], texts: [{ who: 'owner', text: `P|${NOTES_CANARY} internal`, classification: 'restricted' }] }, updatedAt: '2026-11-12T00:01:00.000Z' };
    await h.engine.keep(restricted, { server: true });
    expect(deleted).toEqual([internal.checkpointId]);
    expect(JSON.stringify([...h.server.rows.values()])).not.toContain(NOTES_CANARY);
    const [dev] = await h.device.list('owner_1', 'p');
    expect(dev).toMatchObject({ labels: ['restricted'], deviceOnly: true });
  });

  it('fix round 1 (H2): a delete that could not reach the server is tried again on reconnect', async () => {
    const h = setup();
    let up = true;
    const deleted: string[] = [];
    (h.deps.server as { deleteAiCheckpoint?: (p: string, id: string) => Promise<void> }).deleteAiCheckpoint = async (_p, id) => { if (!up) throw new Error('unavailable: network error'); deleted.push(id); };
    const internal = notes('internal');
    await h.engine.keep(internal, { server: true });
    up = false;
    await h.engine.keep({ ...internal, labels: ['restricted'], locked: true, partial: { issues: [], texts: [{ who: 'owner', text: 'P|x', classification: 'restricted' }] } }, { server: true });
    expect(deleted).toEqual([]);
    up = true;
    await h.engine.reconnect();
    expect(deleted).toEqual([internal.checkpointId]);
  });

  it('fix round 1 (M1): a paused check whose task is now device only is not sent, and says why', async () => {
    const SHA = 'b'.repeat(64);
    let r = route();
    const h = setup({ currentBriefSha: () => SHA }, () => r);
    h.setSnap({ ...snap(), settings: [{ scope: 'run', key: 'run', field: 'web_research', desired: true } as never] });
    h.setOnline(false);
    const id = await pauseVerify(h, SHA);
    r = route({ override: 'ONLY_ON_DEVICE', effective: 'ONLY_ON_DEVICE' });
    h.setOnline(true);
    await h.engine.reconnect();
    expect(h.runner.pm).not.toHaveBeenCalled();
    expect(h.engine.store.getState().problems[id]).toEqual(['route_device_only']);
  });

  const withDelete = (h: ReturnType<typeof setup>) => {
    const deleted: string[] = [];
    (h.deps.server as { deleteAiCheckpoint?: (p: string, id: string) => Promise<void> }).deleteAiCheckpoint = async (_p, id) => { deleted.push(id); h.server.rows.delete(id); };
    return deleted;
  };

  it('fix round 2 (N1): when the notes become restricted, every brief check of that run and task, waiting or closed, is kept on this device only and its server copy deleted', async () => {
    const h = setup({ currentBriefSha: () => null });
    const deleted = withDelete(h);
    const id = await pauseVerify(h, 'b'.repeat(64));
    const closed = { ...h.engine.store.getState().checkpoints[id]!, checkpointId: 'ckp_verify_closed_0001', status: 'sent' as const };
    await h.engine.keep(closed);
    const other = { ...closed, checkpointId: 'ckp_verify_othertask1', taskId: 't9' };
    await h.engine.keep(other);
    expect(JSON.stringify([...h.server.rows.values()])).toContain('Boards sort by votes.');
    await h.engine.restrictBriefChecks('run', 't1');
    expect(deleted.sort()).toEqual([closed.checkpointId, id].sort());
    const left = [...h.server.rows.values()].filter((c) => c.taskId === 't1');
    expect(JSON.stringify(left)).not.toContain('Boards sort by votes.');
    for (const cid of [id, closed.checkpointId]) {
      const c = h.engine.store.getState().checkpoints[cid]!;
      expect(c).toMatchObject({ locked: true, labels: ['restricted'], continuation: 'device_only' });
      expect(c.partial!.texts.every((t) => t.classification === 'restricted')).toBe(true);
      expect(h.engine.store.getState().deviceOnly[cid]).toBe(true);
    }
    // Another task's check is left alone.
    expect(h.server.rows.get(other.checkpointId)).toBeDefined();
  });

  it('fix round 2 (N1): Drop leaves no brief text on the server', async () => {
    const h = setup({ currentBriefSha: () => null });
    const id = await pauseVerify(h, 'b'.repeat(64));
    await h.engine.drop(id);
    expect(h.server.rows.get(id)).toMatchObject({ status: 'dropped' });
    expect(JSON.stringify(h.server.rows.get(id))).not.toContain('Boards sort by votes.');
  });

  it('fix round 2 (N3): a restricted write of notes or a reviewed brief always deletes the server copy, even when this tab never saw one', async () => {
    const h = setup();
    const deleted = withDelete(h);
    await h.engine.keep(notes('restricted'));
    expect(deleted).toEqual(['ckp_notes_restricted_00000001']);
  });
});

