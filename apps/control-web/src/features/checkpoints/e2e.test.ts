import { describe, expect, it } from 'vitest';
import { AIError, AIErrorCode } from 'firebase/ai';
import { createMockDataSource, createSeededClock, fixtureTime, scoped } from '@selarikru/data-source-mock';
import { createAgents, type AgentsOutcome } from '../hybrid/agents.ts';
import { createDemoSdk } from '../hybrid/demo-sdk.ts';
import { connectivity } from './connectivity.ts';
import { memoryDeviceStore } from './device-store.ts';
import { createCheckpointEngine, type CheckpointRunner } from './engine.ts';

/**
 * H12 end to end on demo data, with the real adapter and the real agents port: offline, a cloud step waits as a checkpoint (not an error); on reconnect it is
 * re-validated and sent inside the accepted plan, and its route record says "after_reconnect", never a fallback.
 */
const id = (local: string) => scoped('feature-delivery', local);

describe('offline queue, end to end on demo data (H12)', () => {
  it('a Cloud only step waits offline, then is sent after reconnecting, recorded as resumed', async () => {
    const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
    const projectId = 'demo-feature-delivery';
    const snapshot = await ds.getSnapshot(projectId);
    const device = memoryDeviceStore();
    const engine = createCheckpointEngine({
      projectId, ownerKey: 'demo-operator', device, server: ds,
      getTaskRoute: (t) => ds.getTaskRoute!(projectId, t), getTaskContext: (t, d, o, c) => ds.getTaskContext!(projectId, t, d, o, c),
      snapshot: () => snapshot, isOnline: () => connectivity.getState().simulatedOffline === false,
    });
    const resumed: AgentsOutcome[] = [];
    const agents = createAgents({ projectId, source: ds, sdk: createDemoSdk(), simulated: true, execute: (c) => ds.execute(c), snapshot: () => snapshot, checkpoints: engine, onResumed: (_r, o) => resumed.push(o as AgentsOutcome) })!;
    engine.attach(agents as unknown as CheckpointRunner);

    connectivity.getState().simulateOffline(true);
    try {
      const out = await agents.run({ taskId: id('contract'), kind: 'criteria', callOverride: null });
      expect(out.kind === 'result' && out.result.proposal).toMatchObject({ status: 'blocked', blockedReason: 'offline' });
      const waiting = Object.values(engine.store.getState().checkpoints);
      expect(waiting).toEqual([expect.objectContaining({ status: 'waiting', stopReason: 'offline', taskId: id('contract'), continuation: 'cloud_capable' })]);
      // Kept in this browser and by the (demo) server.
      expect(await device.list('demo-operator', projectId)).toHaveLength(1);
      expect(await ds.listAiCheckpoints!(projectId)).toHaveLength(1);
      // A device step still runs offline.
      const local = await agents.run({ taskId: id('search'), kind: 'criteria', callOverride: null });
      expect(local.kind === 'result' && local.result.proposal.observedSource).toBe('ON_DEVICE');
    } finally {
      connectivity.getState().simulateOffline(false);
    }
    await engine.reconnect();
    const cp = Object.values(engine.store.getState().checkpoints).find((c) => c.taskId === id('contract'))!;
    expect(cp).toMatchObject({ status: 'sent', resumedAs: 'after_reconnect' });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.kind === 'result' && resumed[0]!.result.proposal).toMatchObject({ status: 'ok', observedSource: 'IN_CLOUD' });
    expect(resumed[0]!.resumed).toBe('after_reconnect');
    const read = await ds.getTaskRoute!(projectId, id('contract'));
    expect(read.records[0]).toMatchObject({ resumed: 'after_reconnect', checkpointId: cp.checkpointId, fellBack: false });
  });
});

