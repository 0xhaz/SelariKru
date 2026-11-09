/**
 * What may appear of worker text in a terminal view: plain text only. Worker output is untrusted, so escape sequences are removed rather than interpreted, and control, bidi
 * and zero-width characters are removed so text cannot rewrite the screen, reorder what is shown, or hide a token from redaction.
 */
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\^_])|\u009b[0-?]*[ -/]*[@-~]/g;
/** C0 and C1 controls other than tab and newline; a stray CR is handled by the line splitter before this runs. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** Bidi overrides and isolates, zero-width marks and joiners, soft hyphen, BOM, line separators, tag characters, the combining grapheme joiner, variation selectors and the blank Hangul fillers. */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [[0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x180b, 0x180f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xffa0, 0xffa0], [0xe0100, 0xe01ef], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff], [0xe0000, 0xe007f]];
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`, 'gu');

export function sanitizeTerminalText(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, '').replace(INVISIBLE, '');
}

/**
 * Whether an attempt's output may leave the runner at all. Public and internal may; restricted, secret, or a classification that cannot be read may not. Fails closed.
 */
export const isTerminalStreamable = (classification: unknown): boolean => classification === 'public' || classification === 'internal';
