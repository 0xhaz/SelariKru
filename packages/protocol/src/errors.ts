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
  'credential_in_input', 'step_not_available', 'onboarding_not_found', 'onboarding_cancelled', 'onboarding_not_activated', 'template_not_supported', 'project_already_started', 'second_repository_refused', 'readiness_failed', 'already_activated', 'not_ready', 'restricted_stays_on_device', 'route_not_recorded', 'outside_recorded_limits',
  'internal_error',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorBodySchema = z
  .object({ error: z.object({ code: ErrorCodeSchema, message: z.string(), details: z.unknown().optional() }).strict() })
  .strict();
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
