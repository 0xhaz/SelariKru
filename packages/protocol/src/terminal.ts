import { sanitizeTerminalText } from '@selarikru/domain';
import { REDACTED, redactSecrets } from './redact.ts';

/** Longest line kept after redaction; a longer one is cut, so a single line can never carry the whole retained budget. */
export const TERMINAL_MAX_LINE_CHARS = 2000;
export const TERMINAL_MAX_BATCH_LINES = 100;
const LINE_CUT_MARK = '… [truncated]';
/** The longest line the wire accepts: a full line plus its mark. A line this code produced must never be the reason a batch is refused. */
export const TERMINAL_MAX_WIRE_LINE_CHARS = TERMINAL_MAX_LINE_CHARS + LINE_CUT_MARK.length;
/** A buffer this long with no newline is not a line: it is discarded whole, never released in pieces, so no part of a secret can escape past the line boundary. */
const MAX_HOLD_CHARS = 64 * 1024;
/** How many lines after an unclosed `BEGIN PRIVATE KEY` are withheld. The longest real private key is well under this. */
const MAX_PEM_LINES = 256;

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_WHOLE = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

export const TERMINAL_WITHHELD_NOTICE = '[output withheld: may contain secrets]';
const PEM_NOTICE = '[private key withheld]';

/** Any identifier with one of these in it names a credential. Bounded on both sides, so a very long line cannot cost quadratic time on the worker's own event loop. */
const NAME = '[A-Za-z0-9_.-]{0,64}(?:secret|passw(?:or)?d|pwd|token|key|credential|auth)[A-Za-z0-9_.-]{0,64}';
const NAME_END = new RegExp(`${NAME}["']?\\s*[:=]?\\s*["']?$`, 'i');
const NAME_SEPARATOR_END = new RegExp(`${NAME}["']?\\s*[:=]\\s*["']?$`, 'i');
const BEARER_END = /\b(?:bearer|basic)\s*$/i;
const YAML_BLOCK = new RegExp(`^(\\s*)(?:-\\s+)?${NAME}["']?\\s*:\\s*[|>][-+0-9]*\\s*$`, 'i');
/** Unquoted values run to the end of the line: an env value or YAML scalar has no reliable end, and hiding too much is the accepted cost. */
const ASSIGNMENT = new RegExp(`(${NAME}["'\\]]?\\s*[:=]\\s*)("[^"\\n]*"?|'[^'\\n]*'?|\\S[^\\n]*)`, 'gi');
const FLAG_VALUE = /(--?[a-z0-9-]{0,64}(?:secret|passw(?:or)?d|pwd|token|key|credential|auth)[a-z0-9-]{0,64})(\s+)("[^"\n]*"|'[^'\n]*'|[^\s-]\S*)/gi;
const WEBHOOK_URL = /https?:\/\/(?:hooks\.slack\.com\/[^\s'"]+|[^\s'"]*webhook[^\s'"]*)/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/?#'"]*@/gi;
const USER_PASS = /(^|\s)((?:-u|--user)(?:[=\s]\s*)?)("[^"\n]*:[^"\n]*"|'[^'\n]*:[^'\n]*'|[^\s"':]+:\S+)/g;
const COMMAND_PASSWORDS: readonly RegExp[] = [
  /\b(mysql(?:dump|admin|import|show)?\b[^\n]*?\s-p)(?=[^\s-])\S+/g,
  /\b(sshpass\s+(?:-\w+\s+)*-p\s*)\S+/g,
  /\b(redis-cli\b[^\n]*?\s-a\s+)\S+/g,
  /\b((?:un)?zip\b[^\n]*?\s-P\s*)\S+/g,
];

/**
 * The terminal's own redaction, stricter than `redactSecrets` and kept apart from it so other uses do not change meaning. Output is shown to a person, so anything named like a
 * credential goes, with no requirement that the value look like one. It over-redacts on purpose. It still only knows formats: a sensitive value with neither a telling name nor shape passes.
 */
export function redactTerminalText(text: string): string {
  let out = redactSecrets(text).replace(PEM_WHOLE, PEM_NOTICE).replace(WEBHOOK_URL, REDACTED).replace(URL_USERINFO, `$1${REDACTED}@`).replace(USER_PASS, `$1$2${REDACTED}`);
  for (const re of COMMAND_PASSWORDS) out = out.replace(re, `$1${REDACTED}`);
  return out.replace(FLAG_VALUE, `$1$2${REDACTED}`).replace(ASSIGNMENT, `$1${REDACTED}`);
}

const NEWLINE = /\r\n|\n|\r(?!$)/;

const fit = (line: string): string => (line.length > TERMINAL_MAX_LINE_CHARS ? `${line.slice(0, TERMINAL_MAX_LINE_CHARS)}${LINE_CUT_MARK}` : line);

/**
 * Redacts worker output that arrives in arbitrary chunks. It is line-buffered: text is held until its line is complete, and only then cleaned and redacted, so a secret split
 * across two chunks is rejoined before any pattern looks at it. Nothing of a partial line is ever released; a line that never ends is dropped whole. Multi-line secrets are
 * handled by state: a line ending in a credential's name is read with the next, a YAML block under one is withheld, and everything after an unclosed private-key header is withheld
 * until its END or the end of the run. `lines` mode is for text that has already been through a stream redactor: only a name with an explicit separator waits for the next line,
 * because a rendered line that merely ends in such a word says nothing about what follows.
 */
export class TerminalRedactor {
  private buffer = '';
  private discarding = false;
  private hanging: string | null = null;
  private pemLines: number | null = null;
  private yamlBlock: { readonly indent: number; lines: number } | null = null;
  /** Partial lines left by earlier messages, not yet known to be separate. */
  private parts: string[] = [];

  constructor(private readonly mode: 'stream' | 'lines' = 'stream') {}

  /** Feed text. Returns the lines that became complete, cleaned and redacted, in order. */
  write(chunk: string): string[] {
    const out: string[] = [];
    this.buffer += chunk;
    for (let m = NEWLINE.exec(this.buffer); m; m = NEWLINE.exec(this.buffer)) {
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      if (this.discarding) this.discarding = false;
      else out.push(...this.settle(line));
    }
    if (this.buffer.length + this.parts.reduce((n, p) => n + p.length, 0) > MAX_HOLD_CHARS) {
      this.buffer = '';
      this.parts = [];
      if (!this.discarding) out.push(`[output over ${MAX_HOLD_CHARS} characters without a line break was withheld]`);
      this.discarding = true;
    }
    return out;
  }

  /** One message ended and another follows. Its unfinished line is shown as its own line, unless a secret turns out to run across the join. */
  softBreak(): void {
    if (this.buffer !== '' && !this.discarding) this.parts.push(this.buffer);
    if (!this.discarding) this.buffer = '';
  }

  /** End of a run of text: whatever is held becomes a line, and no state survives into the next run. */
  flush(): string[] {
    const line = this.buffer;
    this.buffer = '';
    const out = !this.discarding && (line !== '' || this.parts.length > 0) ? this.settle(line) : [];
    this.parts = [];
    this.discarding = false;
    if (this.hanging !== null) {
      out.push(...this.emit(this.hanging));
      this.hanging = null;
    }
    if (this.pemLines !== null) out.push(this.endPem(true));
    this.yamlBlock = null;
    return out;
  }

  /** Decides whether held messages were separate: only if reading them together redacts nothing that reading them apart would miss. */
  private settle(line: string): string[] {
    if (this.parts.length === 0) return this.complete(line);
    const pieces = line === '' ? this.parts : [...this.parts, line];
    this.parts = [];
    const apart = pieces.map((p) => redactTerminalText(sanitizeTerminalText(p))).join('');
    const together = redactTerminalText(sanitizeTerminalText(pieces.join('')));
    return apart === together ? pieces.flatMap((p) => this.complete(p)) : this.complete(pieces.join(''));
  }

  private endPem(truncated: boolean): string {
    const count = this.pemLines ?? 0;
    this.pemLines = null;
    return truncated && count > 0 ? `[private key withheld, ${count} ${count === 1 ? 'line' : 'lines'}]` : PEM_NOTICE;
  }

  private complete(raw: string): string[] {
    const clean = sanitizeTerminalText(raw);
    if (this.pemLines !== null) {
      this.pemLines += 1;
      if (PEM_END.test(clean)) return [this.endPem(false)];
      return this.pemLines >= MAX_PEM_LINES ? [this.endPem(true)] : [];
    }
    if (this.yamlBlock !== null) {
      const indent = clean.length - clean.trimStart().length;
      if ((clean.trim() === '' || indent > this.yamlBlock.indent) && this.yamlBlock.lines < MAX_PEM_LINES) {
        this.yamlBlock.lines += 1;
        return [];
      }
      this.yamlBlock = null;
    }
    const nameEnd = this.mode === 'stream' ? NAME_END : NAME_SEPARATOR_END;
    const held = this.hanging;
    this.hanging = null;
    // Judged after redaction: a value that happens to end in such a word is gone by then, and is not a name left waiting.
    if (held !== null && nameEnd.test(redactTerminalText(held)) && clean.trim() !== '') return [...this.emit(held), REDACTED];
    const joined = held !== null ? `${held}\n${clean}` : clean;
    if (PEM_BEGIN.test(joined) && !PEM_END.test(joined)) {
      this.pemLines = 0;
      return [];
    }
    const yaml = YAML_BLOCK.exec(clean);
    if (yaml) {
      this.yamlBlock = { indent: (yaml[1] ?? '').length, lines: 0 };
      return this.emit(joined);
    }
    if (held === null && (BEARER_END.test(clean) || nameEnd.test(redactTerminalText(clean)))) {
      this.hanging = clean;
      return [];
    }
    return this.emit(joined);
  }

  private emit(text: string): string[] {
    return redactTerminalText(text).split('\n').map(fit);
  }
}