describe('fix 1 (I2): a network blip, end to end on demo data', () => {
  it('with navigator.onLine true, a cloud request that fails on the network waits; after the backoff the probe sends it, and the failure clears', async () => {
    const { vi } = await import('vitest');
    const { FirebaseHybridAssistantAdapter } = await import('@selarikru/inference-firebase-web');
    const { createConnectivity, isOnlineState, onReconnect } = await import('./connectivity.ts');
    const { fetchRouteFrom } = await import('../hybrid/agents.ts');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
      const projectId = 'demo-feature-delivery';
      const snapshot = await ds.getSnapshot(projectId);
      const c = createConnectivity(true);
      const demo = createDemoSdk();
      let fail = true;
      // The first cloud request fails on the network, as the Firebase SDK reports it; later ones answer.
      const sdk = { ...demo, createModel: (spec: Parameters<typeof demo.createModel>[0]) => { const m = demo.createModel(spec); return { generate: async (p: string) => { if (spec.allowCloud && fail) { fail = false; throw new AIError(AIErrorCode.ERROR, 'Error fetching from https://firebasevertexai.googleapis.com/v1beta/x:generateContent: Failed to fetch'); } return m.generate(p); } }; } };
      const adapter = new FirebaseHybridAssistantAdapter({ sdk, fetchRoute: fetchRouteFrom(ds), isOnline: () => isOnlineState(c.getState()), onNetworkFailure: (e) => c.getState().reportNetworkFailure(e), onNetworkSuccess: () => c.getState().reportNetworkSuccess() });
      const engine = createCheckpointEngine({
        projectId, ownerKey: 'demo-operator', device: memoryDeviceStore(), server: ds,
        getTaskRoute: (t) => ds.getTaskRoute!(projectId, t), getTaskContext: (t, d, o, x) => ds.getTaskContext!(projectId, t, d, o, x),
        snapshot: () => snapshot, isOnline: () => isOnlineState(c.getState()),
      });
      const agents = createAgents({ projectId, source: ds, adapter, simulated: true, execute: (x) => ds.execute(x), snapshot: () => snapshot, checkpoints: engine })!;
      engine.attach(agents as unknown as CheckpointRunner);
      let pending: Promise<void> | null = null;
      onReconnect(c, () => { pending = engine.reconnect(); });
      const out = await agents.run({ taskId: id('contract'), kind: 'criteria', callOverride: null });
      expect(out.kind === 'result' && out.result.proposal).toMatchObject({ status: 'blocked', blockedReason: 'offline' });
      expect(c.getState()).toMatchObject({ navigatorOnline: true, networkFailed: true });
      const cpId = Object.values(engine.store.getState().checkpoints)[0]!.checkpointId;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pending).not.toBeNull();
      await pending;
      expect(engine.store.getState().checkpoints[cpId]).toMatchObject({ status: 'sent', resumedAs: 'after_reconnect' });
      expect(c.getState()).toMatchObject({ networkFailed: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('H9 fix round 3: a 429 from the cloud, end to end on demo data', () => {
  it('never flips the app offline, pauses the step as the cloud quota or rate limit, and reconnecting does not resend it: the owner is asked', async () => {
    const { FirebaseHybridAssistantAdapter } = await import('@selarikru/inference-firebase-web');
    const { createConnectivity, isOnlineState } = await import('./connectivity.ts');
    const { fetchRouteFrom } = await import('../hybrid/agents.ts');
    const { pausedRows } = await import('./model.ts');
    const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
    const projectId = 'demo-feature-delivery';
    const snapshot = await ds.getSnapshot(projectId);
    const c = createConnectivity(true);
    const demo = createDemoSdk();
    let calls = 0;
    // Exactly as @firebase/ai 3.0.0 throws a non-OK response: fetch-error with the HTTP status.
    const sdk = { ...demo, createModel: (spec: Parameters<typeof demo.createModel>[0]) => ({ generate: async () => { calls += 1; throw new AIError(AIErrorCode.FETCH_ERROR, 'Error fetching from https://firebasevertexai.googleapis.com/v1beta/x:generateContent: [429 Too Many Requests] Resource exhausted', { status: 429, statusText: 'Too Many Requests' }); } }) };
    const adapter = new FirebaseHybridAssistantAdapter({ sdk, fetchRoute: fetchRouteFrom(ds), isOnline: () => isOnlineState(c.getState()), onNetworkFailure: (e) => c.getState().reportNetworkFailure(e), onNetworkSuccess: () => c.getState().reportNetworkSuccess() });
    const engine = createCheckpointEngine({
      projectId, ownerKey: 'demo-operator', device: memoryDeviceStore(), server: ds,
      getTaskRoute: (t) => ds.getTaskRoute!(projectId, t), getTaskContext: (t, d, o, x) => ds.getTaskContext!(projectId, t, d, o, x),
      snapshot: () => snapshot, isOnline: () => isOnlineState(c.getState()),
    });
    const agents = createAgents({ projectId, source: ds, adapter, simulated: true, execute: (x) => ds.execute(x), snapshot: () => snapshot, checkpoints: engine })!;
    engine.attach(agents as unknown as CheckpointRunner);
    const out = await agents.run({ taskId: id('contract'), kind: 'criteria', callOverride: null });
    expect(out.kind === 'result' && out.result.proposal).toMatchObject({ status: 'blocked', blockedReason: 'cloud_rate_limited' });
    expect(c.getState()).toMatchObject({ networkFailed: false });
    expect(isOnlineState(c.getState())).toBe(true);
    const cp = Object.values(engine.store.getState().checkpoints)[0]!;
    expect(cp).toMatchObject({ status: 'waiting', stopReason: 'cloud_rate_limited' });
    await engine.reconnect();
    expect(calls).toBe(1);
    expect(engine.store.getState().checkpoints[cp.checkpointId]).toMatchObject({ status: 'waiting' });
    expect(engine.store.getState().asks[cp.checkpointId]).toBe('resume');
    expect(pausedRows(engine.store.getState(), (t) => t, true)[0]).toMatchObject({ stop: 'Cloud quota or rate limit reached' });
  });
});
