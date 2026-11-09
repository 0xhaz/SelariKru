import { describe, expect, it, vi } from 'vitest';
import type { TerminalControlState } from '@selarikru/view-protocol';
import { openLiveControl, type WebSocketFactory } from '../src/control.ts';

class FakeSocket {
  readonly sent: string[] = [];
  readyState = 1;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  url = '';
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  frame(f: unknown): void { this.onmessage?.({ data: JSON.stringify(f) } as MessageEvent); }
}

const REQ = { taskId: 't1', attemptId: 'a1', expectedRevision: 1, projectId: 'p1' };

function open(res: Partial<Response>) {
  const sock = new FakeSocket();
  const makeSocket: WebSocketFactory = (url) => { sock.url = url; return sock as never; };
  const fetchAuthed = vi.fn(async () => res as Response);
  const states: TerminalControlState[] = [];
  const ch = openLiveControl({ baseUrl: 'http://127.0.0.1:8787', request: REQ, fetchAuthed, makeSocket });
  ch.onState((s) => states.push(s));
  return { sock, ch, states, fetchAuthed };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the live control channel', () => {
  it('sends the ticket as the first message, never in the URL, and is on only after the shell answers', async () => {
    const { sock, ch, states, fetchAuthed } = open({ ok: true, status: 201, json: async () => ({ ticket: 'srct_abc', sessionId: 's' }) });
    await flush(); await flush();
    expect(fetchAuthed).toHaveBeenCalledWith('/v1/projects/p1/attempts/a1/terminal/control-tickets', expect.objectContaining({ method: 'POST' }));
    sock.onopen?.({} as Event);
    expect(sock.url).toBe('ws://127.0.0.1:8787/v1/projects/p1/attempts/a1/terminal/control');
    expect(sock.url).not.toContain('srct_abc');
    expect(JSON.parse(sock.sent[0]!)).toEqual({ type: 'auth', ticket: 'srct_abc' });
    expect(states.at(-1)?.phase).toBe('connecting');
    ch.send('ls');
    expect(sock.sent).toHaveLength(1);
    sock.frame({ type: 'ready', sessionId: 's', echo: true });
    await flush();
    expect(states.at(-1)).toEqual({ phase: 'on', reason: null, echo: true });
    ch.send('ls');
    ch.interrupt();
    expect(sock.sent.slice(1).map((s) => JSON.parse(s))).toEqual([{ type: 'input', seq: 1, text: 'ls' }, { type: 'interrupt', seq: 2 }]);
  });

  it('shows the reason a ticket was refused', async () => {
    const { states } = open({ ok: false, status: 403, json: async () => ({ error: { code: 'control_refused_trial' } }) });
    await flush(); await flush();
    expect(states.at(-1)).toEqual({ phase: 'refused', reason: 'trial', echo: null });
  });

  it('a dropped socket reads as ended, and leaving is idempotent', async () => {
    const { sock, states, ch } = open({ ok: true, status: 201, json: async () => ({ ticket: 'x', sessionId: 's' }) });
    await flush(); await flush();
    sock.frame({ type: 'ready', sessionId: 's', echo: true });
    sock.onclose?.({} as CloseEvent);
    expect(states.at(-1)).toEqual({ phase: 'ended', reason: 'connection_lost', echo: null });
    ch.close();
  });

  it('a server end frame ends it with its reason', async () => {
    const { sock, states } = open({ ok: true, status: 201, json: async () => ({ ticket: 'x', sessionId: 's' }) });
    await flush(); await flush();
    sock.frame({ type: 'ready', sessionId: 's', echo: true });
    sock.frame({ type: 'ended', reason: 'attempt_fenced' });
    expect(states.at(-1)).toEqual({ phase: 'ended', reason: 'attempt_fenced', echo: null });
    expect(sock.closed).toBe(true);
  });
});
