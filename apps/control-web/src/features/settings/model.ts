import type { Tone } from '@selarikru/ui';
import type { AuthorizedViewCommand, BoundedAutonomy, PolicyBasis, ProjectViewSnapshot, RunView, SettingState, SettingView } from '@selarikru/view-protocol';
import type { CommandIntent, ConfirmCopy } from '../decisions/model.ts';

/**
 * What the owner's settings say on screen. Everything comes from the snapshot: the server's effective policy, and each saved setting with whether its
 * enforcer has acknowledged it. A save is never shown as applied: a field is in force only when the snapshot says so.
 */

export const SETTINGS_OFF = 'Settings are off until the connection is live, so nothing is changed on stale state.';

export interface FieldStatus {
  readonly label: string;
  readonly tone: Tone;
  /** True only when the snapshot says the enforcer has acknowledged this value. */
  readonly inForce: boolean;
  readonly detail: string;
}

export interface SettingAction {
  readonly id: string;
  readonly label: string;
  readonly intent: CommandIntent;
  readonly disabledReason: string | null;
  readonly confirm: ConfirmCopy | null;
}

/** A saved setting's place between saved and in force. Null: nothing saved, so the configured value stands. */
export function settingStatus(s: SettingView | undefined): FieldStatus | null {
  if (!s) return null;
  if (s.field === 'paused') {
    const pausing = s.desired === true;
    if (s.state === 'applied') {
      return pausing
        ? { label: 'Paused', tone: 'neutral', inForce: true, detail: 'The runner confirmed it. No new work is assigned; attempts already running continue until they finish.' }
        : { label: 'Scheduling', tone: 'active', inForce: true, detail: 'The runner confirmed the resume. Work is assigned again within the run\'s limits.' };
    }
    if (s.state === 'waiting_for_runner_update') {
      const u = updateNeeded(s.waitingOn);
      return { ...u, detail: `${pausing ? 'Pause requested: no new work is assigned from now; attempts already running continue.' : 'Resume requested: work can be assigned again.'} ${u.detail}` };
    }
    const none = s.state === 'waiting_for_runner' ? ' No runner is connected to confirm it yet.' : ' Waiting for the runner to confirm on its next heartbeat.';
    return pausing
      ? { label: 'Pause requested', tone: 'warning', inForce: false, detail: `No new work is assigned from now; attempts already running continue.${none}` }
      : { label: 'Resume requested', tone: 'warning', inForce: false, detail: `The budget, policy and leases were checked again and work can be assigned.${none}` };
  }
  if (s.state === 'waiting_for_runner_update') return updateNeeded(s.waitingOn);
  // A route override the data lock replaces: saved, but the task runs on this device only, which is what is in force.
  if (s.state === 'locked') return { label: 'Locked to this device', tone: 'warning', inForce: true, detail: 'This task reads restricted data, so its AI steps run on this device only, whatever was saved. Only a reclassification decision lifts the lock.' };
  if (s.state === 'applied') return { label: 'Applied', tone: 'success', inForce: true, detail: s.enforcer === 'server' ? 'The server enforces it from the moment it was saved.' : 'The runner confirmed it.' };
  if (s.state === 'waiting_for_runner') {
    return { label: s.scope === 'runner' ? 'Saved · applies when this runner connects' : 'Saved · applies when a runner connects', tone: 'warning', inForce: false, detail: 'The server already refuses new work it would forbid. No runner is connected to confirm it.' };
  }
  return {
    label: 'Applying', tone: 'warning', inForce: false,
    detail: s.enforcer === 'server' ? 'The server is putting this in force.' : 'Saved. The server already refuses new work it would forbid; the runner confirms it on its next heartbeat.',
  };
}

/** A connected runner runs a build that never acknowledges, so nothing it holds can be shown in force until it is updated. */
function updateNeeded(waitingOn: readonly string[] | undefined): FieldStatus {
  const who = waitingOn && waitingOn.length > 0 ? waitingOn.join(', ') : 'a connected runner';
  return { label: 'Waiting for runner update', tone: 'warning', inForce: false, detail: `Saved, and the server already refuses new work it would forbid. ${who} runs a build that cannot confirm settings: update it to put this in force.` };
}

