import { describe, expect, it } from 'vitest';
import {
  AiCheckpointSchema, checkpointBudget, checkpointStorage, continuationFor, escalationDecision, pmPlanRoutes, resumeDisposition, revalidateCheckpoint, serverCheckpointRefusal, stopReasonFor,
  type AiCheckpoint, type CheckpointRecheck,
} from './ai-checkpoint.ts';

const HEX = 'a'.repeat(64);
const cp = (over: Partial<AiCheckpoint> = {}): AiCheckpoint => ({
  checkpointId: 'ckp_0123456789abcdef', projectId: 'p1', taskId: 't1', taskRevision: 2, runId: 'r1', planRevision: 3, stepKind: 'criteria', stage: 'criteria',
  callOverride: null, routeMode: 'ONLY_IN_CLOUD', continuation: 'cloud_capable', labels: ['internal'], locked: false,
  inputs: { contextId: 'ctx_1', bundleSha256: HEX, files: [], inputChars: 1200 }, partial: null, stopReason: 'offline', status: 'waiting', routeRecordId: 'req_1',
  escalatedAt: null, resumedAs: null, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', ...over,
});
const fine: CheckpointRecheck = { route: { mode: 'ONLY_IN_CLOUD', lock: false }, taskRevision: 2, budget: 'ok', inputs: { bundleSha256: HEX, files: [] }, context: 'ok' };

