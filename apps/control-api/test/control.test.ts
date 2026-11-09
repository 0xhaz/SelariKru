import { schema } from '@selarikru/persistence';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ControlHub, DEFAULT_CONTROL_LIMITS } from '../src/control.ts';
import { API_POLICY, ORIGIN, PROJECT, RUN, TENANT, bearer, enrolRunner, get, makeHarness, owner, post, resetDb, seedTask, setupTestDb, specFor, type Harness, type TestDb } from './helpers.ts';

/** Passes through. It is how a test reaches the hub the app built, to place a commit at one exact moment of a sweep. */
const attachSpy = vi.spyOn(ControlHub.prototype, 'attach');
let hub: { stillLive: (...args: unknown[]) => Promise<boolean>; db: any; links: Map<string, unknown>; whileFinishing: <T>(id: string, f: () => Promise<T>) => Promise<T>; endForAttempt: (id: string, reason: 'attempt_finished') => void };
let t: TestDb;
let h: Harness;
let base: string;
let wsBase: string;

const POLICY_ALLOW = { ...API_POLICY, operations: { ...API_POLICY.operations, terminal_control: 'allow' as const } };

beforeAll(async () => {
  t = await setupTestDb();
  h = makeHarness(t, {}, POLICY_ALLOW, { controlLimits: { ...DEFAULT_CONTROL_LIMITS, sweepMs: 20, ackTimeoutMs: 150, pingMs: 60_000, authTimeoutMs: 300, openTimeoutMs: 2_000 } });
  hub = attachSpy.mock.contexts.at(-1) as unknown as typeof hub;
  base = await h.app.listen({ port: 0, host: '127.0.0.1' });
  wsBase = base.replace('http', 'ws');
});
afterAll(async () => {
  await h.app.close();
  await t.close();
});
beforeEach(async () => {
  // A session left open by the previous test may still be writing its end while the tables are truncated.
  for (let i = 0; ; i += 1) {
    try {
      await new Promise((r) => setTimeout(r, 30));
      await resetDb(t.db);
      return;
    } catch (err) {
      if (i >= 4) throw err;
    }
  }
});

const pathOf = (attemptId: string, project = PROJECT): string => `/v1/projects/${project}/attempts/${attemptId}/terminal`;

async function runningAttempt(taskId = 't1', trial = false) {
  await seedTask(t.db, specFor(taskId), 'ready');
  if (trial) await t.db.execute(sql`UPDATE runs SET trial = true, pinned_model = ${JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5-5' })}::jsonb WHERE run_id = ${RUN}`);
  const runner = await enrolRunner(h.app, 'local');
  const claim = await post(h.app, '/v1/runners/claim', {}, bearer(runner.token));
  expect(claim.status).toBe(200);
  const lease = { attemptId: claim.body.lease.attemptId as string, fence: claim.body.lease.fence as number, leaseToken: claim.body.lease.leaseToken as string };
  return { runner, lease, controllable: claim.body.lease.controllable as boolean };
}

class FakeLink {
  readonly frames: any[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.frames.push(JSON.parse(d.toString())));
  }
  static async open(token: string, lease: unknown): Promise<FakeLink> {
    const ws = new WebSocket(`${wsBase}/v1/runners/control-link`, { headers: { authorization: `Bearer ${token}` } });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const link = new FakeLink(ws);
    ws.send(JSON.stringify({ type: 'hello', lease }));
    await link.waitFor((f) => f.type === 'linked');
    return link;
  }
  async waitFor(pred: (f: any) => boolean, ms = 2000): Promise<any> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = this.frames.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no matching link frame; saw ${JSON.stringify(this.frames)}`);
  }
  send(frame: unknown): void { this.ws.send(JSON.stringify(frame)); }
  close(): void { this.ws.close(); }
}

class Client {
  readonly frames: any[] = [];
  closeCode: number | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.frames.push(JSON.parse(d.toString())));
    ws.on('close', (c) => { this.closeCode = c; });
    ws.on('error', () => undefined);
  }
  static async connect(attemptId: string, origin: string = ORIGIN): Promise<Client> {
    const ws = new WebSocket(`${wsBase}${pathOf(attemptId)}/control`, { origin });
    const c = new Client(ws);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    return c;
  }
  send(frame: unknown): void { this.ws.send(JSON.stringify(frame)); }
  async waitFor(pred: (f: any) => boolean, ms = 2000): Promise<any> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = this.frames.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no matching client frame; saw ${JSON.stringify(this.frames)}`);
  }
  async closed(ms = 2000): Promise<number> {
    const deadline = Date.now() + ms;
    while (this.closeCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    return this.closeCode ?? -1;
  }
}

