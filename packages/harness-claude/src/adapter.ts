import { CLAUDE_MODELS, CLAUDE_PROVIDER_ID } from './catalog.ts';
import {
  ApprovalDestinationSchema,
  redactSecrets,
  requiresDestination,
  WorkerApprovalOperationSchema,
  type ApprovalRefusalReason,
  type CapabilityStatus,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessInput,
  type NormalizedHarnessEvent,
  type NormalizedUsage,
  type StopAcknowledgement,
  type ApprovalDestination,
  type WorkerApprovalOperation,
} from '@selarikru/protocol';

/** What the runtime (local sandbox, cloud sandbox) must give the adapter. The adapter never decides where it runs. */
export interface LaunchSpec {
  readonly attemptId: string;
  readonly command: readonly string[];
  readonly cwd: string;
}

export interface LaunchedProcess {
  /**
   * Raw output chunks as strings. They need not align with line boundaries. The launcher MUST decode bytes with a
   * streaming decoder (see `decodeUtf8Stream`), never per-chunk `toString()`, or a multibyte character split across
   * chunks is corrupted.
   */
  readonly lines: AsyncIterable<string>;
  readonly stdin: { write(data: string): void; end(): void };
  /** Kills the HOST-side client only. Observed (spike section 5): this does not stop the agent in the sandbox. */
  readonly kill: () => void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface HarnessLauncher {
  launch(spec: LaunchSpec): Promise<LaunchedProcess>;
  /** In-sandbox stop (e.g. signal the agent process inside the sandbox). Resolves when the request is accepted. */
  stop(attemptId: string): Promise<{ accepted: boolean; detail: string | null }>;
}

/**
 * Equals the table in docs/evidence/spike-runtime.md section 8 (Claude Code 2.1.319, sbx v0.51.0, `sbx exec`), plus `modelSelection`: the installed CLI documents
 * `--model <model>` for a model's full name (`claude --help`, 2.1.316). The runner still compares what the stream reports against what was recorded.
 */
export const CLAUDE_CAPABILITIES: HarnessCapabilities = Object.freeze({
  structuredEvents: 'supported',
  resume: 'not established',
  cancel: 'partial',
  approvalCallbacks: 'not established',
  providerOverride: 'not established',
  localInference: 'not established',
  usageReporting: 'supported',
  networkEnforcement: 'not established',
  outputSchema: 'not established',
  modelSelection: 'supported',
});

const DEFAULT_PREVIEW_CHARS = 200;
/** Ends any preview that was cut, so a clipped message never reads as the whole message. */
export const TRUNCATED_MARK = '… [truncated]';
/** Longest line parsed; a longer one is discarded to the next newline. */
export const MAX_LINE_CHARS = 1024 * 1024;
const MAX_IDENT_CHARS = 256;
const MAX_PENDING_EVENTS = 1000;

type Json = Record<string, unknown>;
type ApprovalSignalOperation = WorkerApprovalOperation;
type Draft = NormalizedHarnessEvent extends infer E ? (E extends unknown ? Omit<E, 'attemptId' | 'seq'> : never) : never;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, MAX_IDENT_CHARS) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redactSecrets(v) as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}

function normalizeUsage(result: Json): NormalizedUsage {
  const u = isObj(result['usage']) ? result['usage'] : null;
  const cost = num(result['total_cost_usd']);
  const fields = {
    inputTokens: u ? num(u['input_tokens']) : null,
    outputTokens: u ? num(u['output_tokens']) : null,
    cacheReadTokens: u ? num(u['cache_read_input_tokens']) : null,
    cacheCreationTokens: u ? num(u['cache_creation_input_tokens']) : null,
  };
  const any = cost !== null || Object.values(fields).some((x) => x !== null);
  return {
    // The harness owns its model calls, so these are its own totals as it chose to report them: never an observed figure.
    source: any ? 'estimated' : 'unavailable',
    ...fields,
    costUsd: cost,
    // total_cost_usd is a list-price computation (modelUsage.costBasis: list), not a billed amount.
    costBasis: cost !== null ? 'list' : null,
  };
}