describe('AI step checkpoints (H12)', () => {
  it('the wire shape is strict: no field for anything but ids, hashes, sizes, codes and labelled text', () => {
    expect(AiCheckpointSchema.safeParse(cp()).success).toBe(true);
    expect(AiCheckpointSchema.safeParse({ ...cp(), prompt: 'the whole prompt' }).success).toBe(false);
    expect(AiCheckpointSchema.safeParse({ ...cp(), partial: { issues: [], texts: [{ who: 'owner', text: 'q' }] } }).success).toBe(false);
    expect(AiCheckpointSchema.safeParse({ ...cp(), stopReason: 'cloud_was_slow' }).success).toBe(false);
  });

  it('storage split: restricted, secret, unlabelled or locked checkpoints stay on the device; only public and internal ones go to the server', () => {
    expect(checkpointStorage(cp())).toBe('server');
    expect(checkpointStorage(cp({ labels: ['public', 'internal'] }))).toBe('server');
    expect(checkpointStorage(cp({ labels: ['internal', 'restricted'] }))).toBe('device');
    expect(checkpointStorage(cp({ labels: ['secret'] }))).toBe('device');
    expect(checkpointStorage(cp({ locked: true }))).toBe('device');
    expect(checkpointStorage(cp({ partial: { issues: [], texts: [{ who: 'owner', text: 'about the patients', classification: 'restricted' }] } }))).toBe('device');
    expect(checkpointStorage({ ...cp(), labels: ['unknown' as never] })).toBe('device');
  });

  it('the server refuses what would be device-only, and secret-shaped text in any form', () => {
    expect(serverCheckpointRefusal(cp())).toBeNull();
    expect(serverCheckpointRefusal(cp({ labels: ['restricted'] }))).toBe('checkpoint_restricted');
    expect(serverCheckpointRefusal(cp({ locked: true }))).toBe('checkpoint_restricted');
    expect(serverCheckpointRefusal(cp({ partial: { issues: [], texts: [{ who: 'owner', text: 'key AKIAABCDEFGHIJKLMNOP here', classification: 'internal' }] } }))).toBe('checkpoint_secret');
  });

  it('the continuation follows the route and the lock: device only when locked or Local only; cloud-capable otherwise', () => {
    expect(continuationFor({ mode: 'ONLY_IN_CLOUD', locked: false })).toBe('cloud_capable');
    expect(continuationFor({ mode: 'PREFER_ON_DEVICE', locked: false })).toBe('cloud_capable');
    expect(continuationFor({ mode: 'ONLY_ON_DEVICE', locked: false })).toBe('device_only');
    expect(continuationFor({ mode: 'PREFER_IN_CLOUD', locked: true })).toBe('device_only');
    expect(continuationFor({ mode: null, locked: false })).toBe('device_only');
  });

  it('stop reasons from the adapter\'s codes', () => {
    expect(stopReasonFor('offline')).toBe('offline');
    expect(stopReasonFor('input_too_large_for_device')).toBe('input_too_large_for_device');
    expect(stopReasonFor('route_changed_in_queue')).toBe('route_changed');
    // H9: the hosted demo's cloud call cap pauses a cloud step as a checkpoint.
    expect(stopReasonFor('cloud_quota')).toBe('cloud_quota');
    // H9 fix round 3: the cloud answered 429 (quota or rate limit): a pause with that reason, not offline.
    expect(stopReasonFor('cloud_rate_limited')).toBe('cloud_rate_limited');
    expect(stopReasonFor('secret_in_input')).toBeNull();
  });

  it('resume re-validation: refuses when the route, the lock, the inputs, the revision, the budget or the context changed, naming each', () => {
    expect(revalidateCheckpoint(cp(), fine)).toEqual({ ok: true });
    expect(revalidateCheckpoint(cp(), { ...fine, route: { mode: 'PREFER_IN_CLOUD', lock: false } })).toEqual({ ok: false, problems: ['route_changed'] });
    expect(revalidateCheckpoint(cp(), { ...fine, route: { mode: 'ONLY_ON_DEVICE', lock: true } })).toEqual({ ok: false, problems: ['route_changed', 'locked'] });
    expect(revalidateCheckpoint(cp(), { ...fine, route: null })).toEqual({ ok: false, problems: ['route_unreadable'] });
    expect(revalidateCheckpoint(cp(), { ...fine, taskRevision: 3 })).toEqual({ ok: false, problems: ['revision_changed'] });
    expect(revalidateCheckpoint(cp(), { ...fine, inputs: { bundleSha256: 'b'.repeat(64), files: [] } })).toEqual({ ok: false, problems: ['inputs_changed'] });
    expect(revalidateCheckpoint(cp({ inputs: { contextId: null, bundleSha256: null, files: [{ path: 'src/a.ts', sha256: HEX }], inputChars: 10 } }), { ...fine, inputs: { bundleSha256: null, files: [{ path: 'src/a.ts', sha256: 'c'.repeat(64) }] } })).toEqual({ ok: false, problems: ['inputs_changed'] });
    expect(revalidateCheckpoint(cp(), { ...fine, inputs: null })).toEqual({ ok: false, problems: ['inputs_changed'] });
    expect(revalidateCheckpoint(cp(), { ...fine, budget: 'missing' })).toEqual({ ok: false, problems: ['budget_missing'] });
    expect(revalidateCheckpoint(cp(), { ...fine, budget: 'exhausted' })).toEqual({ ok: false, problems: ['budget_exhausted'] });
    expect(revalidateCheckpoint(cp(), { ...fine, context: 'refused' })).toEqual({ ok: false, problems: ['context_refused'] });
    // A device-only resume needs no cloud budget.
    expect(revalidateCheckpoint(cp(), { ...fine, budget: 'missing' }, 'device')).toEqual({ ok: true });
    // A checkpoint that was already sent or dropped is never sent again.
    expect(revalidateCheckpoint(cp({ status: 'sent' }), fine)).toEqual({ ok: false, problems: ['not_waiting'] });
  });

  it('fix 1 (I1): an escalation skips only the route comparison; the budget, the lock and the inputs still apply', () => {
    const failed = cp({ stopReason: 'local_failed_checks', routeMode: 'PREFER_ON_DEVICE' });
    const now = { ...fine, route: { mode: 'PREFER_ON_DEVICE' as const, lock: false } };
    expect(revalidateCheckpoint(failed, { ...now, route: { mode: 'ONLY_IN_CLOUD', lock: false } }, 'cloud', { escalation: true })).toEqual({ ok: true });
    expect(revalidateCheckpoint(failed, { ...now, budget: 'missing' }, 'cloud', { escalation: true })).toEqual({ ok: false, problems: ['budget_missing'] });
    expect(revalidateCheckpoint(failed, { ...now, route: { mode: 'PREFER_ON_DEVICE', lock: true } }, 'cloud', { escalation: true })).toEqual({ ok: false, problems: ['locked'] });
  });

  it('the budget: a configured, unspent run budget is ok; missing is never unlimited, and a stopped run is spent', () => {
    expect(checkpointBudget({ value: 10, basis: 'configured' }, false)).toBe('ok');
    expect(checkpointBudget({ value: 25, basis: 'recommended' }, false)).toBe('missing');
    expect(checkpointBudget({ value: null, basis: 'unresolved' }, false)).toBe('missing');
    expect(checkpointBudget(null, false)).toBe('missing');
    expect(checkpointBudget({ value: 0, basis: 'configured' }, false)).toBe('exhausted');
    expect(checkpointBudget({ value: 10, basis: 'configured' }, true)).toBe('exhausted');
  });

  it('escalation: once, only on Local first, never on locked data or Local only, and only for a local result that failed its checks', () => {
    const failed = cp({ stopReason: 'local_failed_checks', routeMode: 'PREFER_ON_DEVICE' });
    expect(escalationDecision(failed, { mode: 'PREFER_ON_DEVICE', lock: false })).toEqual({ ok: true });
    expect(escalationDecision({ ...failed, escalatedAt: '2026-11-12T00:01:00.000Z' }, { mode: 'PREFER_ON_DEVICE', lock: false })).toEqual({ ok: false, reason: 'already_escalated' });
    expect(escalationDecision(failed, { mode: 'ONLY_ON_DEVICE', lock: false })).toEqual({ ok: false, reason: 'not_local_first' });
    expect(escalationDecision(failed, { mode: 'PREFER_IN_CLOUD', lock: false })).toEqual({ ok: false, reason: 'not_local_first' });
    expect(escalationDecision(failed, { mode: 'PREFER_ON_DEVICE', lock: true })).toEqual({ ok: false, reason: 'locked' });
    expect(escalationDecision({ ...failed, locked: true }, { mode: 'PREFER_ON_DEVICE', lock: false })).toEqual({ ok: false, reason: 'locked' });
    expect(escalationDecision({ ...failed, labels: ['restricted'] }, { mode: 'PREFER_ON_DEVICE', lock: false })).toEqual({ ok: false, reason: 'locked' });
    expect(escalationDecision(cp(), { mode: 'PREFER_ON_DEVICE', lock: false })).toEqual({ ok: false, reason: 'not_failed_checks' });
  });

  it('fix 1 (H1): escalation respects the call\'s own device-only choice: a call pinned to the device on a Local first task never goes to the cloud', () => {
    const failed = cp({ stopReason: 'local_failed_checks', routeMode: 'PREFER_ON_DEVICE', continuation: 'cloud_capable' });
    // The review's case: Local first task, this call overridden to Local only. Its effective mode was Local only and its continuation device only.
    const pinned = { ...failed, callOverride: 'ONLY_ON_DEVICE' as const, routeMode: 'ONLY_ON_DEVICE' as const, continuation: 'device_only' as const };
    expect(escalationDecision(pinned, { mode: 'PREFER_ON_DEVICE', lock: false })).toEqual({ ok: false, reason: 'device_only' });
    // Each condition on its own refuses too.
    expect(escalationDecision({ ...failed, callOverride: 'ONLY_ON_DEVICE' }, { mode: 'PREFER_ON_DEVICE', lock: false })).toEqual({ ok: false, reason: 'device_only' });
    expect(escalationDecision({ ...failed, continuation: 'device_only' }, { mode: 'PREFER_ON_DEVICE', lock: false })).toEqual({ ok: false, reason: 'device_only' });
    expect(escalationDecision({ ...failed, routeMode: 'PREFER_IN_CLOUD' }, { mode: 'PREFER_ON_DEVICE', lock: false })).toEqual({ ok: false, reason: 'not_local_first' });
    expect(escalationDecision(failed, { mode: 'PREFER_ON_DEVICE', lock: false })).toEqual({ ok: true });
  });

  it('inside the accepted plan a checkpoint resumes on its own; outside it, or for a step that changes the plan, it waits for the owner', () => {
    const plan = { planRevision: 3, taskIds: ['t1', 't2'] };
    expect(resumeDisposition(cp(), plan)).toBe('automatic');
    expect(resumeDisposition(cp({ planRevision: 2 }), plan)).toBe('owner');
    expect(resumeDisposition(cp({ taskId: 't9' }), plan)).toBe('owner');
    expect(resumeDisposition(cp(), null)).toBe('owner');
    expect(resumeDisposition(cp(), { planRevision: 0, taskIds: ['t1'] })).toBe('owner');
    expect(resumeDisposition(cp({ stepKind: 'pmPlan', stage: 'plan_draft' }), plan)).toBe('owner');
    expect(resumeDisposition(cp({ stepKind: 'pmResearch', stage: 'pm_turn' }), plan)).toBe('owner');
  });

  it('PM route proposals: one per plan task, from suggestRoute\'s inputs, with its reason; restricted data is fixed to Local only', () => {
    const routes = pmPlanRoutes([
      { key: 'T1', label: 'internal', inputChars: 800 },
      { key: 'T2', label: 'restricted', inputChars: 800 },
      { key: 'T3', label: 'internal', inputChars: 20_000 },
      { key: 'T4', label: undefined, inputChars: null },
    ], { nanoBudgetChars: 6000 });
    expect(routes.map((r) => [r.key, r.mode, r.locked])).toEqual([['T1', 'PREFER_ON_DEVICE', false], ['T2', 'ONLY_ON_DEVICE', true], ['T3', 'PREFER_IN_CLOUD', false], ['T4', 'ONLY_ON_DEVICE', true]]);
    expect(routes[0]!.reason).toMatch(/^Local first/);
    expect(routes[2]!.reason).toMatch(/characters/);
    // Offline: every unlocked task is proposed Local only for now, with that reason.
    expect(pmPlanRoutes([{ key: 'T1', label: 'internal', inputChars: 800 }], { nanoBudgetChars: 6000, offline: true })[0]).toMatchObject({ mode: 'ONLY_ON_DEVICE', rule: 'offline' });
  });
});

