// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// 3×5 bitmap font for in-world signs and tags.

import { C } from './palette.ts';
import { GLYPH_FONT, type Pen } from './pen.ts';

const FONT: Record<string, string[]> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"], B: ["##.", "#.#", "##.", "#.#", "##."], C: [".##", "#..", "#..", "#..", ".##"], D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"], F: ["###", "#..", "##.", "#..", "#.."], G: [".##", "#..", "#.#", "#.#", ".##"], H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"], J: ["..#", "..#", "..#", "#.#", ".#."], K: ["#.#", "#.#", "##.", "#.#", "#.#"], L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"], N: ["##.", "#.#", "#.#", "#.#", "#.#"], O: [".#.", "#.#", "#.#", "#.#", ".#."], P: ["##.", "#.#", "##.", "#..", "#.."],
  Q: [".#.", "#.#", "#.#", "##.", ".##"], R: ["##.", "#.#", "##.", "#.#", "#.#"], S: [".##", "#..", ".#.", "..#", "##."], T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"], V: ["#.#", "#.#", "#.#", "#.#", ".#."], W: ["#.#", "#.#", "###", "###", "#.#"], X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."], Z: ["###", "..#", ".#.", "#..", "###"],
  0: ["###", "#.#", "#.#", "#.#", "###"], 1: [".#.", "##.", ".#.", ".#.", "###"], 2: ["##.", "..#", ".#.", "#..", "###"], 3: ["##.", "..#", ".#.", "..#", "##."],
  4: ["#.#", "#.#", "###", "..#", "..#"], 5: ["###", "#..", "##.", "..#", "##."], 6: [".##", "#..", "###", "#.#", "###"], 7: ["###", "..#", ".#.", ".#.", ".#."],
  8: ["###", "#.#", "###", "#.#", "###"], 9: ["###", "#.#", "###", "..#", "##."],
  "#": ["#.#", "###", "#.#", "###", "#.#"], "-": ["...", "...", "###", "...", "..."], ".": ["...", "...", "...", "...", ".#."], ":": ["...", ".#.", "...", ".#.", "..."],
  "!": [".#.", ".#.", ".#.", "...", ".#."], "?": ["##.", "..#", ".#.", "...", ".#."], "+": ["...", ".#.", "###", ".#.", "..."], "/": ["..#", "..#", ".#.", "#..", "#.."],
  "(": ["..#", ".#.", ".#.", ".#.", "..#"], ")": ["#..", ".#.", ".#.", ".#.", "#.."], ",": ["...", "...", "...", ".#.", "#.."], "'": [".#.", ".#.", "...", "...", "..."],
  "&": [".#.", "#.#", ".#.", "#.#", ".##"], "_": ["...", "...", "...", "...", "###"], "=": ["...", "###", "...", "###", "..."], ">": ["#..", ".#.", "..#", ".#.", "#.."],
  "·": ["...", "...", ".#.", "...", "..."], "—": ["...", "...", "###", "...", "..."],
  " ": ["...", "...", "...", "...", "..."],
};

/** Whether a string has a character the bitmap font cannot draw (a name in another script): it is then drawn with the canvas font (H11 fix round 1, M3). */
export const needsGlyphs = (str: string): boolean => [...String(str).toUpperCase()].some((ch) => FONT[ch] === undefined);
const glyphPx = (s: number): number => 7 * s;

/** A canvas only to measure glyph text when no pen is at hand. Absent (no DOM): an estimate. */
let measurer: CanvasRenderingContext2D | null | undefined;
function measureGlyphs(str: string, px: number): number {
  if (measurer === undefined) measurer = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!measurer) return [...str].length * px;
  measurer.font = `${px}px ${GLYPH_FONT}`;
  return Math.ceil(measurer.measureText(str).width);
}

export const textW = (str: string, s = 1, pen?: Pen): number => {
  if (needsGlyphs(str)) return pen?.measure ? pen.measure(String(str), glyphPx(s)) : measureGlyphs(String(str), glyphPx(s));
  return Math.max(0, String(str).length * 4 - 1) * s;
};

/** The first `n` graphemes (what a reader counts as characters), so a cut never splits an emoji, a combining mark or a syllable. */
export function clipGraphemes(str: string, n: number): string {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let out = '';
  let i = 0;
  for (const g of seg.segment(str)) { if (i++ >= n) break; out += g.segment; }
  return out;
}

export function text(p: Pen, str: string, x: number, y: number, color: string, s = 1) {
  const up = String(str).toUpperCase();
  if (needsGlyphs(up) && p.glyphs) { p.glyphs(up, x, y - s, color, glyphPx(s)); return; }
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  for (let i = 0; i < up.length; i++) {
    const gl = FONT[up[i]!] ?? FONT['?']!;
    for (let gy = 0; gy < 5; gy++) {
      const row = gl[gy]!;
      // Merge horizontal runs into one rect.
      let gx = 0;
      while (gx < 3) {
        if (row[gx] !== "#") {
          gx += 1;
          continue;
        }
        let run = 1;
        while (gx + run < 3 && row[gx + run] === "#") run += 1;
        p.rect(x0 + (i * 4 + gx) * s, y0 + gy * s, run * s, s, color);
        gx += run;
      }
    }
  }
}

/** Small tag: text on a plate, centred on cx. */
export function tag(p: Pen, str: string, cx: number, y: number, bg: string = C.ink, fg: string = C.white) {
  const w = textW(str);
  const x = Math.round(cx - w / 2);
  p.rect(x - 2, y - 1, w + 4, 7, bg);
  text(p, str, x, y, fg);
}

/** Clips a label to fit `maxPx` wide. */
export function fit(str: string, maxPx: number): string {
  if (needsGlyphs(str)) {
    const count = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str)].length;
    for (let n = count; n >= 1; n--) { const s = n === count ? str : clipGraphemes(str, n) + '.'; if (textW(s) <= maxPx) return s; }
    return clipGraphemes(str, 1);
  }
  const max = Math.max(1, Math.floor((maxPx + 1) / 4));
  return str.length <= max ? str : str.slice(0, Math.max(1, max - 1)) + ".";
}
