import type { AuthorizedViewCommand, CommandReceipt } from '@selarikru/view-protocol';
import type { DecisionAction, DecisionCardModel } from './model.ts';

/** What a person hears and reads after a command was accepted. Granted and executed are different records, so this says only what was recorded. */
export function outcomeMessage(card: DecisionCardModel, action: Extract<DecisionAction, { kind: 'command' }>, command: AuthorizedViewCommand, receipt: CommandReceipt): string {
  const name = card.title;
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
  approval_already_resolved: { text: 'This request was already decided, so nothing new was recorded.', changed: false },
  reduced_scope_changed: { text: 'This request changed: what was not delivered is different now. Nothing was accepted; review the updated list.', changed: true },
  not_allowed: { text: 'The server refused this, and nothing was recorded.', changed: false },
  invalid_command: { text: 'The server could not read this command, and nothing was recorded.', changed: false },
  policy_denied: { text: 'Policy does not allow this, so it was not recorded. No approval can override it.', changed: false },
  cancel_pending: { text: 'A budget stop is still stopping work, so the scope is not final yet.', changed: false },
  not_budget_stopped: { text: 'This run has no budget-stopped work to accept.', changed: false },
  already_accepted: { text: 'This reduced scope was already accepted.', changed: false },
  nothing_to_reverify: { text: 'Nothing here can be re-verified any more. The block may already be cleared.', changed: false },
  reverify_limit_reached: { text: 'This task has used its re-verifications under this verifier. Replan or cancel it instead.', changed: false },
  resource_conflict: { text: 'Re-verifying is waiting on a resource another task holds. Try again when it is free.', changed: false },
  run_not_ready: { text: 'This run is not ready for a pull request.', changed: false },
  reduced_scope_not_accepted: { text: 'Accept the reduced scope first: a pull request cannot open while budget-stopped work is undecided.', changed: false },
  run_already_merged: { text: 'A pull request for this run was already merged.', changed: false },
  candidate_changed: { text: 'The verified candidate changed while this was being sent. Nothing was opened; review the updated run.', changed: true },
  no_valid_record: { text: 'No live verification record supports this candidate, so no pull request was opened.', changed: false },
  record_not_passing: { text: 'The verification record for this candidate is not a full pass, so no pull request was opened.', changed: false },
  no_candidate: { text: 'This run has no assembled candidate to open a pull request for.', changed: false },
  pull_request_refused: { text: 'The server refused to open this pull request, and nothing was recorded.', changed: false },
  no_provider_detected: { text: 'No runner has reported an installed harness, so no model can be assigned.', changed: false },
  unsupported_provider: { text: 'That provider is not installed here, or cannot run a chosen model. Nothing was saved.', changed: false },
  unsupported_model: { text: 'That model is not one the installed harness offers. Nothing was saved.', changed: false },
  model_not_allowed: { text: 'Policy does not allow that model, so it was not saved. No approval can override it.', changed: false },
  trial_model_pinned: { text: 'This run is a benchmark trial pinned to one model, so overrides are refused.', changed: false },
};

export const rejectionView = (rejection: CommandReceipt['rejection']): RejectionView => REJECTION[rejection ?? 'not_allowed'];
export const NETWORK_MESSAGE = 'The server could not be reached, so we cannot say whether this was recorded. Trying again is safe.';
/** Nothing left the browser: different from a request that went out and got no answer. */
export const NOT_SENT_MESSAGE = 'Not sent: the connection dropped before this could go out, so nothing was decided.';
export const CHANGED_NOT_SENT_MESSAGE = 'This request changed while you were deciding. Nothing was sent; review it again.';
export const GONE_NOT_SENT_MESSAGE = 'That request is no longer waiting. Nothing was sent.';
