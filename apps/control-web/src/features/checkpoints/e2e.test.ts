import { describe, expect, it } from 'vitest';
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
