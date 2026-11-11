import { describe, expect, it } from 'vitest';
import type { RouteRecord } from '@selarikru/domain';
import type { SettingView, TaskRouteView } from '@selarikru/view-protocol';
import { iso, task } from '../overview/testing.ts';
import { settingStatus } from '../settings/model.ts';
import { AGENT_ACTIONS, RUNS_ON, acceptBlocker, actionAvailability, patchAcceptBlocker, patchAcceptRefusal, patchReceiptText, filesNoteText, reaskNote, effectiveStep, observedChip, refusalText, replanConfirm, revisionRefusal, routeIntent, runsOnModel, sourceLabel, stepRoute, workerRouteText, type BrowserInputs } from './model.ts';

const route = (over: Partial<TaskRouteView> = {}): TaskRouteView => ({
  effective: 'PREFER_ON_DEVICE', source: 'run', runDefault: 'PREFER_ON_DEVICE', override: null, overrideRevision: 0, lock: null,
  suggestion: { mode: 'PREFER_ON_DEVICE', rule: 'bounded_step', reason: 'server reason', locked: false }, lastObserved: null, ...over,
});
const LOCK = { label: 'restricted' as const, reason: 'This task reads restricted data, so its AI steps run on this device only.' };
const record = (over: Partial<RouteRecord> = {}): RouteRecord => ({
  recordId: 'r', taskId: 't1', taskRevision: 1, requestId: 'q', stepKind: 'patch', callOverride: null, requestedMode: 'PREFER_ON_DEVICE', effectiveMode: 'PREFER_ON_DEVICE', policySource: 'run', locked: false,
  observedSource: 'ON_DEVICE', fellBack: false, conformance: 'conforms', requestModeMismatch: false, status: 'ok', model: { cloudModel: 'm', sdkVersion: '12.5.0' }, timing: { totalMs: 1200, firstOutputMs: null },
  validation: 'passed', blockedReason: null, reportedBy: 'browser', trust: 'untrusted', reportedAt: iso(5), ...over,
});
const ONLINE: BrowserInputs = { online: true, cloudBudgetAvailable: null, nanoBudgetChars: 6000 };
const setting = (over: Partial<SettingView> = {}): SettingView => ({
  scope: 'task', key: 't1', field: 'route_override', desired: 'ONLY_IN_CLOUD', effective: 'ONLY_IN_CLOUD', desiredRevision: 1, effectiveRevision: 1, enforcer: 'server', state: 'applied',
  updatedBy: 'u', updatedAt: iso(5), appliedAt: iso(5), ...over,
});
const model = (r: TaskRouteView, over: Partial<Parameters<typeof runsOnModel>[0]> = {}) => runsOnModel({ projectId: 'p', task: task('t1'), route: r, setting: undefined, live: true, browser: ONLINE, inputChars: null, ...over });

describe('the four route labels', () => {
  it('are Local only, Local first, Cloud only and Cloud first, each with a short description', () => {
    expect(RUNS_ON.map((o) => [o.mode, o.label])).toEqual([['ONLY_ON_DEVICE', 'Local only'], ['PREFER_ON_DEVICE', 'Local first'], ['ONLY_IN_CLOUD', 'Cloud only'], ['PREFER_IN_CLOUD', 'Cloud first']]);
    for (const o of RUNS_ON) expect(o.description.length).toBeGreaterThan(10);
    expect(RUNS_ON[0]!.description).toMatch(/never/i);
  });

  it('name where the choice came from', () => {
    expect(sourceLabel('run')).toBe('Run default');
    expect(sourceLabel('task')).toBe('Set on this task');
    expect(sourceLabel('call')).toBe('This call only');
    expect(sourceLabel('lock')).toMatch(/restricted data/i);
    expect(sourceLabel('unset')).toMatch(/not set/i);
  });
});