const mint = (attemptId: string, headers: Record<string, string> = owner({ origin: ORIGIN }), key = 'k1', project = PROJECT) =>
  post(h.app, `${pathOf(attemptId, project)}/control-tickets`, { idempotencyKey: key }, headers);

async function enter(attemptId: string, link: FakeLink, key = 'k1'): Promise<Client> {
  const ticket = await mint(attemptId, owner({ origin: ORIGIN }), key);
  expect(ticket.status).toBe(201);
  const c = await Client.connect(attemptId);
  c.send({ type: 'auth', ticket: ticket.body.ticket });
  const open = await link.waitFor((f) => f.type === 'open');
  link.send({ type: 'opened', sessionId: open.sessionId, echo: true });
  await c.waitFor((f) => f.type === 'ready');
  return c;
}

const inputRows = (attemptId?: string) => t.db.select().from(schema.controlInputs).orderBy(schema.controlInputs.seq).then((rows) => (attemptId ? rows : rows));
const sessionRow = () => t.db.select().from(schema.controlSessions).then((r) => r[0]!);
const eventsOf = async () => (await t.db.select().from(schema.events)).map((e) => ({ type: e.type, actor: e.actorKind, id: e.actorId, attempt: e.attemptId, payload: e.payload }));

describe('tickets', () => {
  it('input requires explicit control mode', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    // A socket with no ticket can send a line, and it goes nowhere: the connection is closed and the runner never hears it.
    const c = await Client.connect(lease.attemptId);
    c.send({ type: 'input', seq: 0, text: 'rm -rf /' });
    expect(await c.closed()).toBe(4401);
    await new Promise((r) => setTimeout(r, 30));
    expect(link.frames.filter((f) => f.type !== 'linked')).toEqual([]);
    expect(await inputRows()).toEqual([]);
    link.close();
  });

  it('missing or wrong-origin token is refused', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    // A ticket can only be minted with the owner's token and from a listed origin.
    expect((await post(h.app, `${pathOf(lease.attemptId)}/control-tickets`, { idempotencyKey: 'x' }, { origin: ORIGIN })).status).toBe(401);
    expect((await mint(lease.attemptId, { authorization: 'Bearer firebase-intruder-token', origin: ORIGIN })).status).toBe(403);
    expect((await mint(lease.attemptId, bearer(runner.token))).status).toBe(403);
    const noOrigin = await mint(lease.attemptId, owner());
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe('origin_required');
    const evil = await mint(lease.attemptId, owner({ origin: 'https://evil.example' }));
    expect(evil.body.error.code).toBe('origin_not_allowed');

    // On the socket, an unlisted origin never upgrades, and neither does no origin at all.
    await expect(Client.connect(lease.attemptId, 'https://evil.example')).rejects.toThrow(/403/);
    await expect(new Promise((res, rej) => { const ws = new WebSocket(`${wsBase}${pathOf(lease.attemptId)}/control`); ws.once('open', res); ws.once('error', rej); })).rejects.toThrow(/403/);
    // A token in the URL is refused before anything reads it.
    await expect(new Promise((res, rej) => { const ws = new WebSocket(`${wsBase}${pathOf(lease.attemptId)}/control?token=abc`, { origin: ORIGIN }); ws.once('open', res); ws.once('error', rej); })).rejects.toThrow(/400/);

    const good = await mint(lease.attemptId);
    expect(good.status).toBe(201);
    // A wrong token closes the socket; and the good ticket from a different listed origin is refused too.
    const bad = await Client.connect(lease.attemptId);
    bad.send({ type: 'auth', ticket: 'srct_wrong' });
    await bad.waitFor((f) => f.type === 'refused' && f.code === 'ticket_invalid');
    expect(await bad.closed()).toBe(4403);
    // The ticket for one attempt cannot be spent on another.
    const other = await runningAttempt('t2');
    const c = await Client.connect(other.lease.attemptId);
    c.send({ type: 'auth', ticket: good.body.ticket });
    await c.waitFor((f) => f.type === 'refused' && f.code === 'ticket_invalid');
    link.close();
  });

  it('a ticket spends once, lapses, and cannot be read back: a retry gets a new one that replaces it', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const first = await mint(lease.attemptId);
    const retry = await mint(lease.attemptId);
    expect(retry.status).toBe(201);
    expect(retry.body.sessionId).toBe(first.body.sessionId);
    expect(retry.body.ticket).not.toBe(first.body.ticket);
    const row = await sessionRow();
    expect(JSON.stringify(row)).not.toContain(retry.body.ticket);
    expect(JSON.stringify(await t.db.select().from(schema.operationReceipts))).not.toContain(retry.body.ticket);

    const stale = await Client.connect(lease.attemptId);
    stale.send({ type: 'auth', ticket: first.body.ticket });
    await stale.waitFor((f) => f.type === 'refused' && f.code === 'ticket_invalid');

    const c = await Client.connect(lease.attemptId);
    c.send({ type: 'auth', ticket: retry.body.ticket });
    const open = await link.waitFor((f) => f.type === 'open');
    link.send({ type: 'opened', sessionId: open.sessionId, echo: true });
    await c.waitFor((f) => f.type === 'ready');

    const again = await Client.connect(lease.attemptId);
    again.send({ type: 'auth', ticket: retry.body.ticket });
    await again.waitFor((f) => f.type === 'refused' && f.code === 'ticket_invalid');
    expect((await mint(lease.attemptId, owner({ origin: ORIGIN }), 'k1')).status).toBe(409);
    expect((await mint(lease.attemptId, owner({ origin: ORIGIN }), 'k2')).body.error.code).toBe('control_session_active');
    c.ws.close();
    link.close();
  });

  it('a lapsed ticket is refused and does not block the next', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const old = await mint(lease.attemptId);
    h.clock.advance(31);
    const c = await Client.connect(lease.attemptId);
    c.send({ type: 'auth', ticket: old.body.ticket });
    await c.waitFor((f) => f.type === 'refused' && f.code === 'ticket_invalid');
    const next = await mint(lease.attemptId, owner({ origin: ORIGIN }), 'k2');
    expect(next.status).toBe(201);
    link.close();
  });
});

