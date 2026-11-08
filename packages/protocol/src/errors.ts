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
  'approval_expired',
  'lease_conflict',
  'actor_not_permitted',
  'internal_error',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorBodySchema = z
  .object({ error: z.object({ code: ErrorCodeSchema, message: z.string(), details: z.unknown().optional() }).strict() })
  .strict();
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
