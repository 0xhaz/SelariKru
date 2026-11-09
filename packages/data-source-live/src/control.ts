import { type AuthorizedTerminalRequest, type TerminalControlChannel, type TerminalControlInputOutcome, type TerminalControlReason, type TerminalControlState } from '@selarikru/view-protocol';

/** What the live source needs from the browser. Injectable so a test can stand in for the socket. */
export type WebSocketFactory = (url: string) => Pick<WebSocket, 'send' | 'close' | 'readyState' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'>;

interface LiveControlOptions {
  readonly baseUrl: string;
  readonly request: AuthorizedTerminalRequest & { readonly projectId: string };
  /** The source's authenticated request: it reads a fresh token and puts it in the header. */
  readonly fetchAuthed: (path: string, init?: RequestInit) => Promise<Response>;
  readonly makeSocket: WebSocketFactory;
}

const REFUSAL_CODES: Readonly<Record<string, TerminalControlReason>> = {
  policy_denied: 'policy_denied', control_refused_trial: 'trial', terminal_restricted: 'restricted', attempt_not_running: 'attempt_not_running', control_session_active: 'session_active', control_unavailable: 'unavailable',
  origin_not_allowed: 'unauthorized', origin_required: 'unauthorized', not_owner: 'unauthorized', invalid_token: 'unauthorized', unauthenticated: 'unauthorized',
};
const SESSION_REFUSALS: readonly TerminalControlReason[] = ['ticket_invalid', 'policy_denied', 'trial', 'restricted', 'attempt_not_running', 'session_active', 'unavailable'];

/**
 * One control session. Asks the server for a ticket with the owner's token in the header, then opens a separate WebSocket and sends the ticket as the first message, so nothing about the owner
 * or the ticket is ever in a URL. It starts `connecting`, and only a `ready` frame from the shell turns it `on`.
 */
export function openLiveControl(options: LiveControlOptions): TerminalControlChannel {
  const { projectId, attemptId } = options.request;
  const path = `/v1/projects/${encodeURIComponent(projectId)}/attempts/${encodeURIComponent(attemptId)}/terminal`;
  const stateHandlers = new Set<(state: TerminalControlState) => void>();
  const inputHandlers = new Set<(o: TerminalControlInputOutcome) => void>();
  let state: TerminalControlState = { phase: 'connecting', reason: null, echo: null };
  let socket: ReturnType<WebSocketFactory> | null = null;
  let seq = 0;
  let finished = false;

  const set = (next: TerminalControlState): void => {
    state = next;
    for (const h of [...stateHandlers]) h(state);
  };
  const finish = (phase: 'refused' | 'ended', reason: TerminalControlReason): void => {
    if (finished) return;
    finished = true;
    set({ phase, reason, echo: null });
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
      socket = null;
    }
  };
  const sendFrame = (frame: unknown): void => {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(frame));
  };

  void (async () => {
    let res: Response;
    try {
      res = await options.fetchAuthed(`${path}/control-tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) });
    } catch {
      finish('refused', 'connection_failed');
      return;
    }
    if (finished) return;
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      finish('refused', REFUSAL_CODES[body?.error?.code ?? ''] ?? (res.status === 401 || res.status === 403 ? 'unauthorized' : 'connection_failed'));
      return;
    }
    const { ticket } = (await res.json()) as { ticket: string };
    if (finished) return;
    const url = new URL(`${path}/control`, options.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = options.makeSocket(url.toString());
    socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', ticket }));
    ws.onerror = () => undefined;
    ws.onclose = () => { if (state.phase === 'connecting') finish('refused', 'connection_failed'); else finish('ended', 'connection_lost'); };
    ws.onmessage = (e) => {
      let f: { type?: string; echo?: boolean | null; on?: boolean; code?: string; reason?: string; seq?: number | null; disposition?: string };
      try { f = JSON.parse(e.data as string) as typeof f; } catch { return; }
      if (f.type === 'ready' && state.phase === 'connecting') set({ phase: 'on', reason: null, echo: f.echo ?? null });
      else if (f.type === 'echo' && state.phase === 'on') set({ ...state, echo: f.on === true });
      else if (f.type === 'ack' && f.disposition !== 'pending') for (const h of inputHandlers) h(f.disposition as TerminalControlInputOutcome);
      else if (f.type === 'refused') {
        if (f.seq === null || f.seq === undefined) finish('refused', (SESSION_REFUSALS as readonly string[]).includes(f.code ?? '') ? (f.code as TerminalControlReason) : 'connection_failed');
        else for (const h of inputHandlers) h(f.code === 'too_long' ? 'too_long' : 'rate_limited');
      } else if (f.type === 'ended' && typeof f.reason === 'string') finish('ended', f.reason as TerminalControlReason);
    };
  })();

  return {
    simulated: false,
    onState(handler) { stateHandlers.add(handler); queueMicrotask(() => { if (stateHandlers.has(handler)) handler(state); }); return () => stateHandlers.delete(handler); },
    onInput(handler) { inputHandlers.add(handler); return () => inputHandlers.delete(handler); },
    send(line) { if (state.phase === 'on') sendFrame({ type: 'input', seq: (seq += 1), text: line }); },
    interrupt() { if (state.phase === 'on') sendFrame({ type: 'interrupt', seq: (seq += 1) }); },
    close() {
      if (finished) return;
      sendFrame({ type: 'leave' });
      finish('ended', 'left');
    },
  };
}
