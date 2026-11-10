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
    ? ({ ...cancelAction(open, paused, 'Stop and cancel this task', STOP_CONSEQUENCE), confirm: { title: `Stop and cancel "${open.title ?? open.taskId}"?`, consequence: STOP_CONSEQUENCE, keepLabel: 'Keep it running' } } as CommandAction)
    : null;
  const stopNone = stop ? null : row.task ? 'This task has already finished, so there is nothing to stop.' : 'This worker has no task now, so there is nothing to stop.';

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
