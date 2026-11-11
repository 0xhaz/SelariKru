/**
 * Every reason a claim can be refused for, top level or per candidate, and whether it clears by itself (`transient`) or needs someone
 * to act. The claim code returns only these (`ClaimReason`), and the benchmark runner reads the same table, so the two cannot drift.
 * Reasons that carry a detail after a prefix are families: the prefix decides, except `placement_blocked:`, which the placement's own
 * reason decides.
 */

const exact = {
  // Top level.
  invalid_runner: false,
  concurrency_limit_reached: true,
  runner_disabled: false,
  runner_slots_full: true,
  no_claimable_task: true,
  // Per candidate.
  illegal_transition: true,
  run_paused: false,
  status_changed: true,
  invalid_spec: false,
  stale_status: true,
  previous_attempt_active: true,
  cancel_requested: false,
  handover_execution_local: false,
  dependencies_unsatisfied: true,
  resource_conflict: true,
  skill_runner_update_required: false,
  location_mismatch: false,
  // Coding workers are off: a task waits for the owner to accept a patch proposal. And an accepted proposal waits for a runner that can apply it.
  awaiting_accepted_proposal: false,
  apply_runner_update_required: false,
  last_apply_failed: false,
  last_apply_unverified: false,
  infra_retry_backoff: true,
  reservation_not_settled: true,
  no_free_slot: true,
  // A handover's holds.
  handover_stopping: true,
  handover_awaiting_review: false,
  handover_decision_pending: false,
  handover_successor_active: true,
  // A repair the policy refused, and the budget (holds are never handed back, and more budget needs the owner).
  repair_limit_exhausted: false,
  invalid_attempt: false,
  missing_policy: false,
  unknown_operation: false,
  invalid_running_count: false,
  no_sources: false,
  // Other operations' policy denials, which reach a claim only inside a placement or approval reason; listed so none reads as unknown.
  missing_models_config: false,
  model_not_allowed: false,
  source_not_cloud_eligible: false,
  source_not_selected: false,
  unclassified_source: false,
  'missing_destination:execution': false,
  'budget:missing_limit': false,
  'budget:unknown_cost': false,
  'budget:exceeds_limit': false,
} as const satisfies Readonly<Record<string, boolean>>;

const families = {
  'missing_limit:': false,
  'model_blocked:': false,
  'skill_blocked:': false,
  'awaiting_approval:': false,
  'handover_held_for_': false,
  'hard_deny:': false,
  'not_administrator:': false,
  'missing_operation_config:': false,
  'invalid_operation_config:': false,
  'configured_deny:': false,
} as const satisfies Readonly<Record<string, boolean>>;

/** Placement reasons that are a wait, not a block (placement.ts marks the same ones `transient`). */
const PLACEMENT_TRANSIENT: ReadonlySet<string> = new Set(['concurrency_limit_reached', 'no_free_slot', 'policy_denied:concurrency_limit_reached']);
const PLACEMENT_FAMILIES = ['missing_limit:', 'role_not_mapped:', 'policy_denied:', 'approval_required:', 'location_disabled:', 'policy_revoked:'] as const;
const PLACEMENT_EXACT: ReadonlySet<string> = new Set([
  'concurrency_limit_reached', 'no_free_slot', 'invalid_running_count', 'execution_conflicts_with_role_pin', 'classification_not_cloud_eligible', 'unknown_placement_mode',
]);

export type ClaimReasonCode = keyof typeof exact;
export type ClaimReason = ClaimReasonCode | `${keyof typeof families}${string}` | `placement_blocked:${string}`;

export const CLAIM_REASONS: Readonly<Record<ClaimReasonCode, boolean>> = exact;

export function classifyClaimReason(reason: string): { readonly known: boolean; readonly transient: boolean } {
  if (Object.hasOwn(exact, reason)) return { known: true, transient: exact[reason as ClaimReasonCode] };
  if (reason.startsWith('placement_blocked:')) {
    const inner = reason.slice('placement_blocked:'.length);
    const known = PLACEMENT_EXACT.has(inner) || PLACEMENT_FAMILIES.some((p) => inner.startsWith(p));
    return { known, transient: known && PLACEMENT_TRANSIENT.has(inner) };
  }
  for (const [prefix, transient] of Object.entries(families)) if (reason.startsWith(prefix)) return { known: true, transient };
  return { known: false, transient: false };
}

/** Types a reason the claim code built from a part (a policy decision, a hold, a budget check) as a claim reason. The table above covers all of them; a test checks it. */
export const asClaimReason = (reason: string): ClaimReason => reason as ClaimReason;
