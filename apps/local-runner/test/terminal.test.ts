import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDACTED, type LeaseRef, type NormalizedHarnessEvent, type TerminalUploadRequest } from '@selarikru/protocol';
import { ApiStatusError, ClaimedLeaseSchema, LeaseLostError } from '../src/api.ts';
import { runAttempt, type AttemptDeps } from '../src/attempt.ts';
import { DEFAULT_TERMINAL_FEED_LIMITS, TerminalFeed, type TerminalFeedLimits } from '../src/terminal.ts';
import { makeWorld, type World } from './world.ts';

type Batch = Omit<TerminalUploadRequest, 'lease'>;
const LEASE: LeaseRef = { attemptId: 'att_1', fence: 1, leaseToken: 'tok' };
const SECRET = 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789';
const ev = <T extends Omit<NormalizedHarnessEvent, 'attemptId' | 'seq'>>(e: T, seq = 0) => ({ attemptId: 'att_1', seq, ...e }) as unknown as NormalizedHarnessEvent;
const text = (preview: string, seq = 0) => ev({ type: 'message', role: 'assistant', blockTypes: ['text'], preview } as never, seq);
const limits = (over: Partial<TerminalFeedLimits> = {}): TerminalFeedLimits => ({ ...DEFAULT_TERMINAL_FEED_LIMITS, flushMs: 1, keepaliveMs: 60_000, closeMs: 200, ...over });
const ALL = (batches: Batch[]) => batches.flatMap((b) => b.lines.map((l) => l.text));

describe('the terminal feed', () => {
  it('a secret split across two chunks of model text is redacted before it is uploaded', async () => {
    const sent: Batch[] = [];
    const feed = new TerminalFeed({ terminal: async (_l, b) => { sent.push(b); } }, LEASE, () => {}, limits());
    // The head alone would match a pattern here, the tail alone would not: an earlier per-event pass would have redacted the head and left the tail behind.
    const mid = 28;
    feed.onEvent(text(`the key is ${SECRET.slice(0, mid)}`, 1));
    feed.onEvent(text(`${SECRET.slice(mid)} ok`, 2));
    await feed.close();
    const out = ALL(sent).join('\n');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(SECRET.slice(0, mid));
    expect(out).not.toContain(SECRET.slice(mid));
    expect(ALL(sent)).toEqual([`the key is ${REDACTED} ok`]);
  });

  it('renders tool names, model text and results as readable lines', async () => {
    const sent: Batch[] = [];
    const feed = new TerminalFeed({ terminal: async (_l, b) => { sent.push(b); } }, LEASE, () => {}, limits());
    feed.start();
    feed.onEvent(text('Reading the file', 1));
    feed.onEvent(ev({ type: 'tool_call', toolUseId: 'u1', toolName: 'Bash', status: 'started', preview: '{"command":"npm test"}' } as never, 2));
    feed.onEvent(ev({ type: 'tool_result', toolUseId: 'u1', toolName: 'Bash', status: 'ok', preview: '3 passed' } as never, 3));
    feed.onEvent(ev({ type: 'result', subtype: 'success', isError: false, terminalReason: 'completed', numTurns: 1, durationMs: 5 } as never, 4));
    await feed.close();
    expect(ALL(sent)).toEqual(['Reading the file', '> Bash npm test', '[ok]', '3 passed', 'Finished: success (completed)']);
    expect(sent.at(-1)).toMatchObject({ ended: true, lines: [] });
  });

  it('never waits on the upload: a stalled control plane costs the oldest lines, counted, and the harness keeps running', async () => {
    let release!: () => void;
    const stalled = new Promise<void>((r) => { release = r; });
    const sent: Batch[] = [];
    const terminal = vi.fn(async (_l: LeaseRef, b: Batch) => { sent.push(b); await stalled; });
    const feed = new TerminalFeed({ terminal }, LEASE, () => {}, limits({ maxLines: 50, maxBytes: 10_000, batchLines: 50 }));
    feed.start();
    await new Promise((r) => setTimeout(r, 5));
    const started = Date.now();
    for (let i = 0; i < 5000; i += 1) feed.onEvent(ev({ type: 'tool_call', toolUseId: `u${i}`, toolName: 'Bash', status: 'started' } as never, i));
    // Synchronous and bounded: the whole burst takes no scheduler turn at all.
    expect(Date.now() - started).toBeLessThan(1000);
    expect((feed as unknown as { pending: unknown[] }).pending.length).toBeLessThanOrEqual(50);
    expect(terminal).toHaveBeenCalledTimes(1);
    release();
    await feed.close();
    const totalDropped = sent.reduce((n, b) => n + b.dropped, 0);
    const sentLines = ALL(sent).length;
    expect(totalDropped).toBeGreaterThan(4000);
    expect(sentLines + totalDropped).toBe(5000);
    expect(sent.at(-1)?.ended).toBe(true);
  });

  it('a refusal stops the feed; a server error or a throttle is retried', async () => {
    for (const [status, stops] of [[403, true], [400, true], [429, false], [503, false]] as const) {
      let calls = 0;
      const feed = new TerminalFeed({ terminal: async () => { calls += 1; throw new ApiStatusError(status, '/v1/runners/terminal'); } }, LEASE, () => {}, limits());
      feed.onEvent(text('hello\n'));
      await new Promise((r) => setTimeout(r, 10));
      expect((feed as unknown as { stopped: boolean }).stopped, String(status)).toBe(stops);
      expect((feed as unknown as { retry: unknown }).retry === null, String(status)).toBe(stops);
      feed.abort();
      expect(calls).toBe(1);
    }
  });

  it('a lost lease stops the feed without taking the harness with it, and a failed upload is retried with the same seq', async () => {
    const seen: Batch[] = [];
    let calls = 0;
    const feed = new TerminalFeed({ terminal: async (_l, b) => { seen.push(b); calls += 1; if (calls === 1) throw new Error('network'); if (calls >= 2) throw new LeaseLostError(); } }, LEASE, () => {}, limits());
    feed.onEvent(text('hello\n'));
    await new Promise((r) => setTimeout(r, 5));
    (feed as unknown as { schedule: (ms: number) => void }).schedule(0);
    await new Promise((r) => setTimeout(r, 10));
    feed.onEvent(text('after\n')); // ignored: the channel is closed, nothing throws.
    await feed.close();
    expect(seen[0]?.seq).toBe(seen[1]?.seq);
  });
});

