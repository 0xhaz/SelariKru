import { schema } from '@selarikru/persistence';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TerminalHub, type TerminalHubLimits, type TerminalSocket, DEFAULT_TERMINAL_HUB_LIMITS } from '../src/terminal.ts';
import { INTRUDER_TOKEN, OWNER_TOKEN, PROJECT, TENANT, bearer, enrolRunner, makeHarness, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

let t: TestDb;
let h: Harness;
let base: string;

beforeAll(async () => {
  t = await setupTestDb();
  h = makeHarness(t);
  base = await h.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await h.app.close();
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
});

const SECRET = 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789';

async function runningAttempt(taskId = 't1', classification: 'internal' | 'restricted' | 'secret' = 'internal') {
  await seedTask(t.db, specFor(taskId), 'ready');
  const runner = await enrolRunner(h.app, 'local');
  const claim = await post(h.app, '/v1/runners/claim', {}, bearer(runner.token));
  expect(claim.status).toBe(200);
  // Placement refuses restricted work a cloud model; the classification is what this test is about, so it is set once the attempt exists.
  if (classification !== 'internal') await t.db.execute(sql`UPDATE task_revisions SET spec = jsonb_set(spec, '{classification}', to_jsonb(${classification}::text)) WHERE task_id = ${taskId}`);
  const lease = { attemptId: claim.body.lease.attemptId as string, fence: claim.body.lease.fence as number, leaseToken: claim.body.lease.leaseToken as string };
  return { runner, lease, as: bearer(runner.token) };
}

const upload = (lease: unknown, as: Record<string, string>, lines: string[], over: Record<string, unknown> = {}, seq = 0) =>
  post(h.app, '/v1/runners/terminal', { lease, seq, lines: lines.map((text) => ({ at: '2026-11-08T06:00:01.000Z', text })), dropped: 0, ended: false, ...over }, as);

/** Reads SSE frames from an open response until `until` is satisfied. */
async function read(res: Response, until: (frames: { event: string; data: any }[]) => boolean, ms = 4000): Promise<{ event: string; data: any }[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: { event: string; data: any }[] = [];
  let buf = '';
  const deadline = Date.now() + ms;
  while (!until(frames) && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((res2) => setTimeout(() => res2({ done: true, value: undefined }), Math.max(1, deadline - Date.now())))]);
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) frames.push({ event, data: JSON.parse(data) });
    }
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

const open = (projectId: string, attemptId: string, token = OWNER_TOKEN) => fetch(`${base}/v1/projects/${projectId}/attempts/${attemptId}/terminal`, { headers: { authorization: `Bearer ${token}` } });
const closed = async (res: Response) => { await res.body?.cancel().catch(() => undefined); };

