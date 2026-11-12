import { describe, expect, it } from 'vitest';
import { createMockDataSource, createSeededClock, fixtureTime, scoped } from '@selarikru/data-source-mock';
import { FirebaseHybridAssistantAdapter } from '@selarikru/inference-firebase-web';
import { createAgents, fetchRouteFrom } from '../hybrid/agents.ts';
import { createDemoSdk } from '../hybrid/demo-sdk.ts';
import { memoryDeviceStore } from '../checkpoints/device-store.ts';
import { createCheckpointEngine, type CheckpointRunner } from '../checkpoints/engine.ts';
import { pausedRows } from '../checkpoints/model.ts';
import { createCloudQuota } from './cloud-quota.ts';

/**
 * H9: the hosted demo's cloud call cap, end to end on demo data with the real adapter, agents port and checkpoint engine (a stand-in SDK in place of the model):
 * once the cap is spent, a cloud step pauses as a checkpoint with a clear reason, and a device step still runs.
 */
const id = (local: string) => scoped('feature-delivery', local);

describe('the hosted demo\'s cloud call cap (H9)', () => {
  it('one cloud call spends the cap of 1; the next Cloud only step waits in Paused AI work as cloud_quota; a Local only step still runs', async () => {
    const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
    const projectId = 'demo-feature-delivery';
    const snapshot = await ds.getSnapshot(projectId);
    const quota = createCloudQuota({ limit: 1, storage: null });
    const adapter = new FirebaseHybridAssistantAdapter({ sdk: createDemoSdk(), fetchRoute: fetchRouteFrom(ds), cloudCalls: quota });
    const engine = createCheckpointEngine({
      projectId, ownerKey: 'demo-operator', device: memoryDeviceStore(), server: ds,
      getTaskRoute: (t) => ds.getTaskRoute!(projectId, t), getTaskContext: (t, d, o, c) => ds.getTaskContext!(projectId, t, d, o, c), snapshot: () => snapshot, isOnline: () => true,
    });
    const agents = createAgents({ projectId, source: ds, adapter, simulated: true, execute: (c) => ds.execute(c), snapshot: () => snapshot, checkpoints: engine })!;
    engine.attach(agents as unknown as CheckpointRunner);

    const first = await agents.run({ taskId: id('contract'), kind: 'criteria', callOverride: null });
    expect(first.kind === 'result' && first.result.proposal).toMatchObject({ status: 'ok', observedSource: 'IN_CLOUD' });
    expect(quota.store.getState()).toEqual({ limit: 1, used: 1 });

    const second = await agents.run({ taskId: id('contract'), kind: 'breakdown', callOverride: null });
    expect(second.kind === 'result' && second.result.proposal).toMatchObject({ status: 'blocked', blockedReason: 'cloud_quota' });
    const rows = pausedRows(engine.store.getState(), (t) => snapshot.tasks[t]?.title ?? t, true);
    expect(rows).toEqual([expect.objectContaining({ stop: 'Cloud call limit reached for this demo', resume: 'This demo tab has used all its cloud calls. Move it to this device, or drop it.' })]);

    const local = await agents.run({ taskId: id('integrate'), kind: 'criteria', callOverride: null });
    expect(local.kind === 'result' && local.result.proposal.observedSource).toBe('ON_DEVICE');
    expect(quota.store.getState().used).toBe(1);
  });
});