describe('the Runs on control', () => {
  it('shows the effective mode, its source, the four choices and a way back to the run default', () => {
    const m = model(route({ effective: 'ONLY_IN_CLOUD', source: 'task', override: 'ONLY_IN_CLOUD', overrideRevision: 1 }));
    expect(m.current).toMatchObject({ mode: 'ONLY_IN_CLOUD', label: 'Cloud only' });
    expect(m.source).toBe('Set on this task');
    expect(m.options.find((o) => o.checked)?.mode).toBe('ONLY_IN_CLOUD');
    expect(m.options.every((o) => o.disabledReason === null)).toBe(true);
    expect(m.clear).toMatchObject({ checked: false, label: 'Run default (Local first)' });
    expect(m.lock).toBeNull();
  });

  it('under the data lock shows the padlock reason and disables every cloud-capable choice', () => {
    const m = model(route({ effective: 'ONLY_ON_DEVICE', source: 'lock', lock: LOCK }));
    expect(m.lock).toEqual({ title: 'Restricted data stays on this device', reason: LOCK.reason });
    expect(m.options.filter((o) => o.disabledReason !== null).map((o) => o.mode)).toEqual(['PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD']);
    expect(m.options.find((o) => o.mode === 'ONLY_ON_DEVICE')!.disabledReason).toBeNull();
    expect(m.source).toMatch(/restricted data/i);
  });

  it('is off while the connection is not live, so nothing is changed on stale state', () => {
    const m = model(route(), { live: false });
    expect(m.options.every((o) => o.disabledReason !== null)).toBe(true);
    expect(m.clear.disabledReason).not.toBeNull();
  });

  it('computes the suggestion in the browser from the step kind, input size and the browser-only inputs', () => {
    expect(model(route()).suggestion).toMatchObject({ mode: 'PREFER_ON_DEVICE', label: 'Local first' });
    expect(model(route(), { browser: { ...ONLINE, online: false } }).suggestion).toMatchObject({ mode: 'ONLY_ON_DEVICE', reason: expect.stringMatching(/offline/i) });
    expect(model(route(), { browser: { ...ONLINE, cloudBudgetAvailable: false } }).suggestion.reason).toMatch(/cloud budget/i);
    expect(model(route(), { inputChars: 9000 }).suggestion).toMatchObject({ mode: 'PREFER_IN_CLOUD', reason: expect.stringMatching(/9000/) });
    expect(model(route({ effective: 'ONLY_ON_DEVICE', source: 'lock', lock: LOCK })).suggestion).toMatchObject({ mode: 'ONLY_ON_DEVICE', reason: expect.stringMatching(/restricted/i) });
  });

  it('shows the last observed source as a chip, and a fallback with its reason', () => {
    expect(observedChip(null).label).toBe('No AI call yet');
    expect(observedChip(record()).label).toBe('Ran on this device');
    expect(observedChip(record({ observedSource: 'IN_CLOUD', effectiveMode: 'ONLY_IN_CLOUD', fellBack: false })).label).toBe('Ran in the cloud');
    const fell = observedChip(record({ observedSource: 'IN_CLOUD', fellBack: true }));
    expect(fell.label).toBe('Fell back to cloud');
    expect(fell.detail).toMatch(/device model/i);
    expect(observedChip(record({ observedSource: 'IN_CLOUD', fellBack: true, requestedMode: 'ONLY_IN_CLOUD', requestModeMismatch: true })).detail).toMatch(/too large/i);
    expect(observedChip(record({ observedSource: 'UNKNOWN', fellBack: null, conformance: 'unverified' })).label).toBe('Unknown');
    expect(observedChip(record({ status: 'blocked', observedSource: 'UNKNOWN', blockedReason: 'input_too_large_for_device' })).label).toBe('Stopped before running');
  });

  it('a change is an owner setting write at the override\'s revision; clearing goes back to the run default', () => {
    expect(routeIntent('p', 't1', route({ overrideRevision: 2 }), 'ONLY_ON_DEVICE')).toEqual({ command: 'setting.set', expectedRevision: 2, args: { projectId: 'p', key: 't1', change: { scope: 'task', field: 'route_override', value: 'ONLY_ON_DEVICE' } } });
    expect(routeIntent('p', 't1', route(), null).args.change).toEqual({ scope: 'task', field: 'route_override', value: null });
  });

  it('carries the setting\'s desired-versus-effective state, and a locked override reads as locked', () => {
    expect(model(route(), { setting: setting() }).status).toMatchObject({ label: 'Applied', inForce: true });
    expect(model(route(), { setting: setting({ state: 'applying', effective: null, effectiveRevision: 0 }) }).status).toMatchObject({ label: 'Applying', inForce: false });
    const locked = settingStatus(setting({ state: 'locked', effective: 'ONLY_ON_DEVICE' }))!;
    expect(locked).toMatchObject({ label: 'Locked to this device', inForce: true, tone: 'warning' });
    expect(locked.detail).toMatch(/restricted/i);
  });
});