describe('the attempt path', () => {
  let world: World;
  afterEach(() => world?.cleanup());
  const deps = (w: World, extra: Partial<AttemptDeps> = {}): AttemptDeps => ({ api: w.api, runtime: w.runtime, artifacts: w.artifacts, workRoot: w.workRoot, repos: { proj1: w.repo }, heartbeatMs: 25, maxMissedHeartbeats: 3, cpus: 1, memoryMiB: 512, log: (l) => w.logs.push(l), timeoutScale: 0.2, terminalFeedLimits: limits({ flushMs: 1 }), ...extra });
  const secretAssistant = (s: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: s }] } });

  it('a secret split across two raw output chunks is redacted on the runner: nothing unredacted is ever uploaded', async () => {
    const raw = `${JSON.stringify(secretAssistant(`key=${SECRET} done`))}\n`;
    const cut = raw.indexOf(SECRET) + 12;
    world = await makeWorld({ agent: async ({ stream }) => { stream.push(raw.slice(0, cut)); await new Promise((r) => setTimeout(r, 5)); stream.push(raw.slice(cut)); } });
    await runAttempt(deps(world), world.lease);
    const calls = (world.api as unknown as { terminal: ReturnType<typeof vi.fn> }).terminal.mock.calls as [LeaseRef, Batch][];
    const out = calls.flatMap(([, b]) => b.lines.map((l) => l.text)).join('\n');
    expect(out).toContain(`key=${REDACTED}`);
    expect(out).not.toContain(SECRET);
    expect(calls.every(([lease]) => lease.attemptId === world.lease.attemptId && lease.fence === world.lease.fence)).toBe(true);
    expect(calls.at(-1)?.[1].ended).toBe(true);
  });

  it('a secret split across two model messages is redacted whole, even when one half matches a pattern alone', async () => {
    const cut = 28;
    world = await makeWorld({ agent: async ({ stream }) => {
      stream.push(`${JSON.stringify(secretAssistant(`the key is ${SECRET.slice(0, cut)}`))}\n`);
      stream.push(`${JSON.stringify(secretAssistant(`${SECRET.slice(cut)} and more`))}\n`);
    } });
    await runAttempt(deps(world), world.lease);
    const calls = (world.api as unknown as { terminal: ReturnType<typeof vi.fn> }).terminal.mock.calls as [LeaseRef, Batch][];
    const out = calls.flatMap(([, b]) => b.lines.map((l) => l.text)).join('\n');
    expect(out).toContain(`the key is ${REDACTED} and more`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(SECRET.slice(cut));
    expect(out).not.toContain(SECRET.slice(0, cut));
    // The whole raw event is redacted everywhere else: only the feed sees it, and the feed redacts before keeping it.
    expect(world.logs.join('\n')).not.toContain(SECRET.slice(0, cut));
  });

  it('a lease not cleared for streaming sends nothing: no channel opens and previews stay off', async () => {
    world = await makeWorld({ streamable: false, agent: async ({ stream }) => { stream.push(`${JSON.stringify(secretAssistant('not for upload'))}\n`); } });
    await runAttempt(deps(world), world.lease);
    expect((world.api as unknown as { terminal: ReturnType<typeof vi.fn> }).terminal).not.toHaveBeenCalled();
    const { streamable: _dropped, ...silent } = world.lease;
    expect(ClaimedLeaseSchema.parse(silent).streamable).toBe(false);
  });

  it('an upload that hangs forever does not stop the attempt from finishing', async () => {
    world = await makeWorld();
    (world.api as unknown as { terminal: unknown }).terminal = vi.fn(() => new Promise(() => {}));
    const report = await runAttempt(deps(world), world.lease);
    expect(['completed', 'failed']).toContain(report.outcome);
    expect(world.api.published.length).toBe(1);
  });
});
