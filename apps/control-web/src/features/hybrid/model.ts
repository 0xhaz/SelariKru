import {
  DEFAULT_NANO_INPUT_BUDGET_CHARS, RESTRICTED_APPLY_REFUSAL, ROUTE_POLICY_LABELS, effectiveRoutePolicy, isCloudCapable, routeLockFor, suggestRoute,
  type RoutePolicyMode, type RoutePolicySource, type RouteRecord, type RouteStepKind,
} from '@selarikru/domain';
import type { Tone } from '@selarikru/ui';
import type { AuthorizedViewCommand, ProposalAcceptReceipt, SettingView, TaskRouteView, TaskView } from '@selarikru/view-protocol';
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
export function fallbackReason(r: RouteRecord): string {
  if (r.observedSource === 'IN_CLOUD') {
    return r.requestModeMismatch && r.requestedMode === 'ONLY_IN_CLOUD'
      ? 'The input was too large for the device model, so it was sent to the cloud, which this route allows.'
      : 'The device model was not ready, so the cloud answered, which this route allows.';
  }
  return 'The cloud call did not answer, so this device did, which this route allows.';
}

/** A record whose answer did not follow its route (conformance `violation`, or the adapter's `route_violation`). */
export const isRouteViolation = (r: RouteRecord): boolean => r.conformance === 'violation' || r.status === 'route_violation';

/** A route violation in plain words (H7 fix I2). Never described as a fallback, and never as something the route allows. */
export function violationText(r: RouteRecord): string {
  const gone = r.status === 'route_violation' ? ' It was discarded.' : ' It does not count as following this task\'s route.';
  if (r.observedSource === 'IN_CLOUD' && r.effectiveMode === 'ONLY_ON_DEVICE') return `A cloud answer came back for a device-only task.${gone}`;
  if (r.observedSource === 'ON_DEVICE' && r.effectiveMode === 'ONLY_IN_CLOUD') return `A device answer came back for a cloud-only task.${gone}`;
  return `The call was not sent the way this task's route says.${gone}`;
}