/** A model assignment between saved and in force. A state the source did not report is unknown, never applied. */
export function assignmentStatus(state: SettingState | undefined, waitingOn?: readonly string[]): FieldStatus {
  const pinned = 'Attempts already running keep the model they started with.';
  if (state === undefined) return { label: 'Status unknown', tone: 'neutral', inForce: false, detail: `The source did not say whether this is in force. ${pinned}` };
  if (state === 'waiting_for_runner_update') { const u = updateNeeded(waitingOn); return { ...u, detail: `${u.detail} ${pinned}` }; }
  if (state === 'applying') return { label: 'Saved · applies on next start', tone: 'warning', inForce: false, detail: `Waiting for the runner to confirm. ${pinned}` };
  if (state === 'waiting_for_runner') return { label: 'Saved · applies when a runner connects', tone: 'warning', inForce: false, detail: `No runner is connected to confirm it. ${pinned}` };
  return { label: 'Applied · used from the next attempt', tone: 'success', inForce: true, detail: pinned };
}

const BASIS: Readonly<Record<PolicyBasis, string>> = { configured: 'Configured', recommended: 'Recommended', unresolved: 'Unresolved' };

export interface PolicyRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly basis: string;
  readonly tone: Tone;
  readonly note: string | null;
}

const money = (n: number): string => `$${n.toFixed(2).replace(/\.00$/, '')}`;

function policyRows(p: BoundedAutonomy): PolicyRow[] {
  const row = (key: string, label: string, value: string | null, basis: PolicyBasis, note: string | null = null): PolicyRow => ({
    key, label, value: value ?? 'Not set', basis: BASIS[basis], tone: basis === 'unresolved' ? 'warning' : basis === 'recommended' ? 'active' : 'neutral',
    note: basis === 'unresolved' ? `${note ?? ''}${note ? ' ' : ''}Missing is never unlimited: what depends on it is blocked.` : basis === 'recommended' ? 'On record but not applied. It applies only once set.' : note,
  });
  return [
    row('allowedPaths', 'Approved scope', p.allowedPaths.value === null ? null : p.allowedPaths.value.length === 0 ? 'No paths: nothing can change' : p.allowedPaths.value.join(', '), p.allowedPaths.basis, 'Paths workers may change.'),
    row('cloudEligible', 'Cloud eligibility', p.cloudEligible.value === null ? null : p.cloudEligible.value ? `Yes${p.cloudDestination.value ? `: ${p.cloudDestination.value}` : ''}` : 'No: local only', p.cloudEligible.basis),
    row('destinations', 'Data destinations', p.destinations.value === null ? null : p.destinations.value.length === 0 ? 'None granted' : p.destinations.value.map((d) => `${d.destination} (${d.purpose})`).join(', '), p.destinations.basis),
    row('maxConcurrentWorkers', 'Worker limit', p.maxConcurrentWorkers.value === null ? null : `${p.maxConcurrentWorkers.value} at once, across locations`, p.maxConcurrentWorkers.basis),
    row('repairAttempts', 'Repair limit', p.repairAttempts.value === null ? null : `${p.repairAttempts.value} per task revision`, p.repairAttempts.basis),
    row('attemptTimeoutSeconds', 'Attempt time limit', p.attemptTimeoutSeconds.value === null ? null : `${Math.round(p.attemptTimeoutSeconds.value / 60)} minutes`, p.attemptTimeoutSeconds.basis),
    row('budgetLimitUsd', 'Budget', p.budgetLimitUsd.value === null ? null : money(p.budgetLimitUsd.value), p.budgetLimitUsd.basis),
    row('merge', 'Merge', 'Human merge on GitHub. Agents never merge.', p.merge.basis),
  ];
}

export interface AutonomyModel {
  readonly projectId: string;
  readonly runId: string;
  readonly rows: readonly PolicyRow[];
  readonly simulated: boolean;
  readonly pause: { readonly status: FieldStatus | null; readonly action: SettingAction };
  readonly cancel: { readonly status: FieldStatus | null; readonly action: SettingAction | null };
  readonly paths: { readonly status: FieldStatus | null; readonly items: readonly { readonly path: string; readonly allowed: boolean; readonly action: SettingAction }[] };
  readonly budget: { readonly status: FieldStatus | null; readonly revision: number; readonly value: number | null; readonly disabledReason: string | null };
  readonly cloud: { readonly status: FieldStatus | null; readonly action: SettingAction } | null;
  /** Tasks a revoke stopped or blocked: shown as such while the runner cleans up, from the snapshot's own stop requests and placement blocks. */
  readonly affected: readonly { readonly taskId: string; readonly title: string; readonly label: string; readonly reason: string }[];
}

