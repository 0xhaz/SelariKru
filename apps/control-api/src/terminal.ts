import { TerminalRedactor, isTerminalStreamable, type TerminalUploadRequest } from '@selarikru/protocol';
import { schema } from '@selarikru/persistence';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './app.ts';
import { AppError } from './errors.ts';
import { loadSpecRow, requireProject } from './store.ts';

/**
 * Live worker output. Deliberately not domain state: it is held only in this process, per attempt, in a bounded buffer with short retention, and never reaches the events table,
 * an artifact, evidence or a log.
 *
 * Retention: the last `maxLines` lines (at most `maxBytes`) of each attempt, kept until `retentionMs` after its last upload, and for at most `maxAttempts` attempts at once (oldest
 * first out). A restart empties it.
 */
export interface TerminalHubLimits {
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly retentionMs: number;
  readonly maxAttempts: number;
  /** Frames queued per client before the oldest line is dropped for that client. */
  readonly clientQueueLines: number;
  readonly clientQueueBytes: number;
  /** A channel the runner has not touched for this long is no longer live. */
  readonly silenceMs: number;
  /** A client that has not drained for this long is disconnected. */
  readonly stalledClientMs: number;
  /** Longest one owner session stays open: the token was only checked when it opened. */
  readonly maxSessionMs: number;
  readonly maxSessionsPerAttempt: number;
  readonly sweepMs: number;
}

export const DEFAULT_TERMINAL_HUB_LIMITS: TerminalHubLimits = {
  maxLines: 500, maxBytes: 256 * 1024, retentionMs: 5 * 60_000, maxAttempts: 32,
  clientQueueLines: 500, clientQueueBytes: 256 * 1024, silenceMs: 30_000, stalledClientMs: 60_000, maxSessionMs: 30 * 60_000, maxSessionsPerAttempt: 8, sweepMs: 5_000,
};

export type TerminalStatus = 'live' | 'ended' | 'disconnected' | 'unavailable';
export type TerminalStateReason = 'no_channel' | 'expired' | 'runner_silent' | 'session_expired' | null;

interface StoredLine { readonly n: number; readonly at: string; readonly text: string }
interface Frame { readonly chunk: string; readonly droppable: boolean; readonly size: number }

/** The output sink of an SSE client. Only `write` and `once('drain')` are used, so a test can stand in for the socket. */
export interface TerminalSocket {
  write(chunk: string): boolean;
  once(event: 'drain', listener: () => void): unknown;
}

const lineFrame = (l: StoredLine): Frame => {
  const chunk = `id: ${l.n}\nevent: line\ndata: ${JSON.stringify({ n: l.n, at: l.at, text: l.text })}\n\n`;
  return { chunk, droppable: true, size: chunk.length };
};
const stateFrame = (state: { status: TerminalStatus; reason: TerminalStateReason; lastLineAt: string | null; dropped: number }): Frame => {
  const chunk = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  return { chunk, droppable: false, size: chunk.length };
};

/**
 * One connected client: a bounded queue in front of a socket. Enqueue never waits. When the socket pushes back, frames wait in the queue; when the queue is full the oldest line is
 * dropped for this client only, and the next frame the client does get says how many were lost. A slow browser can only ever slow itself.
 */
export class TerminalClient {
  private readonly queue: Frame[] = [];
  private queuedBytes = 0;
  private droppedSinceNotice = 0;
  /** Set while the socket has refused more. */
  private waitingSinceMs: number | null = null;
  closed = false;

  constructor(
    private readonly socket: TerminalSocket,
    private readonly limits: Pick<TerminalHubLimits, 'clientQueueLines' | 'clientQueueBytes'>,
    private readonly nowMs: () => number,
  ) {}

  /** Lines this client has lost that have been reported to it. */
  droppedTotal = 0;
  get queuedLines(): number { return this.queue.length; }
  get stalledForMs(): number | null { return this.waitingSinceMs === null ? null : this.nowMs() - this.waitingSinceMs; }

