import { checkpointLabel, type AiCheckpoint, type AiCheckpointStopReason } from '@selarikru/domain';
import type { Tone } from '@selarikru/ui';
import type { CheckpointState } from './engine.ts';

/** H12: what the Paused AI work list, the activity feed and the office say about checkpoints. Pure: read from the engine's state and the snapshot's titles. */

export const STEP_LABEL: Readonly<Record<string, string>> = {
  criteria: 'Draft criteria', breakdown: 'Break down', patch: 'Propose change', review: 'Review change', triage: 'Explain failure', prDescription: 'Write PR description',
  pmAnswer: 'Ask the PM', pmResearch: 'PM web research', pmPlan: 'PM plan draft', pmDelegate: 'PM assignments', brief: 'Draft brief', plan: 'Plan',
};

export const STOP_TEXT: Readonly<Record<AiCheckpointStopReason, string>> = {
  offline: 'Waiting for connection',
  input_too_large_for_device: 'Too large for the model on this device',
  local_failed_checks: 'The local result failed its checks',
  awaiting_owner: 'Waiting for you',
  route_changed: 'The route changed while it waited',
  budget: 'No cloud budget',
  cloud_quota: 'Cloud call limit reached for this demo',
};

export const PROBLEM_TEXT: Readonly<Record<string, string>> = {
  route_unreadable: 'Where this task\'s AI runs could not be read, so nothing was sent.',
  route_changed: 'This task\'s route changed since it paused, so it was not sent.',
  locked: 'This task now reads restricted data, so it stays on this device.',
  revision_changed: 'The task has a new revision since it paused, so it was not sent.',
  inputs_changed: 'Its inputs changed since it paused (files, context or task revision), so it was not sent.',
  budget_missing: 'This run has no budget set, so a cloud step is not sent. Missing is never unlimited: set one in Settings › Workflow.',
  budget_exhausted: 'This run\'s budget is used up, so a cloud step is not sent.',
  context_refused: 'The server did not serve this step\'s context for the cloud, so it was not sent.',
  not_local_first: 'Not escalated: only a Local first task continues in the cloud after its local result fails. This one is not Local first.',
  already_escalated: 'Already escalated once; it is not escalated again.',
  device_only: 'Not escalated: this call was set to run on this device only, so it never goes to the cloud.',
  not_failed_checks: 'Not escalated: its local result did not fail its checks.',
  escalation_refused: 'The server did not allow escalating this step.',
  claimed: 'Another tab is sending this step, or already sent it; it is not sent twice.',
  claim_failed: 'This step could not be claimed for sending. Try again.',
};

