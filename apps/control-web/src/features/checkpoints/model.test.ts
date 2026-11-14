import { describe, expect, it } from 'vitest';
import type { AiCheckpoint } from '@selarikru/domain';
import { checkpointActivity, pausedRows, resumedText, sendsText, waitingCloudCalls } from './model.ts';

const CANARY = 'CANARY-H12-model-55';
const cp = (over: Partial<AiCheckpoint> = {}): AiCheckpoint => ({
  checkpointId: 'ckp_model_0000001', projectId: 'p', taskId: 't1', taskRevision: 1, runId: 'run', planRevision: 1, stepKind: 'patch', stage: 'patch',
  callOverride: null, routeMode: 'ONLY_IN_CLOUD', continuation: 'cloud_capable', labels: ['internal'], locked: false,
  inputs: { contextId: 'ctx_1', bundleSha256: null, files: [{ path: 'src/a.ts', sha256: null }], inputChars: 1200 }, partial: null, stopReason: 'offline', status: 'waiting', routeRecordId: null,
  escalatedAt: null, resumedAs: null, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', ...over,
});
const titles = (id: string) => (id === 't1' ? 'Search index' : id);
const state = (cps: AiCheckpoint[], over: Record<string, unknown> = {}) => ({ checkpoints: Object.fromEntries(cps.map((c) => [c.checkpointId, c])), problems: {}, asks: {}, busy: {}, ...over });

describe('Paused AI work (H12)', () => {
  it('lists waiting steps with their stop reason; offline is "Waiting for connection", and Resume waits for the connection', () => {
    const [row] = pausedRows(state([cp(), cp({ checkpointId: 'ckp_model_done0001', status: 'sent' })]), titles, false);
    expect(row).toMatchObject({ headline: 'Waiting for connection: Search index · Propose change', resume: 'Waiting for connection.', moveToDevice: null });
    expect(pausedRows(state([cp()]), titles, true)[0]!.resume).toBeNull();
  });

  it('outside the plan the owner is asked: "Resume in cloud? <task> · <step>"', () => {
    expect(pausedRows(state([cp()], { asks: { ckp_model_0000001: 'resume' } }), titles, true)[0]!.headline).toBe('Resume in cloud? Search index · Propose change');
  });

  it('a refused re-validation says why, and offers only Move to device only and Drop', () => {
    const [row] = pausedRows(state([cp()], { problems: { ckp_model_0000001: ['budget_missing'] } }), titles, true);
    expect(row!.problems[0]).toMatch(/no budget set.*Missing is never unlimited/);
    // Fix round 1 (M4): Resume runs the check again, so it is offered while online, problems or not.
    expect(row!.resume).toBeNull();
    expect(row!.moveToDevice).toBeNull();
  });

  it('what would be sent: a restricted checkpoint shows sizes and labels only', () => {
    const restricted = cp({ labels: ['restricted'], inputs: { contextId: null, bundleSha256: null, files: [{ path: `src/${CANARY}.ts`, sha256: null }], inputChars: 300 }, partial: { issues: [], texts: [{ who: 'owner', text: CANARY, classification: 'restricted' }] } });
    expect(sendsText(restricted)).not.toContain(CANARY);
    expect(sendsText(restricted)).toMatch(/300 characters · 1 file · labels: restricted/);
    expect(sendsText(cp())).toContain('src/a.ts');
  });

  it('activity: Paused: offline, Sent after reconnecting, Escalated to cloud', () => {
    const items = checkpointActivity([cp(), cp({ checkpointId: 'ckp_b', status: 'sent' }), cp({ checkpointId: 'ckp_c', status: 'escalated' })], titles).map((i) => i.text);
    expect(items).toEqual(['Search index · Propose change: Paused: offline', 'Search index · Propose change: Sent after reconnecting', 'Search index · Propose change: Escalated to cloud: local result failed checks']);
    expect(resumedText('after_reconnect')).toBe('Sent after reconnecting');
  });

  it('M1: a step the owner resumed reads "Resumed by owner", never "Sent after reconnecting"', () => {
    const items = checkpointActivity([cp({ status: 'sent', resumedAs: 'owner_resume' }), cp({ checkpointId: 'ckp_b', status: 'sent', resumedAs: 'after_reconnect' }), cp({ checkpointId: 'ckp_c', status: 'sent' })], titles).map((i) => i.text);
    expect(items).toEqual(['Search index · Propose change: Resumed by owner', 'Search index · Propose change: Sent after reconnecting', 'Search index · Propose change: Sent after reconnecting']);
    expect(resumedText('owner_resume')).toBe('Resumed by owner');
  });

  it('the office: only a waiting cloud step stands at the cloud deck', () => {
    expect(waitingCloudCalls([cp(), cp({ checkpointId: 'ckp_d', continuation: 'device_only', stopReason: 'input_too_large_for_device' }), cp({ checkpointId: 'ckp_e', status: 'sent' })])).toEqual([{ taskId: 't1', place: 'cloud', stepKind: 'patch', waiting: true }]);
  });

  it('fix 2: an abandoned step is visible, "Abandoned: <task> · <step>", in the feed and in the list, where it can be run again from scratch', () => {
    const gone = cp({ checkpointId: 'ckp_abandoned_001', status: 'abandoned', stopReason: null });
    expect(checkpointActivity([gone], titles).map((i) => i.text)).toEqual(['Abandoned: Search index · Propose change']);
    const rows = pausedRows(state([gone]), titles, true);
    expect(rows).toEqual([expect.objectContaining({ id: 'ckp_abandoned_001', headline: 'Abandoned: Search index · Propose change', abandoned: true })]);
    // Dismissed: no longer listed.
    expect(pausedRows(state([gone], { dismissed: { ckp_abandoned_001: true } }), titles, true)).toEqual([]);
  });
});

describe('H9: the hosted demo\'s cloud call cap', () => {
  it('a step paused by the cap says so plainly, offers no Resume (nothing more can be sent from this tab), and keeps Move to device only and Drop', () => {
    const [row] = pausedRows(state([cp({ stopReason: 'cloud_quota' })]), titles, true);
    expect(row).toMatchObject({ stop: 'Cloud call limit reached for this demo', headline: 'Cloud call limit reached for this demo: Search index · Propose change', moveToDevice: null });
    expect(row!.resume).toBe('This demo tab has used all its cloud calls. Move it to this device, or drop it.');
  });
});

describe('H13 fix round 1 (H1): a cloud check is never moved to this device', () => {
  it('Move to device only is disabled for a paused brief check and for web research, and says why', () => {
    for (const stepKind of ['pmVerify', 'pmVerifyNoWeb', 'pmResearch'] as const) {
      const [row] = pausedRows(state([cp({ stepKind, stage: 'pm_turn', callOverride: 'ONLY_IN_CLOUD' })]), titles, true);
      expect(row!.moveToDevice).toBe('A cloud check can\'t run on this device. Drop it, or check again.');
    }
  });
});