  enqueue(frame: Frame): void {
    if (this.closed) return;
    this.queue.push(frame);
    this.queuedBytes += frame.size;
    while (this.queue.length > this.limits.clientQueueLines || this.queuedBytes > this.limits.clientQueueBytes) {
      const i = this.queue.findIndex((f) => f.droppable);
      if (i < 0) break;
      this.queuedBytes -= this.queue[i]!.size;
      this.queue.splice(i, 1);
      this.droppedSinceNotice += 1;
      this.droppedTotal += 1;
    }
    this.pump();
  }

  private pump(): void {
    while (this.waitingSinceMs === null && !this.closed && (this.droppedSinceNotice > 0 || this.queue.length > 0)) {
      let chunk: string;
      if (this.droppedSinceNotice > 0) {
        chunk = `event: dropped\ndata: ${JSON.stringify({ count: this.droppedSinceNotice })}\n\n`;
        this.droppedSinceNotice = 0;
      } else {
        const frame = this.queue.shift()!;
        this.queuedBytes -= frame.size;
        chunk = frame.chunk;
      }
      if (this.socket.write(chunk)) continue;
      this.waitingSinceMs = this.nowMs();
      this.socket.once('drain', () => {
        this.waitingSinceMs = null;
        this.pump();
      });
    }
  }

  /** The sender's half of the keepalive: skipped while the socket is full, because silence is then already explained. */
  keepalive(): void {
    if (this.waitingSinceMs !== null || this.closed) return;
    this.socket.write(': keepalive\n\n');
  }

  stateFrame(state: Parameters<typeof stateFrame>[0]): void {
    this.enqueue(stateFrame(state));
  }
}

interface AttemptChannel {
  readonly projectId: string;
  readonly redactor: TerminalRedactor;
  readonly lines: StoredLine[];
  bytes: number;
  next: number;
  lastSeq: number;
  lastUploadMs: number;
  lastLineAt: string | null;
  dropped: number;
  ended: boolean;
  silent: boolean;
  readonly clients: Set<TerminalAttachment>;
}

export interface TerminalAttachment {
  readonly client: TerminalClient;
  /** Closes the client and detaches it. Idempotent. */
  close(): void;
}

