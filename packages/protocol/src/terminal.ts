import { sanitizeTerminalText } from '@selarikru/domain';
import { redactSecrets } from './redact.ts';

/** Longest line kept after redaction; a longer one is cut, so a single line can never carry the whole retained budget. */
export const TERMINAL_MAX_LINE_CHARS = 2000;
export const TERMINAL_MAX_BATCH_LINES = 100;
/** A buffer this long with no newline is not a line: it is discarded whole, never released in pieces, so no part of a secret can escape past the line boundary. */
const MAX_HOLD_CHARS = 64 * 1024;
/** How many lines after an unclosed `BEGIN PRIVATE KEY` are withheld. The longest real private key is well under this. */
const MAX_PEM_LINES = 256;

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
/** A line ending in a credential's name: its value may be on the next line, which the patterns in `redactSecrets` only see when the two are read together. */
const HANGING_KEY = /(?:\b(?:bearer|basic)|(?:token|credential|secret|passw(?:or)?d|api[_-]?key|private[_-]?key)s?)["']?\s*[:=]?\s*["']?$/i;
const NEWLINE = /\r\n|\n|\r(?!$)/;

/**
 * Whether an attempt's output may leave the runner at all. Public and internal may; restricted, secret, or a classification that cannot be read may not. Fails closed.
 */
export const isTerminalStreamable = (classification: unknown): boolean => classification === 'public' || classification === 'internal';

const fit = (line: string): string => (line.length > TERMINAL_MAX_LINE_CHARS ? `${line.slice(0, TERMINAL_MAX_LINE_CHARS)}…` : line);

/**
 * Redacts worker output that arrives in arbitrary chunks. It is line-buffered: text is held until its line is complete, and only then cleaned and redacted, so a secret split
 * across two chunks is rejoined before any pattern looks at it. Nothing of a partial line is ever released; a line that never ends is dropped whole. Multi-line secrets are
 * handled by state: a line ending in a credential's name waits to be read with the next one, and everything after an unclosed `BEGIN PRIVATE KEY` is withheld until its END.
 */
export class TerminalRedactor {
  private buffer = '';
  private discarding = false;
  private hanging: string | null = null;
  private pemLines: number | null = null;

  /** Feed text. Returns the lines that became complete, cleaned and redacted, in order. */
  write(chunk: string): string[] {
    const out: string[] = [];
    this.buffer += chunk;
    for (let m = NEWLINE.exec(this.buffer); m; m = NEWLINE.exec(this.buffer)) {
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      if (this.discarding) this.discarding = false;
      else out.push(...this.complete(line));
    }
    if (this.buffer.length > MAX_HOLD_CHARS) {
      this.buffer = '';
      if (!this.discarding) out.push(`[output over ${MAX_HOLD_CHARS} characters without a line break was withheld]`);
      this.discarding = true;
    }
    return out;
  }

  /** End of a run of text: whatever is held becomes a line, and nothing stays for the next run. */
  flush(): string[] {
    const line = this.buffer;
    this.buffer = '';
    const out = line !== '' && !this.discarding ? this.complete(line) : [];
    this.discarding = false;
    if (this.hanging !== null) {
      out.push(...this.emit(this.hanging));
      this.hanging = null;
    }
    return out;
  }

  private complete(raw: string): string[] {
    const clean = sanitizeTerminalText(raw);
    if (this.pemLines !== null) {
      this.pemLines += 1;
      if (PEM_END.test(clean) || this.pemLines >= MAX_PEM_LINES) this.pemLines = null;
      return [];
    }
    const wasHanging = this.hanging !== null;
    const joined = wasHanging ? `${this.hanging}\n${clean}` : clean;
    this.hanging = null;
    if (PEM_BEGIN.test(joined) && !PEM_END.test(joined)) {
      this.pemLines = 0;
      return this.emit(joined);
    }
    if (!wasHanging && HANGING_KEY.test(clean)) {
      this.hanging = clean;
      return [];
    }
    return this.emit(joined);
  }

  private emit(text: string): string[] {
    return redactSecrets(text).split('\n').map(fit);
  }
}
