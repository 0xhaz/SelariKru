import { describe, expect, it } from 'vitest';
import type { BoundedAutonomy, SettingView } from '@selarikru/view-protocol';
import { iso, snapshotOf, task, worker } from '../overview/testing.ts';
import { assignmentStatus, autonomyModel, pmNameModel, settingStatus, webResearchModel, workerControls } from './model.ts';

const v = <T,>(value: T, basis: 'configured' | 'recommended' | 'unresolved' = 'configured') => ({ value, basis });
const POLICY: BoundedAutonomy = {
  allowedPaths: v(['src', 'tests']), planPaths: ['src', 'tests'], cloudEligible: v(false), cloudDestination: v(null), destinations: v([]), maxConcurrentWorkers: v(2), repairAttempts: v(2),
  attemptTimeoutSeconds: v(1800), budgetLimitUsd: v(25), merge: v('human' as const), schedulingPaused: v(false),
};
const setting = (over: Partial<SettingView>): SettingView => ({
  scope: 'run', key: 'run', field: 'paused', desired: true, effective: null, desiredRevision: 1, effectiveRevision: 0, enforcer: 'runner', state: 'applying', updatedBy: 'u', updatedAt: iso(5), appliedAt: null, ...over,
});
const withRun = (over: Record<string, unknown> = {}, settings: SettingView[] = [], parts: Parameters<typeof snapshotOf>[0] = {}) => {
  const s = snapshotOf(parts);
  return { ...s, runs: { run: { ...s.runs['run']!, policy: POLICY, ...over } }, settings, limits: { maxConcurrentTotal: 2 } };
};

describe('a save is never shown as applied', () => {
  it('a pause reads as requested until the runner confirms it, then paused', () => {
    expect(settingStatus(setting({}))).toMatchObject({ label: 'Pause requested', inForce: false, tone: 'warning' });
    expect(settingStatus(setting({ state: 'waiting_for_runner' }))!.detail).toMatch(/no runner is connected/i);
    expect(settingStatus(setting({ state: 'applied', effective: true, effectiveRevision: 1, appliedAt: iso(1) }))).toMatchObject({ label: 'Paused', inForce: true });
    expect(settingStatus(setting({ desired: false, effective: true, desiredRevision: 2, effectiveRevision: 1 }))).toMatchObject({ label: 'Resume requested', inForce: false });
  });

  it('a change held by a runner on an old build says the runner needs updating, and names it', () => {
    const st = settingStatus(setting({ state: 'waiting_for_runner_update', waitingOn: ['runner_old'] }))!;
    expect(st).toMatchObject({ label: 'Waiting for runner update', inForce: false });
    expect(st.detail).toMatch(/runner_old/);
    expect(st.detail).toMatch(/update/i);
  });

  it('a server-enforced field is applying until the snapshot says it is in force', () => {
    expect(settingStatus(setting({ field: 'allowed_paths', enforcer: 'server', desired: ['src'], state: 'applying' }))).toMatchObject({ label: 'Applying', inForce: false });
    expect(settingStatus(setting({ field: 'allowed_paths', enforcer: 'server', desired: ['src'], effective: ['src'], state: 'applied', effectiveRevision: 1 }))).toMatchObject({ label: 'Applied', inForce: true });
  });

  it('a worker field says the runner confirms it on its next heartbeat', () => {
    expect(settingStatus(setting({ scope: 'runner', key: 'w', field: 'slots', desired: 1 }))!.label).toBe('Applying');
    expect(settingStatus(setting({ scope: 'runner', key: 'w', field: 'slots', desired: 1 }))!.detail).toMatch(/next heartbeat/);
    expect(settingStatus(setting({ scope: 'runner', key: 'w', field: 'enabled', desired: false, state: 'waiting_for_runner' }))!.label).toBe('Saved · applies when this runner connects');
  });

  it('a model is saved and applies on next start, and running attempts keep theirs', () => {
    expect(assignmentStatus('applying')).toMatchObject({ label: 'Saved · applies on next start', inForce: false });
    expect(assignmentStatus('applying').detail).toMatch(/keep the model they started with/);
    expect(assignmentStatus('waiting_for_runner').label).toBe('Saved · applies when a runner connects');
    expect(assignmentStatus('applied')).toMatchObject({ label: 'Applied · used from the next attempt', inForce: true });
    // Not reported is not applied.
    expect(assignmentStatus(undefined)).toMatchObject({ label: 'Status unknown', inForce: false });
    expect(assignmentStatus('waiting_for_runner_update', ['runner_old'])).toMatchObject({ label: 'Waiting for runner update', inForce: false });
    expect(assignmentStatus('waiting_for_runner_update', ['runner_old']).detail).toMatch(/runner_old/);
  });
});

