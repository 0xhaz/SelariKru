import { describe, expect, it } from 'vitest';
import { approveBrief, briefFromOutput } from './brief.ts';
import { approvedBriefSha, briefKey, checkStateAfterResume, pmBrief } from './brief-store.ts';

const draft = () => approveBrief(briefFromOutput({ goal: 'g', items: [{ id: 'P1', text: 'x', kind: 'fact', checkable: true, source: 'points', from: [1] }], uncertainties: [], omitted: [] }, 'internal', [{ n: 1, text: 'x', list: 'points' }]));

describe('the plan brief store (H13 fix round 1)', () => {
  it('M3: an approval belongs to its run and subject task: another task of the run has none', () => {
    pmBrief.setState({ runs: {} });
    pmBrief.getState().set(briefKey('run', 't1'), () => ({ draft: draft() }));
    expect(approvedBriefSha('run', 't1')).toMatch(/^[0-9a-f]{64}$/);
    expect(approvedBriefSha('run', 't2')).toBeNull();
    expect(approvedBriefSha('other', 't1')).toBeNull();
  });

  it('M2: a resumed check that was refused shows as failed with its refusal; a paused one as paused; an ok one as done', () => {
    expect(checkStateAfterResume('pmVerify', { kind: 'refused', code: 'verify_device_only' }, 'a'.repeat(64))).toEqual({ kind: 'pmVerify', status: 'failed', message: 'You set this task to run on this device only, so the brief is not checked in the cloud for it.' });
    const blocked = { kind: 'result', simulated: false, result: { proposal: { status: 'blocked', blockedReason: 'offline', data: null }, grounding: null } } as never;
    expect(checkStateAfterResume('pmVerify', blocked, 'a'.repeat(64))).toMatchObject({ status: 'paused', reason: 'Waiting for connection' });
    const ok = { kind: 'result', simulated: true, result: { proposal: { status: 'ok', blockedReason: null, data: { items: [], uncertainties: [] } }, grounding: null } } as never;
    expect(checkStateAfterResume('pmVerify', ok, 'a'.repeat(64))).toMatchObject({ status: 'done', resumed: true, briefSha256: 'a'.repeat(64) });
    expect(checkStateAfterResume('pmVerify', ok, null)).toMatchObject({ status: 'failed' });
  });
});