/** Longest `reason` kept from an approval signal. */
const MAX_APPROVAL_REASON_CHARS = 480;
/** The signal file's fields; anything else in it is refused, so a typo cannot silently drop `destination`. */
const SIGNAL_KEYS = new Set(['operation', 'destination', 'reason']);

/**
 * Reads the agent's approval signal: the content a `Write` tool call puts at the reserved path, as JSON with a closed shape. A `tool_use` block in an
 * assistant message is what the structured stream reports (docs/evidence/spike-runtime.md section 2); that, and only that, can raise this. Text,
 * tool results and every other event never reach here, so a model cannot ask by writing the words, and a file it merely reads cannot ask for it.
 */
function parseApprovalSignal(raw: unknown): { kind: 'signal'; operation: ApprovalSignalOperation; destination: ApprovalDestination | null; reason: string } | { kind: 'refused'; why: ApprovalRefusalReason } {
  const refuse = (why: ApprovalRefusalReason) => ({ kind: 'refused' as const, why });
  if (typeof raw !== 'string') return refuse('malformed_signal');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse('malformed_signal');
  }
  if (!isObj(body) || Object.keys(body).some((k) => !SIGNAL_KEYS.has(k))) return refuse('malformed_signal');
  const operation = WorkerApprovalOperationSchema.safeParse(body['operation']);
  if (!operation.success) return refuse('unknown_operation');
  const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
  if (reason === '') return refuse('missing_reason');
  const declared = body['destination'] ?? null;
  const parsed = declared === null ? null : ApprovalDestinationSchema.safeParse(declared);
  if (parsed !== null && !parsed.success) return refuse('invalid_destination');
  if (parsed?.success && redactSecrets(parsed.data.host) !== parsed.data.host) return refuse('invalid_destination');
  const needs = requiresDestination(operation.data);
  if (needs && parsed === null) return refuse('destination_required');
  if (!needs && parsed !== null) return refuse('destination_not_applicable');
  return { kind: 'signal', operation: operation.data, destination: parsed?.data ?? null, reason: reason.slice(0, MAX_APPROVAL_REASON_CHARS) };
}

export class ClaudeHarnessAdapter implements HarnessAdapter {
  constructor(private readonly launcher: HarnessLauncher) {}

  capabilities(): HarnessCapabilities {
    return CLAUDE_CAPABILITIES;
  }

  async cancel(attemptId: string): Promise<StopAcknowledgement> {
    try {
      const r = await this.launcher.stop(attemptId);
      return {
        attemptId,
        status: r.accepted ? 'stop_requested' : 'stop_rejected',
        terminationConfirmed: false,
        detail: r.detail === null ? null : redactSecrets(r.detail),
      };
    } catch (err) {
      return {
        attemptId,
        status: 'stop_rejected',
        terminationConfirmed: false,
        detail: redactSecrets(err instanceof Error ? err.message : 'stop failed'),
      };
    }
  }

