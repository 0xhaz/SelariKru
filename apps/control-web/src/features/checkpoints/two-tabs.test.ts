import { describe, expect, it } from 'vitest';
import type { AiCheckpoint } from '@selarikru/domain';
import type { TaskAgentContext, TaskRouteRead } from '@selarikru/view-protocol';
import { snapshotOf, task } from '../overview/testing.ts';
import { memoryDeviceStore } from './device-store.ts';
import { createCheckpointEngine, type CheckpointEngineDeps, type CheckpointRunner } from './engine.ts';
import { pausedRows } from './model.ts';

/**
 * H12 fix round 3 (R1): a second tab never marks a live claim as abandoned. Two engines share one server (as two tabs of one owner do) and one device store. The
 * fake server keeps the claim time apart from the body, as an old server did, so only the engine's own server-first rule can protect the claim.
 */
const MIN = 60_000;
const T0 = Date.parse('2026-11-12T12:00:00.000Z');
const cp = (over: Partial<AiCheckpoint> = {}): AiCheckpoint => ({
  checkpointId: 'ckp_two_tabs_000001', projectId: 'p', taskId: 't1', taskRevision: 1, runId: 'run', planRevision: 1, stepKind: 'criteria', stage: 'criteria',
  callOverride: null, routeMode: 'ONLY_IN_CLOUD', continuation: 'cloud_capable', labels: ['internal'], locked: false,
  inputs: { contextId: null, bundleSha256: null, files: [], inputChars: 10 }, partial: null, stopReason: 'offline', status: 'waiting', routeRecordId: null,
  escalatedAt: null, resumedAs: null, createdAt: new Date(T0 - 45 * MIN).toISOString(), updatedAt: new Date(T0 - 45 * MIN).toISOString(), ...over,
});

function sharedServer(nowMs: () => number) {
  const rows = new Map<string, AiCheckpoint>();
  const tokens = new Map<string, string>();
  const claimedAt = new Map<string, number>();
  let online = true;
  const api = {
    rows, setOnline: (v: boolean) => { online = v; },
    saveAiCheckpoint: async (_p: string, c: AiCheckpoint) => {
      if (!online) throw new Error('unavailable: network error');
      const prior = rows.get(c.checkpointId);
      if (prior && ['done', 'sent', 'escalated', 'moved_to_device', 'dropped', 'abandoned'].includes(prior.status) && prior.status !== c.status) throw new Error(`checkpoint_closed: already ${prior.status}`);
      if (prior?.status === 'sending') {
        const holder = c.claimToken !== undefined && c.claimToken === tokens.get(c.checkpointId);
        const stale = c.status === 'abandoned' && nowMs() - (claimedAt.get(c.checkpointId) ?? 0) > 30 * MIN;
        if (!holder && !stale) throw new Error('checkpoint_claimed: another tab is sending this step');
      }
      tokens.delete(c.checkpointId);
      const { claimToken: _t, ...rest } = c;
      void _t;
      rows.set(c.checkpointId, rest);
    },
    listAiCheckpoints: async () => { if (!online) throw new Error('unavailable: network error'); return [...rows.values()]; },
    claimAiCheckpointSend: async (_p: string, id: string) => {
      if (!online) throw new Error('unavailable: network error');
      const c = rows.get(id);
      if (!c) throw new Error('checkpoint_not_found: none');
      if (c.status !== 'waiting') throw new Error(`checkpoint_claimed: ${c.status}`);
      // As an old server did: the claim time is kept apart; the body's updatedAt is left as it was.
      const next = { ...c, status: 'sending' as const };
      rows.set(id, next);
      claimedAt.set(id, nowMs());
      tokens.set(id, 'tok_aaaaaaaaaaaaaaaaaaaa');
      return { ...next, claimToken: 'tok_aaaaaaaaaaaaaaaaaaaa' };
    },
  };
  return api;
}

const route = { effective: 'ONLY_IN_CLOUD', source: 'task', runDefault: 'PREFER_ON_DEVICE', override: 'ONLY_IN_CLOUD', overrideRevision: 1, lock: null, suggestion: null, lastObserved: null } as never;
const context = { taskId: 't1', revision: 1, runId: 'run', planRevision: 1, destination: 'cloud', task: { title: 'Search', description: null, criteria: [], allowedPaths: ['src'], classification: 'internal' },
  bundle: { schemaVersion: 1, destination: 'cloud', taskId: 't1', compilationVersion: null, generator: { id: 'g', version: '1' }, watermark: 0, sourceHead: 0, indexLag: 0, recordsPending: false, compiledAt: null, pinned: [], claims: [], omissions: [], contentLabel: 'internal' },
  change: null, simulated: true } as unknown as TaskAgentContext;

function engineFor(server: ReturnType<typeof sharedServer>, device: ReturnType<typeof memoryDeviceStore>, nowMs: () => number, online: () => boolean) {
  const s = snapshotOf({ tasks: [task('t1', { title: 'Search index', status: 'planned', route })] });
  const snap = { ...s, runs: { run: { ...s.runs['run']!, policy: { budgetLimitUsd: { value: 10, basis: 'configured' } } as never } } };
  const deps: CheckpointEngineDeps = {
    projectId: 'p', ownerKey: 'owner_1', device, server,
    getTaskRoute: async (taskId) => ({ taskId, revision: 1, runId: 'run', route, records: [] }) as TaskRouteRead,
    getTaskContext: async () => context, snapshot: () => snap, isOnline: online, now: () => new Date(nowMs()),
  };
  return createCheckpointEngine(deps);
}

