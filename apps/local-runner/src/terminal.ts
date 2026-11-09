import { TerminalRedactor, type LeaseRef, type NormalizedHarnessEvent, type TerminalLine } from '@selarikru/protocol';
import { LeaseLostError, type RunnerApi } from './api.ts';

/** What is held waiting for upload, and how often it goes. The whole feed is bounded: a slow control plane costs lines, never the worker's time. */
export interface TerminalFeedLimits {
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly batchLines: number;
  readonly flushMs: number;
  readonly keepaliveMs: number;
  /** Longest the end-of-attempt flush can hold up publishing the result. */
  readonly closeMs: number;
}

export const DEFAULT_TERMINAL_FEED_LIMITS: TerminalFeedLimits = { maxLines: 500, maxBytes: 256 * 1024, batchLines: 100, flushMs: 200, keepaliveMs: 10_000, closeMs: 3_000 };

/** The most a single tool argument or result contributes to one event's preview. */
export const TERMINAL_PREVIEW_CHARS = 4000;

const bytes = (l: TerminalLine): number => l.text.length;

/** A compact view of a tool call: the argument that identifies it, else its JSON. */
function toolArgument(preview: string | undefined): string {
  if (preview === undefined) return '';
  try {
    const input = JSON.parse(preview) as Record<string, unknown>;
    const main = input['command'] ?? input['file_path'] ?? input['path'] ?? input['pattern'];
    return typeof main === 'string' ? ` ${main}` : ` ${preview}`;
  } catch {
    return ` ${preview}`;
  }
}

/** How a harness event reads as a line of output. Null: it has no place in the terminal. */
function render(ev: NormalizedHarnessEvent): { readonly key: string; readonly text: string } | null {
  switch (ev.type) {
    case 'message': return ev.role === 'assistant' && ev.preview ? { key: 'text', text: ev.preview } : null;
    case 'tool_call': return { key: `tool:${ev.seq}`, text: `> ${ev.toolName ?? 'tool'}${toolArgument(ev.preview)}\n` };
    case 'tool_result': return { key: `result:${ev.toolUseId ?? ev.seq}`, text: `${ev.status === 'error' ? '[error]' : '[ok]'}${ev.preview ? `\n${ev.preview}` : ''}\n` };
    case 'result': return { key: `done:${ev.seq}`, text: `Finished: ${ev.subtype ?? 'unknown'}${ev.terminalReason ? ` (${ev.terminalReason})` : ''}\n` };
    case 'exit': return { key: `exit:${ev.seq}`, text: `Agent exited with code ${ev.code ?? 'none'}${ev.signal ? `, signal ${ev.signal}` : ''}\n` };
    case 'stream_error': return { key: `err:${ev.seq}`, text: 'The agent output stream failed\n' };
    case 'ended_without_result': return { key: `err:${ev.seq}`, text: 'The agent ended without a result\n' };
    default: return null;
  }
}

/**
 * The output channel for one attempt. Fed synchronously from the harness loop (a push to a bounded array, never a network wait), it uploads in the background, one batch at a
 * time: a stalled control plane fills this buffer and then costs the oldest lines, which are counted and reported on the next upload that gets through. Nothing here can make
 * the harness wait. Lines are redacted before they are buffered, so nothing unredacted ever reaches the upload path.
 */
export class TerminalFeed {
  private readonly redactor = new TerminalRedactor();
  private readonly pending: TerminalLine[] = [];
  private pendingBytes = 0;
  private dropped = 0;
  private key: string | null = null;
  private seq = 0;
  private inFlight: Promise<void> | null = null;
  private retry: { readonly seq: number; readonly lines: TerminalLine[]; readonly dropped: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private closing = false;

  constructor(
    private readonly api: Pick<RunnerApi, 'terminal'>,
    private readonly lease: LeaseRef,
    private readonly log: (line: string) => void,
    private readonly limits: TerminalFeedLimits = DEFAULT_TERMINAL_FEED_LIMITS,
  ) {}

  /** Opens the channel with an empty batch, so "connected, no output yet" is a fact the control plane knows. */
  start(): void {
    this.keepalive = setInterval(() => this.schedule(0, true), this.limits.keepaliveMs);
    this.keepalive.unref?.();
    this.schedule(0, true);
  }

  /** Synchronous and non-throwing: whatever goes wrong here, the attempt carries on. */
  onEvent(ev: NormalizedHarnessEvent): void {
    if (this.stopped) return;
    try {
      const r = render(ev);
      if (r === null) return;
      // A run of output ends when the source changes: that is what releases a last line that has no newline.
      if (this.key !== null && this.key !== r.key) this.append(this.redactor.flush());
      this.key = r.key;
      this.append(this.redactor.write(r.text));
      this.schedule(this.limits.flushMs);
    } catch (err) {
      this.stopped = true;
      this.log(`terminal feed stopped: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  private append(lines: readonly string[]): void {
    const at = new Date().toISOString();
    for (const text of lines) {
      const line = { at, text };
      this.pending.push(line);
      this.pendingBytes += bytes(line);
      while (this.pending.length > this.limits.maxLines || this.pendingBytes > this.limits.maxBytes) {
        this.pendingBytes -= bytes(this.pending.shift()!);
        this.dropped += 1;
      }
    }
  }

  private schedule(ms: number, force = false): void {
    if (this.stopped || this.closing || this.timer !== null) return;
    if (this.inFlight !== null) return;
    if (this.pending.length === 0 && this.retry === null && !force) return;
    this.timer = setTimeout(() => { this.timer = null; void this.upload(); }, ms);
    this.timer.unref?.();
  }

  private upload(): Promise<void> {
    if (this.stopped || this.inFlight !== null) return this.inFlight ?? Promise.resolve();
    const lines = this.retry?.lines ?? this.pending.splice(0, this.limits.batchLines);
    if (this.retry === null) for (const l of lines) this.pendingBytes -= bytes(l);
    const dropped = this.retry?.dropped ?? this.dropped;
    const batch = this.retry ?? { seq: this.seq, lines, dropped };
    if (this.retry === null) { this.seq += 1; this.dropped = 0; }
    const work = this.api
      .terminal(this.lease, { seq: batch.seq, lines: batch.lines, dropped: batch.dropped, ended: false })
      .then(() => { this.retry = null; })
      .catch((err: unknown) => {
        if (err instanceof LeaseLostError) { this.stopped = true; return; }
        this.retry = batch;
      })
      .finally(() => {
        this.inFlight = null;
        if (this.retry !== null) { this.schedule(2000); return; }
        if (this.pending.length > 0) this.schedule(this.limits.flushMs);
      });
    this.inFlight = work;
    return work;
  }

  /** The end of the attempt: release what is held and say the channel ended. Bounded, so the result is never held up for long. */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.closing = true;
    this.append(this.redactor.flush());
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.keepalive !== null) { clearInterval(this.keepalive); this.keepalive = null; }
    const finish = async (): Promise<void> => {
      await this.inFlight;
      for (let i = 0; i < this.limits.maxLines && !this.stopped && (this.pending.length > 0 || this.retry !== null); i += 1) await this.upload();
      if (!this.stopped) {
        await this.api.terminal(this.lease, { seq: this.seq, lines: [], dropped: this.dropped, ended: true }).catch(() => undefined);
      }
    };
    await Promise.race([finish(), new Promise<void>((res) => { const t = setTimeout(res, this.limits.closeMs); t.unref?.(); })]);
    this.abort();
  }

  /** Stops the channel with no flush. */
  abort(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.timer = null;
    this.keepalive = null;
  }
}