  async *run(input: HarnessInput): AsyncGenerator<NormalizedHarnessEvent> {
    let seq = 0;
    // `raw` previews are redacted by the caller, after being joined back up across events; everything else about the event is still redacted here.
    const rawPreviews = input.previews?.raw === true;
    const finish = (d: Draft): NormalizedHarnessEvent => {
      const event = redactDeep({ ...d, attemptId: input.attemptId, seq: seq++ } as NormalizedHarnessEvent);
      return rawPreviews && 'preview' in d && typeof d.preview === 'string' ? ({ ...event, preview: d.preview } as NormalizedHarnessEvent) : event;
    };

    const acceptPartial = new Set(input.acceptPartial ?? []);
    for (const cap of input.requires ?? []) {
      const status: CapabilityStatus = CLAUDE_CAPABILITIES[cap];
      if (status === 'supported' || (status === 'partial' && acceptPartial.has(cap))) continue;
      yield finish({ type: 'launch_refused', reason: 'capability_unavailable', capability: cap, status });
      return;
    }

    const selected = input.model;
    if (selected !== undefined && (selected.provider !== CLAUDE_PROVIDER_ID || !CLAUDE_MODELS.some((m) => m.id === selected.model))) {
      yield finish({ type: 'launch_refused', reason: 'model_unsupported', provider: selected.provider, model: selected.model });
      return;
    }

    const command = ['claude', '-p', input.prompt, '--output-format', 'stream-json', '--verbose'];
    if (selected !== undefined) command.push('--model', selected.model);
    if (input.maxTurns !== undefined) command.push('--max-turns', String(input.maxTurns));
    // `=` forms: both flags take variadic values and would otherwise swallow whatever follows.
    if (input.mcp === 'none') command.push('--strict-mcp-config', '--mcp-config={"mcpServers":{}}');
    if (input.tools !== undefined) command.push(`--tools=${input.tools.join(',')}`);
    const proc = await this.launcher.launch({ attemptId: input.attemptId, command, cwd: input.workspacePath });
    // Without a closed stdin, claude waits and warns (spike section 2).
    proc.stdin.end();

    const previewsOn = input.previews?.enabled === true;
    const maxChars = input.previews?.maxChars ?? DEFAULT_PREVIEW_CHARS;
    const preview = (text: string): string => {
      const safe = rawPreviews ? text : redactSecrets(text);
      return safe.length > maxChars ? `${safe.slice(0, maxChars)}${TRUNCATED_MARK}` : safe;
    };
    // One character past the limit survives, so `preview` can tell the text was longer and say so.
    const text = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, maxChars + 1) : null);
    const toolNames = new Map<string, string>();

    let initSeen = false;
    let sawResult = false;
    const pending: Draft[] = [];

    const sessionDraft = (init: Json | null): Draft => ({
      type: 'session_started',
      harnessVersion: init ? str(init['claude_code_version']) : null,
      permissionMode: init ? str(init['permissionMode']) : null,
      model: init ? str(init['model']) : null,
      initObserved: init !== null,
      connectedMcpServers: init && Array.isArray(init['mcp_servers'])
        ? init['mcp_servers'].filter(isObj).filter((s) => s['status'] === 'connected').map((s) => str(s['name']) ?? 'unknown')
        : null,
    });

    const handle = (obj: Json): Draft[] => {
      const type = str(obj['type']);
      switch (type) {
        case 'system': {
          if (obj['subtype'] === 'init') return [];
          return [{ type: 'system', subtype: str(obj['subtype']) }];
        }
        case 'assistant':
        case 'user': {
          const message = isObj(obj['message']) ? obj['message'] : {};
          const content = Array.isArray(message['content']) ? message['content'] : [];
          const blocks = content.filter(isObj);
          const out: Draft[] = [];
          const textPreview = previewsOn
            ? blocks.map((b) => text(b['text'])).filter((t): t is string => t !== null).join('\n')
            : '';
          const base = { type: 'message' as const, role: type, blockTypes: blocks.map((b) => str(b['type']) ?? 'unknown') };
          out.push(textPreview ? { ...base, preview: preview(textPreview) } : base);
          for (const b of blocks) {
            if (b['type'] === 'tool_use') {
              const id = str(b['id']);
              const name = str(b['name']);
              if (id && name) toolNames.set(id, name);
              const d = { type: 'tool_call' as const, toolUseId: id, toolName: name, status: 'started' as const };
              out.push(previewsOn && b['input'] !== undefined ? { ...d, preview: preview(JSON.stringify(b['input'])) } : d);
              // Only an assistant's tool call counts, only `Write`, and only at the exact reserved path.
              if (type === 'assistant' && input.approvalSignalPath !== undefined && name === 'Write' && isObj(b['input']) && b['input']['file_path'] === input.approvalSignalPath) {
                const signal = parseApprovalSignal(b['input']['content']);
                out.push(signal.kind === 'signal' ? { type: 'approval_signal', operation: signal.operation, destination: signal.destination, reason: signal.reason } : { type: 'approval_refused', why: signal.why });
              }
            } else if (b['type'] === 'tool_result') {
              const id = str(b['tool_use_id']);
              const d = {
                type: 'tool_result' as const,
                toolUseId: id,
                toolName: id ? (toolNames.get(id) ?? null) : null,
                status: b['is_error'] === true ? ('error' as const) : ('ok' as const),
              };
              let result = '';
              if (typeof b['content'] === 'string') result = b['content'];
              else if (Array.isArray(b['content']))
                result = b['content'].filter(isObj).map((c) => text(c['text']) ?? '').join('\n');
              out.push(previewsOn && result ? { ...d, preview: preview(result) } : d);
            }
          }
          return out;
        }
        case 'rate_limit_event': {
          const info = isObj(obj['rate_limit_info']) ? obj['rate_limit_info'] : null;
          return [{ type: 'rate_limit', status: info ? str(info['status']) : null }];
        }
        case 'result': {
          sawResult = true;
          return [
            { type: 'usage', usage: normalizeUsage(obj) },
            {
              type: 'result',
              subtype: str(obj['subtype']),
              isError: typeof obj['is_error'] === 'boolean' ? obj['is_error'] : null,
              terminalReason: str(obj['terminal_reason']),
              numTurns: num(obj['num_turns']),
              durationMs: num(obj['duration_ms']),
            },
          ];
        }
        default:
          return [{ type: 'raw_unrecognized', rawType: type ?? 'unknown' }];
      }
    };

    const process_ = (line: string): Draft[] => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return [{ type: 'unparseable_line' }];
      }
      if (!isObj(parsed)) return [{ type: 'unparseable_line' }];
      if (parsed['type'] === 'system' && parsed['subtype'] === 'init' && !initSeen) {
        initSeen = true;
        return [sessionDraft(parsed), ...pending.splice(0)];
      }
      const drafts = handle(parsed);
      if (!initSeen) {
        for (const d of drafts) if (pending.length < MAX_PENDING_EVENTS) pending.push(d);
        return [];
      }
      return drafts;
    };

    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      try {
        proc.kill();
      } catch {
        /* cleanup is best effort */
      }
      // Killing the host client does not stop the agent (spike section 5); stop it inside the sandbox too.
      try {
        await this.launcher.stop(input.attemptId);
      } catch {
        /* cleanup is best effort */
      }
    };

    let completed = false;
    try {
      let buffer = '';
      let discarding = false;
      const lineDrafts = (line: string): Draft[] => process_(line);
      let streamFailed = false;
      try {
        for await (const chunk of proc.lines) {
          let pos = 0;
          while (pos <= chunk.length) {
            const nl = chunk.indexOf('\n', pos);
            const end = nl < 0 ? chunk.length : nl;
            const segLen = end - pos;
            if (!discarding && buffer.length + segLen > MAX_LINE_CHARS) {
              discarding = true;
              buffer = '';
              yield finish({ type: 'oversize_line' });
            }
            if (nl < 0) {
              if (!discarding) buffer += chunk.slice(pos);
              break;
            }
            if (discarding) discarding = false;
            else {
              const line = buffer + chunk.slice(pos, nl);
              buffer = '';
              for (const d of lineDrafts(line)) yield finish(d);
            }
            pos = nl + 1;
          }
        }
        if (!discarding) for (const d of lineDrafts(buffer)) yield finish(d);
      } catch (err) {
        streamFailed = true;
        await cleanup();
        const msg = err instanceof Error ? err.message : 'stream failed';
        yield finish({ type: 'stream_error', message: msg.slice(0, 500) });
      }

      if (!initSeen) {
        initSeen = true;
        yield finish(sessionDraft(null));
        for (const d of pending.splice(0)) yield finish(d);
      }
      if (!sawResult) yield finish({ type: 'ended_without_result' });
      if (streamFailed) {
        completed = true;
        return;
      }
      const exit = await proc.exited.catch(() => ({ code: null, signal: null }));
      completed = true;
      yield finish({
        type: 'exit',
        code: exit.code,
        signal: exit.signal,
        failed: exit.code !== 0 || exit.signal !== null,
      });
    } finally {
      // Consumer break/return, or any unexpected throw: do not leak a running agent.
      if (!completed) await cleanup();
    }
  }
}