export class TerminalHub {
  private readonly channels = new Map<string, AttemptChannel>();
  /** Clients waiting on an attempt that has no channel yet. */
  private readonly waiting = new Map<string, { readonly projectId: string; readonly clients: Set<TerminalAttachment> }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly nowMs: () => number,
    readonly limits: TerminalHubLimits = DEFAULT_TERMINAL_HUB_LIMITS,
  ) {}

  startSweeper(): void {
    this.sweepTimer = setInterval(() => this.sweep(), this.limits.sweepMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const key of [...this.channels.keys()]) this.dropChannel(key, null);
    for (const w of [...this.waiting.values()]) for (const a of [...w.clients]) a.close();
    this.waiting.clear();
  }

  /** The current shape of a channel: never `live` unless a runner is actually uploading. */
  private statusOf(c: AttemptChannel | undefined): { status: TerminalStatus; reason: TerminalStateReason; lastLineAt: string | null; dropped: number } {
    if (!c) return { status: 'unavailable', reason: 'no_channel', lastLineAt: null, dropped: 0 };
    if (c.ended) return { status: 'ended', reason: null, lastLineAt: c.lastLineAt, dropped: c.dropped };
    if (c.silent) return { status: 'disconnected', reason: 'runner_silent', lastLineAt: c.lastLineAt, dropped: c.dropped };
    return { status: 'live', reason: null, lastLineAt: c.lastLineAt, dropped: c.dropped };
  }

  /** Applies one upload. Synchronous, and cannot wait on any client. The runner's lines have already been redacted; this reads them through a second redactor anyway. */
  publish(projectId: string, attemptId: string, batch: Pick<TerminalUploadRequest, 'seq' | 'lines' | 'dropped' | 'ended'>): void {
    const now = this.nowMs();
    let channel = this.channels.get(attemptId);
    const created = channel === undefined;
    if (!channel) {
      channel = this.createChannel(projectId, attemptId, now);
    }
    if (channel.projectId !== projectId) return;
    const wasSilent = channel.silent;
    const wasEnded = channel.ended;
    channel.lastUploadMs = now;
    channel.silent = false;
    if (batch.seq <= channel.lastSeq) {
      if (wasSilent) this.broadcastState(channel);
      return; // A retry of an upload already applied.
    }
    channel.lastSeq = batch.seq;
    channel.dropped += batch.dropped;
    for (const line of batch.lines) {
      for (const text of channel.redactor.write(`${line.text}\n`)) this.addLine(channel, line.at, text);
    }
    if (batch.ended) {
      const last = batch.lines.at(-1)?.at ?? new Date(now).toISOString();
      for (const text of channel.redactor.flush()) this.addLine(channel, last, text);
      channel.ended = true;
    }
    if (created || wasSilent || batch.dropped > 0 || channel.ended !== wasEnded) this.broadcastState(channel);
  }

  private createChannel(projectId: string, attemptId: string, now: number): AttemptChannel {
    while (this.channels.size >= this.limits.maxAttempts) {
      const oldest = [...this.channels.entries()].sort(([, a], [, b]) => Number(b.ended) - Number(a.ended) || a.lastUploadMs - b.lastUploadMs)[0];
      if (!oldest) break;
      this.dropChannel(oldest[0], 'expired');
    }
    const channel: AttemptChannel = { projectId, redactor: new TerminalRedactor(), lines: [], bytes: 0, next: 1, lastSeq: -1, lastUploadMs: now, lastLineAt: null, dropped: 0, ended: false, silent: false, clients: new Set() };
    this.channels.set(attemptId, channel);
    const waiters = this.waiting.get(attemptId);
    if (waiters && waiters.projectId === projectId) {
      for (const a of waiters.clients) channel.clients.add(a);
      this.waiting.delete(attemptId);
    }
    return channel;
  }

  private addLine(channel: AttemptChannel, at: string, text: string): void {
    const line = { n: channel.next, at, text };
    channel.next += 1;
    channel.lastLineAt = at;
    channel.lines.push(line);
    channel.bytes += text.length;
    while (channel.lines.length > this.limits.maxLines || channel.bytes > this.limits.maxBytes) channel.bytes -= channel.lines.shift()!.text.length;
    const frame = lineFrame(line);
    for (const a of channel.clients) a.client.enqueue(frame);
  }

  private broadcastState(channel: AttemptChannel): void {
    const state = this.statusOf(channel);
    for (const a of channel.clients) a.client.stateFrame(state);
  }

  /** The attempt's result was accepted: whatever the runner last sent, the channel has ended. */
  markEnded(attemptId: string): void {
    const channel = this.channels.get(attemptId);
    if (!channel || channel.ended) return;
    channel.lastUploadMs = this.nowMs();
    channel.ended = true;
    channel.silent = false;
    this.broadcastState(channel);
  }

  /** Called before the response is committed, so a refusal can still be an HTTP error. */
  admit(projectId: string, attemptId: string): void {
    const channel = this.channels.get(attemptId);
    if (channel && channel.projectId !== projectId) throw new AppError(404, 'attempt_not_found', 'no such attempt in this project');
    const count = channel?.clients.size ?? this.waiting.get(attemptId)?.clients.size ?? 0;
    if (count >= this.limits.maxSessionsPerAttempt) throw new AppError(429, 'too_many_terminal_sessions', 'too many terminal sessions for this attempt');
  }

  /** Registers a client, replays what is retained, and tells it the channel's state. A client on an attempt with no channel waits for one and is told so. */
  attach(projectId: string, attemptId: string, socket: TerminalSocket, onClose: () => void): TerminalAttachment {
    const channel = this.channels.get(attemptId);
    const client = new TerminalClient(socket, this.limits, this.nowMs);
    let closed = false;
    const attachment: TerminalAttachment = {
      client,
      close: () => {
        if (closed) return;
        closed = true;
        client.closed = true;
        channel?.clients.delete(attachment);
        this.channels.get(attemptId)?.clients.delete(attachment);
        const w = this.waiting.get(attemptId);
        if (w) { w.clients.delete(attachment); if (w.clients.size === 0) this.waiting.delete(attemptId); }
        onClose();
      },
    };
    client.stateFrame(this.statusOf(channel));
    if (channel) {
      channel.clients.add(attachment);
      for (const line of channel.lines) client.enqueue(lineFrame(line));
    } else {
      const entry = this.waiting.get(attemptId) ?? { projectId, clients: new Set<TerminalAttachment>() };
      entry.clients.add(attachment);
      this.waiting.set(attemptId, entry);
    }
    return attachment;
  }

  /** Drops expired channels, marks silent ones, and cuts loose clients that stopped reading. */
  sweep(): void {
    const now = this.nowMs();
    for (const [attemptId, channel] of [...this.channels]) {
      for (const a of [...channel.clients]) {
        const stalled = a.client.stalledForMs;
        if (stalled !== null && stalled >= this.limits.stalledClientMs) a.close();
      }
      if (now - channel.lastUploadMs >= this.limits.retentionMs) { this.dropChannel(attemptId, 'expired'); continue; }
      if (!channel.ended && !channel.silent && now - channel.lastUploadMs >= this.limits.silenceMs) {
        channel.silent = true;
        this.broadcastState(channel);
      }
    }
  }

  private dropChannel(attemptId: string, reason: TerminalStateReason): void {
    const channel = this.channels.get(attemptId);
    if (!channel) return;
    this.channels.delete(attemptId);
    for (const a of [...channel.clients]) {
      if (reason) a.client.stateFrame({ status: 'unavailable', reason, lastLineAt: channel.lastLineAt, dropped: channel.dropped });
      a.close();
    }
  }

  /** Reads for tests. */
  debugChannel(attemptId: string): { lines: number; ended: boolean } | null {
    const c = this.channels.get(attemptId);
    return c ? { lines: c.lines.length, ended: c.ended } : null;
  }
}

