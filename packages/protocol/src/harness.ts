/**
 * Harness adapter contracts shared by every runtime (local sandbox, cloud sandbox). Types only; no I/O.
 * Capability statuses come from the T0.5 spike table and must not be upgraded beyond what it shows.
 */
import type { ApprovalDestination, WorkerApprovalOperation } from '@selarikru/domain';

export const CAPABILITY_STATUSES = ['supported', 'partial', 'unsupported', 'not established'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const HARNESS_CAPABILITY_NAMES = [
  'structuredEvents',
  'resume',
  'cancel',
  'approvalCallbacks',
  'providerOverride',
  'localInference',
  'usageReporting',
  'networkEnforcement',
  'outputSchema',
] as const;
export type HarnessCapabilityName = (typeof HARNESS_CAPABILITY_NAMES)[number];
export type HarnessCapabilities = Readonly<Record<HarnessCapabilityName, CapabilityStatus>>;

export interface HarnessInput {
  readonly attemptId: string;
  readonly prompt: string;
  /** Working directory inside the sandbox. */
  readonly workspacePath: string;
  readonly maxTurns?: number;
  /** Capabilities the task needs. Anything not `supported` fails before launch unless listed in `acceptPartial`. */
  readonly requires?: readonly HarnessCapabilityName[];
  readonly acceptPartial?: readonly HarnessCapabilityName[];
  /** Off by default: assistant text and tool arguments are not forwarded. When on, previews are bounded. */
  /** `none`: launch with an empty, strict MCP configuration so no owner connector is reachable. */
  readonly mcp?: 'none';
  /** Explicit built-in tool list. Anything not listed (WebFetch, WebSearch, Task...) is unavailable. */
  readonly tools?: readonly string[];
  /**
   * Absolute path a `Write` tool call must name to count as an approval signal (see the adapter). Absent: no signal is recognised.
   * A tool call in the structured stream is the only channel; model text never is.
   */
  readonly approvalSignalPath?: string;
  readonly previews?: { readonly enabled: boolean; readonly maxChars?: number };
}

export const APPROVAL_REFUSAL_REASONS = ['malformed_signal', 'unknown_operation', 'destination_required', 'destination_not_applicable', 'invalid_destination', 'missing_reason'] as const;
export type ApprovalRefusalReason = (typeof APPROVAL_REFUSAL_REASONS)[number];

export const USAGE_SOURCES = ['observed', 'estimated', 'unavailable'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** Missing values are null, never 0. `costUsd` is list-basis (see `costBasis`), not money billed. */
export interface NormalizedUsage {
  readonly source: UsageSource;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly costUsd: number | null;
  readonly costBasis: 'list' | null;
}

interface EventBase {
  readonly attemptId: string;
  readonly seq: number;
}

export type NormalizedHarnessEvent = EventBase &
  (
    | {
        readonly type: 'session_started';
        readonly harnessVersion: string | null;
        /** As observed in the stream; null if the stream never said. Never assumed. */
        readonly permissionMode: string | null;
        readonly model: string | null;
        /** Names of MCP servers the init event reports as connected; null when the stream never said. */
        readonly connectedMcpServers: readonly string[] | null;
      }
    | { readonly type: 'launch_refused'; readonly reason: 'capability_unavailable'; readonly capability: string; readonly status: CapabilityStatus }
    | { readonly type: 'system'; readonly subtype: string | null }
    | { readonly type: 'message'; readonly role: 'assistant' | 'user'; readonly blockTypes: readonly string[]; readonly preview?: string }
    | { readonly type: 'tool_call'; readonly toolUseId: string | null; readonly toolName: string | null; readonly status: 'started'; readonly preview?: string }
    | {
        readonly type: 'tool_result';
        readonly toolUseId: string | null;
        readonly toolName: string | null;
        readonly status: 'ok' | 'error';
        readonly preview?: string;
      }
    /** The agent asked for a human decision through the structured channel. Closed-vocabulary fields only. */
    | { readonly type: 'approval_signal'; readonly operation: WorkerApprovalOperation; readonly destination: ApprovalDestination | null; readonly reason: string }
    /** A tool call that targeted the signal path but failed the closed schema. Carries no model-supplied text. */
    | { readonly type: 'approval_refused'; readonly why: ApprovalRefusalReason }
    | { readonly type: 'usage'; readonly usage: NormalizedUsage }
    | { readonly type: 'rate_limit'; readonly status: string | null }
    | {
        readonly type: 'result';
        readonly subtype: string | null;
        readonly isError: boolean | null;
        readonly terminalReason: string | null;
        readonly numTurns: number | null;
        readonly durationMs: number | null;
      }
    | { readonly type: 'ended_without_result' }
    /** `failed` is true for any non-zero code or any signal, even after a `success` result. */
    | { readonly type: 'exit'; readonly code: number | null; readonly signal: string | null; readonly failed: boolean }
    /** A line over the size limit was discarded; no content is carried. */
    | { readonly type: 'oversize_line' }
    /** The output stream threw. The message is redacted and bounded. */
    | { readonly type: 'stream_error'; readonly message: string }
    | { readonly type: 'unparseable_line' }
    /** Unknown event type: the type name only, never the payload. */
    | { readonly type: 'raw_unrecognized'; readonly rawType: string }
  );

/**
 * Acknowledges a stop REQUEST. It is not confirmation that the agent ended: `terminationConfirmed` is always
 * false here; termination is learned later (stream end, `exit` event).
 */
export interface StopAcknowledgement {
  readonly attemptId: string;
  readonly status: 'stop_requested' | 'stop_rejected';
  readonly terminationConfirmed: false;
  readonly detail: string | null;
}

export interface HarnessAdapter {
  capabilities(): HarnessCapabilities;
  run(input: HarnessInput): AsyncIterable<NormalizedHarnessEvent>;
  cancel(attemptId: string): Promise<StopAcknowledgement>;
}
