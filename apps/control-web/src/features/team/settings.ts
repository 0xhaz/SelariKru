import { isClosedTask } from '../overview/attention.ts';
import { cancelAction, type DecisionAction, type DecisionCardModel, type DecisionsModel } from '../decisions/model.ts';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';
import type { TeamRow } from './model.ts';

export type CommandAction = Extract<DecisionAction, { kind: 'command' }>;

export interface WorkerSettingsModel {
  /** Stops the running attempt by cancelling its task: the one owner command that stops work. Null when the worker holds no open task. */
  readonly stop: CommandAction | null;
  /** Why there is no Stop. Null when there is one. */
  readonly stopNone: string | null;
  /** The Decisions cards about this worker's current or last task, with the actions that apply to it. */
  readonly cards: readonly { readonly card: DecisionCardModel; readonly actions: readonly DecisionAction[] }[];
}

const STOP_CONSEQUENCE = 'The running attempt is stopped and the task is cancelled for good. It is not stopped until the runner confirms. Work so far stays on record, but the task only runs again through a new plan revision. Changing the model instead keeps the task and applies from its next attempt.';

/** Cancelling has no Decisions card of its own; this key keeps its confirmation and idempotency key apart from the cards'. */
export const STOP_CARD = 'stop';

/** A confirmation as it was opened: the exact command it will send, and the card it was read from. */
export interface PendingConfirm {
  readonly cardId: string;
  readonly action: CommandAction;
  readonly fingerprint: string | null;
}

/** The action now on screen with this card and id, or null when it is gone. */
export function currentAction(settings: WorkerSettingsModel, cardId: string, actionId: string): { readonly card: DecisionCardModel | null; readonly action: CommandAction | null } {
  if (cardId === STOP_CARD) return { card: null, action: settings.stop !== null && settings.stop.id === actionId ? settings.stop : null };
  const entry = settings.cards.find((c) => c.card.id === cardId);
  const action = entry?.actions.find((a): a is CommandAction => a.kind === 'command' && a.id === actionId) ?? null;
  return { card: entry?.card ?? null, action };
}

/**
 * A confirmation stands only while the session is live and what it would send is exactly what is on screen: the same command for the same task at the same revision,
 * still on, and, for a card, a card that has not changed or been held since. Anything else drops it unsent.
 */
export function confirmationStale(p: PendingConfirm, settings: WorkerSettingsModel, live: boolean, held: ReadonlySet<string>): boolean {
  if (!live || held.has(p.cardId)) return true;
  const now = currentAction(settings, p.cardId, p.action.id);
  if (now.action === null || now.action.disabledReason !== null) return true;
  if (JSON.stringify(now.action.intent) !== JSON.stringify(p.action.intent)) return true;
  return p.cardId !== STOP_CARD && now.card?.fingerprint !== p.fingerprint;
}

const PAUSED_FALLBACK = 'Stopping is off until the connection is live, so nothing is changed on stale state.';

/**
 * What the drawer's Settings tab can do for one worker, built from the same Decisions model and owner commands as the Decisions screen, so each keeps its confirmation,
 * its "off when not live" rule and its server route. Nothing here is a new command.
 */
export function workerSettings(snapshot: ProjectViewSnapshot, decisions: DecisionsModel | null, row: TeamRow): WorkerSettingsModel {
  const paused = decisions ? decisions.paused : PAUSED_FALLBACK;
  const current = row.task ? snapshot.tasks[row.task.taskId] : undefined;
  const open = current !== undefined && !isClosedTask(current) ? current : null;
  const stop = open
    ? ({ ...cancelAction(open, paused, 'Cancel task', STOP_CONSEQUENCE), confirm: { title: `Cancel "${open.title ?? open.taskId}"?`, consequence: STOP_CONSEQUENCE, keepLabel: 'Keep the task' } } as CommandAction)
    : null;
  const stopNone = stop ? null : row.task ? 'This task has already finished, so there is nothing to cancel.' : 'This worker has no task now, so there is nothing to cancel.';

  const focus = row.task ?? row.lastTask;
  const focusTask = focus ? snapshot.tasks[focus.taskId] : undefined;
  if (!focusTask || !decisions) return { stop, stopNone, cards: [] };
  const ids = new Set([`placement:${focusTask.taskId}`, `reverify:${focusTask.runId}`, `scope:${focusTask.runId}`, ...Object.values(snapshot.approvals).filter((a) => a.taskId === focusTask.taskId).map((a) => `decision:${a.approvalId}`)]);
  const keep = (a: DecisionAction): boolean => {
    if (a.kind !== 'command') return true;
    const { intent } = a;
    if (intent.command !== 'task.cancel') return true;
    // Another task's cancel belongs to that task's worker; this task's is Stop when it is running.
    return (intent.args as { taskId: string }).taskId === focusTask.taskId && stop === null;
  };
  const cards = decisions.cards.filter((c) => ids.has(c.id)).map((card) => ({ card, actions: card.actions.filter(keep) }));
  return { stop, stopNone, cards };
}