describe('bounded autonomy', () => {
  it('lists the effective policy from the server, each value labelled, and human merge as the merge policy', () => {
    const m = autonomyModel(withRun({ policy: { ...POLICY, budgetLimitUsd: v(null, 'unresolved'), repairAttempts: v(2, 'recommended') } }), true)!;
    const row = (key: string) => m.rows.find((r) => r.key === key)!;
    expect(row('allowedPaths')).toMatchObject({ value: 'src, tests', basis: 'Configured' });
    expect(row('budgetLimitUsd')).toMatchObject({ value: 'Not set', basis: 'Unresolved', tone: 'warning' });
    expect(row('repairAttempts')).toMatchObject({ value: '2 per task revision', basis: 'Recommended' });
    expect(row('merge')).toMatchObject({ value: 'Human merge on GitHub. Agents never merge.', basis: 'Configured' });
    expect(row('cloudEligible').value).toBe('No: local only');
  });

  it('says nothing when the server reports no policy, rather than inventing one', () => {
    expect(autonomyModel(withRun({ policy: null }), true)).toBeNull();
  });

  it('pause is a save of the run setting at its revision, off while not live', () => {
    const m = autonomyModel(withRun(), true)!;
    expect(m.pause.action).toMatchObject({ label: 'Pause scheduling', intent: { command: 'setting.set', expectedRevision: 0, args: { projectId: 'p', key: 'run', change: { scope: 'run', field: 'paused', value: true } } } });
    const requested = autonomyModel(withRun({}, [setting({})]), true)!;
    expect(requested.pause.status).toMatchObject({ label: 'Pause requested' });
    expect(requested.pause.action).toMatchObject({ label: 'Resume scheduling', intent: { expectedRevision: 1, args: { change: { value: false } } } });
    expect(autonomyModel(withRun(), false)!.pause.action.disabledReason).toMatch(/connection/i);
  });

  it('cancel run asks for confirmation, then reads as requested until the run is cancelled', () => {
    const m = autonomyModel(withRun({}, [], { tasks: [task('a', { status: 'running' })] }), true)!;
    expect(m.cancel.action).toMatchObject({ label: 'Cancel run', intent: { command: 'run.cancel', expectedRevision: 1, args: { runId: 'run' } } });
    expect(m.cancel.action!.confirm!.consequence).toMatch(/kept/);
    const requested = autonomyModel(withRun({ cancel: { requestedAt: iso(3), requestedBy: 'u' } }, [], { tasks: [task('a', { status: 'running' })] }), true)!;
    expect(requested.cancel).toMatchObject({ action: null, status: { label: 'Cancel requested' } });
    expect(requested.cancel.status!.detail).toMatch(/1 running attempt/);
    expect(autonomyModel(withRun({ lifecycle: 'cancelled', cancel: { requestedAt: iso(3), requestedBy: 'u' } }), true)!.cancel.status!.label).toBe('Cancelled');
  });

  it('a path can be removed and given back, each one a save that blocks or unblocks at once', () => {
    const m = autonomyModel(withRun({}, [setting({ field: 'allowed_paths', enforcer: 'server', desired: ['src'], effective: ['src'], state: 'applied', effectiveRevision: 1 })]), true)!;
    // The plan's paths come from the server's policy before the narrowing: here the narrowed list is what is allowed.
    expect(m.paths.items.find((i) => i.path === 'src')!.action).toMatchObject({ label: 'Remove src', intent: { expectedRevision: 1, args: { change: { field: 'allowed_paths', value: [] } } } });
  });
});

describe('a revoke shows what it stopped', () => {
  it('a running task told to stop and a queued one blocked both read as blocked by policy', () => {
    const s = withRun({}, [], { tasks: [
      task('a', { title: 'API', status: 'running', cancelRequested: { at: iso(2), operationId: 'op', reason: 'policy_revoked:allowed_paths' } }),
      task('b', { title: 'UI', status: 'ready', placementBlock: 'policy_revoked:cloud_eligible' }),
      task('c', { status: 'ready' }),
    ] });
    const m = autonomyModel(s, true)!;
    expect(m.affected).toEqual([
      expect.objectContaining({ taskId: 'a', label: expect.stringMatching(/Blocked by policy .*stopping/) }),
      expect.objectContaining({ taskId: 'b', label: 'Blocked by policy (cloud taken away)' }),
    ]);
  });
});

describe('worker controls', () => {
  it('disable and slots are saves on the worker, each with whether the runner has confirmed it', () => {
    const s = withRun({}, [setting({ scope: 'runner', key: 'w', field: 'enabled', desired: false })], { workers: [worker('w')] });
    const m = workerControls(s, 'w', true);
    expect(m.enabled).toMatchObject({ value: false, status: { label: 'Applying' }, action: { label: 'Enable worker', intent: { expectedRevision: 1, args: { key: 'w', change: { scope: 'runner', field: 'enabled', value: true } } } } });
    expect(m.slots).toMatchObject({ value: null, revision: 0, options: [1, 2] });
    expect(m.enabled.detail).toMatch(/current attempt/);
  });
});

describe('H11 fix round 1: the Project Manager\'s settings in Settings › Workflow', () => {
  it('I5: web research is off until the owner grants it, and the grant is a run setting the server holds', () => {
    const off = webResearchModel(withRun(), true)!;
    expect(off.on).toBe(false);
    expect(off.action.label).toBe('Turn on Google Search (web research)');
    expect(off.action.intent).toMatchObject({ command: 'setting.set', args: { change: { scope: 'run', field: 'web_research', value: true } } });
    const on = webResearchModel(withRun({}, [setting({ scope: 'run', key: 'run', field: 'web_research', desired: true, effective: true })]), true)!;
    expect(on.on).toBe(true);
    expect(on.action.intent).toMatchObject({ args: { change: { value: false } } });
  });

  it('M10: the Project Manager\'s name is editable before any worker holds the role', () => {
    const m = pmNameModel(withRun(), true)!;
    expect(m.value).toBe('');
    expect(m.runId).toBe('run');
    const named = pmNameModel(withRun({}, [setting({ scope: 'run', key: 'run', field: 'pm_display_name', desired: 'Puan Zara', effective: 'Puan Zara' })]), true)!;
    expect(named.value).toBe('Puan Zara');
  });
});