describe('two tabs (H12 fix round 3, R1)', () => {
  it('tab A claims a checkpoint last touched 45 minutes ago and is still sending it; tab B loads: B does not mark it abandoned and offers no Run again', async () => {
    const now = () => T0;
    const server = sharedServer(now);
    const device = memoryDeviceStore();
    await server.saveAiCheckpoint('p', cp());
    await device.put('owner_1', cp());
    const a = engineFor(server, device, now, () => true);
    await a.load();
    // A's step is in flight: its runner never answers in this test, so the claim stays held.
    let started!: () => void;
    const inFlight = new Promise<void>((r) => { started = r; });
    a.attach({ run: async () => { started(); return new Promise(() => undefined); }, pm: async () => undefined } as unknown as CheckpointRunner);
    void a.resume('ckp_two_tabs_000001');
    await inFlight;
    expect(server.rows.get('ckp_two_tabs_000001')!.status).toBe('sending');

    // B is another browser of the same owner: it has no copy of its own, only the server's.
    const elsewhere = memoryDeviceStore();
    const b = engineFor(server, elsewhere, now, () => true);
    await b.load();
    expect(server.rows.get('ckp_two_tabs_000001')!.status).toBe('sending');
    expect(b.store.getState().checkpoints['ckp_two_tabs_000001']!.status).not.toBe('abandoned');
    expect(pausedRows(b.store.getState(), () => 'Search index', true).filter((r) => r.abandoned)).toEqual([]);
    expect((await elsewhere.list('owner_1', 'p')).filter((c) => c.status === 'abandoned')).toEqual([]);
  });

  it('offline, nothing is marked abandoned: it waits for the connection', async () => {
    const now = () => T0;
    const server = sharedServer(now);
    const device = memoryDeviceStore();
    await device.put('owner_1', cp({ status: 'running', stopReason: null }));
    server.setOnline(false);
    const b = engineFor(server, device, now, () => false);
    await b.load();
    expect(b.store.getState().checkpoints['ckp_two_tabs_000001']!.status).toBe('running');
    expect((await device.list('owner_1', 'p'))[0]!.status).toBe('running');
  });

  it('a claim truly left for more than 30 minutes is abandoned, server first', async () => {
    let t = T0;
    const server = sharedServer(() => t);
    const device = memoryDeviceStore();
    await server.saveAiCheckpoint('p', cp());
    await server.claimAiCheckpointSend('p', 'ckp_two_tabs_000001');
    t = T0 + 31 * MIN;
    const b = engineFor(server, device, () => t, () => true);
    await b.load();
    expect(server.rows.get('ckp_two_tabs_000001')!.status).toBe('abandoned');
    expect(b.store.getState().checkpoints['ckp_two_tabs_000001']!.status).toBe('abandoned');
  });

  it('R2: offline, this tab moves a step to device only while another tab sends it; on reconnect the server refuses the late write, and this tab adopts the server\'s copy (sent) instead of keeping its own', async () => {
    let online = true;
    const now = () => T0;
    const server = sharedServer(now);
    const device = memoryDeviceStore();
    await server.saveAiCheckpoint('p', cp({ updatedAt: new Date(T0).toISOString() }));
    const b = engineFor(server, device, now, () => online);
    await b.load();
    b.attach({
      run: async (req: { taskId: string; kind: string; callOverride: null; resume?: { checkpointId: string; kind: 'device_only' } }) => {
        const rec = b.begin({ taskId: req.taskId, stepKind: req.kind as never, callOverride: req.callOverride, ...(req.resume ? { resumeOf: req.resume.checkpointId, resumedAs: req.resume.kind } : {}) });
        const proposal = { status: 'ok', blockedReason: null, observedSource: 'ON_DEVICE', requestId: 'req_d', validation: { status: 'passed', errors: [] }, route: { effectiveMode: 'ONLY_ON_DEVICE' }, input: null } as never;
        const result = { kind: 'criteria', proposal, report: { requestId: 'req_d' }, reported: 'sent', omissions: [], locked: false } as never;
        await rec.finish({ kind: 'result', result, context });
        return { kind: 'result', result, context };
      },
      pm: async () => undefined,
    } as unknown as CheckpointRunner);
    online = false;
    server.setOnline(false);
    await b.moveToDevice('ckp_two_tabs_000001');
    expect(b.store.getState().checkpoints['ckp_two_tabs_000001']!.status).toBe('moved_to_device');
    // Meanwhile another tab sent it.
    server.rows.set('ckp_two_tabs_000001', { ...server.rows.get('ckp_two_tabs_000001')!, status: 'sent', resumedAs: 'after_reconnect' });
    online = true;
    server.setOnline(true);
    await b.reconnect();
    expect(server.rows.get('ckp_two_tabs_000001')!.status).toBe('sent');
    expect(b.store.getState().checkpoints['ckp_two_tabs_000001']!.status).toBe('sent');
    expect((await device.list('owner_1', 'p'))[0]!.status).toBe('sent');
    // Not retried again: a refusal is not a network failure.
    await b.reconnect();
    expect(b.store.getState().checkpoints['ckp_two_tabs_000001']!.status).toBe('sent');
  });
});