export interface PausedRow {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly step: string;
  /** The one line: "Waiting for connection", "Resume in cloud? <task> · <step>", … */
  readonly headline: string;
  readonly stop: string;
  readonly tone: Tone;
  /** What would be sent. A restricted checkpoint shows sizes and labels only. */
  readonly sends: string;
  readonly problems: readonly string[];
  readonly restricted: boolean;
  readonly busy: boolean;
  /** Null: offered. Otherwise why not. */
  readonly resume: string | null;
  readonly escalate: string | null;
  readonly moveToDevice: string | null;
  /** Fix round 2: an abandoned step (its tab closed mid-step), offered Run again (from scratch) and Dismiss. */
  readonly abandoned?: boolean;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** What resuming would send, in words. Restricted: sizes and labels only, never a path or a word of its text. */
export function sendsText(cp: AiCheckpoint): string {
  const label = checkpointLabel(cp);
  const size = cp.inputs.inputChars !== null ? `${cp.inputs.inputChars} characters` : 'size not measured';
  const labels = [...new Set([...cp.labels, ...(cp.partial?.texts ?? []).map((t) => t.classification)])].join(', ');
  if (label !== 'public' && label !== 'internal') return `${size} · ${plural(cp.inputs.files.length, 'file')} · labels: ${labels}. Restricted: kept on this device, never sent to the cloud.`;
  const files = cp.inputs.files.length > 0 ? ` · files: ${cp.inputs.files.map((f) => f.path).join(', ')}` : '';
  const q = cp.partial?.texts.find((t) => t.who === 'owner');
  return `${size}${files}${q ? ` · question: "${q.text.slice(0, 80)}${q.text.length > 80 ? '…' : ''}"` : ''} · labels: ${labels}`;
}

export function pausedRows(state: Pick<CheckpointState, 'checkpoints' | 'problems' | 'asks' | 'busy'> & { readonly dismissed?: Readonly<Record<string, boolean>> }, titleOf: (taskId: string) => string, online: boolean): PausedRow[] {
  const dismissed = state.dismissed ?? {};
  const abandoned = Object.values(state.checkpoints).filter((cp) => cp.status === 'abandoned' && !dismissed[cp.checkpointId]).map((cp): PausedRow => {
    const title = titleOf(cp.taskId);
    const step = STEP_LABEL[cp.stepKind] ?? cp.stepKind;
    return {
      id: cp.checkpointId, taskId: cp.taskId, title, step, headline: `Abandoned: ${title} · ${step}`, stop: 'Abandoned', tone: 'warning',
      sends: 'Its tab closed while it ran, so it never finished. Run it again from scratch, or dismiss it.', problems: [], restricted: !['public', 'internal'].includes(checkpointLabel(cp)),
      busy: state.busy[cp.checkpointId] === true, resume: 'An abandoned step is run again from scratch, not resumed.', escalate: 'An abandoned step is run again from scratch.', moveToDevice: 'An abandoned step is run again from scratch.', abandoned: true,
    };
  });
  return [...abandoned, ...Object.values(state.checkpoints).filter((cp) => cp.status === 'waiting').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((cp): PausedRow => {
    const title = titleOf(cp.taskId);
    const step = STEP_LABEL[cp.stepKind] ?? cp.stepKind;
    const problems = (state.problems[cp.checkpointId] ?? []).map((p) => PROBLEM_TEXT[p] ?? p);
    const ask = state.asks[cp.checkpointId];
    const stop = cp.stopReason ? STOP_TEXT[cp.stopReason] : 'Paused';
    const restricted = !['public', 'internal'].includes(checkpointLabel(cp));
    const headline = ask === 'resume' ? `Resume in cloud? ${title} · ${step}` : ask === 'escalate' ? `Escalate to cloud? ${title} · ${step}` : `${stop}: ${title} · ${step}`;
    const cloudOk = cp.continuation === 'cloud_capable';
    // Fix round 1 (M4): Resume runs the whole check again, so it is offered whenever this browser is online, even after a refusal.
    const resume = cp.stopReason === 'local_failed_checks' ? 'This step continues in the cloud only by escalation.'
      : cp.stopReason === 'cloud_quota' ? 'This demo tab has used all its cloud calls. Move it to this device, or drop it.'
      : !cloudOk ? 'This step may only run on this device.' : !online ? 'Waiting for connection.' : null;
    const escalate = cp.stopReason !== 'local_failed_checks' ? 'Only a step whose local result failed its checks is escalated.' : !online ? 'Waiting for connection.' : null;
    return {
      id: cp.checkpointId, taskId: cp.taskId, title, step, headline, stop, tone: problems.length > 0 ? 'warning' : ask ? 'active' : 'neutral',
      sends: sendsText(cp), problems, restricted, busy: state.busy[cp.checkpointId] === true, resume, escalate,
      moveToDevice: cp.routeMode === 'ONLY_ON_DEVICE' && cp.stopReason === 'input_too_large_for_device' ? 'It is already device only, and too large for this device.' : null,
    };
  })];
}

export interface CheckpointActivity { readonly id: string; readonly at: string; readonly glyph: string; readonly tone: Tone; readonly text: string }

/** The activity feed's checkpoint lines: "Paused: offline", "Sent after reconnecting", "Escalated to cloud". */
export function checkpointActivity(checkpoints: readonly AiCheckpoint[], titleOf: (taskId: string) => string): CheckpointActivity[] {
  return checkpoints.flatMap((cp): CheckpointActivity[] => {
    const what = `${titleOf(cp.taskId)} · ${STEP_LABEL[cp.stepKind] ?? cp.stepKind}`;
    if (cp.status === 'waiting' && cp.stopReason === 'offline') return [{ id: `ckp:${cp.checkpointId}`, at: cp.updatedAt, glyph: '‖', tone: 'warning', text: `${what}: Paused: offline` }];
    if (cp.status === 'waiting' && cp.stopReason) return [{ id: `ckp:${cp.checkpointId}`, at: cp.updatedAt, glyph: '‖', tone: 'warning', text: `${what}: Paused: ${STOP_TEXT[cp.stopReason].toLowerCase()}` }];
    if (cp.status === 'sent') return [{ id: `ckp:${cp.checkpointId}`, at: cp.updatedAt, glyph: '☁', tone: 'active', text: `${what}: Sent after reconnecting` }];
    if (cp.status === 'escalated') return [{ id: `ckp:${cp.checkpointId}`, at: cp.updatedAt, glyph: '⇡', tone: 'active', text: `${what}: Escalated to cloud: local result failed checks` }];
    if (cp.status === 'abandoned') return [{ id: `ckp:${cp.checkpointId}`, at: cp.updatedAt, glyph: '!', tone: 'warning', text: `Abandoned: ${what}` }];
    if (cp.status === 'moved_to_device') return [{ id: `ckp:${cp.checkpointId}`, at: cp.updatedAt, glyph: '▣', tone: 'success', text: `${what}: Moved to device only` }];
    return [];
  });
}

/** The office's waiting robots: a step waiting to be sent to the cloud stands at the rooftop CLOUD deck, marked waiting. */
export function waitingCloudCalls(checkpoints: readonly AiCheckpoint[]): { readonly taskId: string; readonly place: 'cloud'; readonly stepKind: string; readonly waiting: true }[] {
  return checkpoints.filter((cp) => cp.status === 'waiting' && cp.continuation === 'cloud_capable' && (cp.stopReason === 'offline' || cp.stopReason === 'local_failed_checks'))
    .map((cp) => ({ taskId: cp.taskId, place: 'cloud' as const, stepKind: cp.stepKind, waiting: true as const }));
}

/** The result card's line for an outcome that continued a paused step. Never a fallback. */
export function resumedText(resumed: string | undefined): string | null {
  if (resumed === 'after_reconnect') return 'Sent after reconnecting';
  if (resumed === 'escalated') return 'Escalated to cloud: local result failed checks';
  if (resumed === 'device_only') return 'Moved to device only';
  return null;
}
