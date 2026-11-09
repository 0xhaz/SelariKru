import { CONTROL_MAX_LINK_BATCH_LINES, CONTROL_MAX_LINK_FRAME_BYTES, ControlDownFrameSchema, TerminalRedactor, redactSecrets, type ControlDownFrame, type ControlShell, type ControlUpFrame, type LeaseRef, type RuntimeAdapter, type SandboxHandle, type TerminalLine } from '@selarikru/protocol';
import { WebSocket } from 'ws';
import { assertSafeApiUrl } from './api.ts';
import { DEFAULT_TERMINAL_FEED_LIMITS, type TerminalFeedLimits } from './terminal.ts';

/** One outbound connection to the control API. `sendable` is false when the connection cannot take more: output waits, never input. */
export interface ControlConnection {
  send(frame: ControlUpFrame): void;
  readonly sendable: boolean;
  close(): void;
}

export interface ControlHandlers {
  onFrame(frame: ControlDownFrame): void;
  onClose(): void;
}

/** How the bridge reaches the API. A test stands in here; production is the WebSocket below. */
export type ControlConnector = (handlers: ControlHandlers) => Promise<ControlConnection>;

export interface ControlDeps {
  /** Builds the connector for one attempt's lease. */
  readonly connectorFor: (lease: LeaseRef) => ControlConnector;
  /** Default limits suit production. */
  readonly limits?: Partial<ControlLimits>;
}

export interface ControlLimits extends Pick<TerminalFeedLimits, 'maxLines' | 'maxBytes' | 'flushMs'> {
  /** Quiet this long, and a prompt with no newline is released so a person can see it. */
  readonly promptMs: number;
  readonly reconnectMs: number;
  /** Longest closing a shell can hold up the end of an attempt. */
  readonly closeMs: number;
}

export const DEFAULT_CONTROL_LIMITS: ControlLimits = { maxLines: DEFAULT_TERMINAL_FEED_LIMITS.maxLines, maxBytes: DEFAULT_TERMINAL_FEED_LIMITS.maxBytes, flushMs: 80, promptMs: 150, reconnectMs: 2_000, closeMs: 8_000 };

