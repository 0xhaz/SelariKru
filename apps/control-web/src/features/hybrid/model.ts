import {
  DEFAULT_NANO_INPUT_BUDGET_CHARS, ROUTE_POLICY_LABELS, effectiveRoutePolicy, isCloudCapable, routeLockFor, suggestRoute,
  type RoutePolicyMode, type RoutePolicySource, type RouteRecord, type RouteStepKind,
} from '@selarikru/domain';
import type { Tone } from '@selarikru/ui';
import type { AuthorizedViewCommand, SettingView, TaskRouteView, TaskView } from '@selarikru/view-protocol';
import { SETTINGS_OFF, settingStatus, type FieldStatus } from '../settings/model.ts';

/**
 * Where a task's AI runs (H4, plan.md §4.2), in words. Everything comes from the server's route view, read from the snapshot for display only: the adapter reads the
 * route fresh before every call. The suggestion is computed here, in the browser, because only the browser knows whether it is offline or out of cloud budget.
 * Inference only: where a worker's sandbox runs is a separate axis with its own labels.
 */

export const RUNS_ON: readonly { readonly mode: RoutePolicyMode; readonly label: string; readonly description: string }[] = [
  { mode: 'ONLY_ON_DEVICE', label: ROUTE_POLICY_LABELS.ONLY_ON_DEVICE, description: 'Gemini Nano on this device. Never the cloud; it waits if the device model is not ready.' },
  { mode: 'PREFER_ON_DEVICE', label: ROUTE_POLICY_LABELS.PREFER_ON_DEVICE, description: 'This device first. Falls back to the cloud only when the device model is not ready and the data may go there.' },
  { mode: 'ONLY_IN_CLOUD', label: ROUTE_POLICY_LABELS.ONLY_IN_CLOUD, description: 'Gemini in the cloud. Never this device.' },
  { mode: 'PREFER_IN_CLOUD', label: ROUTE_POLICY_LABELS.PREFER_IN_CLOUD, description: 'The cloud first. Falls back to this device if the cloud call fails.' },
];

export const LOCK_TITLE = 'Restricted data stays on this device';

const SOURCE: Readonly<Record<RoutePolicySource, string>> = {
  run: 'Run default', task: 'Set on this task', call: 'This call only', lock: 'Locked by restricted data', unset: 'Not set: choose one',
};
export const sourceLabel = (source: RoutePolicySource): string => SOURCE[source];

export const modeLabel = (mode: RoutePolicyMode | null): string => (mode === null ? 'Not set' : ROUTE_POLICY_LABELS[mode]);

/** What the browser alone knows. `cloudBudgetAvailable` null: not known, so that rule does not apply. */
export interface BrowserInputs {
  readonly online: boolean;
  readonly cloudBudgetAvailable: boolean | null;
  readonly nanoBudgetChars: number;
}
export const DEFAULT_BROWSER: BrowserInputs = { online: true, cloudBudgetAvailable: null, nanoBudgetChars: DEFAULT_NANO_INPUT_BUDGET_CHARS };

export interface Chip {
  readonly label: string;
  readonly tone: Tone;
  readonly detail: string | null;
}

/** Why a call fell back: from what the record says, never guessed beyond it. */
function fallbackReason(r: RouteRecord): string {
  if (r.observedSource === 'IN_CLOUD') {
    return r.requestModeMismatch && r.requestedMode === 'ONLY_IN_CLOUD'
      ? 'The input was too large for the device model, so it was sent to the cloud, which this route allows.'
      : 'The device model was not ready, so the cloud answered, which this route allows.';
  }
  return 'The cloud call did not answer, so this device did, which this route allows.';
}

/** The last observed source, as reported by the browser and untrusted. An unknown source stays unknown. */
export function observedChip(r: RouteRecord | null): Chip {
  if (!r) return { label: 'No AI call yet', tone: 'neutral', detail: null };
  if (r.status === 'blocked' || r.status === 'error') return { label: 'Stopped before running', tone: 'warning', detail: r.blockedReason ? refusalText(r.blockedReason) : 'The call did not run.' };
  if (r.observedSource === 'UNKNOWN') return { label: 'Unknown', tone: 'warning', detail: 'Where the last call ran was not shown, so it is not counted as either.' };
  if (r.fellBack === true) return { label: r.observedSource === 'IN_CLOUD' ? 'Fell back to cloud' : 'Fell back to this device', tone: 'warning', detail: fallbackReason(r) };
  return r.observedSource === 'ON_DEVICE'
    ? { label: 'Ran on this device', tone: 'success', detail: null }
    : { label: 'Ran in the cloud', tone: 'active', detail: null };
}