describe('one AI step\'s route', () => {
  it('shows the route the step will use and offers a one-call override to the other side', () => {
    expect(stepRoute(route(), null)).toMatchObject({ mode: 'PREFER_ON_DEVICE', label: 'Local first', source: 'Run default', override: { mode: 'ONLY_IN_CLOUD', label: 'Use cloud for this call' } });
    expect(stepRoute(route({ effective: 'PREFER_IN_CLOUD', source: 'task', override: 'PREFER_IN_CLOUD' }), null).override).toEqual({ mode: 'ONLY_ON_DEVICE', label: 'Use this device for this call' });
    expect(stepRoute(route(), 'ONLY_IN_CLOUD')).toMatchObject({ mode: 'ONLY_IN_CLOUD', label: 'Cloud only', source: 'This call only' });
  });

  it('never offers a cloud override under the lock, and a cloud call override cannot relax it', () => {
    const locked = route({ effective: 'ONLY_ON_DEVICE', source: 'lock', lock: LOCK, override: 'ONLY_IN_CLOUD' });
    expect(stepRoute(locked, null).override).toBeNull();
    expect(stepRoute(locked, 'ONLY_IN_CLOUD')).toMatchObject({ mode: 'ONLY_ON_DEVICE', label: 'Local only', locked: true });
  });

  it('an unset route is said to be unset, not given a default', () => {
    expect(stepRoute(route({ effective: null, source: 'unset', runDefault: null }), null)).toMatchObject({ mode: null, label: 'Not set' });
  });
});

describe('agent actions', () => {
  it('are the six task steps, by name', () => {
    expect(AGENT_ACTIONS.map((a) => [a.kind, a.label])).toEqual([
      ['criteria', 'Draft criteria'], ['breakdown', 'Break down'], ['patch', 'Propose change'], ['review', 'Review change'], ['triage', 'Explain failure'], ['prDescription', 'Write PR description'],
    ]);
  });

  it('review and PR description need a change; explain failure needs a failed check; the rest are always offered', () => {
    const none = { hasChange: false, failedCheck: false };
    expect(actionAvailability('criteria', none)).toBeNull();
    expect(actionAvailability('patch', none)).toBeNull();
    expect(actionAvailability('review', none)).toMatch(/no change/i);
    expect(actionAvailability('prDescription', none)).toMatch(/no change/i);
    expect(actionAvailability('triage', none)).toMatch(/no failed check/i);
    expect(actionAvailability('review', { hasChange: true, failedCheck: false })).toBeNull();
    expect(actionAvailability('triage', { hasChange: false, failedCheck: true })).toBeNull();
  });
});

describe('refusals in plain words', () => {
  it('names each refusal the brief lists, and never shows a bare code', () => {
    expect(refusalText('input_too_large_for_device')).toMatch(/too large for the model on this device/i);
    expect(refusalText('route_changed_in_queue')).toMatch(/changed while .* waiting/i);
    expect(refusalText('secret_in_input')).toMatch(/secret/i);
    expect(refusalText('cloud_source_without_approval')).toMatch(/cloud answer/i);
    expect(refusalText('cloud_not_granted_for_label')).toMatch(/may not go to the cloud/i);
    expect(refusalText('device_unavailable')).toMatch(/not ready/i);
    expect(refusalText('route_fetch_failed')).toMatch(/could not be read/i);
    expect(refusalText('context_destination_refused')).toMatch(/keeps its AI steps on this device/i);
    expect(refusalText('task_spec_unreadable')).toMatch(/spec/i);
    expect(refusalText('something_new')).toMatch(/stopped/i);
    for (const code of ['input_too_large_for_device', 'route_changed_in_queue', 'secret_in_input', 'cloud_source_without_approval', 'something_new']) expect(refusalText(code)).not.toMatch(/_/);
  });
});

