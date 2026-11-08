import {
  redactSecrets,
  type CapabilityStatus,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessInput,
  type NormalizedHarnessEvent,
  type NormalizedUsage,
  type StopAcknowledgement,
} from '@selarikru/protocol';

/** What the runtime (local sandbox, cloud sandbox) must give the adapter. The adapter never decides where it runs. */
export interface LaunchSpec {
  readonly attemptId: string;
  readonly command: readonly string[];
  readonly cwd: string;
}

export interface LaunchedProcess {
  /** Raw output chunks. They need not align with line boundaries. */
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

/** Equals the table in docs/evidence/spike-runtime.md section 8 (Claude Code 2.1.319, sbx v0.51.0, `sbx exec`). */
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
});

const DEFAULT_PREVIEW_CHARS = 200;

type Json = Record<string, unknown>;
type Draft = NormalizedHarnessEvent extends infer E ? (E extends unknown ? Omit<E, 'attemptId' | 'seq'> : never) : never;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
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
    source: any ? 'observed' : 'unavailable',
    ...fields,
    costUsd: cost,
    // total_cost_usd is a list-price computation (modelUsage.costBasis: list), not a billed amount.
    costBasis: cost !== null ? 'list' : null,
  };
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
    const finish = (d: Draft): NormalizedHarnessEvent =>
      redactDeep({ ...d, attemptId: input.attemptId, seq: seq++ } as NormalizedHarnessEvent);

    const acceptPartial = new Set(input.acceptPartial ?? []);
    for (const cap of input.requires ?? []) {
      const status: CapabilityStatus = CLAUDE_CAPABILITIES[cap];
      if (status === 'supported' || (status === 'partial' && acceptPartial.has(cap))) continue;
      yield finish({ type: 'launch_refused', reason: 'capability_unavailable', capability: cap, status });
      return;
    }

    const command = ['claude', '-p', input.prompt, '--output-format', 'stream-json', '--verbose'];
    if (input.maxTurns !== undefined) command.push('--max-turns', String(input.maxTurns));
    const proc = await this.launcher.launch({ attemptId: input.attemptId, command, cwd: input.workspacePath });
    // Without a closed stdin, claude waits and warns (spike section 2).
    proc.stdin.end();

    const previewsOn = input.previews?.enabled === true;
    const maxChars = input.previews?.maxChars ?? DEFAULT_PREVIEW_CHARS;
    const preview = (text: string): string => {
      const safe = redactSecrets(text);
      return safe.length > maxChars ? `${safe.slice(0, maxChars)}…` : safe;
    };
    const toolNames = new Map<string, string>();

    let initSeen = false;
    let sawResult = false;
    const pending: Draft[] = [];

    const sessionDraft = (init: Json | null): Draft => ({
      type: 'session_started',
      harnessVersion: init ? str(init['claude_code_version']) : null,
      permissionMode: init ? str(init['permissionMode']) : null,
      model: init ? str(init['model']) : null,
      sessionId: init ? str(init['session_id']) : null,
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
            ? blocks.map((b) => str(b['text'])).filter((t): t is string => t !== null).join('\n')
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
            } else if (b['type'] === 'tool_result') {
              const id = str(b['tool_use_id']);
              const d = {
                type: 'tool_result' as const,
                toolUseId: id,
                toolName: id ? (toolNames.get(id) ?? null) : null,
                status: b['is_error'] === true ? ('error' as const) : ('ok' as const),
              };
              let text = '';
              if (typeof b['content'] === 'string') text = b['content'];
              else if (Array.isArray(b['content']))
                text = b['content'].filter(isObj).map((c) => str(c['text']) ?? '').join('\n');
              out.push(previewsOn && text ? { ...d, preview: preview(text) } : d);
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
        pending.push(...drafts);
        return [];
      }
      return drafts;
    };

    let buffer = '';
    for await (const chunk of proc.lines) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        for (const d of process_(line)) yield finish(d);
      }
    }
    for (const d of process_(buffer)) yield finish(d);

    if (!initSeen) {
      initSeen = true;
      yield finish(sessionDraft(null));
      for (const d of pending.splice(0)) yield finish(d);
    }
    if (!sawResult) yield finish({ type: 'ended_without_result' });
    const exit = await proc.exited.catch(() => ({ code: null, signal: null }));
    yield finish({ type: 'exit', code: exit.code, signal: exit.signal });
  }
}