const TERMINAL = ['merged', 'failed', 'cancelled'];

/** The run the panel is about: the newest one still in play, else the newest. */
export function currentRun(snapshot: ProjectViewSnapshot): RunView | null {
  const runs = Object.values(snapshot.runs);
  return runs.filter((r) => !TERMINAL.includes(r.lifecycle)).at(-1) ?? runs.at(-1) ?? null;
}

const find = (snapshot: ProjectViewSnapshot, scope: 'run' | 'runner', key: string, field: string): SettingView | undefined =>
  snapshot.settings.find((s) => s.scope === scope && s.key === key && s.field === field);

type SaveIntent = Omit<Extract<AuthorizedViewCommand, { command: 'setting.set' }>, 'idempotencyKey'>;
const save = (projectId: string, key: string, setting: SettingView | undefined, change: SaveIntent['args']['change']): SaveIntent =>
  ({ command: 'setting.set', expectedRevision: setting?.desiredRevision ?? 0, args: { projectId, key, change } });

/** The Bounded autonomy panel. Null when the server reports no policy for the run: nothing is invented in its place. */
export function autonomyModel(snapshot: ProjectViewSnapshot, live: boolean): AutonomyModel | null {
  const run = currentRun(snapshot);
  if (!run || !run.policy) return null;
  const projectId = snapshot.meta.projectId;
  const closed = TERMINAL.includes(run.lifecycle);
  const cancelling = run.cancel != null && !closed;
  const off = !live ? SETTINGS_OFF : closed ? `This run is ${run.lifecycle}, so its settings no longer change.` : cancelling ? 'This run is being cancelled, so its settings no longer change.' : null;

  const paused = find(snapshot, 'run', run.runId, 'paused');
  const pausing = paused?.desired === true;
  const pause: AutonomyModel['pause'] = {
    status: settingStatus(paused),
    action: {
      id: pausing ? 'resume' : 'pause', label: pausing ? 'Resume scheduling' : 'Pause scheduling', disabledReason: off, confirm: null,
      intent: save(projectId, run.runId, paused, { scope: 'run', field: 'paused', value: !pausing }),
    },
  };

  const running = Object.values(snapshot.tasks).filter((t) => t.runId === run.runId && t.status === 'running').length;
  const cancel: AutonomyModel['cancel'] = run.lifecycle === 'cancelled'
    ? { status: { label: 'Cancelled', tone: 'neutral', inForce: true, detail: 'Every active attempt has ended. Artifacts and history are kept.' }, action: null }
    : cancelling
      ? { status: { label: 'Cancel requested', tone: 'warning', inForce: false, detail: `No new work is assigned. Waiting for ${running} running attempt${running === 1 ? '' : 's'} to end or for its lease to expire. Artifacts and history are kept; unused grants are revoked.` }, action: null }
      : closed ? { status: null, action: null } : {
        status: null,
        action: {
          id: 'cancel-run', label: 'Cancel run', disabledReason: live ? null : SETTINGS_OFF,
          intent: { command: 'run.cancel', expectedRevision: run.planRevision, args: { runId: run.runId } },
          confirm: { title: 'Cancel this run?', consequence: `No new work is assigned. ${running > 0 ? `${running} running attempt${running === 1 ? ' is' : 's are'} asked to stop; the run is cancelled once ${running === 1 ? 'it has' : 'they have'} ended or the lease has expired. ` : ''}Every other open task is cancelled now, holds are released and unused grants are revoked. Artifacts and history are kept. This cannot be undone.`, keepLabel: 'Keep the run' },
        },
      };

  const narrowed = find(snapshot, 'run', run.runId, 'allowed_paths');
  // What the owner last saved, so a second change builds on it rather than on what was in force before it.
  const current = narrowed && Array.isArray(narrowed.desired) ? (narrowed.desired as string[]) : run.policy.allowedPaths.value ?? [];
  const items = run.policy.planPaths.map((path) => {
    const allowed = current.includes(path);
    const value = allowed ? current.filter((p) => p !== path) : run.policy!.planPaths.filter((p) => p === path || current.includes(p));
    return { path, allowed, action: { id: `path:${path}`, label: `${allowed ? 'Remove' : 'Give back'} ${path}`, disabledReason: off, confirm: null, intent: save(projectId, run.runId, narrowed, { scope: 'run', field: 'allowed_paths', value }) } };
  });

  const budget = find(snapshot, 'run', run.runId, 'budget_limit_usd');
  const cloudSetting = find(snapshot, 'run', run.runId, 'cloud_eligible');
  const cloudCapable = run.policy.cloudEligible.value === true || cloudSetting !== undefined;
  const cloudOn = cloudSetting ? cloudSetting.desired === true : run.policy.cloudEligible.value === true;
  const affected = Object.values(snapshot.tasks).filter((t) => t.runId === run.runId).flatMap((t) => {
    const stopping = t.cancelRequested?.reason?.startsWith('policy_revoked:') ? t.cancelRequested.reason : null;
    const reason = stopping ?? (t.placementBlock?.startsWith('policy_revoked:') ? t.placementBlock : null);
    if (reason === null) return [];
    const what = reason.endsWith('cloud_eligible') ? 'cloud taken away' : 'a path taken away';
    return [{ taskId: t.taskId, title: t.title ?? t.taskId, reason, label: stopping ? `Blocked by policy (${what}): stopping, the runner is told on its next heartbeat` : `Blocked by policy (${what})` }];
  });
  return {
    projectId, runId: run.runId, rows: policyRows(run.policy), simulated: snapshot.meta.provenance === 'simulated', affected,
    pause, cancel,
    paths: { status: settingStatus(narrowed), items },
    budget: { status: settingStatus(budget), revision: budget?.desiredRevision ?? 0, value: run.policy.budgetLimitUsd.basis === 'configured' ? run.policy.budgetLimitUsd.value : null, disabledReason: off },
    cloud: cloudCapable ? { status: settingStatus(cloudSetting), action: { id: 'cloud', label: cloudOn ? 'Turn off cloud for this run' : 'Allow cloud again', disabledReason: off, confirm: null, intent: save(projectId, run.runId, cloudSetting, { scope: 'run', field: 'cloud_eligible', value: !cloudOn }) } } : null,
  };
}