describe('fix round 1', () => {
  it('one mapping from route to mode, first place and bundle destination', () => {
    expect(effectiveStep(route(), null)).toMatchObject({ mode: 'PREFER_ON_DEVICE', place: 'device', destination: 'cloud', locked: false });
    expect(effectiveStep(route(), 'ONLY_ON_DEVICE')).toMatchObject({ place: 'device', destination: 'local' });
    expect(effectiveStep(route({ effective: 'PREFER_IN_CLOUD', override: 'PREFER_IN_CLOUD', source: 'task' }), null)).toMatchObject({ place: 'cloud', destination: 'cloud' });
    expect(effectiveStep(route({ effective: 'ONLY_ON_DEVICE', source: 'lock', lock: LOCK }), 'ONLY_IN_CLOUD')).toMatchObject({ mode: 'ONLY_ON_DEVICE', place: 'device', destination: 'local', locked: true });
    expect(effectiveStep(route({ effective: null, source: 'unset', runDefault: null }), null)).toMatchObject({ mode: null, place: null, destination: 'local' });
  });

  it('with no route at all, no one-call override is offered: the run default comes first', () => {
    const unset = stepRoute(route({ effective: null, source: 'unset', runDefault: null }), null);
    expect(unset.override).toBeNull();
    expect(unset.needsDefault).toBe(true);
    expect(stepRoute(route(), null).needsDefault).toBe(false);
  });

  it('the worker card names the effective route and the last observed source, in words', () => {
    expect(workerRouteText(route())).toBe('AI: Local first · No AI call yet');
    expect(workerRouteText(route({ lastObserved: record({ observedSource: 'IN_CLOUD', fellBack: true }) }))).toBe('AI: Local first · Fell back to cloud');
    expect(workerRouteText(route({ effective: 'ONLY_ON_DEVICE', source: 'lock', lock: LOCK, lastObserved: record() }))).toBe('AI: Local only (locked) · Ran on this device');
  });

  it('accepting criteria needs a replannable task, an unlocked result, a source that can replan and a live connection', () => {
    const ok = { status: 'ready' as const, locked: false, canRevise: true, live: true };
    expect(acceptBlocker(ok)).toBeNull();
    for (const status of ['planned', 'blocked', 'awaiting_approval'] as const) expect(acceptBlocker({ ...ok, status })).toBeNull();
    for (const status of ['running', 'verifying', 'verified', 'merged', 'failed', 'cancelled', 'superseded'] as const) expect(acceptBlocker({ ...ok, status })).toMatch(new RegExp(`${status.replace('_', ' ')}.*cannot take a new revision`, 'i'));
    expect(acceptBlocker({ ...ok, locked: true })).toMatch(/restricted/i);
    expect(acceptBlocker({ ...ok, canRevise: false })).toMatch(/cannot take a plan revision/i);
    expect(acceptBlocker({ ...ok, live: false })).toMatch(/live/i);
  });

  it('says what a replan does, and asks first when it withdraws an approval or closes a handover', () => {
    expect(replanConfirm({ pendingApproval: false, openHandover: false }).confirm).toBeNull();
    const both = replanConfirm({ pendingApproval: true, openHandover: true });
    expect(both.consequence).toMatch(/back to planned/i);
    expect(both.consequence).toMatch(/pending approvals .* withdrawn/i);
    expect(both.consequence).toMatch(/handover .* closes/i);
    expect(both.consequence).toMatch(/cost cap/i);
    expect(both.consequence).not.toMatch(/nothing else/i);
    expect(both.confirm?.title).toMatch(/replan/i);
    expect(replanConfirm({ pendingApproval: false, openHandover: true }).confirm?.consequence).toMatch(/handover/i);
  });

  it('a refused revision reads in plain words, by the refusal\'s code', () => {
    expect(revisionRefusal('stale_revision: the plan moved')).toMatch(/plan changed since/i);
    expect(revisionRefusal('task_not_replannable: a running task')).toMatch(/cannot take a new revision/i);
    expect(revisionRefusal('route_locked_restricted: x')).toMatch(/restricted/i);
    for (const code of ['plan_invalid', 'path_not_allowed', 'criteria_not_covered', 'roles_not_covered', 'plan_over_run_budget', 'policy_denied']) {
      const text = revisionRefusal(`${code}: server words`);
      expect(text, code).toMatch(/not recorded/i);
      expect(text, code).not.toMatch(/try again|trying again|retry/i);
      expect(text, code).not.toBe(revisionRefusal('something odd'));
    }
    expect(new Set(['plan_invalid', 'path_not_allowed', 'criteria_not_covered', 'roles_not_covered', 'plan_over_run_budget', 'policy_denied'].map((c) => revisionRefusal(`${c}: x`))).size).toBe(6);
    expect(revisionRefusal('something odd')).toMatch(/not recorded/i);
    expect(revisionRefusal('something odd')).not.toMatch(/safe|will work/i);
  });
});

