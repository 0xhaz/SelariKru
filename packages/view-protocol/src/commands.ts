import { z } from 'zod';

const Id = z.string().min(1);

/**
 * Distinct typed commands (no generic command bag, and no secret values). The name does not mean the browser can assert permission:
 * the server decides authorization. `expectedRevision` is the aggregate revision the caller saw; `idempotencyKey` makes a retry safe.
 */
const base = { expectedRevision: z.number().int().min(0), idempotencyKey: Id };

export const AuthorizedViewCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('task.cancel'), ...base, args: z.object({ taskId: Id }).strict() }).strict(),
  z.object({ command: z.literal('task.retry'), ...base, args: z.object({ taskId: Id }).strict() }).strict(),
  z.object({ command: z.literal('approval.grant'), ...base, args: z.object({ approvalId: Id, scopeHash: Id }).strict() }).strict(),
  z.object({ command: z.literal('approval.deny'), ...base, args: z.object({ approvalId: Id, scopeHash: Id }).strict() }).strict(),
  // Run-level commands. `expectedRevision` is the plan revision the caller saw. There is no merge command, and there never will be: people merge on GitHub.
  z.object({ command: z.literal('run.accept_reduced_scope'), ...base, args: z.object({ runId: Id, notDeliveredHash: Id, note: z.string().max(2000).optional() }).strict() }).strict(),
  z.object({ command: z.literal('run.reverify'), ...base, args: z.object({ runId: Id }).strict() }).strict(),
  z.object({ command: z.literal('run.open_pull_request'), ...base, args: z.object({ runId: Id }).strict() }).strict(),
]);
export type AuthorizedViewCommand = z.infer<typeof AuthorizedViewCommandSchema>;

export const REJECTION_REASONS = [
  'stale_revision', 'unknown_target', 'not_allowed', 'invalid_command', 'approval_expired', 'scope_mismatch',
  // Named refusals of the decision routes, so a screen can say why.
  'approval_already_resolved', 'reduced_scope_changed', 'policy_denied', 'cancel_pending', 'not_budget_stopped', 'already_accepted', 'nothing_to_reverify', 'reverify_limit_reached', 'resource_conflict',
  'run_not_ready', 'reduced_scope_not_accepted', 'run_already_merged',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Acceptance is not execution: `accepted` says the request was taken; `execution` says what has happened to it. */
export const CommandReceiptSchema = z
  .object({
    idempotencyKey: Id,
    operationId: Id.nullable(),
    accepted: z.boolean(),
    execution: z.enum(['pending', 'applied', 'cancel_requested', 'rejected']),
    rejection: z.enum(REJECTION_REASONS).nullable(),
    /** A replay of an earlier idempotency key returns the first receipt with this set. */
    replayed: z.boolean(),
    simulated: z.boolean(),
  })
  .strict();
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

/** Terminal access is read-only and per attempt. A short-lived session token is the server's concern, not carried here. */
export const AuthorizedTerminalRequestSchema = z.object({ taskId: Id, attemptId: Id, expectedRevision: z.number().int().min(0) }).strict();
export type AuthorizedTerminalRequest = z.infer<typeof AuthorizedTerminalRequestSchema>;

export const TERMINAL_MAX_LINES = 200;
/** Bounded, transient output. It is never durable evidence and never read as a check result. */
export interface TerminalChannel {
  readonly channelId: string;
  readonly simulated: boolean;
  onLine(handler: (line: string) => void): () => void;
  close(): void;
}
