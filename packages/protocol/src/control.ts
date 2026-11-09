import { sanitizeTerminalText } from '@selarikru/domain';
import { z } from 'zod';
import { LeaseRefSchema, TerminalLineSchema } from './runner.ts';
import { TERMINAL_MAX_BATCH_LINES, fitTerminalLine, redactTerminalText } from './terminal.ts';

/**
 * Control mode: a person typing into a PTY shell inside one attempt's own sandbox. The browser path is a separate WebSocket, authenticated by a single-use ticket sent as the
 * first message, never in a URL. It is line-at-a-time on purpose: the output must stay on the T5.9 redacted, line-buffered path, so there is no cursor-addressed terminal to serve, and one
 * line is one audited input.
 */

/** A pty line editor reads at most 4095 bytes before a newline. */
export const CONTROL_MAX_INPUT_CHARS = 4096;
export const CONTROL_MAX_FRAME_BYTES = 16 * 1024;
export const CONTROL_MAX_LINK_FRAME_BYTES = 512 * 1024;
export const CONTROL_MAX_LINK_BATCH_LINES = TERMINAL_MAX_BATCH_LINES;

/** One line a person typed. Printable text and tabs only: no line breaks, so one frame is exactly one audited input, and no control or escape characters to rewrite the session. */
const NOT_INPUT = new RegExp('[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
const InputTextSchema = z.string().max(CONTROL_MAX_INPUT_CHARS).refine((t) => !NOT_INPUT.test(t), 'input is a single line of text');
const Seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ControlClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), ticket: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('input'), seq: Seq, text: InputTextSchema }).strict(),
  z.object({ type: z.literal('interrupt'), seq: Seq }).strict(),
  z.object({ type: z.literal('leave') }).strict(),
]);
export type ControlClientFrame = z.infer<typeof ControlClientFrameSchema>;

export const CONTROL_END_REASONS = ['left', 'connection_lost', 'idle_timeout', 'session_limit', 'attempt_finished', 'attempt_fenced', 'shell_exited', 'shell_unavailable', 'runner_link_lost', 'audit_failed', 'input_limit', 'server_shutdown', 'server_restarted'] as const;
export type ControlEndReason = (typeof CONTROL_END_REASONS)[number];

export const CONTROL_INPUT_DISPOSITIONS = ['pending', 'recorded', 'withheld_echo_off', 'withheld_unconfirmed', 'interrupt'] as const;
export type ControlInputDisposition = (typeof CONTROL_INPUT_DISPOSITIONS)[number];

export const CONTROL_REFUSALS = ['ticket_invalid', 'origin_refused', 'policy_denied', 'trial', 'restricted', 'attempt_not_running', 'session_active', 'unavailable', 'too_long', 'rate_limited'] as const;
export type ControlRefusal = (typeof CONTROL_REFUSALS)[number];

export const ControlServerFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), sessionId: z.string().min(1), echo: z.boolean().nullable() }).strict(),
  z.object({ type: z.literal('echo'), on: z.boolean() }).strict(),
  z.object({ type: z.literal('ack'), seq: Seq, disposition: z.enum(CONTROL_INPUT_DISPOSITIONS) }).strict(),
  z.object({ type: z.literal('refused'), seq: Seq.nullable(), code: z.enum(CONTROL_REFUSALS) }).strict(),
  z.object({ type: z.literal('ended'), reason: z.enum(CONTROL_END_REASONS) }).strict(),
]);
export type ControlServerFrame = z.infer<typeof ControlServerFrameSchema>;

const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const Data = z.string().max(CONTROL_MAX_INPUT_CHARS + 2);

/** The control API to the runner holding the attempt, over the runner's own outbound connection. */
export const ControlDownFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('linked') }).strict(),
  z.object({ type: z.literal('open'), sessionId: SessionId }).strict(),
  z.object({ type: z.literal('input'), sessionId: SessionId, seq: Seq, data: Data }).strict(),
  z.object({ type: z.literal('close'), sessionId: SessionId, reason: z.enum(CONTROL_END_REASONS) }).strict(),
]);
export type ControlDownFrame = z.infer<typeof ControlDownFrameSchema>;

/** From the runner. `ack.echo` is the shell's echo flag read at the moment that input reached the pty, or null when it could not be read. */
export const ControlUpFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), lease: LeaseRefSchema }).strict(),
  z.object({ type: z.literal('opened'), sessionId: SessionId, echo: z.boolean().nullable() }).strict(),
  z.object({ type: z.literal('ack'), sessionId: SessionId, seq: Seq, echo: z.boolean().nullable() }).strict(),
  z.object({ type: z.literal('echo'), sessionId: SessionId, on: z.boolean() }).strict(),
  z.object({ type: z.literal('output'), sessionId: SessionId, lines: z.array(TerminalLineSchema).max(CONTROL_MAX_LINK_BATCH_LINES), dropped: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal('shell_ended'), sessionId: SessionId, unavailable: z.boolean() }).strict(),
]);
export type ControlUpFrame = z.infer<typeof ControlUpFrameSchema>;

/** What the mint route answers. The ticket is shown once: only its hash is stored. */
export const ControlTicketResponseSchema = z.object({ sessionId: z.string().min(1), ticket: z.string().min(1), expiresAt: z.string() }).strict();
export type ControlTicketResponse = z.infer<typeof ControlTicketResponseSchema>;
export const ControlTicketRequestSchema = z.object({ idempotencyKey: z.string().min(1).max(200) }).strict();

/** The form a typed line is stored in: cleaned, then through the same redaction as terminal output, and bounded. */
export const redactControlInput = (text: string): string => fitTerminalLine(redactTerminalText(sanitizeTerminalText(text)));

/** The form an output line takes on the API's own second pass. Stateless, because a line here was already line-buffered by the runner. */
export const redactControlOutputLine = (text: string): string => fitTerminalLine(redactTerminalText(sanitizeTerminalText(text)));