const lockOf = (route: TaskRouteView) => (route.lock ? routeLockFor([route.lock.label]) : null);

/** The suggestion for one step, with the browser's own inputs: the data rule first, then offline, the cloud budget, then size. Shown, never applied. */
export function suggestionFor(route: TaskRouteView, stepKind: RouteStepKind, inputChars: number | null, browser: BrowserInputs) {
  const s = suggestRoute(
    { label: route.lock?.label ?? 'internal', stepKind, inputChars },
    { nanoBudgetChars: browser.nanoBudgetChars, offline: !browser.online, cloudBudgetAvailable: browser.cloudBudgetAvailable },
  );
  return { mode: s.mode, label: ROUTE_POLICY_LABELS[s.mode], reason: s.reason, rule: s.rule };
}

type SaveIntent = Omit<Extract<AuthorizedViewCommand, { command: 'setting.set' }>, 'idempotencyKey'>;

/** An owner write of the task override, at the revision on screen. Null clears it: the run default applies again. */
export const routeIntent = (projectId: string, taskId: string, route: TaskRouteView, value: RoutePolicyMode | null): SaveIntent =>
  ({ command: 'setting.set', expectedRevision: route.overrideRevision, args: { projectId, key: taskId, change: { scope: 'task', field: 'route_override', value } } });

export interface RunsOnOption {
  readonly mode: RoutePolicyMode;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabledReason: string | null;
}

export interface RunsOnModel {
  readonly taskId: string;
  readonly current: { readonly mode: RoutePolicyMode | null; readonly label: string };
  readonly source: string;
  readonly lock: { readonly title: string; readonly reason: string } | null;
  readonly options: readonly RunsOnOption[];
  readonly clear: { readonly label: string; readonly checked: boolean; readonly disabledReason: string | null };
  readonly suggestion: ReturnType<typeof suggestionFor>;
  readonly observed: Chip;
  /** The saved override between desired and in force. Null: nothing saved on this task. */
  readonly status: FieldStatus | null;
}

const LOCKED_OPTION = 'Restricted data stays on this device, so a route that can use the cloud is not offered.';

export function runsOnModel(input: {
  readonly projectId: string;
  readonly task: TaskView;
  readonly route: TaskRouteView;
  readonly setting: SettingView | undefined;
  readonly live: boolean;
  readonly browser: BrowserInputs;
  readonly inputChars: number | null;
  readonly stepKind?: RouteStepKind;
}): RunsOnModel {
  const { route, live } = input;
  const off = live ? null : SETTINGS_OFF;
  return {
    taskId: input.task.taskId,
    current: { mode: route.effective, label: modeLabel(route.effective) },
    source: sourceLabel(route.source),
    lock: route.lock ? { title: LOCK_TITLE, reason: route.lock.reason } : null,
    options: RUNS_ON.map((o) => ({
      ...o,
      checked: route.override === o.mode,
      disabledReason: off ?? (route.lock && isCloudCapable(o.mode) ? LOCKED_OPTION : null),
    })),
    clear: { label: `Run default (${modeLabel(route.runDefault)})`, checked: route.override === null, disabledReason: off },
    suggestion: suggestionFor(route, input.stepKind ?? 'patch', input.inputChars, input.browser),
    observed: observedChip(route.lastObserved),
    status: settingStatus(input.setting),
  };
}

/**
 * The one mapping from a route to where a call runs: the effective mode (this call's override, else the task's, else the run default, after the lock), where it is
 * meant to run first, and which context bundle it may read (`cloud` for any cloud-capable mode). The step control, the runner and the office all use it.
 */
export interface EffectiveStep {
  readonly mode: RoutePolicyMode | null;
  readonly source: RoutePolicySource;
  readonly locked: boolean;
  readonly place: 'device' | 'cloud' | null;
  readonly destination: 'local' | 'cloud';
}
export function effectiveStep(route: Pick<TaskRouteView, 'override' | 'runDefault' | 'lock'>, callOverride: RoutePolicyMode | null): EffectiveStep {
  const lock = route.lock ? routeLockFor([route.lock.label]) : null;
  const e = effectiveRoutePolicy({ call: callOverride, task: route.override, run: route.runDefault, lock });
  return {
    mode: e.mode, source: e.source, locked: lock !== null,
    place: e.mode === null ? null : e.mode === 'ONLY_ON_DEVICE' || e.mode === 'PREFER_ON_DEVICE' ? 'device' : 'cloud',
    destination: e.mode !== null && isCloudCapable(e.mode) ? 'cloud' : 'local',
  };
}