describe('terminal output', () => {
  it('secrets are redacted before reaching the browser', async () => {
    const { lease, as } = await runningAttempt();
    // Even a runner that did not redact (or sends a line it missed) is redacted here, and a key split over two batches is held back.
    const mid = Math.floor(SECRET.length / 2);
    const res = await open(PROJECT, lease.attemptId);
    expect(res.status).toBe(200);
    await upload(lease, as, [`key is ${SECRET}`, 'token: \u001b[31msk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZ\u001b[0m'], {}, 0);
    await upload(lease, as, ['-----BEGIN PRIVATE KEY-----'], {}, 1);
    await upload(lease, as, ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEA'], {}, 2);
    await upload(lease, as, ['-----END PRIVATE KEY-----', 'after key'], { ended: true }, 3);
    const frames = await read(res, (f) => f.some((x) => x.event === 'line' && x.data.text === 'after key'));
    const text = frames.filter((f) => f.event === 'line').map((f) => f.data.text as string).join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SECRET.slice(0, mid));
    expect(text).not.toContain('sk-ant-api03-ZZZ');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('MIIEvQIB');
    expect(text).toContain('after key');
    // Terminal output is not domain state: nothing of it reached the events table.
    const events = await t.db.execute(sql`SELECT count(*)::int AS n FROM events WHERE payload::text LIKE ${'%after key%'} OR payload::text LIKE ${'%sk-ant-api03%'}`);
    expect(events[0]?.['n']).toBe(0);
    await closed(res);
  });

  it('other project\'s token is refused', async () => {
    const { runner, lease, as } = await runningAttempt();
    await upload(lease, as, ['visible only to the owner of this project']);
    // Another project's attempt path does not reach this attempt, whatever the token.
    await t.db.insert(schema.projects).values({ tenantId: TENANT, projectId: 'proj_b', repository: 'r2', defaultBranch: 'main', classification: 'internal' });
    const crossProject = await open('proj_b', lease.attemptId);
    expect(crossProject.status).toBe(404);
    await crossProject.text().catch(() => undefined);
    // A token that is not the owner's is refused.
    const intruder = await open(PROJECT, lease.attemptId, INTRUDER_TOKEN);
    expect(intruder.status).toBe(403);
    expect(((await intruder.json()) as any).error.code).toBe('not_owner');
    // A runner credential is not an owner credential.
    const asRunner = await open(PROJECT, lease.attemptId, runner.token);
    expect(asRunner.status).toBe(403);
    expect(((await asRunner.json()) as any).error.code).toBe('wrong_principal_type');
    // No credential, or one in the URL.
    const none = await fetch(`${base}/v1/projects/${PROJECT}/attempts/${lease.attemptId}/terminal?token=${OWNER_TOKEN}&access_token=${OWNER_TOKEN}`);
    expect(none.status).toBe(401);
    // A real owner reaches it, proving those refusals are about the caller and not the route.
    const ok = await open(PROJECT, lease.attemptId);
    expect(ok.status).toBe(200);
    await closed(ok);
  });

  it('a runner may publish only for its own current fenced attempt', async () => {
    const { lease, as } = await runningAttempt();
    expect((await upload(lease, as, ['ok'])).status).toBe(200);
    expect((await upload({ ...lease, fence: lease.fence + 1 }, as, ['stale'])).status).toBe(409);
    expect((await upload({ ...lease, leaseToken: 'wrong' }, as, ['wrong'])).status).toBe(409);
    const other = await enrolRunner(h.app, 'local');
    expect((await upload(lease, bearer(other.token), ['stolen'])).status).toBe(409);
    // Once the attempt is over, the fence is gone.
    await post(h.app, '/v1/runners/result', { lease, result: { outcome: 'failed', reason: 'x' } }, as);
    expect((await upload(lease, as, ['too late'])).status).toBe(409);
    // An owner credential cannot publish.
    expect((await post(h.app, '/v1/runners/terminal', { lease, seq: 9, lines: [], dropped: 0, ended: false })).status).toBe(403);
  });

  for (const classification of ['restricted', 'secret'] as const) {
    it(`${classification} work is not streamed and not accepted`, async () => {
      const { lease, as } = await runningAttempt(`t_${classification}`, classification);
      const res = await open(PROJECT, lease.attemptId);
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).error.code).toBe('terminal_restricted');
      expect((await upload(lease, as, ['should not be stored'])).status).toBe(403);
    });
  }

  it('an attempt with no channel reads as unavailable, never as connected, and goes live once the runner opens one', async () => {
    const { lease, as } = await runningAttempt();
    const res = await open(PROJECT, lease.attemptId);
    setTimeout(() => void upload(lease, as, []), 50);
    const frames = await read(res, (f) => f.filter((x) => x.event === 'state').length >= 2);
    expect(frames.filter((f) => f.event === 'state').map((f) => f.data.status)).toEqual(['unavailable', 'live']);
    expect(frames[0]?.data).toMatchObject({ status: 'unavailable', reason: 'no_channel', lastLineAt: null });
    await closed(res);
  });

  it('a client joining mid-run replays what is retained, and ending the attempt ends the channel', async () => {
    const { lease, as } = await runningAttempt();
    await upload(lease, as, ['one', 'two'], {}, 0);
    const res = await open(PROJECT, lease.attemptId);
    setTimeout(() => void post(h.app, '/v1/runners/result', { lease, result: { outcome: 'failed', reason: 'done' } }, as), 50);
    const frames = await read(res, (f) => f.some((x) => x.event === 'state' && x.data.status === 'ended'));
    expect(frames.filter((f) => f.event === 'line').map((f) => f.data.text)).toEqual(['one', 'two']);
    expect(frames.find((f) => f.event === 'state' && f.data.status === 'live')?.data.lastLineAt).toBe('2026-11-08T06:00:01.000Z');
    await closed(res);
  });

  it('a retried upload is not applied twice, and upstream losses are reported', async () => {
    const { lease, as } = await runningAttempt();
    await upload(lease, as, ['once'], { dropped: 4 }, 0);
    await upload(lease, as, ['once'], { dropped: 4 }, 0);
    const res = await open(PROJECT, lease.attemptId);
    const frames = await read(res, (f) => f.some((x) => x.event === 'line'));
    expect(frames.filter((f) => f.event === 'line').map((f) => f.data.text)).toEqual(['once']);
    expect(frames.find((f) => f.event === 'state')?.data.dropped).toBe(4);
    await closed(res);
  });

  it('slow client applies backpressure and cannot stall the worker', async () => {
    // A real slow client: the socket stops accepting bytes. The upload route keeps answering, and frames for that client are dropped, oldest first, while others are unaffected.
    const { lease, as } = await runningAttempt();
    const stalled = await open(PROJECT, lease.attemptId);
    expect(stalled.status).toBe(200);
    const live = await open(PROJECT, lease.attemptId);
    let seq = 0;
    const started = Date.now();
    for (let batch = 0; batch < 20; batch += 1) {
      const r = await upload(lease, as, Array.from({ length: 100 }, (_, i) => `b${batch}-${i}-${'x'.repeat(200)}`), {}, seq);
      seq += 1;
      expect(r.status).toBe(200);
    }
    // The worker's path (the upload) finished: it was never waiting on anyone reading.
    expect(Date.now() - started).toBeLessThan(10_000);
    const frames = await read(live, (f) => f.some((x) => x.event === 'line' && x.data.text.startsWith('b19-99')));
    expect(frames.some((f) => f.event === 'line' && f.data.text.startsWith('b19-99'))).toBe(true);
    await closed(live);
    await closed(stalled);
  });
});