describe('gates', () => {
  it('policy denies by default', async () => {
    const denied = makeHarness(t, {}, API_POLICY);
    await seedTask(t.db, specFor('t1'), 'ready');
    const runner = await enrolRunner(denied.app, 'local');
    const claim = await post(denied.app, '/v1/runners/claim', {}, bearer(runner.token));
    const r = await post(denied.app, `${pathOf(claim.body.lease.attemptId)}/control-tickets`, { idempotencyKey: 'k' }, owner({ origin: ORIGIN }));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('policy_denied');
    await denied.app.close();
  });

  it('restricted or secret work refuses control mode', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    await t.db.execute(sql`UPDATE attempts SET detail = jsonb_set(detail, '{terminalStreamable}', 'false') WHERE attempt_id = ${lease.attemptId}`);
    const r = await mint(lease.attemptId);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('terminal_restricted');
    link.close();
  });

  it('trial runs refuse control mode', async () => {
    const { runner, lease, controllable } = await runningAttempt('t1', true);
    // The claim does not offer it, and even a runner that opened a link anyway is refused for every ticket.
    expect(controllable).toBe(false);
    const link = await FakeLink.open(runner.token, lease);
    const r = await mint(lease.attemptId);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('control_refused_trial');
    expect((await t.db.select().from(schema.controlSessions))).toEqual([]);
    link.close();
  });

  it('an attempt that is not running, or a project it does not belong to, refuses', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const other = await mint(lease.attemptId, owner({ origin: ORIGIN }), 'k', 'proj_other');
    expect(other.status).toBe(404);
    await t.db.execute(sql`UPDATE attempts SET ended_at = now() WHERE attempt_id = ${lease.attemptId}`);
    const done = await mint(lease.attemptId);
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('attempt_not_running');
    link.close();
  });

  it('with no runner connection to reach, refuses before anyone waits', async () => {
    const { lease } = await runningAttempt();
    const r = await mint(lease.attemptId);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('control_unavailable');
  });

  it('an open cancel refuses a new ticket, and a cancel request closes the session after it commits', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    const [status] = await t.db.select().from(schema.taskStatus);
    const cancel = await post(h.app, '/v1/tasks/t1/commands', { command: 'cancel', expectedRevision: status!.rowRevision, idempotencyKey: 'c1' });
    expect(cancel.status).toBe(202);
    await c.waitFor((f) => f.type === 'ended' && f.reason === 'attempt_fenced');
    await new Promise((r) => setTimeout(r, 40));
    const next = await mint(lease.attemptId, owner({ origin: ORIGIN }), 'after-cancel');
    expect(next.status).toBe(409);
    expect(next.body.error.code).toBe('attempt_not_running');
    link.close();
  });

  it('a stale cancel that is refused closes nobody\'s session', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    const cancel = await post(h.app, '/v1/tasks/t1/commands', { command: 'cancel', expectedRevision: 9999, idempotencyKey: 'c2' });
    expect(cancel.status).toBe(409);
    await new Promise((r) => setTimeout(r, 60));
    expect(c.frames.some((f) => f.type === 'ended')).toBe(false);
    c.ws.close();
    link.close();
  });

  it('a runner link carries the runner token, never an Origin, and the lease must be its own', async () => {
    const { runner, lease } = await runningAttempt();
    await expect(new Promise((res, rej) => { const ws = new WebSocket(`${wsBase}/v1/runners/control-link`); ws.once('open', res); ws.once('error', rej); })).rejects.toThrow(/401/);
    await expect(new Promise((res, rej) => { const ws = new WebSocket(`${wsBase}/v1/runners/control-link`, { origin: ORIGIN, headers: { authorization: `Bearer ${runner.token}` } }); ws.once('open', res); ws.once('error', rej); })).rejects.toThrow(/403/);
    await expect(FakeLink.open(runner.token, { ...lease, fence: lease.fence + 7 })).rejects.toThrow();
  });
});

