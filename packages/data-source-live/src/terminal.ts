import { type TerminalChannel, type TerminalReason, type TerminalState, type TerminalStatus } from '@selarikru/view-protocol';

interface LiveTerminalOptions {
  readonly channelId: string;
  readonly path: string;
  /** The source's authenticated request: it reads a fresh token and puts it in the header. */
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  readonly idleMs: number;
  /** Called once, on the way out, so the source stops tracking this channel. */
  readonly onClose: (close: () => void) => void;
}

const SERVER_STATUSES: readonly TerminalStatus[] = ['live', 'ended', 'disconnected', 'unavailable'];
const SERVER_REASONS: readonly TerminalReason[] = ['no_channel', 'expired', 'runner_silent', 'session_expired'];
/** `session_expired` and `no_channel` are the server's own words; any other string from it is ignored rather than displayed. */
const readReason = (v: unknown): TerminalReason | null => (typeof v === 'string' && (SERVER_REASONS as readonly string[]).includes(v) ? (v as TerminalReason) : null);

export type LiveTerminalChannel = TerminalChannel & { readonly closeNow: () => void };

/**
 * One owner session against the API's terminal route, read with fetch so the token stays in the header. The channel never claims to be live on its own: it starts `connecting`,
 * and `live` only follows a server state frame. A refused or absent channel reads as `unavailable`; a dropped one as `disconnected`, keeping the time of the last line.
 */
export function openLiveTerminal(options: LiveTerminalOptions): LiveTerminalChannel {
  const lineHandlers = new Set<(line: string) => void>();
  const stateHandlers = new Set<(state: TerminalState) => void>();
  const abort = new AbortController();
  let open = true;
  let state: TerminalState = { status: 'connecting', reason: null, lastLineAt: null, dropped: 0 };
  let upstreamDropped = 0;
  let clientDropped = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const set = (next: TerminalState): void => {
    state = next;
    for (const h of [...stateHandlers]) h(state);
  };
  const finish = (next: Partial<TerminalState>): void => {
    if (!open) return;
    set({ ...state, ...next });
  };

  const closeNow = (): void => {
    if (!open) return;
    open = false;
    if (idle !== undefined) clearTimeout(idle);
    abort.abort();
    lineHandlers.clear();
    stateHandlers.clear();
    options.onClose(closeNow);
  };

  const watchdog = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => {
      if (!open) return;
      abort.abort();
      finish({ status: 'disconnected', reason: 'connection_lost' });
      closeSoft();
    }, options.idleMs);
  };
  /** The stream is over but the panel keeps reading this channel's final state. */
  const closeSoft = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    abort.abort();
  };

  const onFrame = (event: string | undefined, data: string): void => {
    if (!open || event === undefined) return;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event === 'line' && typeof body['text'] === 'string') {
      const at = typeof body['at'] === 'string' ? body['at'] : null;
      if (at !== null && at !== state.lastLineAt) set({ ...state, lastLineAt: at });
      for (const h of [...lineHandlers]) h(body['text']);
    } else if (event === 'dropped' && typeof body['count'] === 'number') {
      clientDropped += body['count'];
      set({ ...state, dropped: upstreamDropped + clientDropped });
    } else if (event === 'state') {
      const status = body['status'];
      if (typeof status !== 'string' || !(SERVER_STATUSES as readonly string[]).includes(status)) return;
      if (typeof body['dropped'] === 'number') upstreamDropped = Math.max(upstreamDropped, body['dropped']);
      set({ status: status as TerminalStatus, reason: readReason(body['reason']), lastLineAt: typeof body['lastLineAt'] === 'string' ? body['lastLineAt'] : state.lastLineAt, dropped: upstreamDropped + clientDropped });
    }
  };

  const connect = async (): Promise<void> => {
    let res: Response;
    try {
      res = await options.request(options.path, { signal: abort.signal, headers: { accept: 'text/event-stream' } });
    } catch {
      finish({ status: 'disconnected', reason: 'connection_lost' });
      return;
    }
    if (!open) {
      void res.body?.cancel();
      return;
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
      const code = body?.error?.code;
      if (code === 'terminal_restricted') finish({ status: 'unavailable', reason: 'restricted' });
      else if (res.status === 404) finish({ status: 'unavailable', reason: 'no_channel' });
      else if (res.status === 401 || res.status === 403) finish({ status: 'unavailable', reason: 'unauthorized' });
      else finish({ status: 'disconnected', reason: 'connection_lost' });
      return;
    }
    watchdog();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!open) return;
        watchdog();
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        for (let i = buffer.indexOf('\n\n'); i >= 0 && open; i = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const lines = frame.split('\n');
          const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
          const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (data !== '') onFrame(event, data);
        }
      }
    } catch {
      if (!open) return;
      closeSoft();
      if (state.status !== 'ended') finish({ status: 'disconnected', reason: 'connection_lost' });
      return;
    }
    closeSoft();
    // The server closed the stream. Unless the channel had finished, that is a lost connection, whatever the last frame said.
    if (open && state.status !== 'ended' && state.status !== 'unavailable') finish({ status: 'disconnected', reason: state.reason ?? 'connection_lost' });
  };

  queueMicrotask(() => { if (open) void connect(); });

  return {
    channelId: options.channelId,
    simulated: false,
    onLine(handler) {
      lineHandlers.add(handler);
      return () => lineHandlers.delete(handler);
    },
    onState(handler) {
      stateHandlers.add(handler);
      queueMicrotask(() => { if (open && stateHandlers.has(handler)) handler(state); });
      return () => stateHandlers.delete(handler);
    },
    close: closeNow,
    closeNow,
  };
}
