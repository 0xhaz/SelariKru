import { appendEvent, withTx } from '@selarikru/persistence';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_POLICY, OWNER_TOKEN, OWNER_UID, PROJECT, RUN, makeHarness, resetDb, setupTestDb, type Harness, type TestDb } from './helpers.ts';

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

const mk = (n: number) => ({
  schemaVersion: 1 as const, eventId: `evt_${n}_${Math.random().toString(36).slice(2)}`, projectId: PROJECT, runId: RUN, taskId: 'task_a', attemptId: null,
  type: 'task.ready' as const, sequence: 0, aggregateRevision: n, actor: { kind: 'scheduler' as const, id: 'sched' },
  occurredAt: '2026-11-08T06:00:00.000Z', receivedAt: '2026-11-08T06:00:01.000Z', causationId: null, traceId: 'trace', payload: { n },
});
const append = (n: number) => withTx(t.db, (tx) => appendEvent(tx, mk(n)));

/** Reads SSE frames until `count` data frames arrive. */
async function readFrames(res: Response, count: number, ms = 5000): Promise<{ id: string; data: any }[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: { id: string; data: any }[] = [];
  let buf = '';
  const deadline = Date.now() + ms;
  while (frames.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (id !== undefined && data !== undefined) frames.push({ id, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return frames;
}

describe('SSE', () => {
  it('SSE replays from cursor without gaps', async () => {
    for (let i = 1; i <= 5; i++) await append(i);
    const ctl = new AbortController();
    const res = await fetch(`${base}/v1/projects/${PROJECT}/events?after=2`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` }, signal: ctl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Live events appended while the stream is open follow the replay with no gap.
    setTimeout(() => void (async () => { await append(6); await append(7); })(), 100);
    const frames = await readFrames(res, 5);
    ctl.abort();
    expect(frames.map((f) => Number(f.id))).toEqual([3, 4, 5, 6, 7]);
    expect(frames.map((f) => f.data.sequence)).toEqual([3, 4, 5, 6, 7]);
  });

  it('resumes from Last-Event-ID and refuses a cursor ahead of the stream', async () => {
    for (let i = 1; i <= 3; i++) await append(i);
    const res = await fetch(`${base}/v1/projects/${PROJECT}/events`, { headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'last-event-id': '2' } });
    const frames = await readFrames(res, 1);
    expect(frames.map((f) => f.data.sequence)).toEqual([3]);
    const ahead = await fetch(`${base}/v1/projects/${PROJECT}/events?after=99`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    expect(ahead.status).toBe(409);
    expect(((await ahead.json()) as any).error.code).toBe('cursor_ahead');
  });

  it('requires the Authorization header and does not accept a token in the URL', async () => {
    const none = await fetch(`${base}/v1/projects/${PROJECT}/events?after=0`);
    expect(none.status).toBe(401);
    const viaUrl = await fetch(`${base}/v1/projects/${PROJECT}/events?after=0&token=${OWNER_TOKEN}&access_token=${OWNER_TOKEN}`);
    expect(viaUrl.status).toBe(401);
  });

  it('snapshot cursor lets a client subscribe after it without missing or repeating events', async () => {
    await append(1);
    await append(2);
    const snap = (await (await fetch(`${base}/v1/projects/${PROJECT}/snapshot`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json()) as { cursor: number };
    expect(snap.cursor).toBe(2);
    await append(3);
    const res = await fetch(`${base}/v1/projects/${PROJECT}/events?after=${snap.cursor}`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    const frames = await readFrames(res, 1);
    expect(frames.map((f) => f.data.sequence)).toEqual([3]);
  });

  it('a stream still being set up when shutdown begins closes itself rather than holding the server open', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = makeHarness(t, {}, API_POLICY, { verifier: { verifyToken: async () => { await gate; return { uid: OWNER_UID }; } } });
    const url = await slow.app.listen({ port: 0, host: '127.0.0.1' });
    const opening = fetch(`${url}/v1/projects/${PROJECT}/events`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } }).then((r) => r.text()).catch(() => '');
    await new Promise((r) => setTimeout(r, 50));
    const closing = slow.app.close();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await closing;
    await opening;
    expect(true).toBe(true);
  }, 10_000);
});