describe('H13: the plan brief and its cloud check as checkpoints', () => {
  const BRIEF = 'b'.repeat(64);
  const verify = (over: Partial<AiCheckpoint> = {}): AiCheckpoint => cp({
    stepKind: 'pmVerify', stage: 'pm_turn', callOverride: 'ONLY_IN_CLOUD', planRevision: 0, inputs: { contextId: null, bundleSha256: null, files: [], inputChars: null, briefSha256: BRIEF },
    partial: { issues: [], texts: [{ who: 'owner', text: 'G\tLet people post.\nP1\tfact\tBoards sort by votes.', classification: 'internal' }] }, ...over,
  });

  it('research notes are a checkpoint of their own kind, stored by the same split', () => {
    const notes = cp({ stepKind: 'researchNotes', stage: 'research_notes', status: 'done', stopReason: null, partial: { issues: [], texts: [{ who: 'owner', text: 'P|Posts are public.', classification: 'internal' }] } });
    expect(AiCheckpointSchema.safeParse(notes).success).toBe(true);
    expect(checkpointStorage(notes)).toBe('server');
    expect(checkpointStorage({ ...notes, partial: { issues: [], texts: [{ who: 'owner', text: 'P|Ward names.', classification: 'restricted' }] } })).toBe('device');
    expect(AiCheckpointSchema.safeParse(verify()).success).toBe(true);
  });

  it('a paused check is re-validated by the approved brief hash and the web research setting', () => {
    const now: CheckpointRecheck = { ...fine, inputs: { briefSha256: BRIEF }, context: 'not_applicable', webResearch: true };
    expect(revalidateCheckpoint(verify(), now)).toEqual({ ok: true });
    expect(revalidateCheckpoint(verify(), { ...now, inputs: { briefSha256: 'c'.repeat(64) } })).toEqual({ ok: false, problems: ['inputs_changed'] });
    // No approved brief now (edited after approval, or a reload): changed, never sent.
    expect(revalidateCheckpoint(verify(), { ...now, inputs: { briefSha256: null } })).toEqual({ ok: false, problems: ['inputs_changed'] });
    expect(revalidateCheckpoint(verify(), { ...now, webResearch: false })).toEqual({ ok: false, problems: ['web_research_off'] });
    expect(revalidateCheckpoint(verify(), { ...now, route: { mode: 'ONLY_ON_DEVICE', lock: true } })).toMatchObject({ ok: false, problems: expect.arrayContaining(['locked']) });
  });

  it('the owner approved exactly what a paused check sends, so it resumes on its own once re-validated, with or without an accepted plan', () => {
    expect(resumeDisposition(verify(), null)).toBe('automatic');
    expect(resumeDisposition(verify({ stepKind: 'pmVerifyNoWeb' }), null)).toBe('automatic');
    expect(resumeDisposition(cp({ stepKind: 'pmResearch' }), { planRevision: 3, taskIds: ['t1'] })).toBe('owner');
  });
});

describe('H13 fix round 1 (M1): a paused brief check whose subject is now device only', () => {
  it('is not sent: the re-validation reports it', () => {
    const v = cp({ stepKind: 'pmVerify', stage: 'pm_turn', callOverride: 'ONLY_IN_CLOUD', inputs: { contextId: null, bundleSha256: null, files: [], inputChars: null, briefSha256: 'b'.repeat(64) } });
    const now: CheckpointRecheck = { ...fine, inputs: { briefSha256: 'b'.repeat(64) }, context: 'not_applicable', webResearch: true };
    expect(revalidateCheckpoint(v, { ...now, deviceOnly: true })).toEqual({ ok: false, problems: ['route_device_only'] });
    expect(revalidateCheckpoint(v, { ...now, deviceOnly: false })).toEqual({ ok: true });
  });
});