describe('a session', () => {
  it('control mode marks the attempt human-intervened', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    expect((await t.db.select().from(schema.attempts))[0]!.humanIntervenedAt).toBeNull();
    const c = await enter(lease.attemptId, link);
    const [attempt] = await t.db.select().from(schema.attempts).where(eq(schema.attempts.attemptId, lease.attemptId));
    expect(attempt!.humanIntervenedAt).not.toBeNull();
    // On the snapshot the Team drawer and Evidence read, durable after the session ends.
    c.send({ type: 'leave' });
    await c.closed();
    const snap = await get(h.app, `/v1/projects/${PROJECT}/snapshot`);
    const seen = snap.body.tasks[0].attempts[0];
    expect(seen.humanIntervenedAt).toBe(attempt!.humanIntervenedAt!.toISOString());
    expect(snap.body.runs[0].humanInterventions).toEqual([{ attemptId: lease.attemptId, taskId: 't1', at: attempt!.humanIntervenedAt!.toISOString() }]);
    const events = await eventsOf();
    expect(events.find((e) => e.type === 'attempt.human_intervened')).toMatchObject({ actor: 'human', id: 'owner_uid_1', attempt: lease.attemptId });
    link.close();
  });

  it('every input is audited and redacted', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    c.send({ type: 'input', seq: 1, text: `export GITHUB_TOKEN=${SECRET}` });
    // The audit row exists before the runner hears the line, and carries no text until the shell confirms it echoed.
    const down = await link.waitFor((f) => f.type === 'input' && f.seq === 1);
    expect(down.data).toBe(`export GITHUB_TOKEN=${SECRET}\r`);
    const before = await inputRows();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ disposition: 'pending', text: null, charCount: down.data.length - 1 });
    link.send({ type: 'ack', sessionId: down.sessionId, seq: 1, echo: true });
    await c.waitFor((f) => f.type === 'ack' && f.seq === 1 && f.disposition === 'recorded');
    const rows = await inputRows();
    expect(rows[0]!.disposition).toBe('recorded');
    expect(rows[0]!.text).toBe('export GITHUB_TOKEN=[REDACTED]');
    expect(rows[0]!.text).not.toContain(SECRET);

    // Echo off: the row says a line was sent and nothing about what it said.
    c.send({ type: 'input', seq: 2, text: 'correct horse battery staple' });
    const down2 = await link.waitFor((f) => f.type === 'input' && f.seq === 2);
    link.send({ type: 'ack', sessionId: down2.sessionId, seq: 2, echo: false });
    await c.waitFor((f) => f.type === 'ack' && f.seq === 2 && f.disposition === 'withheld_echo_off');
    // No answer: same, fail closed.
    c.send({ type: 'input', seq: 3, text: 'unanswered line' });
    await link.waitFor((f) => f.type === 'input' && f.seq === 3);
    await c.waitFor((f) => f.type === 'ack' && f.seq === 3 && f.disposition === 'withheld_unconfirmed');
    // Ctrl-C is audited as what it is.
    c.send({ type: 'interrupt', seq: 4 });
    const down4 = await link.waitFor((f) => f.type === 'input' && f.seq === 4);
    expect(down4.data).toBe('\u0003');
    link.send({ type: 'ack', sessionId: down4.sessionId, seq: 4, echo: true });
    await c.waitFor((f) => f.type === 'ack' && f.seq === 4 && f.disposition === 'interrupt');

    const final = await inputRows();
    expect(final.map((r) => r.disposition)).toEqual(['recorded', 'withheld_echo_off', 'withheld_unconfirmed', 'interrupt']);
    expect(final.slice(1).every((r) => r.text === null)).toBe(true);
    const stored = JSON.stringify([final, await sessionRow(), await eventsOf(), await t.db.select().from(schema.operationReceipts)]);
    expect(stored).not.toContain('correct horse');
    expect(stored).not.toContain('unanswered');
    expect(stored).not.toContain(SECRET);
    c.ws.close();
    link.close();
  });

  it('the entry and exit are events with the human as the actor, and no input text', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    c.send({ type: 'input', seq: 1, text: 'hello world' });
    const d = await link.waitFor((f) => f.type === 'input' && f.seq === 1);
    link.send({ type: 'ack', sessionId: d.sessionId, seq: 1, echo: true });
    await c.waitFor((f) => f.type === 'ack' && f.seq === 1);
    c.send({ type: 'leave' });
    await c.waitFor((f) => f.type === 'ended' && f.reason === 'left');
    await link.waitFor((f) => f.type === 'close' && f.reason === 'left');
    await new Promise((r) => setTimeout(r, 50));
    const ended = (await eventsOf()).find((e) => e.type === 'terminal.control_ended');
    expect(ended).toMatchObject({ actor: 'human', id: 'owner_uid_1', attempt: lease.attemptId, payload: { reason: 'left', inputs: 1, withheld: 0 } });
    expect(JSON.stringify(ended)).not.toContain('hello world');
    expect((await sessionRow()).state).toBe('ended');
    link.close();
  });

  it('a dropped browser ends the session', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    c.ws.terminate();
    await link.waitFor((f) => f.type === 'close' && f.reason === 'connection_lost');
    await new Promise((r) => setTimeout(r, 30));
    expect((await sessionRow()).endReason).toBe('connection_lost');
    link.close();
  });

  it('a lost runner connection ends the session', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    link.ws.terminate();
    await c.waitFor((f) => f.type === 'ended' && f.reason === 'runner_link_lost');
  });

  it('an idle session ends itself, and a session cannot outlive its limit', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    h.clock.advance(Math.ceil(DEFAULT_CONTROL_LIMITS.idleMs / 1000) + 1);
    await c.waitFor((f) => f.type === 'ended' && f.reason === 'idle_timeout');
    link.close();
  });

  it('a sweep judges idleness and lease expiry against one clock reading', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    const original = hub.stillLive;
    // The clock moves past both the idle limit and the lease while a sweep is in flight.
    hub.stillLive = async (...args) => {
      hub.stillLive = original;
      h.clock.advance(Math.ceil(DEFAULT_CONTROL_LIMITS.idleMs / 1000) + 1);
      return original(...args);
    };
    await c.waitFor((f) => f.type === 'ended');
    expect(c.frames.find((f) => f.type === 'ended').reason).toBe('idle_timeout');
    link.close();
  });

  it('a sweep during a result publish leaves the session to end as finished', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    await hub.whileFinishing(lease.attemptId, async () => {
      await t.db.update(schema.attempts).set({ endedAt: new Date(h.clock.now().getTime()) }).where(eq(schema.attempts.attemptId, lease.attemptId));
      await new Promise((r) => setTimeout(r, 90)); // several 20 ms sweeps
    });
    hub.endForAttempt(lease.attemptId, 'attempt_finished');
    await c.waitFor((f) => f.type === 'ended');
    expect(c.frames.find((f) => f.type === 'ended').reason).toBe('attempt_finished');
  });

  it('a sweep does not remove a newer link registered while it was reading', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    await enter(lease.attemptId, link);
    const replacement = { fence: lease.fence, ws: { close: () => undefined, terminate: () => undefined, readyState: 3 } };
    const realDb = hub.db;
    let read = false;
    // The sweep's link read is answered as stale, with the newer link appearing during that read.
    hub.db = new Proxy(realDb, { get(target, prop) {
      if (prop !== 'select') return Reflect.get(target, prop);
      return (columns: Record<string, unknown> | undefined) => {
        if (!columns || !('fence' in columns) || 'runner' in columns) return target.select(columns);
        hub.db = realDb;
        return { from: () => ({ where: async () => { hub.links.set(lease.attemptId, replacement); read = true; return [{ fence: -1, endedAt: null, expires: null }]; } }) };
      };
    } });
    await vi.waitFor(() => expect(read).toBe(true));
    await new Promise((r) => setTimeout(r, 5));
    expect(hub.links.get(lease.attemptId)).toBe(replacement);
    hub.links.delete(lease.attemptId);
  });

  it('a fence committing between the session check and the link check still ends the session as fenced', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    const original = hub.stillLive;
    // The session check reads the attempt as live, and the fence commits just after it.
    hub.stillLive = async (...args) => {
      const live = await original(...args);
      hub.stillLive = original;
      await t.db.update(schema.attempts).set({ leaseFence: lease.fence + 1 }).where(eq(schema.attempts.attemptId, lease.attemptId));
      return live;
    };
    await c.waitFor((f) => f.type === 'ended');
    expect(c.frames.find((f) => f.type === 'ended').reason).toBe('attempt_fenced');
    await vi.waitFor(async () => expect((await sessionRow()).endReason).toBe('attempt_fenced'));
    await vi.waitFor(async () => expect((await eventsOf()).find((e) => e.type === 'terminal.control_ended')?.payload).toMatchObject({ reason: 'attempt_fenced' }));
  });

  it('fenced attempt closes the session', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    await t.db.update(schema.attempts).set({ leaseFence: lease.fence + 1 }).where(eq(schema.attempts.attemptId, lease.attemptId));
    await c.waitFor((f) => f.type === 'ended' && f.reason === 'attempt_fenced');
    await link.waitFor((f) => f.type === 'close');
    expect(await c.closed()).toBe(1000);
    await new Promise((r) => setTimeout(r, 30));
    expect((await sessionRow()).state).toBe('ended');
    link.close();
  });

  it('a line typed after the fence never reaches the shell, and leaves no row', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    await t.db.update(schema.attempts).set({ endedAt: h.clock.now() }).where(eq(schema.attempts.attemptId, lease.attemptId));
    c.send({ type: 'input', seq: 1, text: 'should never run' });
    await c.closed();
    expect(link.frames.filter((f) => f.type === 'input')).toEqual([]);
    expect(await inputRows()).toEqual([]);
    link.close();
  });

  it('the worker\'s result closes the session at once', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    const res = await post(h.app, '/v1/runners/result', { lease, result: { outcome: 'failed', reason: 'stopped' } }, bearer(runner.token));
    expect(res.status).toBe(200);
    await c.waitFor((f) => f.type === 'ended' && f.reason === 'attempt_finished');
  });

  it('the shell exiting ends the session', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    const open = await link.waitFor((f) => f.type === 'open');
    link.send({ type: 'shell_ended', sessionId: open.sessionId, unavailable: false });
    await c.waitFor((f) => f.type === 'ended' && f.reason === 'shell_exited');
    link.close();
  });

  it('Enter never resolves anything: a typed line leaves approvals, checks and task status alone', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    await t.db.insert(schema.approvals).values({ tenantId: TENANT, projectId: PROJECT, approvalId: 'apr_1', runId: RUN, taskId: 't1', revision: 1, requester: 'worker', scopeHash: 'x', actionHash: 'x', expectedRevisions: {}, outcome: 'pending', detail: {} });
    const status = (await t.db.select().from(schema.taskStatus))[0]!;
    const c = await enter(lease.attemptId, link);
    for (const [seq, text] of [[1, 'y'], [2, 'approve'], [3, '']] as const) {
      c.send({ type: 'input', seq, text });
      const d = await link.waitFor((f) => f.type === 'input' && f.seq === seq);
      link.send({ type: 'ack', sessionId: d.sessionId, seq, echo: true });
      await c.waitFor((f) => f.type === 'ack' && f.seq === seq);
    }
    const approval = (await t.db.select().from(schema.approvals))[0]!;
    expect(approval.outcome).toBe('pending');
    expect(approval.resolvedAt).toBeNull();
    const after = (await t.db.select().from(schema.taskStatus))[0]!;
    expect(after.status).toBe(status.status);
    expect(after.rowRevision).toBe(status.rowRevision);
    const types = (await eventsOf()).map((e) => e.type);
    expect(types.filter((t2) => /approval|verification|candidate|change/.test(t2))).toEqual([]);
    c.ws.close();
    link.close();
  });

  it('one session per attempt, enforced by the database as well', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    await mint(lease.attemptId);
    expect((await mint(lease.attemptId, owner({ origin: ORIGIN }), 'other')).body.error.code).toBe('control_session_active');
    await expect(t.db.insert(schema.controlSessions).values({ tenantId: TENANT, projectId: PROJECT, sessionId: 'ctl_x', attemptId: lease.attemptId, runId: RUN, taskId: 't1', revision: 1, runner: 'r', leaseFence: 1, ownerUid: 'o', origin: ORIGIN, ticketHash: 'h', ticketExpiresAt: new Date(Date.now() + 99999), state: 'active' })).rejects.toThrow();
    link.close();
  });

  it('input is size and rate limited, and persistent abuse ends the session', async () => {
    const limited = makeHarness(t, {}, POLICY_ALLOW, { controlLimits: { ...DEFAULT_CONTROL_LIMITS, sweepMs: 20, ackTimeoutMs: 80, inputBurst: 2, inputPerSecond: 0, charsPerSecond: 0, maxStrikes: 3, maxQueued: 100 } });
    const url = await limited.app.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = url.replace('http', 'ws');
    await seedTask(t.db, specFor('t1'), 'ready');
    const runner = await enrolRunner(limited.app, 'local');
    const claim = await post(limited.app, '/v1/runners/claim', {}, bearer(runner.token));
    const lease = { attemptId: claim.body.lease.attemptId as string, fence: claim.body.lease.fence as number, leaseToken: claim.body.lease.leaseToken as string };
    const linkWs = new WebSocket(`${wsUrl}/v1/runners/control-link`, { headers: { authorization: `Bearer ${runner.token}` } });
    const linkFrames: any[] = [];
    linkWs.on('message', (d) => {
      const f = JSON.parse(d.toString());
      linkFrames.push(f);
      if (f.type === 'open') linkWs.send(JSON.stringify({ type: 'opened', sessionId: f.sessionId, echo: true }));
      if (f.type === 'input') linkWs.send(JSON.stringify({ type: 'ack', sessionId: f.sessionId, seq: f.seq, echo: true }));
    });
    await new Promise((r) => linkWs.once('open', r));
    linkWs.send(JSON.stringify({ type: 'hello', lease }));
    await new Promise((r) => setTimeout(r, 50));
    const ticket = await post(limited.app, `${pathOf(lease.attemptId)}/control-tickets`, { idempotencyKey: 'k' }, owner({ origin: ORIGIN }));
    const ws = new WebSocket(`${wsUrl}${pathOf(lease.attemptId)}/control`, { origin: ORIGIN });
    const frames: any[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'auth', ticket: ticket.body.ticket }));
    await new Promise((r) => setTimeout(r, 80));
    expect(frames.some((f) => f.type === 'ready')).toBe(true);
    if (!linkFrames.some((f) => f.type === 'linked')) throw new Error('link did not attach');
    for (let i = 1; i <= 2; i += 1) {
      ws.send(JSON.stringify({ type: 'input', seq: i, text: `line ${i}` }));
      await new Promise((r) => setTimeout(r, 60));
    }
    for (let i = 3; i <= 5; i += 1) ws.send(JSON.stringify({ type: 'input', seq: i, text: `line ${i}` }));
    await new Promise((r) => setTimeout(r, 150));
    expect(linkFrames.filter((f) => f.type === 'input')).toHaveLength(2);
    expect(frames.filter((f) => f.type === 'refused' && f.code === 'rate_limited').length).toBeGreaterThan(0);
    expect(frames.some((f) => f.type === 'ended' && f.reason === 'input_limit')).toBe(true);
    ws.send(JSON.stringify({ type: 'input', seq: 9, text: 'x'.repeat(5000) }));
    await limited.app.close();
  });

  it('a line with a line break is refused and never reaches the shell', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    c.send({ type: 'input', seq: 1, text: 'one\nrm -rf /' });
    c.send({ type: 'input', seq: 2, text: 'x'.repeat(5000) });
    await new Promise((r) => setTimeout(r, 60));
    expect(link.frames.filter((f) => f.type === 'input')).toEqual([]);
    expect(await inputRows()).toEqual([]);
    c.ws.close();
    link.close();
  });

  it('output goes through the existing redacted channel, marked as shell output, and is not stored', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    // The worker's channel exists once it has uploaded.
    await post(h.app, '/v1/runners/terminal', { lease, seq: 0, lines: [], dropped: 0, ended: false }, bearer(runner.token));
    const c = await enter(lease.attemptId, link);
    const open = await link.waitFor((f) => f.type === 'open');
    const at = '2026-11-08T06:00:01.000Z';
    link.send({ type: 'output', sessionId: open.sessionId, lines: [{ at, text: 'db_password=hunter2' }, { at, text: 'on disk' }], dropped: 0 });
    const res = await fetch(`${base}${pathOf(lease.attemptId)}`, { headers: { authorization: 'Bearer firebase-owner-token' } });
    const reader = res.body!.getReader();
    let text = '';
    const deadline = Date.now() + 1500;
    while (!text.includes('on disk') && Date.now() < deadline) {
      const r = await reader.read();
      if (r.done) break;
      text += new TextDecoder().decode(r.value);
    }
    await reader.cancel();
    expect(text).toContain('[shell] db_password=[REDACTED]');
    expect(text).toContain('[shell] on disk');
    expect(text).not.toContain('hunter2');
    const stored = JSON.stringify(await t.db.select().from(schema.events));
    expect(stored).not.toContain('on disk');
    c.ws.close();
    link.close();
  });

  it('a restart closes what was left open and says so', async () => {
    const { runner, lease } = await runningAttempt();
    const link = await FakeLink.open(runner.token, lease);
    const c = await enter(lease.attemptId, link);
    await t.db.execute(sql`INSERT INTO control_inputs (tenant_id, project_id, session_id, seq, received_at, char_count, disposition) SELECT tenant_id, project_id, session_id, 99, now(), 5, 'pending' FROM control_sessions`);
    // A second API process stands in for the server after a crash: it holds no session, and reaps what the database says is open.
    const next = makeHarness(t, {}, POLICY_ALLOW);
    await next.app.ready();
    const row = await sessionRow();
    expect(row.state).toBe('ended');
    expect(row.endReason).toBe('server_restarted');
    expect((await inputRows()).find((r) => r.seq === 99)!.disposition).toBe('withheld_unconfirmed');
    await next.app.close();
    c.ws.close();
    link.close();
  });
});
