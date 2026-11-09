import { ASSIGNMENT_SCOPES, ModelSelectionSchema } from '@selarikru/domain';
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
  // Starts a new run in a project whose earlier run has spent its budget. `expectedRevision` is not used (a new run has none) and is sent as 0; the server sets the budget at the project's recorded ceiling.
  z.object({ command: z.literal('run.start_new'), ...base, args: z.object({ projectId: Id, title: z.string().trim().min(1).max(200) }).strict() }).strict(),
  z.object({ command: z.literal('run.open_pull_request'), ...base, args: z.object({ runId: Id }).strict() }).strict(),
  // Sets or removes one assignment; `expectedRevision` is that assignment's revision (0 if never set). It applies to the next attempt only, and has no secret fields.
  z.object({ command: z.literal('assignment.set'), ...base, args: z.object({ projectId: Id, scope: z.enum(ASSIGNMENT_SCOPES), key: Id, selection: ModelSelectionSchema.nullable() }).strict() }).strict(),
]);
export type AuthorizedViewCommand = z.infer<typeof AuthorizedViewCommandSchema>;

export const REJECTION_REASONS = [
  'stale_revision', 'unknown_target', 'not_allowed', 'invalid_command', 'approval_expired', 'scope_mismatch',
  // Named refusals of the decision routes, so a screen can say why.
  'approval_already_resolved', 'reduced_scope_changed', 'policy_denied', 'cancel_pending', 'not_budget_stopped', 'already_accepted', 'nothing_to_reverify', 'reverify_limit_reached', 'resource_conflict',
  // Named refusals of starting a new run: the project's recorded setup does not allow it.
  'outside_recorded_limits', 'onboarding_not_activated', 'template_not_supported',
  'run_not_ready', 'reduced_scope_not_accepted', 'run_already_merged',
  // Named refusals of the pull-request route: the verified candidate moved, or no valid record supports it.
  'candidate_changed', 'no_valid_record', 'record_not_passing', 'no_candidate', 'pull_request_refused',
  // Named refusals of the assignment route.
  'no_provider_detected', 'unsupported_provider', 'unsupported_model', 'model_not_allowed', 'trial_model_pinned',
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

/** Where a live output channel stands. `live` is only ever claimed while output can actually arrive; an attempt with no channel is `unavailable`, never a quiet connection. */
export type TerminalStatus = 'connecting' | 'live' | 'ended' | 'disconnected' | 'unavailable';
export type TerminalReason = 'no_channel' | 'expired' | 'restricted' | 'runner_silent' | 'session_expired' | 'connection_lost' | 'unauthorized';
export interface TerminalState {
  readonly status: TerminalStatus;
  readonly reason: TerminalReason | null;
  /** When the last line was produced. Kept across a disconnect so it can be shown. Null: none has arrived. */
  readonly lastLineAt: string | null;
  /** How many lines were lost to backpressure before reaching this client. */
  readonly dropped: number;
}

/** Bounded, transient output. It is never durable evidence and never read as a check result. */
export interface TerminalChannel {
  readonly channelId: string;
  readonly simulated: boolean;
  /** Delivers each line of output as plain text. */
  onLine(handler: (line: string) => void): () => void;
  /** Delivers the channel's current state immediately, then every change. */
  onState(handler: (state: TerminalState) => void): () => void;
  close(): void;
}

/** Why a control session is not on, or ended. `demo`: mock data, which has no shell. */
export type TerminalControlReason =
  // Refused before a session began.
  | 'demo' | 'ticket_invalid' | 'policy_denied' | 'trial' | 'restricted' | 'attempt_not_running' | 'session_active' | 'unavailable' | 'unauthorized' | 'connection_failed'
  // Why a session that began has ended.
  | 'left' | 'connection_lost' | 'idle_timeout' | 'session_limit' | 'attempt_finished' | 'attempt_fenced' | 'shell_exited' | 'shell_unavailable' | 'runner_link_lost' | 'audit_failed' | 'input_limit' | 'server_shutdown' | 'server_restarted';

export type TerminalControlInputOutcome = 'recorded' | 'withheld_echo_off' | 'withheld_unconfirmed' | 'interrupt' | 'rate_limited' | 'too_long';

/** Where control mode stands. `on` is claimed only after the sandbox's shell has answered. */
export interface TerminalControlState {
  readonly phase: 'connecting' | 'on' | 'refused' | 'ended';
  readonly reason: TerminalControlReason | null;
  /** Null: not known yet. False: the shell is reading something it does not want shown, such as a password. */
  readonly echo: boolean | null;
}

/**
 * A control session on one attempt. Output keeps arriving on the read-only channel, unchanged, marked as shell output; this is only the way in. Lines typed here are audited by the server, and
 * nothing here can resolve a decision, a grant or a check.
 */
export interface TerminalControlChannel {
  readonly simulated: boolean;
  /** Delivers the current state immediately, then every change. */
  onState(handler: (state: TerminalControlState) => void): () => void;
  /** What the server did with each line, by the order they were sent. */
  onInput(handler: (outcome: TerminalControlInputOutcome) => void): () => void;
  /** One line. Only while `on`. */
  send(line: string): void;
  /** Ctrl-C. */
  interrupt(): void;
  /** Leaves control mode. Idempotent. */
  close(): void;
}
