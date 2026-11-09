import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { schema, withTx, type Db, type Executor } from '@selarikru/persistence';
import { evaluate } from '@selarikru/policy';
import {
  CONTROL_MAX_FRAME_BYTES, CONTROL_MAX_LINK_FRAME_BYTES, ControlClientFrameSchema, ControlTicketRequestSchema, ControlUpFrameSchema, redactControlInput,
  type ControlDownFrame, type ControlEndReason, type ControlInputDisposition, type ControlRefusal, type ControlServerFrame, type LeaseRef, type TerminalLine,
} from '@selarikru/protocol';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AppContext } from './app.ts';
import { RUNNER_TOKEN_PREFIX, bearerToken, sha256Hex } from './auth.ts';
import { AppError } from './errors.ts';
import { parseBody } from './routes-owner.ts';
import { fingerprint, idempotent, newId, requireProject, writeEvent } from './store.ts';
import { attemptStreamable } from './terminal.ts';

/**
 * Control mode: a person's keystrokes reaching a shell in one attempt's sandbox, over a path no other route shares.
 *
 * The ticket is minted by the owner, bound to one project, attempt and browser origin, lives for 30 s, is stored only as a hash and spends once. It is sent as the first WebSocket message, so no
 * credential ever sits in a URL, a subprotocol header or a proxy log. Every line is written down before it reaches the shell, and its text is added only once the runner reports the shell was
 * echoing when the line arrived. The session closes with its attempt, its lease or its browser.
 */
export interface ControlLimits {
  readonly ticketTtlMs: number;
  /** How long a connection may sit before its ticket arrives. */
  readonly authTimeoutMs: number;
  /** How long the runner has to start the shell. `sbx exec` is not instant. */
  readonly openTimeoutMs: number;
  /** How long the runner has to say what the shell did with a line. Past this the line's text is withheld. */
  readonly ackTimeoutMs: number;
  /** No input for this long ends the session. */
  readonly idleMs: number;
  /** Absolute limit on one session. */
  readonly maxSessionMs: number;
  readonly pingMs: number;
  /** How often open sessions are checked against their attempt. Lease expiry has no direct hook here, so this bounds how long a fenced attempt can keep its shell. */
  readonly sweepMs: number;
  /** Lines a burst may spend, and how many come back per second. */
  readonly inputBurst: number;
  readonly inputPerSecond: number;
  /** Characters a burst may spend, and how many come back per second. */
  readonly charsBurst: number;
  readonly charsPerSecond: number;
  /** Refusals in a row before the session is ended for abuse. */
  readonly maxStrikes: number;
  /** Lines waiting behind the one in flight. */
  readonly maxQueued: number;
}

export const DEFAULT_CONTROL_LIMITS: ControlLimits = {
  ticketTtlMs: 30_000, authTimeoutMs: 5_000, openTimeoutMs: 20_000, ackTimeoutMs: 2_000, idleMs: 5 * 60_000, maxSessionMs: 30 * 60_000, pingMs: 15_000, sweepMs: 1_000,
  inputBurst: 20, inputPerSecond: 5, charsBurst: 64 * 1024, charsPerSecond: 8 * 1024, maxStrikes: 8, maxQueued: 16,
};

const WS_NORMAL = 1000;
const WS_REFUSED = 4403;
const WS_UNAUTHORIZED = 4401;
const CLIENT_PATH = /^\/v1\/projects\/([A-Za-z0-9_-]{1,120})\/attempts\/([A-Za-z0-9_-]{1,120})\/terminal\/control$/;
const LINK_PATH = '/v1/runners/control-link';