/** The last observed source, as reported by the browser and untrusted. An unknown source stays unknown; a violation is said as one. */
export function observedChip(r: RouteRecord | null): Chip {
  if (!r) return { label: 'No AI call yet', tone: 'neutral', detail: null };
  if (r.status === 'blocked' || r.status === 'error') return { label: 'Stopped before running', tone: 'warning', detail: r.blockedReason ? refusalText(r.blockedReason) : 'The call did not run.' };
  if (isRouteViolation(r)) return { label: 'Route violation', tone: 'danger', detail: violationText(r) };
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

/** Why "Accept and apply" is off for a patch proposal (H5), or null. Restricted first: a locked result never leaves this device. */
export function patchAcceptBlocker(f: { readonly status: TaskView['status']; readonly locked: boolean; readonly canAccept: boolean; readonly live: boolean; readonly recorded: boolean; readonly checked: boolean }): string | null {
  if (f.locked) return `${RESTRICTED_APPLY_REFUSAL}. This proposal stays here and is not sent.`;
  if (!f.canAccept) return 'This source cannot apply a change.';
  if (!f.checked) return 'This proposal has no checked file contents to apply.';
  if (!f.recorded) return 'Where this call ran was not recorded, so the proposal cannot be accepted. Propose the change again.';
  if (!['planned', 'ready'].includes(f.status)) return `A ${f.status.replace(/_/g, ' ')} task is not waiting to start, so a change cannot be applied to it now.`;
  if (!f.live) return 'Accepting is off until the connection is live.';
  return null;
}

/** What accepting a patch does. */
export const PATCH_ACCEPT_CONSEQUENCE = 'The server checks the change again. Then the runner applies these exact file contents in a clean sandbox, with no model, and builds, tests and verifies the result. Nothing merges.';

const PATCH_ACCEPT_REFUSALS: Readonly<Record<string, string>> = {
  proposal_restricted: `${RESTRICTED_APPLY_REFUSAL}. Nothing was sent.`,
  proposal_from_restricted_call: `This change came from a call that read restricted data. ${RESTRICTED_APPLY_REFUSAL}.`,
  proposal_from_restricted_context: `This change came from a call whose context held restricted data. ${RESTRICTED_APPLY_REFUSAL}.`,
  route_record_missing: 'The server has no record of where this call ran, so the proposal was not accepted. Propose the change again.',
  task_not_applicable: 'The task is not waiting to start, so the change was not accepted.',
  stale_revision: 'The task has a newer revision. Propose the change again against it.',
  proposal_already_accepted: 'This proposal was already accepted and has not failed, so it is not queued again.',
  too_many_file_requests: 'Too many file reads are waiting. Try again in a moment.',
  proposal_not_acceptable: 'This result cannot be accepted.',
};
const PROPOSAL_CHECK_TEXT: Readonly<Record<string, string>> = {
  base_mismatch: 'it was made against another base commit than the task\'s',
  hash_mismatch: 'a file\'s contents do not match their hash',
  path_outside_allowed: 'it changes a file outside the task\'s allowed paths',
  path_reserved: 'it changes a reserved path',
  path_secret: 'it changes a credentials file',
  path_invalid: 'a path is not a plain file path',
  result_too_large: 'it is larger than a change may be',
  secret_content: 'a file holds something shaped like a secret',
  diff_results_mismatch: 'its diff and its file contents disagree',
  diff_unreadable: 'its diff could not be read',
};

/** A refused accept in plain words. The fallback does not promise a retry will work. */
export function patchAcceptRefusal(message: string): string {
  const code = /^([a-z_]+):/.exec(message)?.[1] ?? '';
  if (code === 'proposal_refused') {
    const check = /([a-z_]+)\s*$/.exec(message)?.[1] ?? '';
    return `The server refused the change: ${PROPOSAL_CHECK_TEXT[check] ?? 'it did not pass the server\'s checks'}. Nothing was applied.`;
  }
  return PATCH_ACCEPT_REFUSALS[code] ?? 'The change was not accepted.';
}

const APPLY_FAILURE_TEXT: Readonly<Record<string, string>> = {
  tests_failed: 'tests failed', build_failed: 'the build failed', proposal_base_mismatch: 'the task\'s base no longer gives these contents', proposal_invalid: 'the proposal did not pass the runner\'s checks',
  proposal_changes_mismatch: 'the build changed an accepted file', proposal_apply_failed: 'the files could not be written safely',
  verification_failed: 'it applied, but did not pass verification',
};

/** Where an accepted proposal is now, in words, and whether to offer accepting it again. A failed apply says why. */
export function patchReceiptText(r: ProposalAcceptReceipt): { readonly text: string; readonly again: boolean } {
  const files = `${r.fileCount} file${r.fileCount === 1 ? '' : 's'}`;
  switch (r.state) {
    case 'failed': {
      const raw = r.lastFailure ?? '';
      const code = /^(?:infrastructure:)?([a-z_]+)/.exec(raw)?.[1] ?? '';
      const detail = raw.includes(': ') ? raw.slice(raw.indexOf(': ') + 2) : '';
      const why = APPLY_FAILURE_TEXT[code] ? `${APPLY_FAILURE_TEXT[code]}${detail ? ` (${detail})` : ''}` : (raw.replace(/_/g, ' ') || 'the runner did not finish');
      return { text: `The last apply failed: ${why}. Accept again to retry.`, again: true };
    }
    case 'superseded': return { text: 'Another accepted change replaced this one before it was applied. Accept again to apply this one instead.', again: true };
    case 'applying': return { text: 'The runner is applying it now.', again: false };
    case 'applied': return { text: 'Applied by the runner. Verification judges the result.', again: false };
    case 'accepted': return {
      text: r.simulated
        ? `Accepted in the demo: ${files}. The demo has no runner, so nothing is applied. Demo data, not evidence.`
        : `${r.round > 1 ? `Accepted again (round ${r.round})` : 'Accepted'}: ${files}. The task waits for the runner, which applies them with no model, then builds, tests and verifies the result.`,
      again: false,
    };
  }
}

/**
 * The round an accept sends, from the proposal as the server last said it is (null: never accepted). Accepting again after a failed apply, a replacement or a failed
 * verification is the next round; otherwise the current one, whose key reads the proposal as it is now. Kept on the server, so a remounted card sends the right one.
 */
export const acceptRoundFor = (r: ProposalAcceptReceipt | null): number => (r === null ? 1 : r.state === 'failed' || r.state === 'superseded' ? r.round + 1 : r.round);

/** Why the patch agent read no files, or null. */
export const filesNoteText = (note: 'restricted' | 'no_checkout' | null | undefined): string | null =>
  note === 'no_checkout' ? 'This runner has no copy of the project; the proposal can only add new files.'
    : note === 'restricted' ? 'This task\'s files stay on this device, so the proposal can only add new files.' : null;

/** Says when Propose change asked the agent again. */
export const reaskNote = (reasked: number | undefined): string | null =>
  !reasked ? null : `The first diff did not apply to the files, so the agent was asked ${reasked === 1 ? 'once more' : `${reasked} more times`} with what was wrong. This is its ${reasked === 1 ? 'second' : 'last'} answer.`;

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
  proposal_from_restricted_context: 'These criteria came from a call whose context held restricted data, so they stay on this device. Nothing was recorded.',
  proposal_from_restricted_call: 'These criteria came from a call that read restricted data, so they stay on this device. Nothing was recorded.',
  criterion_unknown: 'A criterion in the proposal is not one this task has, so nothing was recorded.',
  // The plan route's own checks. None of these changes on a retry: the plan, the run's settings or the policy has to change first.
  plan_invalid: 'The revised plan did not pass the plan checks, so the revision was not recorded.',
  path_not_allowed: 'This task\'s paths are no longer all approved for the run, so the revision was not recorded. Give the paths back under Bounded autonomy first.',
  criteria_not_covered: 'The revised plan would leave a required criterion with no task, so the revision was not recorded.',
  roles_not_covered: 'The revised plan would leave a role this project needs with no task, so the revision was not recorded.',
  plan_over_run_budget: 'This run has no budget left for the revised task, so the revision was not recorded.',
  policy_denied: 'Policy does not allow planning here, so the revision was not recorded.',
};
/** A refused revision in words, by the code that leads its message. The fallback promises nothing about a retry. */
export const revisionRefusal = (message: string): string => REVISION_REFUSALS[/^([a-z_]+):/.exec(message)?.[1] ?? ''] ?? 'The revision was not recorded.';