export interface StepRoute {
  readonly mode: RoutePolicyMode | null;
  readonly label: string;
  readonly source: string;
  readonly locked: boolean;
  /** Where the call is meant to run first. Null: no route, so it cannot run. */
  readonly place: 'device' | 'cloud' | null;
  /** The one-call override on offer. Never under the lock, and never before a route exists. */
  readonly override: { readonly mode: RoutePolicyMode; readonly label: string } | null;
  /** Nothing is chosen for the task or the run: the run default comes first. */
  readonly needsDefault: boolean;
}

/** The route one AI step will use, with this call's override if any, after the lock. The adapter reads the route again before the call; this is what is shown. */
export function stepRoute(route: TaskRouteView, callOverride: RoutePolicyMode | null): StepRoute {
  const e = effectiveStep(route, callOverride);
  // The offer is relative to the route without this call's override, so choosing it and then un-choosing it is the same control.
  const base = effectiveStep(route, null);
  const override = base.locked || base.place === null ? null : base.place === 'cloud'
    ? { mode: 'ONLY_ON_DEVICE' as const, label: 'Use this device for this call' }
    : { mode: 'ONLY_IN_CLOUD' as const, label: 'Use cloud for this call' };
  return { mode: e.mode, label: modeLabel(e.mode), source: sourceLabel(e.source), locked: e.locked, place: e.place, override, needsDefault: base.mode === null };
}

/** The worker card's line: the task's effective route and, in words, where its last call ran. */
export const workerRouteText = (route: TaskRouteView): string =>
  `AI: ${modeLabel(route.effective)}${route.lock ? ' (locked)' : ''} · ${observedChip(route.lastObserved).label}`;

/** The statuses the server's plan route lets take a new revision. */
export const REPLANNABLE_STATUSES: readonly TaskView['status'][] = ['planned', 'ready', 'blocked', 'awaiting_approval'];

/** Why a criteria proposal cannot be accepted now. Null: it can. */
export function acceptBlocker(f: { readonly status: TaskView['status']; readonly locked: boolean; readonly canRevise: boolean; readonly live: boolean }): string | null {
  if (f.locked) return 'This proposal came from restricted data. It stays on this device, and a browser proposal does not revise a restricted task.';
  if (!f.canRevise) return 'This source cannot take a plan revision.';
  if (!REPLANNABLE_STATUSES.includes(f.status)) return `A ${f.status.replace(/_/g, ' ')} task cannot take a new revision. Accept criteria when it is planned, ready, blocked or awaiting approval.`;
  if (!f.live) return 'Accepting is off until the connection is live.';
  return null;
}

const REPLAN_CONSEQUENCE = 'Accepting makes a new revision of this task through the replan path, with these criteria. The task goes back to planned, pending approvals for it are withdrawn, an open handover for it closes, and its cost cap may be set again.';

/** What a replan does, and the confirmation it needs when it would withdraw an approval or close a handover. */
export function replanConfirm(f: { readonly pendingApproval: boolean; readonly openHandover: boolean }): { readonly consequence: string; readonly confirm: { readonly title: string; readonly consequence: string; readonly keepLabel: string } | null } {
  if (!f.pendingApproval && !f.openHandover) return { consequence: REPLAN_CONSEQUENCE, confirm: null };
  const lost = [f.pendingApproval ? 'its pending approval is withdrawn' : null, f.openHandover ? 'its open handover closes' : null].filter(Boolean).join(' and ');
  return { consequence: REPLAN_CONSEQUENCE, confirm: { title: 'Replan this task with these criteria?', consequence: `The task goes back to planned, ${lost}, and its cost cap may be set again. This cannot be undone.`, keepLabel: 'Keep the current criteria' } };
}

const REVISION_REFUSALS: Readonly<Record<string, string>> = {
  stale_revision: 'The plan changed since this was read, so nothing was recorded. Draft the criteria again.',
  task_not_replannable: 'This task cannot take a new revision in its current state, so nothing was recorded.',
  route_locked_restricted: 'This task reads restricted data, so a browser proposal does not revise it. Nothing was recorded.',
  criterion_unknown: 'A criterion in the proposal is not one this task has, so nothing was recorded.',
};
/** A refused revision in words, by the code that leads its message. */
export const revisionRefusal = (message: string): string => REVISION_REFUSALS[/^([a-z_]+):/.exec(message)?.[1] ?? ''] ?? 'The revision was not recorded. Trying again is safe.';