const send = (ws: WebSocket, frame: ControlServerFrame | ControlDownFrame): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
};
const parse = (data: RawData): unknown => {
  try {
    return JSON.parse(data.toString()) as unknown;
  } catch {
    return null;
  }
};
const reject = (socket: Duplex, status: number): void => {
  const reason = status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Forbidden';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

interface Link {
  readonly ws: WebSocket;
  readonly runnerId: string;
  projectId: string;
  attemptId: string;
  fence: number;
  ready: boolean;
  alive: boolean;
}

interface Pending {
  readonly seq: number;
  readonly text: string;
  readonly interrupt: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly done: () => void;
}

interface Session {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly runner: string;
  readonly fence: number;
  readonly ownerUid: string;
  readonly startedMs: number;
  readonly ws: WebSocket;
  readonly link: Link;
  ready: boolean;
  ended: boolean;
  alive: boolean;
  lastInputMs: number;
  lastSeq: number;
  lines: number;
  chars: number;
  lastRefillMs: number;
  strikes: number;
  queued: number;
  queue: Promise<void>;
  pending: Pending | null;
  echo: boolean | null;
  openTimer: ReturnType<typeof setTimeout> | null;
}

type Refused = { readonly refused: ControlRefusal };

export class ControlHub {
  private readonly links = new Map<string, Link>();
  private readonly sessions = new Map<string, Session>();
  private readonly clientServer = new WebSocketServer({ noServer: true, maxPayload: CONTROL_MAX_FRAME_BYTES, perMessageDeflate: false });
  private readonly linkServer = new WebSocketServer({ noServer: true, maxPayload: CONTROL_MAX_LINK_FRAME_BYTES, perMessageDeflate: false });
  private timers: ReturnType<typeof setInterval>[] = [];
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly ctx: Pick<AppContext, 'config' | 'now' | 'policy' | 'terminal'>,
    private readonly authenticateRunner: (token: string) => Promise<{ runnerId: string; tenantId: string } | null>,
    readonly limits: ControlLimits = DEFAULT_CONTROL_LIMITS,
  ) {}

  private get nowMs(): number { return this.ctx.now().getTime(); }

  /** Everything on the upgrade path is checked here, because Fastify's hooks do not run for an upgrade. */
  attach(server: Server, isAllowedHost: (hostHeader: string | undefined) => boolean, origins: ReadonlySet<string>): void {
    server.on('upgrade', (req, socket, head) => { this.onUpgrade(req, socket, head, isAllowedHost, origins).catch(() => socket.destroy()); });
    const sweep = setInterval(() => void this.sweep().catch(() => undefined), this.limits.sweepMs);
    const ping = setInterval(() => this.ping(), this.limits.pingMs);
    sweep.unref?.();
    ping.unref?.();
    this.timers = [sweep, ping];
  }

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, isAllowedHost: (h: string | undefined) => boolean, origins: ReadonlySet<string>): Promise<void> {
    socket.on('error', () => undefined);
    const url = req.url ?? '';
    // A credential in a query string would land in logs and history, so a URL carrying one is not this endpoint.
    if (url.includes('?')) { reject(socket, 400); return; }
    if (url === LINK_PATH) { await this.upgradeLink(req, socket, head); return; }
    const match = CLIENT_PATH.exec(url);
    if (!match) { reject(socket, 404); return; }
    if (!isAllowedHost(req.headers.host)) { reject(socket, 403); return; }
    const origin = req.headers.origin;
    // A browser always sends Origin on a WebSocket, so a missing one is not a browser this allowlist can vouch for. Exact match only: a page on any other origin is refused here.
    if (typeof origin !== 'string' || !origins.has(origin) || origin === '*') { reject(socket, 403); return; }
    if (this.closing) { reject(socket, 403); return; }
    this.clientServer.handleUpgrade(req, socket, head, (ws) => this.onClient(ws, match[1]!, match[2]!, origin));
  }

  private async upgradeLink(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // A browser cannot set Authorization on a WebSocket, so a request that has an Origin header is not the runner.
    if (req.headers.origin !== undefined) { reject(socket, 403); return; }
    const token = bearerToken(req.headers.authorization);
    if (!token || !token.startsWith(RUNNER_TOKEN_PREFIX)) { reject(socket, 401); return; }
    const runner = await this.authenticateRunner(token).catch(() => null);
    if (!runner || runner.tenantId !== this.ctx.config.tenantId) { reject(socket, 401); return; }
    this.linkServer.handleUpgrade(req, socket, head, (ws) => this.onLink(ws, runner.runnerId));
  }

  /** Waits for the ticket. Anything else first, and the connection is gone. */
  private onClient(ws: WebSocket, projectId: string, attemptId: string, origin: string): void {
    let authed = false;
    let session: Session | null = null;
    const timer = setTimeout(() => { if (!authed) ws.close(WS_UNAUTHORIZED); }, this.limits.authTimeoutMs);
    timer.unref?.();
    ws.on('error', () => undefined);
    ws.on('close', () => {
      clearTimeout(timer);
      if (session !== null) this.end(session, 'connection_lost');
    });
    ws.on('pong', () => { if (session) session.alive = true; });
    ws.on('message', (data: RawData) => {
      const frame = ControlClientFrameSchema.safeParse(parse(data));
      if (!authed) {
        if (!frame.success || frame.data.type !== 'auth') { ws.close(WS_UNAUTHORIZED); return; }
        authed = true;
        clearTimeout(timer);
        void this.consumeTicket(frame.data.ticket, projectId, attemptId, origin, ws).then((s) => { session = s; if (s && ws.readyState !== ws.OPEN) this.end(s, 'connection_lost'); }).catch(() => { ws.close(WS_REFUSED); });
        return;
      }
      if (session === null) return;
      if (!frame.success) { this.refuseInput(session, null, 'too_long'); return; }
      if (frame.data.type === 'leave') { this.end(session, 'left'); return; }
      if (frame.data.type === 'auth') return;
      this.onInput(session, frame.data.seq, frame.data.type === 'input' ? frame.data.text : null);
    });
  }

  /**
   * One transaction: find the row by the ticket's hash under a lock, spend it, re-judge the gate, and on success write the mark and event. A ticket that fails the re-check is still spent. The mark is
   * written here, before any shell can exist.
   */
  private async consumeTicket(ticket: string, projectId: string, attemptId: string, origin: string, ws: WebSocket): Promise<Session | null> {
    const { config } = this.ctx;
    const at = this.ctx.now();
    const refusal = (r: ControlRefusal): Refused => ({ refused: r });
    const link = this.links.get(attemptId);
    const outcome = await withTx(this.db, async (tx): Promise<Refused | Omit<Session, 'ws' | 'link' | 'startedMs' | 'ready' | 'ended' | 'alive' | 'lastInputMs' | 'lastSeq' | 'lines' | 'chars' | 'lastRefillMs' | 'strikes' | 'queued' | 'queue' | 'pending' | 'echo' | 'openTimer'>> => {
      const [row] = await tx.select().from(schema.controlSessions).where(and(eq(schema.controlSessions.tenantId, config.tenantId), eq(schema.controlSessions.projectId, projectId), eq(schema.controlSessions.attemptId, attemptId), eq(schema.controlSessions.ticketHash, sha256Hex(ticket)))).for('update');
      if (!row || row.state !== 'minted' || row.origin !== origin || row.ticketExpiresAt.getTime() <= at.getTime()) return refusal('ticket_invalid');
      const refuse = async (r: ControlRefusal): Promise<Refused> => {
        await tx.update(schema.controlSessions).set({ state: 'expired', endedAt: at, endReason: r }).where(and(eq(schema.controlSessions.tenantId, config.tenantId), eq(schema.controlSessions.projectId, projectId), eq(schema.controlSessions.sessionId, row.sessionId)));
        return refusal(r);
      };
      const gate = await this.gate(tx, projectId, attemptId, at);
      if ('refused' in gate) return refuse(gate.refused);
      if (!link || !link.ready || link.fence !== gate.attempt.leaseFence || link.runnerId !== gate.attempt.runner) return refuse('unavailable');
      await tx.update(schema.controlSessions).set({ state: 'active', enteredAt: at }).where(and(eq(schema.controlSessions.tenantId, config.tenantId), eq(schema.controlSessions.projectId, projectId), eq(schema.controlSessions.sessionId, row.sessionId)));
      await tx.update(schema.attempts).set({ humanIntervenedAt: sql`COALESCE(${schema.attempts.humanIntervenedAt}, ${at.toISOString()}::timestamptz)` }).where(and(eq(schema.attempts.tenantId, config.tenantId), eq(schema.attempts.projectId, projectId), eq(schema.attempts.attemptId, attemptId)));
      await writeEvent(tx, at, {
        projectId, runId: gate.runId, taskId: gate.attempt.taskId, attemptId, aggregateRevision: gate.rowRevision, type: 'attempt.human_intervened',
        actor: { kind: 'human', id: row.ownerUid }, payload: { sessionId: row.sessionId },
      });
      return { sessionId: row.sessionId, tenantId: config.tenantId, projectId, attemptId, taskId: gate.attempt.taskId, runId: gate.runId, runner: gate.attempt.runner!, fence: gate.attempt.leaseFence!, ownerUid: row.ownerUid };
    });
    if ('refused' in outcome) {
      send(ws, { type: 'refused', seq: null, code: outcome.refused });
      ws.close(WS_REFUSED);
      return null;
    }
    const session: Session = {
      ...outcome, ws, link: link!, startedMs: this.nowMs, ready: false, ended: false, alive: true, lastInputMs: this.nowMs, lastSeq: -1, lines: this.limits.inputBurst, chars: this.limits.charsBurst, lastRefillMs: this.nowMs,
      strikes: 0, queued: 0, queue: Promise.resolve(), pending: null, echo: null, openTimer: null,
    };
    this.sessions.set(session.sessionId, session);
    session.openTimer = setTimeout(() => this.end(session, 'shell_unavailable'), this.limits.openTimeoutMs);
    session.openTimer.unref?.();
    send(link!.ws, { type: 'open', sessionId: session.sessionId });
    return session;
  }

  /** What every ticket and connection is held to. Refuses in order of the most lasting reason first, so the screen says the true one. */
  async gate(tx: Executor, projectId: string, attemptId: string, at: Date) {
    const { config, policy } = this.ctx;
    if (evaluate({ kind: 'terminal_control' }, policy).decision !== 'allow') return { refused: 'policy_denied' as const };
    const [attempt] = await tx.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, config.tenantId), eq(schema.attempts.projectId, projectId), eq(schema.attempts.attemptId, attemptId)));
    if (!attempt) return { refused: 'attempt_not_running' as const };
    const [revision] = await tx.select({ runId: schema.taskRevisions.runId }).from(schema.taskRevisions).where(and(eq(schema.taskRevisions.tenantId, config.tenantId), eq(schema.taskRevisions.projectId, projectId), eq(schema.taskRevisions.taskId, attempt.taskId), eq(schema.taskRevisions.revision, attempt.revision)));
    const [run] = revision ? await tx.select({ trial: schema.runs.trial, runId: schema.runs.runId }).from(schema.runs).where(and(eq(schema.runs.tenantId, config.tenantId), eq(schema.runs.projectId, projectId), eq(schema.runs.runId, revision.runId))) : [];
    if (!run) return { refused: 'attempt_not_running' as const };
    if (run.trial) return { refused: 'trial' as const };
    if (!attemptStreamable(attempt)) return { refused: 'restricted' as const };
    const [status] = await tx.select({ status: schema.taskStatus.status, currentRevision: schema.taskStatus.currentRevision, rowRevision: schema.taskStatus.rowRevision }).from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, config.tenantId), eq(schema.taskStatus.projectId, projectId), eq(schema.taskStatus.taskId, attempt.taskId)));
    const live = status?.status === 'running' && status.currentRevision === attempt.revision && attempt.endedAt === null && attempt.leaseExpiresAt !== null && attempt.leaseExpiresAt.getTime() > at.getTime() && attempt.leaseFence !== null && attempt.runner !== null;
    if (!live) return { refused: 'attempt_not_running' as const };
    if (await this.cancelOpen(tx, projectId, attempt.taskId, attempt.revision)) return { refused: 'attempt_not_running' as const };
    return { attempt, runId: run.runId, rowRevision: status.rowRevision };
  }

  /** A cancel requested and not yet resolved: the worker is stopping, so nobody may start typing into it. */
  private async cancelOpen(tx: Executor, projectId: string, taskId: string, revision: number): Promise<boolean> {
    const rows = await tx.select({ id: schema.taskCommands.operationId }).from(schema.taskCommands).where(and(eq(schema.taskCommands.tenantId, this.ctx.config.tenantId), eq(schema.taskCommands.projectId, projectId), eq(schema.taskCommands.taskId, taskId), eq(schema.taskCommands.revision, revision), eq(schema.taskCommands.command, 'cancel'), eq(schema.taskCommands.state, 'cancel_requested')));
    return rows.length > 0;
  }

  private refuseInput(session: Session, seq: number | null, code: ControlRefusal): void {
    send(session.ws, { type: 'refused', seq, code });
    session.strikes += 1;
    if (session.strikes >= this.limits.maxStrikes) this.end(session, 'input_limit');
  }

  /** Spends the session's allowance for one line. Refills over time. */
  private allow(session: Session, chars: number): boolean {
    const now = this.nowMs;
    const elapsed = Math.max(0, now - session.lastRefillMs) / 1000;
    session.lastRefillMs = now;
    session.lines = Math.min(this.limits.inputBurst, session.lines + elapsed * this.limits.inputPerSecond);
    session.chars = Math.min(this.limits.charsBurst, session.chars + elapsed * this.limits.charsPerSecond);
    if (session.lines < 1 || session.chars < chars || session.queued >= this.limits.maxQueued) return false;
    session.lines -= 1;
    session.chars -= chars;
    return true;
  }

  private onInput(session: Session, seq: number, text: string | null): void {
    if (session.ended || !session.ready) return;
    if (seq <= session.lastSeq) { this.refuseInput(session, seq, 'too_long'); return; }
    const chars = text?.length ?? 1;
    if (!this.allow(session, chars)) { this.refuseInput(session, seq, 'rate_limited'); return; }
    session.lastSeq = seq;
    session.lastInputMs = this.nowMs;
    session.strikes = 0;
    session.queued += 1;
    session.queue = session.queue.then(() => this.processInput(session, seq, text)).catch(() => undefined).finally(() => { session.queued -= 1; });
  }

  /** The audit row commits first, with no text: an Enter cannot reach the shell unless the attempt is still live and the record of it exists. Then the runner, then the ack that adds the text. */
  private async processInput(session: Session, seq: number, text: string | null): Promise<void> {
    if (session.ended) return;
    const interrupt = text === null;
    const chars = text?.length ?? 1;
    const disposition: ControlInputDisposition = interrupt ? 'interrupt' : 'pending';
    let live = false;
    try {
      live = await withTx(this.db, async (tx) => {
        if (!(await this.stillLive(tx, session))) return false;
        await tx.insert(schema.controlInputs).values({ tenantId: session.tenantId, projectId: session.projectId, sessionId: session.sessionId, seq, receivedAt: this.ctx.now(), charCount: chars, disposition });
        await tx.update(schema.controlSessions).set({ inputCount: sql`${schema.controlSessions.inputCount} + 1` }).where(this.sessionRow(session));
        return true;
      });
    } catch {
      this.end(session, 'audit_failed');
      return;
    }
    if (!live) { this.end(session, 'attempt_fenced'); return; }
    if (session.ended) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { if (session.pending?.seq === seq) { const p = session.pending; session.pending = null; void this.settle(session, p, null).finally(p.done); } }, this.limits.ackTimeoutMs);
      session.pending = { seq, text: text ?? '', interrupt, timer, done: resolve };
      send(session.link.ws, { type: 'input', sessionId: session.sessionId, seq, data: text === null ? '\u0003' : `${text}\r` });
    });
  }

  private sessionRow(s: Session) {
    return and(eq(schema.controlSessions.tenantId, s.tenantId), eq(schema.controlSessions.projectId, s.projectId), eq(schema.controlSessions.sessionId, s.sessionId));
  }

  /** `nowMs`: the sweep passes the instant it started, so one pass judges idleness and lease expiry against the same clock reading. */
  private stillLive = async (tx: Executor, s: Session, nowMs: number = this.nowMs): Promise<boolean> => {
    const [row] = await tx.select({ runner: schema.attempts.runner, fence: schema.attempts.leaseFence, endedAt: schema.attempts.endedAt, expires: schema.attempts.leaseExpiresAt, status: schema.taskStatus.status, revision: schema.attempts.revision, current: schema.taskStatus.currentRevision })
      .from(schema.attempts)
      .innerJoin(schema.taskStatus, and(eq(schema.taskStatus.tenantId, schema.attempts.tenantId), eq(schema.taskStatus.projectId, schema.attempts.projectId), eq(schema.taskStatus.taskId, schema.attempts.taskId)))
      .where(and(eq(schema.attempts.tenantId, s.tenantId), eq(schema.attempts.projectId, s.projectId), eq(schema.attempts.attemptId, s.attemptId)));
    if (!row || row.runner !== s.runner || row.fence !== s.fence || row.endedAt !== null || row.expires === null || row.expires.getTime() <= nowMs || row.status !== 'running' || row.revision !== row.current) return false;
    // Also here, for a ticket spent in the moment before a cancel committed.
    return !(await this.cancelOpen(tx, s.projectId, s.taskId, row.revision));
  };

  /** What the shell did with the line. `echo` null means no answer: its text stays out. */
  private async settle(session: Session, p: Pending, echo: boolean | null): Promise<void> {
    clearTimeout(p.timer);
    let disposition: ControlInputDisposition;
    let text: string | null = null;
    if (p.interrupt) disposition = 'interrupt';
    else if (echo === true) { disposition = 'recorded'; text = redactControlInput(p.text); }
    else disposition = echo === false ? 'withheld_echo_off' : 'withheld_unconfirmed';
    try {
      await this.db.update(schema.controlInputs).set({ disposition, text }).where(and(eq(schema.controlInputs.tenantId, session.tenantId), eq(schema.controlInputs.projectId, session.projectId), eq(schema.controlInputs.sessionId, session.sessionId), eq(schema.controlInputs.seq, p.seq)));
      if (disposition === 'withheld_echo_off' || disposition === 'withheld_unconfirmed') await this.db.update(schema.controlSessions).set({ withheldCount: sql`${schema.controlSessions.withheldCount} + 1` }).where(this.sessionRow(session));
    } catch {
      this.end(session, 'audit_failed');
      return;
    }
    send(session.ws, { type: 'ack', seq: p.seq, disposition });
  }

  private onLink(ws: WebSocket, runnerId: string): void {
    const link: Link = { ws, runnerId, projectId: '', attemptId: '', fence: -1, ready: false, alive: true };
    const timer = setTimeout(() => { if (!link.ready) ws.close(WS_UNAUTHORIZED); }, this.limits.authTimeoutMs);
    timer.unref?.();
    ws.on('error', () => undefined);
    ws.on('pong', () => { link.alive = true; });
    ws.on('close', () => {
      clearTimeout(timer);
      if (this.links.get(link.attemptId) === link) this.links.delete(link.attemptId);
      for (const s of [...this.sessions.values()]) if (s.link === link) this.end(s, 'runner_link_lost');
    });
    ws.on('message', (data: RawData) => {
      const frame = ControlUpFrameSchema.safeParse(parse(data));
      if (!frame.success) return;
      const f = frame.data;
      if (f.type === 'hello') {
        if (link.ready) return;
        void this.registerLink(link, f.lease).catch(() => ws.close(WS_REFUSED));
        return;
      }
      if (!link.ready) return;
      const session = this.sessions.get(f.sessionId);
      if (!session || session.link !== link || session.ended) return;
      switch (f.type) {
        case 'opened':
          if (session.openTimer !== null) clearTimeout(session.openTimer);
          session.openTimer = null;
          session.ready = true;
          session.echo = f.echo;
          send(session.ws, { type: 'ready', sessionId: session.sessionId, echo: f.echo });
          break;
        case 'echo':
          if (session.echo !== f.on) {
            session.echo = f.on;
            send(session.ws, { type: 'echo', on: f.on });
          }
          break;
        case 'ack': {
          if (session.pending?.seq !== f.seq) break;
          const p = session.pending;
          session.pending = null;
          void this.settle(session, p, f.echo).finally(p.done);
          break;
        }
        case 'output':
          this.ctx.terminal.publishControl(session.projectId, session.attemptId, f.lines as TerminalLine[], f.dropped);
          break;
        case 'shell_ended':
          this.end(session, f.unavailable ? 'shell_unavailable' : 'shell_exited');
          break;
      }
    });
  }

  /** A runner's own connection, held to the same lease checks as an output upload. */
  private async registerLink(link: Link, lease: LeaseRef): Promise<void> {
    const { config } = this.ctx;
    const [a] = await this.db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, config.tenantId), eq(schema.attempts.attemptId, lease.attemptId)));
    if (!a || a.runner !== link.runnerId || a.leaseFence !== lease.fence || a.leaseToken !== lease.leaseToken || a.endedAt !== null || a.leaseExpiresAt === null || a.leaseExpiresAt.getTime() <= this.nowMs || !attemptStreamable(a)) {
      link.ws.close(WS_REFUSED);
      return;
    }
    const held = this.links.get(a.attemptId);
    if (held && held !== link) {
      for (const s of [...this.sessions.values()]) if (s.link === held) this.end(s, 'runner_link_lost');
      held.ws.close(WS_NORMAL);
    }
    link.projectId = a.projectId;
    link.attemptId = a.attemptId;
    link.fence = a.leaseFence;
    link.ready = true;
    this.links.set(a.attemptId, link);
    send(link.ws, { type: 'linked' });
  }

  /** Whether this runner's connection for the attempt is up: a ticket with no shell to reach is refused before anyone is told to wait. */
  hasLink(attemptId: string, runner: string | null, fence: number | null): boolean {
    const link = this.links.get(attemptId);
    return link !== undefined && link.ready && link.runnerId === runner && link.fence === fence;
  }

  /** Immediately, and only ever after the attempt's own result or cancellation is durable. */
  endForAttempt(attemptId: string, reason: ControlEndReason): void {
    for (const s of [...this.sessions.values()]) if (s.attemptId === attemptId) this.end(s, reason);
    const link = this.links.get(attemptId);
    if (link) { this.links.delete(attemptId); link.ws.close(WS_NORMAL); }
  }

  /** Ends a session exactly once: stop reading input now, tell both ends, and write the record last so nothing can reorder it behind later input. */
  private end(session: Session, reason: ControlEndReason): void {
    if (session.ended) return;
    session.ended = true;
    if (session.openTimer !== null) clearTimeout(session.openTimer);
    session.openTimer = null;
    this.sessions.delete(session.sessionId);
    const flush = session.pending;
    session.pending = null;
    if (flush !== null) { clearTimeout(flush.timer); flush.done(); }
    send(session.link.ws, { type: 'close', sessionId: session.sessionId, reason });
    send(session.ws, { type: 'ended', reason });
    if (session.ws.readyState === session.ws.OPEN) session.ws.close(WS_NORMAL);
    void this.record(session, reason).catch(() => undefined);
  }

  private async record(session: Session, reason: ControlEndReason): Promise<void> {
    const at = this.ctx.now();
    await withTx(this.db, async (tx) => {
      const rows = await tx.update(schema.controlSessions).set({ state: 'ended', endedAt: at, endReason: reason }).where(and(this.sessionRow(session), eq(schema.controlSessions.state, 'active'))).returning({ inputCount: schema.controlSessions.inputCount, withheldCount: schema.controlSessions.withheldCount });
      if (rows.length === 0) return;
      // Lines still pending here never got an answer, so their text was never read.
      await tx.update(schema.controlInputs).set({ disposition: 'withheld_unconfirmed' }).where(and(eq(schema.controlInputs.tenantId, session.tenantId), eq(schema.controlInputs.projectId, session.projectId), eq(schema.controlInputs.sessionId, session.sessionId), eq(schema.controlInputs.disposition, 'pending')));
      const [status] = await tx.select({ rowRevision: schema.taskStatus.rowRevision }).from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, session.tenantId), eq(schema.taskStatus.projectId, session.projectId), eq(schema.taskStatus.taskId, session.taskId)));
      await writeEvent(tx, at, { projectId: session.projectId, runId: session.runId, taskId: session.taskId, attemptId: session.attemptId, aggregateRevision: status?.rowRevision ?? 0, type: 'terminal.control_ended', actor: { kind: 'human', id: session.ownerUid }, payload: { sessionId: session.sessionId, reason, inputs: rows[0]!.inputCount, withheld: rows[0]!.withheldCount } });
    });
  }

  private ping(): void {
    for (const s of [...this.sessions.values()]) {
      if (!s.alive) { s.ws.terminate(); this.end(s, 'connection_lost'); continue; }
      s.alive = false;
      if (s.ws.readyState === s.ws.OPEN) s.ws.ping();
    }
    for (const link of [...this.links.values()]) {
      if (!link.alive) { link.ws.terminate(); continue; }
      link.alive = false;
      if (link.ws.readyState === link.ws.OPEN) link.ws.ping();
    }
  }

  /** The catch for what has no direct hook: a lease expired by the driver, a fence taken by another runner, a session gone quiet. */
  async sweep(): Promise<void> {
    const now = this.nowMs;
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastInputMs >= this.limits.idleMs) { this.end(s, 'idle_timeout'); continue; }
      if (now - s.startedMs >= this.limits.maxSessionMs) { this.end(s, 'session_limit'); continue; }
      if (!(await this.stillLive(this.db, s, now))) this.end(s, 'attempt_fenced');
    }
    for (const [attemptId, link] of [...this.links]) {
      const [a] = await this.db.select({ fence: schema.attempts.leaseFence, endedAt: schema.attempts.endedAt, expires: schema.attempts.leaseExpiresAt }).from(schema.attempts).where(and(eq(schema.attempts.tenantId, this.ctx.config.tenantId), eq(schema.attempts.attemptId, attemptId)));
      if (!a || a.fence !== link.fence || a.endedAt !== null || (a.expires !== null && a.expires.getTime() <= now)) {
        // A fence can commit after the loop above read this attempt as live. Named here, or the link's close would record it as a lost link.
        for (const s of [...this.sessions.values()]) if (s.link === link) this.end(s, 'attempt_fenced');
        this.links.delete(attemptId);
        link.ws.close(WS_NORMAL);
      }
    }
  }

  /** A restart cannot still be holding a session. Anything left open says so, and a line still pending is closed unread. */
  async reapOrphans(): Promise<void> {
    const at = this.ctx.now();
    const open = await this.db.select().from(schema.controlSessions).where(and(eq(schema.controlSessions.tenantId, this.ctx.config.tenantId), eq(schema.controlSessions.state, 'active')));
    for (const row of open) {
      if (this.sessions.has(row.sessionId)) continue;
      await withTx(this.db, async (tx) => {
        await tx.update(schema.controlSessions).set({ state: 'ended', endedAt: at, endReason: 'server_restarted' }).where(and(eq(schema.controlSessions.tenantId, row.tenantId), eq(schema.controlSessions.projectId, row.projectId), eq(schema.controlSessions.sessionId, row.sessionId), eq(schema.controlSessions.state, 'active')));
        await tx.update(schema.controlInputs).set({ disposition: 'withheld_unconfirmed' }).where(and(eq(schema.controlInputs.tenantId, row.tenantId), eq(schema.controlInputs.projectId, row.projectId), eq(schema.controlInputs.sessionId, row.sessionId), eq(schema.controlInputs.disposition, 'pending')));
        const [status] = await tx.select({ rowRevision: schema.taskStatus.rowRevision }).from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, row.tenantId), eq(schema.taskStatus.projectId, row.projectId), eq(schema.taskStatus.taskId, row.taskId)));
        await writeEvent(tx, at, { projectId: row.projectId, runId: row.runId, taskId: row.taskId, attemptId: row.attemptId, aggregateRevision: status?.rowRevision ?? 0, type: 'terminal.control_ended', actor: { kind: 'human', id: row.ownerUid }, payload: { sessionId: row.sessionId, reason: 'server_restarted', inputs: row.inputCount, withheld: row.withheldCount } });
      });
    }
  }

  stop(): void {
    this.closing = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of [...this.sessions.values()]) this.end(s, 'server_shutdown');
    for (const link of [...this.links.values()]) link.ws.close(WS_NORMAL);
    this.links.clear();
    for (const c of this.clientServer.clients) c.terminate();
    for (const c of this.linkServer.clients) c.terminate();
    this.clientServer.close();
    this.linkServer.close();
  }

  /** Reads for tests. */
  debug(): { sessions: number; links: number } {
    return { sessions: this.sessions.size, links: this.links.size };
  }
}

