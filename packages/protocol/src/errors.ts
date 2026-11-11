import { z } from 'zod';

/** Stable machine-readable error codes. Clients branch on these, never on `message`. */
export const ERROR_CODES = [
  'unauthenticated',
  'invalid_token',
  'wrong_principal_type',
  'not_owner',
  'invalid_pairing_code',
  'origin_not_allowed',
  'host_not_allowed',
  'invalid_request',
  'not_found',
  'project_not_found',
  'attempt_not_found',
  'terminal_restricted',
  'too_many_terminal_sessions',
  'shutting_down',
  'run_not_found',
  'task_not_found',
  'approval_not_found',
  'ambiguous_id',
  'stale_revision',
  'cursor_ahead',
  'plan_invalid',
  'proposal_rejected',
  'proposal_not_acceptable',
  'acknowledgement_required',
  'missing_server_config',
  'task_not_replannable',
  'command_not_allowed',
  'command_not_supported',
  'cancel_pending',
  'policy_denied',
  'idempotency_key_conflict',
  'scope_mismatch',
  'approval_already_resolved',
  'reduced_scope_changed',
  'approval_expired',
  'lease_conflict',
  'actor_not_permitted',
  'pull_request_not_allowed',
  'no_provider_detected',
  'unsupported_provider',
  'unsupported_model',
  'model_not_allowed',
  'trial_model_pinned',
  'origin_required',
  'control_refused_trial',
  'attempt_not_running',
  'control_session_active',
  'control_ticket_used',
  'control_unavailable',
  'credential_in_input', 'step_not_available', 'onboarding_not_found', 'onboarding_cancelled', 'onboarding_not_activated', 'template_not_supported', 'pilot_criteria_fixed', 'criteria_not_covered', 'roles_not_covered', 'role_has_many_tasks', 'model_over_run_budget', 'plan_over_run_budget', 'project_already_started', 'second_repository_refused', 'readiness_failed', 'already_activated', 'not_ready', 'restricted_stays_on_device', 'route_not_recorded', 'outside_recorded_limits',
  /** Settings and run controls: the run is closed or being cancelled, no such worker, a path outside the plan, a resume the run cannot take yet, nothing to record a change against. */
  'run_closed', 'runner_not_found', 'outside_plan_scope', 'resume_refused', 'no_run', 'path_not_allowed',
  /** Route policy: a cloud-capable mode asked for a task whose data is restricted or secret. It stays on the device until a reclassification decision lowers the label. */
  'route_locked_restricted',
  /** A route record replayed with the same request id but a different body. The first record stands. */
  'replay_mismatch',
  /** The database aborted the transaction to break a deadlock or a serialization conflict. Nothing was recorded; the same request may be sent again. */
  'transaction_conflict',
  /** Project Brain: no such source, revision or conflict; a source already revoked; a conflict already settled; a manifest from work whose data stays on the device. */
  'brain_source_not_found', 'brain_source_revoked', 'brain_conflict_not_found', 'brain_conflict_resolved', 'brain_manifest_restricted',
  /** Stack settings: a write over a newer revision; no such component, selection or detection; an entry the catalog does not have or lists elsewhere; a duplicate or a
   * settled detection; a limit; a detection from work whose data stays on the device. */
  'stack_revision_conflict', 'stack_component_not_found', 'stack_item_not_found', 'stack_detection_not_found', 'stack_entry_unknown', 'stack_entry_wrong_category',
  'stack_item_exists', 'stack_detection_settled', 'stack_limit', 'stack_detection_restricted', 'stack_unreadable', 'classification_downgrade',
  /** Skill library: no such pack or version; a blocked pack cannot be reviewed; review findings not acknowledged; already reviewed or revoked; a binding to a version
   * that is not reviewed or is revoked; an intake path that cannot be read as a pack, or whose content is already staged elsewhere. */
  'skill_not_found', 'skill_version_not_found', 'skill_not_reviewable', 'skill_findings_unacknowledged', 'skill_already_reviewed', 'skill_already_revoked',
  'skill_not_reviewed', 'skill_revoked', 'skill_intake_failed', 'skill_already_staged', 'skill_binding_unscoped', 'skill_confirmation_mismatch',
  /** Product records: no such record; a citation that does not resolve to a stored Brain revision and anchor; a requirement this project does not have; a release note for a run
   * no person merged; product history needs a run to record its events against; a proposal from work whose data stays on the device. */
  'product_record_not_found', 'product_citation_invalid', 'product_requirement_unknown', 'product_not_merged', 'product_needs_run', 'product_proposal_restricted', 'product_requirement_mismatch', 'product_proposal_not_found',
  /** Checkpoint continuation: a handover refused (the reason is in details), a checkpoint refused or changed since it was checked, restricted work's checkpoint, no such handover. */
  'handover_refused', 'handover_task_blocked', 'checkpoint_refused', 'checkpoint_tampered', 'checkpoint_restricted', 'handover_not_found', 'no_checkpoint',
  /** A task's agent context: its spec cannot be read, so nothing is given to an agent. */
  'task_spec_unreadable',
  /** A cloud context asked for a task whose route keeps its AI steps on the device. */
  'context_destination_refused',
  /** Accepted patch proposals (H5): a restricted task's proposal (its content stays on the device); a proposal the server's checks refuse (the issue code is in details);
   * a proposal with no route record of its patch call; a task that is not waiting to start; a proposal already accepted; no proposal for this apply attempt. */
  'proposal_restricted', 'proposal_from_restricted_call', 'proposal_from_restricted_context', 'context_id_reused', 'proposal_refused', 'route_record_missing', 'task_not_applicable', 'proposal_already_accepted', 'no_proposal',
  /** Base files for the patch agent: restricted tasks are never served; no runner with the project's checkout answered in time; no such file request. */
  'files_restricted', 'files_unavailable', 'file_request_not_found', 'no_checkout', 'too_many_file_requests',
  /** H11: a worker name that cannot be used. */
  'name_empty', 'name_too_long', 'name_invalid', 'name_secret', 'name_taken',
  // H11 fix round 1: a Project Manager delegation bound to its call, and a worker role from the project's roles.
  'delegation_output_mismatch', 'plan_revision_changed', 'route_record_used', 'role_unknown', 'role_pm_taken', 'pm_plan_refused', 'plan_output_mismatch',
  // H12: AI step checkpoints.
  'checkpoint_secret', 'checkpoint_project_mismatch', 'checkpoint_not_found', 'checkpoint_closed', 'escalation_refused',
  'internal_error',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorBodySchema = z
  .object({ error: z.object({ code: ErrorCodeSchema, message: z.string(), details: z.unknown().optional() }).strict() })
  .strict();
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