describe('the hub', () => {
  const limits = (over: Partial<TerminalHubLimits> = {}): TerminalHubLimits => ({ ...DEFAULT_TERMINAL_HUB_LIMITS, maxLines: 5, maxBytes: 1000, retentionMs: 1000, silenceMs: 100, sweepMs: 10, clientQueueLines: 4, clientQueueBytes: 10_000, stalledClientMs: 200, ...over });
  const mkHub = (over?: Partial<TerminalHubLimits>) => { let now = 1_000_000; const hub = new TerminalHub(() => now, limits(over)); return { hub, advance: (ms: number) => { now += ms; } }; };
  const line = (text: string) => ({ at: '2026-11-09T00:00:00.000Z', text });
  /** A socket that accepts everything until told to stall, and remembers what it got. */
  const socket = () => {
    const s = { chunks: [] as string[], accept: true, drain: null as (() => void) | null, write(c: string): boolean { s.chunks.push(c); return s.accept; }, once(_e: 'drain', l: () => void): unknown { s.drain = l; return s; } };
    const typed: TerminalSocket = s;
    void typed;
    return s;
  };
  const lineFrames = (chunks: string[]) => chunks.filter((c) => c.includes('event: line')).map((c) => JSON.parse(/data: (.*)/.exec(c)![1]!).text as string);

  it('keeps a bounded buffer and expires it after its retention', () => {
    const { hub, advance } = mkHub();
    for (let i = 0; i < 12; i += 1) hub.publish('p', 'a', { seq: i, lines: [line(`l${i}`)], dropped: 0, ended: false });
    expect(hub.debugChannel('a')).toMatchObject({ lines: 5 });
    const s = socket();
    hub.attach('p', 'a', s, () => {});
    expect(lineFrames(s.chunks)).toEqual(['l7', 'l8', 'l9', 'l10', 'l11']);
    advance(999);
    hub.sweep();
    expect(hub.debugChannel('a')).not.toBeNull();
    advance(2);
    hub.sweep();
    expect(hub.debugChannel('a')).toBeNull();
    expect(s.chunks.join('')).toContain('"status":"unavailable"');
  });

  it('a stalled client loses its oldest lines, is told, and a fast one loses nothing', () => {
    const { hub, advance } = mkHub({ clientQueueLines: 3, maxLines: 500, maxBytes: 100_000, retentionMs: 60_000 });
    hub.publish('p', 'a', { seq: 0, lines: [], dropped: 0, ended: false });
    const fast = socket();
    const stuck = socket();
    const stuckClient = hub.attach('p', 'a', stuck, () => {}).client;
    hub.attach('p', 'a', fast, () => {});
    stuck.accept = false;
    let seq = 1;
    const burst = (n: number, from: number) => Array.from({ length: n }, (_, i) => line(`l${from + i}`));
    hub.publish('p', 'a', { seq: seq++, lines: burst(1, 0), dropped: 0, ended: false });
    expect(stuck.drain).not.toBeNull(); // The socket pushed back on the first line.
    hub.publish('p', 'a', { seq: seq++, lines: burst(9, 1), dropped: 0, ended: false });
    expect(stuckClient.queuedLines).toBeLessThanOrEqual(3);
    expect(stuckClient.droppedTotal).toBeGreaterThan(0);
    expect(lineFrames(fast.chunks)).toEqual(burst(10, 0).map((l) => l.text));
    // The worker's side never blocked, so publishing kept going; now the client catches up and hears what it lost.
    stuck.accept = true;
    stuck.drain!();
    expect(stuck.chunks.join('')).toContain('event: dropped');
    const after = lineFrames(stuck.chunks);
    expect(after.at(-1)).toBe('l9');
    expect(after.length).toBeLessThan(10);
    advance(1);
  });

  it('a client that stops reading is eventually disconnected', () => {
    const { hub, advance } = mkHub({ stalledClientMs: 500 });
    hub.publish('p', 'a', { seq: 0, lines: [], dropped: 0, ended: false });
    const stuck = socket();
    stuck.accept = false;
    let closed = false;
    const attachment = hub.attach('p', 'a', stuck, () => { closed = true; });
    hub.publish('p', 'a', { seq: 1, lines: [line('x')], dropped: 0, ended: false });
    advance(499);
    hub.sweep();
    expect(closed).toBe(false);
    advance(1);
    hub.sweep();
    expect(closed).toBe(true);
    expect(attachment.client.closed).toBe(true);
  });

  it('a channel the runner stopped touching is no longer live', () => {
    const { hub, advance } = mkHub({ silenceMs: 100, retentionMs: 10_000 });
    hub.publish('p', 'a', { seq: 0, lines: [line('one')], dropped: 0, ended: false });
    const s = socket();
    hub.attach('p', 'a', s, () => {});
    advance(101);
    hub.sweep();
    const last = JSON.parse(/data: (.*)/.exec(s.chunks.at(-1)!)![1]!);
    expect(last).toMatchObject({ status: 'disconnected', reason: 'runner_silent', lastLineAt: '2026-11-09T00:00:00.000Z' });
    // Coming back is noticed.
    hub.publish('p', 'a', { seq: 1, lines: [], dropped: 0, ended: false });
    expect(s.chunks.at(-1)).toContain('"status":"live"');
  });

  it('refuses an attempt published under one project and read under another', () => {
    const { hub } = mkHub();
    hub.publish('p', 'a', { seq: 0, lines: [line('x')], dropped: 0, ended: false });
    expect(() => hub.admit('other', 'a')).toThrow();
  });

  it('caps sessions per attempt', () => {
    const { hub } = mkHub({ maxSessionsPerAttempt: 1 });
    hub.attach('p', 'a', socket(), () => {});
    expect(() => hub.admit('p', 'a')).toThrow();
  });

  it('a queue full of lines never drops the state frame', () => {
    const { hub } = mkHub({ clientQueueLines: 2 });
    hub.publish('p', 'a', { seq: 0, lines: [], dropped: 0, ended: false });
    const stuck = socket();
    stuck.accept = false;
    const c = hub.attach('p', 'a', stuck, () => {}).client;
    c.stateFrame({ status: 'ended', reason: null, lastLineAt: null, dropped: 0 });
    for (let i = 1; i < 20; i += 1) hub.publish('p', 'a', { seq: i, lines: [line('x')], dropped: 0, ended: false });
    stuck.accept = true;
    stuck.drain!();
    expect(stuck.chunks.join('')).toContain('"status":"ended"');
  });
});