describe('accepting a patch for the apply worker (H5)', () => {
  const base = { status: 'ready' as const, locked: false, canAccept: true, live: true, recorded: true, checked: true };
  it('says why Accept and apply is off, restricted first', () => {
    expect(patchAcceptBlocker(base)).toBeNull();
    expect(patchAcceptBlocker({ ...base, locked: true })).toBe('Restricted work is applied by the local runner on this device. This proposal stays here and is not sent.');
    expect(patchAcceptBlocker({ ...base, recorded: false })).toMatch(/not recorded/);
    expect(patchAcceptBlocker({ ...base, status: 'verified' })).toMatch(/A verified task is not waiting to start/);
    expect(patchAcceptBlocker({ ...base, canAccept: false })).toMatch(/cannot apply/);
    expect(patchAcceptBlocker({ ...base, live: false })).toMatch(/live/);
  });
  it('reads each refusal in its own words, and the fallback promises no retry', () => {
    expect(patchAcceptRefusal('proposal_restricted: x')).toBe('Restricted work is applied by the local runner on this device. Nothing was sent.');
    expect(patchAcceptRefusal('proposal_refused: the proposal did not pass the server\'s checks: base_mismatch')).toMatch(/base commit/);
    expect(patchAcceptRefusal('route_record_missing: x')).toMatch(/where this call ran/);
    expect(patchAcceptRefusal('task_not_applicable: x')).toMatch(/not waiting to start/);
    expect(patchAcceptRefusal('stale_revision: x')).toMatch(/newer revision/);
    expect(patchAcceptRefusal('something else')).toBe('The change was not accepted.');
  });
  it('names the re-ask in plain words', () => {
    expect(reaskNote(0)).toBeNull();
    expect(reaskNote(1)).toBe('The first diff did not apply to the files, so the agent was asked once more with what was wrong. This is its second answer.');
  });
});

describe('fix round 1: what an accept says, by where the proposal is now (I1, M3)', () => {
  const r = (state: string, over: Record<string, unknown> = {}) => ({ proposalId: 'p', taskId: 't', revision: 1, digest: 'a'.repeat(64), fileCount: 2, state, round: 1, lastFailure: null, simulated: false, ...over }) as never;
  it('a failed apply says why and offers to accept again; a waiting or applied one says so and offers nothing', () => {
    expect(patchReceiptText(r('failed', { lastFailure: 'tests_failed: pnpm run test exited with code 1' }))).toEqual({ text: 'The last apply failed: tests failed (pnpm run test exited with code 1). Accept again to retry.', again: true });
    expect(patchReceiptText(r('superseded'))).toMatchObject({ again: true });
    expect(patchReceiptText(r('accepted'))).toEqual({ text: 'Accepted: 2 files. The task waits for the runner, which applies them with no model, then builds, tests and verifies the result.', again: false });
    expect(patchReceiptText(r('accepted', { round: 2 }))).toMatchObject({ text: expect.stringMatching(/^Accepted again \(round 2\)/) });
    expect(patchReceiptText(r('applying'))).toMatchObject({ text: 'The runner is applying it now.', again: false });
    expect(patchReceiptText(r('applied'))).toMatchObject({ again: false });
    expect(patchReceiptText(r('accepted', { simulated: true }))).toMatchObject({ text: expect.stringMatching(/^Accepted in the demo: 2 files/) });
  });
  it('says when the agent read no files, and why', () => {
    expect(filesNoteText('no_checkout')).toBe('This runner has no copy of the project; the proposal can only add new files.');
    expect(filesNoteText('restricted')).toMatch(/stay on this device/);
    expect(filesNoteText(null)).toBeNull();
  });
});