export interface WorkerControlsModel {
  readonly enabled: { readonly value: boolean; readonly status: FieldStatus | null; readonly action: SettingAction; readonly detail: string };
  readonly slots: { readonly value: number | null; readonly status: FieldStatus | null; readonly revision: number; readonly options: readonly number[]; readonly disabledReason: string | null; readonly projectId: string };
}

/** A worker's own settings, changed in its drawer. The server refuses a disabled worker's claims from the save; its current attempt finishes. */
export function workerControls(snapshot: ProjectViewSnapshot, workerId: string, live: boolean): WorkerControlsModel {
  const projectId = snapshot.meta.projectId;
  const enabled = find(snapshot, 'runner', workerId, 'enabled');
  const slots = find(snapshot, 'runner', workerId, 'slots');
  const on = enabled ? enabled.desired !== false : true;
  const off = live ? null : SETTINGS_OFF;
  const max = snapshot.limits.maxConcurrentTotal ?? 1;
  return {
    enabled: {
      value: on, status: settingStatus(enabled), detail: on ? 'Disabling stops new work for this worker at once. Its current attempt finishes.' : 'Disabled: it is given no new work. Its current attempt, if any, finishes.',
      action: { id: 'enabled', label: on ? 'Disable worker' : 'Enable worker', disabledReason: off, confirm: null, intent: save(projectId, workerId, enabled, { scope: 'runner', field: 'enabled', value: !on }) },
    },
    slots: { value: slots && typeof slots.desired === 'number' ? slots.desired : null, status: settingStatus(slots), revision: slots?.desiredRevision ?? 0, options: Array.from({ length: Math.max(1, max) }, (_, i) => i + 1), disabledReason: off, projectId },
  };
}
