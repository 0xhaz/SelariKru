import { describe, expect, it } from 'vitest';
import type { TerminalState } from '@selarikru/view-protocol';
import { openLiveTerminal } from '../src/terminal.ts';

function sseResponse(frames: string[], keepOpen = false): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      if (!keepOpen) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const liveState = { status: 'live', reason: null, lastLineAt: null, dropped: 0 };

async function run(response: Response | (() => Promise<Response>)) {
  const states: TerminalState[] = [];
  const lines: string[] = [];
  const paths: string[] = [];
  const closes: unknown[] = [];
  const channel = openLiveTerminal({
    channelId: 'term_a', path: '/v1/projects/p/attempts/a/terminal', idleMs: 60_000, onClose: (c) => closes.push(c),
    request: async (p, init) => { paths.push(p); expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream'); return typeof response === 'function' ? response() : response; },
  });
  channel.onLine((l) => lines.push(l));
  channel.onState((s) => states.push(s));
  await new Promise((r) => setTimeout(r, 30));
  return { channel, states, lines, paths, closes };
}

describe('the live terminal channel', () => {
  it('reports connecting, then only claims live once the server says so, delivers lines and keeps the time of the last one', async () => {
    const res = sseResponse([frame('state', liveState), frame('line', { n: 1, at: '2026-11-09T01:00:00.000Z', text: 'hello' })], true);
    const { states, lines, paths, channel } = await run(res);
    expect(states[0]?.status).toBe('connecting');
    expect(states.map((s) => s.status)).toContain('live');
    expect(lines).toEqual(['hello']);
    expect(states.at(-1)?.lastLineAt).toBe('2026-11-09T01:00:00.000Z');
    expect(paths).toEqual(['/v1/projects/p/attempts/a/terminal']);
    expect(paths[0]).not.toMatch(/token/i);
    channel.close();
  });

  it('an attempt with no channel reads as unavailable and never as connected', async () => {
    const { states, channel } = await run(sseResponse([frame('state', { status: 'unavailable', reason: 'no_channel', lastLineAt: null, dropped: 0 })], true));
    expect(states.map((s) => s.status)).not.toContain('live');
    expect(states.at(-1)).toMatchObject({ status: 'unavailable', reason: 'no_channel' });
    channel.close();
  });

  it('restricted work is told apart from no channel, and a refused token is unavailable', async () => {
    const restricted = await run(new Response(JSON.stringify({ error: { code: 'terminal_restricted' } }), { status: 403 }));
    expect(restricted.states.at(-1)).toMatchObject({ status: 'unavailable', reason: 'restricted' });
    const refused = await run(new Response(JSON.stringify({ error: { code: 'not_owner' } }), { status: 403 }));
    expect(refused.states.at(-1)).toMatchObject({ status: 'unavailable', reason: 'unauthorized' });
  });

  it('a stream that ends without an ended state reads as disconnected, keeping the last line time', async () => {
    const res = sseResponse([frame('state', liveState), frame('line', { n: 1, at: '2026-11-09T02:00:00.000Z', text: 'x' })]);
    const { states } = await run(res);
    expect(states.at(-1)).toMatchObject({ status: 'disconnected', reason: 'connection_lost', lastLineAt: '2026-11-09T02:00:00.000Z' });
  });

  it('an ended channel stays ended when the server closes the stream, and counts dropped lines', async () => {
    const res = sseResponse([frame('state', { ...liveState, dropped: 3 }), frame('dropped', { count: 2 }), frame('state', { status: 'ended', reason: null, lastLineAt: null, dropped: 3 })]);
    const { states } = await run(res);
    expect(states.at(-1)).toMatchObject({ status: 'ended', dropped: 5 });
  });

  it('a network failure reads as disconnected, and close stops delivering', async () => {
    const failing = await run(() => Promise.reject(new Error('net')));
    expect(failing.states.at(-1)).toMatchObject({ status: 'disconnected', reason: 'connection_lost' });
    const { channel, lines } = await run(sseResponse([frame('state', liveState)], true));
    channel.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(lines).toEqual([]);
  });
});