const REFUSALS: Readonly<Record<ControlRefusal, AppError>> = {
  ticket_invalid: new AppError(403, 'policy_denied', 'the ticket is not valid'),
  origin_refused: new AppError(403, 'origin_not_allowed', 'origin is not on the allowlist'),
  policy_denied: new AppError(403, 'policy_denied', 'policy does not allow control mode for this project', { reason: 'terminal_control' }),
  trial: new AppError(403, 'control_refused_trial', 'a benchmark trial never takes human input'),
  restricted: new AppError(403, 'terminal_restricted', 'control mode is not available for restricted or secret work'),
  attempt_not_running: new AppError(409, 'attempt_not_running', 'this attempt is not running'),
  session_active: new AppError(409, 'control_session_active', 'someone is already in control of this attempt'),
  unavailable: new AppError(409, 'control_unavailable', 'this worker cannot take a control session right now'),
  too_long: new AppError(422, 'invalid_request', 'input is too long'),
  rate_limited: new AppError(429, 'invalid_request', 'too much input'),
};

/** Mints the ticket. `Authorization` carries the owner's token, so a website with no way to read it cannot call this; `Origin` is required as well, so the ticket is bound to the page that asked. */
export function registerControlRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const control = ctx.control;

  app.post('/v1/projects/:id/attempts/:attemptId/terminal/control-tickets', { onRequest: [ctx.owner] }, async (req, reply) => {
    if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
    const uid = req.principal.uid;
    const origin = req.corsOrigin;
    if (origin === null) throw new AppError(403, 'origin_required', 'a ticket is only minted for a browser origin on the allowlist');
    const { id: projectId, attemptId } = req.params as { id: string; attemptId: string };
    const body = parseBody(ControlTicketRequestSchema, req.body);
    await requireProject(db, config.tenantId, projectId);
    const at = now();
    const expiresAt = new Date(at.getTime() + control.limits.ticketTtlMs);
    const ticket = `srct_${randomBytes(32).toString('base64url')}`;

    const sessionId = await withTx(db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.control:${config.tenantId}:${projectId}:${attemptId}`}, 0))`);
      const key = { tenantId: config.tenantId, projectId, key: `control.ticket:${attemptId}:${body.idempotencyKey}` };
      const stored = await idempotent(tx, key, fingerprint({ attemptId, origin }), async () => {
        // A ticket nobody used has lapsed, and is no reason to refuse the next one.
        await tx.update(schema.controlSessions).set({ state: 'expired', endedAt: at, endReason: 'ticket_lapsed' }).where(and(
          eq(schema.controlSessions.tenantId, config.tenantId), eq(schema.controlSessions.projectId, projectId), eq(schema.controlSessions.attemptId, attemptId),
          eq(schema.controlSessions.state, 'minted'), sql`${schema.controlSessions.ticketExpiresAt} <= ${at.toISOString()}::timestamptz`));
        const gate = await control.gate(tx, projectId, attemptId, at);
        if ('refused' in gate) throw REFUSALS[gate.refused];
        const open = await tx.select({ sessionId: schema.controlSessions.sessionId }).from(schema.controlSessions).where(and(
          eq(schema.controlSessions.tenantId, config.tenantId), eq(schema.controlSessions.projectId, projectId), eq(schema.controlSessions.attemptId, attemptId), sql`state IN ('minted', 'active')`));
        if (open.length > 0) throw REFUSALS.session_active;
        if (!control.hasLink(attemptId, gate.attempt.runner, gate.attempt.leaseFence)) throw REFUSALS.unavailable;
        const newSession = newId('ctl');
        await tx.insert(schema.controlSessions).values({
          tenantId: config.tenantId, projectId, sessionId: newSession, attemptId, runId: gate.runId, taskId: gate.attempt.taskId, revision: gate.attempt.revision,
          runner: gate.attempt.runner!, leaseFence: gate.attempt.leaseFence!, ownerUid: uid, origin, ticketHash: sha256Hex(ticket), ticketExpiresAt: expiresAt, state: 'minted',
        });
        return { sessionId: newSession };
      });
      // A retry cannot be handed the ticket from the first answer, because only its hash was stored. It gets a fresh one, which replaces the first and is still single-use.
      const updated = await tx.update(schema.controlSessions).set({ ticketHash: sha256Hex(ticket), ticketExpiresAt: expiresAt, origin }).where(and(
        eq(schema.controlSessions.tenantId, config.tenantId), eq(schema.controlSessions.projectId, projectId), eq(schema.controlSessions.sessionId, stored.sessionId), eq(schema.controlSessions.state, 'minted'))).returning({ sessionId: schema.controlSessions.sessionId });
      if (updated.length === 0) throw new AppError(409, 'control_ticket_used', 'this ticket has already been used');
      return stored.sessionId;
    });
    return reply.code(201).header('cache-control', 'no-store').send({ sessionId, ticket, expiresAt: expiresAt.toISOString() });
  });
}