/** The runner's outbound WebSocket to the API. The runner token goes in a header it can set; the lease goes in the first message; neither is in a URL. */
export function wsControlConnector(apiBaseUrl: string, token: string): (lease: LeaseRef) => ControlConnector {
  const base = assertSafeApiUrl(apiBaseUrl);
  const wsUrl = new URL('/v1/runners/control-link', base);
  wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return (lease) => (handlers) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` }, maxPayload: CONTROL_MAX_LINK_FRAME_BYTES, perMessageDeflate: false });
      let opened = false;
      ws.once('open', () => {
        opened = true;
        ws.send(JSON.stringify({ type: 'hello', lease }));
        resolve({
          send: (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); },
          get sendable() { return ws.readyState === ws.OPEN && ws.bufferedAmount < 1024 * 1024; },
          close: () => ws.close(),
        });
      });
      ws.on('message', (data: Buffer) => {
        let body: unknown;
        try {
          body = JSON.parse(data.toString());
        } catch {
          return;
        }
        const frame = ControlDownFrameSchema.safeParse(body);
        if (frame.success) handlers.onFrame(frame.data);
      });
      ws.on('error', (err: Error) => { if (!opened) reject(err); });
      ws.on('close', () => { if (!opened) reject(new Error('control link closed before opening')); handlers.onClose(); });
    });
}

interface ActiveShell {
  readonly sessionId: string;
  readonly shell: ControlShell;
}

/**
 * One attempt's control channel on the runner. Opens no port: it dials out, holds one connection, and hosts at most one shell, in this attempt's own sandbox. Output takes the same redactor and the
 * same bounds as the worker's output and is never written anywhere here, and it stops the moment the attempt stops.
 */
export class ControlBridge {
  private connection: ControlConnection | null = null;
  private active: ActiveShell | null = null;
  private stopped = false;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private readonly limits: ControlLimits;
  private redactor = new TerminalRedactor();
  private pending: TerminalLine[] = [];
  private pendingBytes = 0;
  private dropped = 0;
  private flush: ReturnType<typeof setTimeout> | null = null;
  private prompt: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly deps: { readonly connect: ControlConnector; readonly runtime: RuntimeAdapter; readonly handle: SandboxHandle; readonly log: (line: string) => void; readonly limits?: Partial<ControlLimits> },
  ) {
    this.limits = { ...DEFAULT_CONTROL_LIMITS, ...deps.limits };
  }

  /** Non-blocking: the attempt never waits on this. */
  start(): void {
    void this.dial();
  }

  private async dial(): Promise<void> {
    if (this.stopped) return;
    try {
      this.connection = await this.deps.connect({ onFrame: (f) => this.onFrame(f), onClose: () => this.onClosed() });
      if (this.stopped) { this.connection.close(); this.connection = null; }
    } catch {
      this.onClosed();
    }
  }

  private onClosed(): void {
    this.connection = null;
    this.endShell();
    if (this.stopped || this.reconnect !== null) return;
    this.reconnect = setTimeout(() => { this.reconnect = null; void this.dial(); }, this.limits.reconnectMs);
    this.reconnect.unref?.();
  }

  private send(frame: ControlUpFrame): void {
    if (!this.stopped) this.connection?.send(frame);
  }

  private onFrame(frame: ControlDownFrame): void {
    if (this.stopped || frame.type === 'linked') return;
    if (frame.type === 'open') { void this.open(frame.sessionId); return; }
    if (this.active?.sessionId !== frame.sessionId) return;
    if (frame.type === 'input') this.active.shell.input(frame.seq, frame.data);
    else this.endShell();
  }

  private async open(sessionId: string): Promise<void> {
    if (this.active !== null) { this.send({ type: 'shell_ended', sessionId, unavailable: true }); return; }
    const shell = await this.deps.runtime.openControlShell?.(this.deps.handle, sessionId).catch(() => null);
    if (!shell) { this.send({ type: 'shell_ended', sessionId, unavailable: true }); return; }
    if (this.stopped || this.active !== null) { await shell.close().catch(() => undefined); return; }
    this.active = { sessionId, shell };
    this.redactor = new TerminalRedactor();
    this.deps.log('control session opened');
    void this.pump(this.active);
  }

  private async pump(active: ActiveShell): Promise<void> {
    const { shell, sessionId } = active;
    let opened = false;
    const open = (echo: boolean | null): void => {
      if (opened) return;
      opened = true;
      this.send({ type: 'opened', sessionId, echo });
    };
    try {
      for await (const ev of shell.events) {
        if (this.active !== active) break;
        switch (ev.kind) {
          case 'echo':
            open(ev.on);
            this.send({ type: 'echo', sessionId, on: ev.on });
            break;
          case 'output':
            open(null);
            this.onOutput(sessionId, ev.text);
            break;
          case 'ack':
            this.send({ type: 'ack', sessionId, seq: ev.seq, echo: ev.echo });
            break;
          case 'exited':
            this.append(this.redactor.flush());
            this.flushNow(sessionId);
            this.send({ type: 'shell_ended', sessionId, unavailable: !opened });
            this.endShell();
            return;
        }
      }
    } catch (err) {
      this.deps.log(`control shell failed: ${redactSecrets(err instanceof Error ? err.message : 'error')}`);
      this.append(this.redactor.flush());
      this.flushNow(sessionId);
      this.send({ type: 'shell_ended', sessionId, unavailable: !opened });
      this.endShell();
    }
  }

  /** Synchronous and non-throwing: a slow API costs oldest lines, counted, and never the shell's own output. */
  private onOutput(sessionId: string, text: string): void {
    this.append(this.redactor.write(text));
    this.schedule(sessionId);
    if (this.prompt !== null) clearTimeout(this.prompt);
    this.prompt = setTimeout(() => {
      this.prompt = null;
      const released = this.redactor.releasePrompt();
      if (released !== null) { this.append([released]); this.schedule(sessionId); }
    }, this.limits.promptMs);
    this.prompt.unref?.();
  }

  private append(lines: readonly string[]): void {
    const at = new Date().toISOString();
    for (const text of lines) {
      this.pending.push({ at, text });
      this.pendingBytes += text.length;
      while (this.pending.length > this.limits.maxLines || this.pendingBytes > this.limits.maxBytes) {
        this.pendingBytes -= this.pending.shift()!.text.length;
        this.dropped += 1;
      }
    }
  }

  private schedule(sessionId: string): void {
    if (this.flush !== null) return;
    this.flush = setTimeout(() => { this.flush = null; this.flushNow(sessionId); }, this.limits.flushMs);
    this.flush.unref?.();
  }

  private flushNow(sessionId: string): void {
    if (this.flush !== null) { clearTimeout(this.flush); this.flush = null; }
    if (this.connection === null || !this.connection.sendable) { if (this.pending.length > 0) this.schedule(sessionId); return; }
    if (this.pending.length === 0 && this.dropped === 0) return;
    const lines = this.pending.splice(0, CONTROL_MAX_LINK_BATCH_LINES);
    for (const l of lines) this.pendingBytes -= l.text.length;
    this.send({ type: 'output', sessionId, lines, dropped: this.dropped });
    this.dropped = 0;
    if (this.pending.length > 0) this.schedule(sessionId);
  }

  private endShell(): void {
    const active = this.active;
    this.active = null;
    if (this.prompt !== null) { clearTimeout(this.prompt); this.prompt = null; }
    if (active !== null) void active.shell.close().catch(() => undefined);
  }

  /** The attempt is stopping: close the shell and the link, bounded, so a stuck `sbx exec` cannot hold up the attempt's own result. Idempotent. */
  shutdown(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.stopped = true;
    if (this.reconnect !== null) clearTimeout(this.reconnect);
    this.reconnect = null;
    const active = this.active;
    this.active = null;
    if (this.flush !== null) { clearTimeout(this.flush); this.flush = null; }
    if (this.prompt !== null) { clearTimeout(this.prompt); this.prompt = null; }
    this.connection?.close();
    this.connection = null;
    const closed = active !== null ? active.shell.close().catch(() => undefined) : Promise.resolve();
    this.closing = Promise.race([closed, new Promise<void>((r) => { const t = setTimeout(r, this.limits.closeMs); t.unref?.(); })]);
    return this.closing;
  }
}
