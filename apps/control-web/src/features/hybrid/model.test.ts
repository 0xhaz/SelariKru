import { describe, expect, it } from 'vitest';
import type { RouteRecord } from '@selarikru/domain';
import type { SettingView, TaskRouteView } from '@selarikru/view-protocol';
import { iso, task } from '../overview/testing.ts';
import { settingStatus } from '../settings/model.ts';
import { AGENT_ACTIONS, RUNS_ON, actionAvailability, observedChip, refusalText, routeIntent, runsOnModel, sourceLabel, stepRoute, type BrowserInputs } from './model.ts';

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
    expect(refusalText('something_new')).toMatch(/stopped/i);
    for (const code of ['input_too_large_for_device', 'route_changed_in_queue', 'secret_in_input', 'cloud_source_without_approval', 'something_new']) expect(refusalText(code)).not.toMatch(/_/);
  });
});
