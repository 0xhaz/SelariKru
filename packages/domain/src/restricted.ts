import { ApprovalDestinationSchema, diffViolationCount, restrictedApprovalReason, restrictedDiffReason, WORKER_APPROVAL_OPERATIONS, type WorkerApprovalOperation } from './approval.ts';

/**
 * Everything a restricted attempt may put in the record as its reason, by outcome. Restricted input and output stay on the device, and a runner's sentence can carry a path or
 * the agent's words, so for an attempt the claim did not clear for streaming the server stores one of these and nothing else. A closed list: a runner branch that is not named
 * here gets its outcome's fallback, so a new error path cannot add a leak. The runner sends these too, and keeps the detail in its own log.
 *
 * Every entry is a fixed string. Two reasons are built from checked values instead: the completion gate's count (`restrictedDiffReason`) and an approval request's operation and
 * destination (`restrictedApproval`).
 */
export const RESTRICTED_REASONS = {
  failed: [
    'worker_failed', 'task_bundle_failed', 'cancelled_before_start', 'timeout_before_start', 'agent_stop_unconfirmed', 'unexpected_mcp_server', 'cancelled', 'attempt_timeout',
    'agent_result_failed', 'agent_exit_failed', 'diff_failed', 'reserved_path_changed', 'completion_gate_error', 'diff_outside_allowed_paths', 'change_set_store_failed',
  ],
  blocked: [
    'worker_blocked', 'cloud_execution_required', 'no_local_repository', 'allowed_paths_invalid', 'base_not_full_commit', 'egress_enforcement_unavailable', 'scope_grant_unavailable',
    'no_model_recorded', 'unsupported_provider', 'unsupported_model', 'toolchain_unresolved', 'secret_in_task_text', 'model_mismatch', 'model_unverified',
    'harness_capability_unavailable', 'approval_signal_refused',
  ],
  infrastructure_failed: [
    'provisioning_failed', 'provisioning_failed: sandbox unavailable', 'provisioning_failed: the toolchain pin could not be read', 'provisioning_failed: a setup step failed',
    'provisioning_failed: the attempt timeout was reached during setup', 'provisioning_failed: this runtime cannot set up a Node toolchain',
  ],
} as const satisfies Record<string, readonly string[]>;

export type RestrictedOutcome = keyof typeof RESTRICTED_REASONS;
export type RestrictedReason<O extends RestrictedOutcome = RestrictedOutcome> = (typeof RESTRICTED_REASONS)[O][number];

/** What a restricted attempt's reason becomes when a runner sends anything off the list. */
export const RESTRICTED_FALLBACK: { readonly [O in RestrictedOutcome]: RestrictedReason<O> } = { failed: 'worker_failed', blocked: 'worker_blocked', infrastructure_failed: 'provisioning_failed' };

/** The reason a restricted attempt keeps: `sent` if it is on the list for `outcome`, the gate's count rebuilt from its number, or else the outcome's fallback. Never other text. */
export function restrictedReason(outcome: RestrictedOutcome, sent: string): string {
  if (outcome !== 'infrastructure_failed') {
    const count = diffViolationCount(sent);
    if (count !== null) return restrictedDiffReason(count);
  }
  return (RESTRICTED_REASONS[outcome] as readonly string[]).includes(sent) ? sent : RESTRICTED_FALLBACK[outcome];
}

/**
 * A restricted approval request as the record may hold it: the operation only if it is on the worker list, the destination host only if it is a plain host name, and the fixed
 * sentence built from those two. Anything else is dropped, and the agent's own reason is never kept.
 */
export function restrictedApproval<D extends { readonly host: string }>(operation: string | undefined, destination: D | null | undefined): { readonly operation: WorkerApprovalOperation | undefined; readonly destination: D | undefined; readonly reason: string } {
  const known = (WORKER_APPROVAL_OPERATIONS as readonly string[]).includes(operation ?? '') ? (operation as WorkerApprovalOperation) : undefined;
  const host = destination && ApprovalDestinationSchema.shape.host.safeParse(destination.host).success ? destination : undefined;
  return { operation: known, destination: host, reason: restrictedApprovalReason(known, host) };
}
