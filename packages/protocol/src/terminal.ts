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

/** A word that means a credential wherever it appears in a name. A value under one of these is always hidden. */
const STRONG_NAME = /secret|passw(?:or)?d|passphrase|(?<!by|com|sur|tres)pass(?![a-z])|pwd|credential|cookie|authorization|api[_.-]?key|access[_.-]?key|private[_.-]?key/i;
/** Names that often mean a credential and often do not, so the value is looked at too. */
const WEAK_NAME = /token|sess(?:ion)?[_.-]?id|(?:^|[._-])sid$/i;
/** `key` and `auth` count only as a whole segment or camelCase hump: `primaryKey` yes, `monkey`, `author` and `keyboard` no. */
const WEAK_SEGMENTS: ReadonlySet<string> = new Set(['key', 'keys', 'auth']);

type NameKind = 'strong' | 'weak' | null;

function kindOf(name: string): NameKind {
  if (STRONG_NAME.test(name)) return 'strong';
  if (WEAK_NAME.test(name)) return 'weak';
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_.-]+/).some((part) => WEAK_SEGMENTS.has(part.toLowerCase())) ? 'weak' : null;
}

/** `auth.ts`, `token.json`: a file, not a name, unless the "extension" is itself a credential word as in `db.pass`. */
const fileLike = (name: string): boolean => {
  const ext = /\.([a-z]{1,5})$/i.exec(name)?.[1];
  return ext !== undefined && kindOf(ext) === null;
};

const VALUE_END = String.raw`\s*(?:[,;)}\]]|$)`;
const HARMLESS_LITERAL = new RegExp(String.raw`^(?:-?\d{1,7}(?:\.\d+)?|true|false|null|undefined|none|nil)${VALUE_END}`, 'i');
const TS_PRIMITIVE = /^(?:string|number|boolean|bigint|symbol|object|any|unknown|void|never|null|undefined)(?:\[\])?(?![\w-])/;
const TS_TYPE_NAME = new RegExp(String.raw`^[A-Z][a-zA-Z]{1,40}(?:<[^>\n]*>)?(?:\[\])?\s*(?:[,;)}\]|&=]|$)`);
const PROSE = /^[A-Za-z][A-Za-z']*(?:\s+[A-Za-z][A-Za-z']*){2,}[.!?]?\s*$/;
const DECLARED = /\b(?:const|let|var|val)\s+$/;

