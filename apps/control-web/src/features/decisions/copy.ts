import type { AuthorizedViewCommand, CommandReceipt } from '@selarikru/view-protocol';
import type { DecisionAction, DecisionCardModel } from './model.ts';

const cardName = (card: DecisionCardModel): string => card.title.replace(/^"|"$/g, '');

/** What a person hears and reads after a command was accepted. Granted and executed are different records, so this says only what was recorded. */
export function outcomeMessage(card: DecisionCardModel, action: Extract<DecisionAction, { kind: 'command' }>, command: AuthorizedViewCommand, receipt: CommandReceipt): string {
  const name = cardName(card);
  switch (command.command) {
    case 'approval.grant': return `${action.label} recorded for ${name}. The scheduler picks it up; that is not the same as it running.`;
    case 'approval.deny': return `Denial recorded for ${name}.`;
    case 'task.cancel': return receipt.execution === 'cancel_requested' ? `Cancel requested for ${name}. It is not stopped until the runner confirms.` : `${name} was cancelled.`;
    case 'run.accept_reduced_scope': return 'Reduced scope accepted. The undelivered work stays listed as not delivered.';
    case 'run.reverify': return 'Sent back for verification. No worker was started.';
    case 'run.open_pull_request': return 'Draft pull request opened. Merging stays on GitHub.';
    default: return 'Recorded.';
  }
}

export interface RejectionView {
  readonly text: string;
  /** True when what was on screen no longer matched the server: the card shows "This request changed" and needs another look. */
  readonly changed: boolean;
}

const REJECTION: Readonly<Record<NonNullable<CommandReceipt['rejection']>, RejectionView>> = {
  stale_revision: { text: 'This request changed; review the updated details. Nothing was decided.', changed: true },
  scope_mismatch: { text: 'This request changed; review the updated details. Nothing was decided.', changed: true },
  approval_expired: { text: 'This request expired while you were deciding, so it was not granted. It can only be denied now.', changed: true },
  unknown_target: { text: 'This no longer exists on the server. Nothing was decided.', changed: true },
  not_allowed: { text: 'The server refused this, and nothing was recorded.', changed: false },
  invalid_command: { text: 'The server could not read this command, and nothing was recorded.', changed: false },
  policy_denied: { text: 'Policy does not allow this, so it was not recorded. No approval can override it.', changed: false },
  cancel_pending: { text: 'A budget stop is still stopping work, so the scope is not final yet.', changed: false },
  not_budget_stopped: { text: 'This run has no budget-stopped work to accept.', changed: false },
  already_accepted: { text: 'This reduced scope was already accepted.', changed: false },
  nothing_to_reverify: { text: 'Nothing here can be re-verified any more. The block may already be cleared.', changed: false },
  reverify_limit_reached: { text: 'This task has used its re-verifications. Replan or cancel it instead.', changed: false },
  resource_conflict: { text: 'Re-verifying is waiting on a resource another task holds. Try again when it is free.', changed: false },
  run_not_ready: { text: 'This run is not ready for a pull request.', changed: false },
  reduced_scope_not_accepted: { text: 'Accept the reduced scope first: a pull request cannot open while budget-stopped work is undecided.', changed: false },
  run_already_merged: { text: 'A pull request for this run was already merged.', changed: false },
};

export const rejectionView = (rejection: CommandReceipt['rejection']): RejectionView => REJECTION[rejection ?? 'not_allowed'];
export const NETWORK_MESSAGE = 'The server could not be reached, so we cannot say whether this was recorded. Trying again is safe.';