export const AGENT_ACTIONS: readonly { readonly kind: Exclude<RouteStepKind, 'brief' | 'plan' | 'pmAnswer' | 'pmResearch' | 'pmPlan' | 'pmDelegate' | 'pmBrief' | 'pmVerify' | 'pmVerifyNoWeb'>; readonly label: string; readonly what: string }[] = [
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
  // H12: not an error. The step is saved as a checkpoint and is sent when the connection is back.
  offline: 'Waiting for connection. This step needs the cloud, and you are offline, so it is saved here and sent once you reconnect. Nothing was sent.',
  // H9: the hosted demo's per-tab cap. Not an error: the step waits in Action items.
  cloud_quota: 'Cloud calls left in this demo: 0. This step needs the cloud, so it is paused in Action items › Paused AI work; move it to this device or drop it there. Nothing was sent.',
  // H9 fix round 3: the cloud answered 429. Not offline: it reached the cloud. It waits for you, and is never sent again on its own.
  cloud_rate_limited: 'The cloud said its quota or rate limit is reached, so this step is paused in Action items › Paused AI work. Resume it later, move it to this device, or drop it.',
  inputs_changed: 'This step\'s inputs changed since it paused (its files, context or task revision), so it was not continued. Run it again.',
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
  task_spec_unreadable: 'This task\'s spec could not be read, so nothing was given to the agent.',
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

/**
 * Who suggested a proposal and where it ran (H7), shown until it is accepted. From the SDK's reported source and the server-derived fallback flag; an
 * unknown source is said, never shown as either side.
 */
export function proposalAttribution(source: 'ON_DEVICE' | 'IN_CLOUD' | 'UNKNOWN', fellBack: boolean | null | undefined, simulated = false): string {
  // Demo output came from no model, so it never names one (H7 fix I3).
  if (simulated) return 'Simulated in the demo; no model ran';
  if (source === 'ON_DEVICE') return `Suggested by Gemini Nano on this device${fellBack === true ? ', after falling back from the cloud' : ''}`;
  if (source === 'IN_CLOUD') return `Suggested by Gemini (cloud)${fellBack === true ? ', after falling back from this device' : ''}`;
  return 'Suggested by Gemini; where it ran was not shown';
}

/** A person accepts every proposal: the line every AI proposal carries until then. */
export const PERSON_ACCEPTS = 'A person accepts every proposal. Until then it changes nothing and is not verified.';

const OMISSION_WORDS: Readonly<Record<string, string>> = {
  restricted_for_destination: 'restricted', too_large: 'too large', revoked: 'revoked', stale: 'out of date', out_of_scope: 'outside the task\'s scope',
  accepted_source_revoked: 'source revoked', not_a_claim: 'not a claim',
};

/** What the AI did not see (H7): the count of omissions with their reasons, and restricted files as a count of their own. Null when nothing was left out. */
export function omissionText(omissions: readonly { readonly kind: string; readonly id?: string; readonly reason: string }[]): string | null {
  if (omissions.length === 0) return null;
  const by = new Map<string, number>();
  for (const o of omissions) { const w = OMISSION_WORDS[o.reason] ?? 'withheld'; by.set(w, (by.get(w) ?? 0) + 1); }
  const reasons = [...by].map(([w, n]) => `${n} ${w}`).join(', ');
  const files = omissions.filter((o) => o.kind === 'file' && o.reason === 'restricted_for_destination').length;
  const fileLine = files > 0 ? ` Left out: ${files} restricted file${files === 1 ? '' : 's'}.` : '';
  return `Left out of what the AI saw: ${omissions.length} item${omissions.length === 1 ? '' : 's'} (${reasons}).${fileLine}`;
}