export const AGENT_ACTIONS: readonly { readonly kind: Exclude<RouteStepKind, 'brief' | 'plan'>; readonly label: string; readonly what: string }[] = [
  { kind: 'criteria', label: 'Draft criteria', what: 'Rewords this task\'s acceptance criteria so each can be tested.' },
  { kind: 'breakdown', label: 'Break down', what: 'Splits this task into ordered steps.' },
  { kind: 'patch', label: 'Propose change', what: 'Proposes a change as a diff, inside the task\'s allowed paths.' },
  { kind: 'review', label: 'Review change', what: 'Reviews this task\'s change against its criteria.' },
  { kind: 'triage', label: 'Explain failure', what: 'Explains the latest failed check and suggests one next step.' },
  { kind: 'prDescription', label: 'Write PR description', what: 'Writes the pull request title and body from the change summary.' },
];
export type AgentActionKind = (typeof AGENT_ACTIONS)[number]['kind'];

/** Why an action is not offered now. Null: it is. */
export function actionAvailability(kind: AgentActionKind, facts: { readonly hasChange: boolean; readonly failedCheck: boolean }): string | null {
  if ((kind === 'review' || kind === 'prDescription') && !facts.hasChange) return 'There is no change for this task that the browser can read yet.';
  if (kind === 'triage' && !facts.failedCheck) return 'This task has no failed check to explain.';
  return null;
}

const REFUSALS: Readonly<Record<string, string>> = {
  input_too_large_for_device: 'The input is too large for the model on this device, and this route may not use the cloud. Nothing was cut and nothing was sent.',
  route_changed_in_queue: 'Where this task\'s AI runs changed while the call was waiting, so it was stopped before it ran. Run it again.',
  secret_in_input: 'The input looks like it holds a secret, such as a key or a token, so it was not sent to any model.',
  cloud_source_without_approval: 'A cloud answer came back for a call that had to stay on this device, so it was thrown away unread.',
  source_not_shown_on_device: 'The answer did not show that it ran on this device, so it was thrown away unread.',
  cloud_not_granted_for_label: 'Some of what this step reads may not go to the cloud, and this route is cloud only. Choose a local route, or use this device for this call.',
  route_fetch_failed: 'Where this task\'s AI runs could not be read from the server, so nothing was sent.',
  route_unreadable: 'Where this task\'s AI runs could not be read from the server, so nothing was sent.',
  route_required: 'This step did not name its task, so it was not run.',
  route_policy_unset: 'No route is set for this task or its run. Choose where it runs first.',
  secret_excluded_from_model_context: 'This step would read secret data, so it was not run on any model.',
  no_allowed_requirement_ids: 'This task has no acceptance criteria to cite, so this step cannot run.',
  missing_policy: 'No data policy is loaded for this call, so nothing was sent.',
  no_sources: 'This call named nothing to read, so nothing was sent.',
  unclassified_source: 'Part of the input has no data label, so nothing was sent.',
  'missing_destination:firebase_cloud_inference': 'The cloud is not granted for this task\'s data, so a cloud route cannot run it.',
  context_bundle_unreadable: 'The task\'s project context could not be read, so nothing was sent.',
  context_bundle_task_mismatch: 'The project context was for another task, so nothing was sent.',
  context_unavailable: 'The task\'s context could not be read from the server, so nothing was sent.',
  context_destination_refused: 'This task\'s route keeps its AI steps on this device, so no cloud context was served and nothing was sent.',
  no_change: 'There is no change for this task that the browser can read, so there is nothing to review or describe.',
  no_failed_check: 'This task has no failed check to explain.',
  diff_unreadable: 'The change could not be read as a diff, so it was not reviewed.',
  diff_too_large: 'The change is too large to review in one call.',
  review_unsafe_path: 'The change touches a path this task may not change, so it was not reviewed.',
  check_output_too_large: 'The check output is too large to explain in one call. Nothing was cut.',
  delimiter_collision: 'The input could not be fenced safely, so nothing was sent.',
  device_unavailable: 'The model on this device is not ready: this browser does not offer it.',
  device_downloadable: 'The model on this device is not ready: it has not been downloaded yet.',
  device_downloading: 'The model on this device is not ready: it is still downloading.',
  device_unknown: 'The model on this device is not ready: its state could not be read.',
};

/** A refusal code in plain words. Unknown codes still read as a sentence; the code itself is shown apart from it, never as the message. */
export const refusalText = (code: string | null): string => (code === null ? 'The call was stopped.' : REFUSALS[code] ?? 'The call was stopped before it ran.');

export const STATUS_TEXT: Readonly<Record<string, string>> = {
  ok: 'Passed its checks',
  invalid: 'The answer did not pass its checks, so it is not shown as a proposal.',
  blocked: 'Stopped before running',
  route_violation: 'Thrown away: it ran somewhere this route does not allow',
  unverified_source: 'Thrown away: where it ran could not be confirmed',
  error: 'The model call failed. Nothing was kept.',
};