const refused = (): AppError => new AppError(403, 'terminal_restricted', 'live output is not available for restricted or secret work');

/** Whether a project's and a task's classification both allow output to leave the runner. Anything unreadable fails closed. */
export async function streamableAttempt(ctx: Pick<AppContext, 'db' | 'config'>, key: { projectId: string; taskId: string; revision: number; projectClassification: unknown }): Promise<boolean> {
  if (!isTerminalStreamable(key.projectClassification)) return false;
  const spec = (await loadSpecRow(ctx.db, { tenantId: ctx.config.tenantId, projectId: key.projectId, taskId: key.taskId, revision: key.revision }))?.spec as { classification?: unknown } | undefined;
  return isTerminalStreamable(spec?.classification);
}

/** The owner's read of one attempt's live output: an SSE stream authenticated by the Authorization header, scoped to the project the attempt belongs to. */
export function registerTerminalRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const hub = ctx.terminal;

  app.get('/v1/projects/:id/attempts/:attemptId/terminal', { onRequest: [ctx.owner] }, async (req, reply) => {
    const { id: projectId, attemptId } = req.params as { id: string; attemptId: string };
    const project = await requireProject(db, config.tenantId, projectId);
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, config.tenantId), eq(schema.attempts.projectId, projectId), eq(schema.attempts.attemptId, attemptId)));
    if (!attempt) throw new AppError(404, 'attempt_not_found', 'no such attempt in this project');
    if (!(await streamableAttempt(ctx, { projectId, taskId: attempt.taskId, revision: attempt.revision, projectClassification: project.classification }))) throw refused();
    if (ctx.lifecycle.closing) throw new AppError(503, 'shutting_down', 'the server is shutting down');

    hub.admit(projectId, attemptId);
    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...ctx.corsHeaders(req.corsOrigin) });
    raw.write(': terminal open\n\n');
    const attachment = hub.attach(projectId, attemptId, raw, () => {
      ctx.openStreams.delete(closeStream);
      raw.end();
    });

    const keepalive = setInterval(() => attachment.client.keepalive(), config.sse.keepAliveMs);
    keepalive.unref?.();
    const expiry = setTimeout(() => {
      attachment.client.stateFrame({ status: 'disconnected', reason: 'session_expired', lastLineAt: null, dropped: 0 });
      closeStream();
    }, hub.limits.maxSessionMs);
    expiry.unref?.();
    function closeStream(): void {
      clearInterval(keepalive);
      clearTimeout(expiry);
      attachment.close();
    }
    ctx.openStreams.add(closeStream);
    req.raw.on('close', closeStream);
    if (ctx.lifecycle.closing) closeStream();
  });
}