/** Whether what follows a weak name plainly is not a credential: a count, a flag, a type, an object, a sentence, or a reference in code. Anything that could be a value is hidden. */
function harmlessValue(value: string, annotation: boolean, before: string): boolean {
  if (value.startsWith('{') || HARMLESS_LITERAL.test(value) || PROSE.test(value)) return true;
  if (annotation && (TS_PRIMITIVE.test(value) || TS_TYPE_NAME.test(value))) return true;
  return DECLARED.test(before) && !/^["'`]/.test(value);
}

const shouldHide = (name: string, value: string, annotation: boolean, before: string): boolean => {
  const kind = kindOf(name);
  return kind === 'strong' || (kind === 'weak' && !harmlessValue(value, annotation, before));
};

const NAME_AND_SEPARATOR = /([A-Za-z0-9_.-]{1,128})(["'\]]{0,2}\s*(?::=|:(?!:)|={1,3}(?![=>])))(\s*)/g;

/** Where a value starting at `start` ends: its closing quote, or the end of the line, since an env value or YAML scalar has no reliable end of its own. */
function valueEnd(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  const eol = newline < 0 ? text.length : newline;
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return eol;
  const close = text.indexOf(quote, start + 1);
  return close >= 0 && close < eol ? close + 1 : eol;
}

/** Walks every `name: value` in the text. A value that is left alone is still read, so `src/a.ts:3: password = x` and `auth: { pass: x }` lose only what they should. Linear in the line. */
function redactAssignments(text: string): string {
  let out = '';
  let copied = 0;
  NAME_AND_SEPARATOR.lastIndex = 0;
  for (let m = NAME_AND_SEPARATOR.exec(text); m; m = NAME_AND_SEPARATOR.exec(text)) {
    const name = m[1]!;
    const separator = m[2]!;
    const start = m.index + m[0].length;
    if (start >= text.length || text[start] === '\n') continue;
    // `name.ext:12` is a position in a file, and a stack frame or grep prefix is not a credential.
    if (m[3] === '' && separator === ':' && /\d/.test(text[start]!) && fileLike(name)) continue;
    const end = valueEnd(text, start);
    if (!shouldHide(name, text.slice(start, end), separator.endsWith(':'), text.slice(Math.max(0, m.index - 8), m.index))) continue;
    out += `${text.slice(copied, start)}${REDACTED}`;
    copied = end;
    NAME_AND_SEPARATOR.lastIndex = end;
  }
  return out + text.slice(copied);
}

const TRAILING_NAME = /([A-Za-z0-9_.-]{1,128})["']?\s*(:=|:|={1,3})?\s*["']?$/;

/** A line whose value may be on the next line: it ends in a name and a separator, or (in stream mode) is nothing but a name. A sentence that happens to end in such a word is not one. */
function endsWithName(line: string, requireSeparator: boolean): boolean {
  const m = TRAILING_NAME.exec(line);
  if (!m || kindOf(m[1]!) === null || fileLike(m[1]!)) return false;
  return m[2] !== undefined || (!requireSeparator && line.trim().replace(/^["']|["']$/g, '') === m[1]);
}

const BARE_BEARER = /\b(bearer)\s+(?:(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}|[A-Za-z0-9._~+/=-]{20,})/gi;
const BEARER_END = /\b(?:bearer|basic)\s*$/i;
const YAML_BLOCK = /^(\s*)(?:-\s+)?([A-Za-z0-9_.-]{1,128})["']?\s*:\s*[|>][-+0-9]*\s*$/;
const FLAG_VALUE = /(?<![\w-])(--?)([a-z0-9][a-z0-9-]{0,127})(\s+)("[^"\n]*"|'[^'\n]*'|[^\s-]\S*)/gi;
const DOCKER_ENV = /^(\s*ENV\s+)([A-Za-z0-9_.-]{1,128})(\s+)(\S[^\n]*)$/gm;
const PRESIGNED = /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|Signature|sig)=)[^&\s'"]+/gi;
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
 * The terminal's own redaction, stricter than `redactSecrets` and kept apart from it so other uses do not change meaning. A value under a credential's name goes, with no requirement
 * that it look like one; only weak names get their value looked at. It still only knows formats: a sensitive value with neither a telling name nor shape passes.
 */
export function redactTerminalText(text: string): string {
  let out = redactSecrets(text).replace(PEM_WHOLE, PEM_NOTICE).replace(WEBHOOK_URL, REDACTED).replace(URL_USERINFO, `$1${REDACTED}@`).replace(USER_PASS, `$1$2${REDACTED}`).replace(PRESIGNED, `$1${REDACTED}`);
  for (const re of COMMAND_PASSWORDS) out = out.replace(re, `$1${REDACTED}`);
  out = out
    .replace(BARE_BEARER, `$1 ${REDACTED}`)
    .replace(FLAG_VALUE, (whole: string, dash: string, name: string, gap: string, value: string) => (shouldHide(name, value, false, '') ? `${dash}${name}${gap}${REDACTED}` : whole))
    .replace(DOCKER_ENV, (whole: string, head: string, name: string, gap: string, value: string) => (shouldHide(name, value, false, '') ? `${head}${name}${gap}${REDACTED}` : whole));
  return redactAssignments(out);
}

const NEWLINE = /\r\n|\n|\r(?!$)/;
/** What an interactive prompt looks like when it stops without a newline. */
const PROMPT_END = /[:?>#$\])][ \t]+$/;
/** With echo off a program is waiting to read, and some prompts, such as macOS sudo's `Password:`, stop with no space. Only `:` and `?`, because `]` and `>` also end progress counters. */
const PROMPT_END_ECHO_OFF = /[:?]$/;
/** The fragment stops inside a URL. The closing characters are the ones the URL redactions stop at, so what comes after a closing quote or space was never part of the URL's redaction. */
const INSIDE_URL = /:\/\/[^\s'"]*$/;
/** A credential named anywhere in a prompt: `password for haz: `, `Enter your API key here: `, `Access token (optional): `. */
const PROMPT_CREDENTIAL = /\b(?:pass(?:word|phrase|code)|passwd|pwd|pin|otp|secret|credentials?|cookie|authorization|(?:api|access|private|secret)[ _.-]*key|token)\b/i;
const MAX_PROMPT_CHARS = 200;

export const fitTerminalLine = (line: string): string => (line.length > TERMINAL_MAX_LINE_CHARS ? `${line.slice(0, TERMINAL_MAX_LINE_CHARS)}${LINE_CUT_MARK}` : line);

/**
 * Redacts worker output that arrives in arbitrary chunks. It is line-buffered: text is held until its line is complete, and only then cleaned and redacted, so a secret split
 * across two chunks is rejoined before any pattern looks at it. Nothing of a partial line is ever released; a line that never ends is dropped whole. Multi-line secrets are
 * handled by state: a line ending in a credential's name and a separator, or that is only a name, is read with the next, a YAML block under one is withheld, and everything after an unclosed private-key header is withheld
 * until its END or the end of the run. `lines` mode is for text that has already been through a stream redactor: only a name with an explicit separator waits for the next line,
 * because a rendered line that merely ends in such a word says nothing about what follows.
 */
export class TerminalRedactor {
  private buffer = '';
  private discarding = false;
  private hanging: string | null = null;
  private pemLines: number | null = null;
  private yamlBlock: { readonly indent: number; lines: number } | null = null;
  /** A released prompt named a credential: the next single-token line is its value, shown or typed. */
  private promptNamed = false;
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
    this.promptNamed = false;
    return out;
  }

  /**
   * Releases an interactive prompt that has no newline, such as `Continue? `, `Password: ` or git's `Username for 'https://github.com': `, so someone at the keyboard can answer it. Releasing a fragment gives up the
   * rejoin that line-buffering guarantees, so only a fragment that cannot be the front of a credential goes out: short, ending like a prompt, not stopped inside a URL, and left alone by redaction apart from a URL's
   * userinfo. A prompt that names a credential goes out, and the whole next line is hidden whatever its shape, in every echo state: echo off says what the terminal does with typed input, not what a program prints next.
   * The cost is one hidden line after a real password prompt such as sudo's. `echoOff`, reported only for a canonical-mode terminal because a raw-mode program (Node's readline) prints what it reads, only allows a prompt
   * with no trailing space to go out. Null otherwise, and the line stays held.
   */
  releasePrompt(echoOff = false): string | null {
    if (this.discarding || this.pemLines !== null || this.yamlBlock !== null || this.parts.length > 0 || this.hanging !== null || this.promptNamed) return null;
    const clean = sanitizeTerminalText(this.buffer);
    if (clean === '' || clean.length > MAX_PROMPT_CHARS || INSIDE_URL.test(clean)) return null;
    if (!PROMPT_END.test(clean) && !(echoOff && PROMPT_END_ECHO_OFF.test(clean))) return null;
    const shown = clean.replace(URL_USERINFO, `$1${REDACTED}@`);
    if (redactTerminalText(clean) !== shown) return null;
    const named = BEARER_END.test(shown) || endsWithName(shown, false) || PROMPT_CREDENTIAL.test(shown);
    this.buffer = '';
    this.promptNamed = named;
    return fitTerminalLine(shown);
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
    if (this.promptNamed) {
      if (clean.trim() === '') return [];
      this.promptNamed = false;
      return [REDACTED];
    }
    const requireSeparator = this.mode === 'lines';
    const held = this.hanging;
    this.hanging = null;
    // Blank lines between a name and its value change nothing, so it keeps waiting.
    if (held !== null && clean.trim() === '') {
      this.hanging = held;
      return [];
    }
    // Judged after redaction: a value that happens to end in such a word is gone by then, and is not a name left waiting. Only a single token is taken for its value.
    if (held !== null && endsWithName(redactTerminalText(held), requireSeparator) && /^\s*\S+\s*$/.test(clean)) return [...this.emit(held), REDACTED];
    const joined = held !== null ? `${held}\n${clean}` : clean;
    if (PEM_BEGIN.test(joined) && !PEM_END.test(joined)) {
      this.pemLines = 0;
      return [];
    }
    const yaml = YAML_BLOCK.exec(clean);
    if (yaml && kindOf(yaml[2]!) !== null) {
      this.yamlBlock = { indent: (yaml[1] ?? '').length, lines: 0 };
      return this.emit(joined);
    }
    if (held === null && (BEARER_END.test(clean) || endsWithName(redactTerminalText(clean), requireSeparator))) {
      this.hanging = clean;
      return [];
    }
    return this.emit(joined);
  }

  private emit(text: string): string[] {
    return redactTerminalText(text).split('\n').map(fitTerminalLine);
  }
}
