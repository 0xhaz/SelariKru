import { describe, expect, it } from 'vitest';
import type { AiCheckpoint } from '@selarikru/domain';
import { buildFixture, createMockDataSource, createSeededClock, fixtureTime, scoped } from '../src/index.ts';

/** H12: the demo keeps AI step checkpoints the way the server does: the same storage split, refusals and one-time escalation. Demo data, never evidence. */
const id = (local: string) => scoped('feature-delivery', local);
async function setup() {
  const ds = createMockDataSource({ clock: createSeededClock(fixtureTime(0)) });
  const f = buildFixture('feature-delivery');
  const snap = await ds.getSnapshot(f.projectId);
  const runId = Object.keys(snap.runs)[0]!;
  const cp = (over: Partial<AiCheckpoint> = {}): AiCheckpoint => ({
    checkpointId: 'ckp_demo_000000001', projectId: f.projectId, taskId: id('search'), taskRevision: snap.tasks[id('search')]!.revision, runId, planRevision: snap.runs[runId]!.planRevision,
    stepKind: 'criteria', stage: 'criteria', callOverride: 'ONLY_IN_CLOUD', routeMode: 'ONLY_IN_CLOUD', continuation: 'cloud_capable', labels: ['internal'], locked: false,
    inputs: { contextId: null, bundleSha256: null, files: [], inputChars: 100 }, partial: null, stopReason: 'offline', status: 'waiting', routeRecordId: null,
    escalatedAt: null, resumedAs: null, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', ...over,
  });
  return { ds, f, snap, runId, cp };
}

describe('the demo\'s AI step checkpoints (H12)', () => {
  it('keeps an internal checkpoint and lists it', async () => {
    const { ds, f, cp } = await setup();
    await ds.saveAiCheckpoint!(f.projectId, cp());
    expect(await ds.listAiCheckpoints!(f.projectId)).toEqual([cp()]);
  });

  it('refuses a restricted or locked one, and one about a locked task, as the server does; nothing is kept', async () => {
    const { ds, f, cp } = await setup();
    await expect(ds.saveAiCheckpoint!(f.projectId, cp({ labels: ['restricted'] }))).rejects.toThrow(/checkpoint_restricted/);
    await expect(ds.saveAiCheckpoint!(f.projectId, cp({ locked: true }))).rejects.toThrow(/checkpoint_restricted/);
    await expect(ds.saveAiCheckpoint!(f.projectId, cp({ taskId: id('e2e') }))).rejects.toThrow(/checkpoint_restricted/);
    await expect(ds.saveAiCheckpoint!(f.projectId, cp({ partial: { issues: [], texts: [{ who: 'owner', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123', classification: 'internal' }] } }))).rejects.toThrow(/checkpoint_secret/);
    expect(await ds.listAiCheckpoints!(f.projectId)).toEqual([]);
  });

  it('a closed checkpoint does not reopen; escalation happens once, on Local first only', async () => {
    const { ds, f, cp } = await setup();
    const failed = cp({ checkpointId: 'ckp_demo_escalate1', stopReason: 'local_failed_checks', routeMode: 'PREFER_ON_DEVICE', callOverride: null, stepKind: 'patch', stage: 'reask' });
    await ds.saveAiCheckpoint!(f.projectId, failed);
    const claimed = await ds.claimAiCheckpointEscalation!(f.projectId, failed.checkpointId);
    expect(claimed.escalatedAt).toEqual(expect.any(String));
    await expect(ds.claimAiCheckpointEscalation!(f.projectId, failed.checkpointId)).rejects.toThrow(/already_escalated/);
    // The contract task runs Cloud only: not Local first.
    const contract = cp({ checkpointId: 'ckp_demo_escalate2', taskId: id('contract'), stopReason: 'local_failed_checks', callOverride: null });
    await ds.saveAiCheckpoint!(f.projectId, contract);
    await expect(ds.claimAiCheckpointEscalation!(f.projectId, contract.checkpointId)).rejects.toThrow(/not_local_first/);
    await ds.saveAiCheckpoint!(f.projectId, cp({ status: 'sent', resumedAs: 'after_reconnect' }));
    await expect(ds.saveAiCheckpoint!(f.projectId, cp())).rejects.toThrow(/checkpoint_closed/);
  });

  it('a resumed call\'s route record says so', async () => {
    const { ds, f } = await setup();
    const report = { kind: 'route' as const, requestId: 'req-resumed', stepKind: 'criteria' as const, callOverride: 'ONLY_IN_CLOUD' as const, requestedMode: 'ONLY_IN_CLOUD' as const, observedSource: 'IN_CLOUD' as const, status: 'ok' as const,
      model: { cloudModel: 'gemini-2.5-flash-lite', sdkVersion: '12.5.0' }, timing: { totalMs: 640, firstOutputMs: null }, validation: 'passed' as const, blockedReason: null, resumed: 'after_reconnect' as const, checkpointId: 'ckp_demo_000000001' };
    await ds.execute({ command: 'route.report', expectedRevision: 0, idempotencyKey: 'r1', args: { projectId: f.projectId, taskId: id('search'), report } });
    const read = await ds.getTaskRoute!(f.projectId, id('search'));
    expect(read.records[0]).toMatchObject({ resumed: 'after_reconnect', checkpointId: 'ckp_demo_000000001' });
  });

  it('the demo run has a configured budget, so a cloud step can be sent after reconnecting', async () => {
    const { snap, runId } = await setup();
    expect(snap.runs[runId]!.policy?.budgetLimitUsd).toMatchObject({ basis: 'configured' });
  });
});
