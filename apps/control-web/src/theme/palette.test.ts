import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentPalette, chipStyle, colors, stateStyle } from './tokens.ts';

/**
 * H7: SelariKru's own palette. The office is a kedai (shophouse) studio, so none of the reference template's colours may remain in this app's source.
 *
 * The list below is every hex value in the reference's `src/theme/tokens.ts` and its `src/index.css` @theme block. It is written out here because the reference
 * is never committed; when a checkout of it sits beside the repo (jsm-hq-main/), the test also re-reads those two files and checks the list is complete.
 */
const REFERENCE_HEX = [
  // @theme and tokens.ts `colors`
  '#241a2e', '#fff6e9', '#f0dfc2', '#e2cba6', '#7d6b73', '#1d2b53', '#16213f', '#29adff', '#ff004d', '#ffa300', '#00e436', '#83769c', '#ffec27', '#ff77a8',
  '#4a8f3d', '#fff1e8',
  // tokens.ts state and review dims
  '#1d6fb8', '#7e0f33', '#a86a00', '#00873a', '#5a5170',
  // tokens.ts agentPalette
  '#ffd23a', '#ff8a3d', '#a98bff', '#3ee0d0', '#ff5c5c', '#c2c3c7', '#b0e04a', '#f0a6ff', '#6fa8ff',
] as const;

/** The reference ink as an rgb() triple, which the old shadows used. */
const REFERENCE_INK_RGB = /rgba?\(\s*36\s*,\s*26\s*,\s*46\b/;

const here = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(here, '..');
const REFERENCE = join(here, '../../../../jsm-hq-main');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|css|json|html)$/.test(name) ? [path] : [];
  });
}

/** 3, 6 and 8 digit hex colours. */
const hexIn = (text: string): string[] => [...text.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)].map((m) => m[0].toLowerCase());

describe('the palette is SelariKru\'s own', () => {
  it('no colour from the reference template appears anywhere in control-web src', () => {
    const self = fileURLToPath(import.meta.url);
    const found: string[] = [];
    for (const file of files(SRC)) {
      if (file === self) continue;
      const text = readFileSync(file, 'utf8');
      for (const hex of hexIn(text)) if ((REFERENCE_HEX as readonly string[]).includes(hex)) found.push(`${relative(SRC, file)}: ${hex}`);
      if (REFERENCE_INK_RGB.test(text)) found.push(`${relative(SRC, file)}: the reference ink as rgb()`);
    }
    expect(found).toEqual([]);
  });

  // When the reference is checked out beside the repo, every colour anywhere in its src counts, not only its palette (H7 fix M1).
  it.runIf(existsSync(join(REFERENCE, 'src')))('no hex colour from anywhere in the reference src appears in control-web src', () => {
    const theirs = new Set(files(join(REFERENCE, 'src')).flatMap((f) => hexIn(readFileSync(f, 'utf8'))));
    expect(theirs.size).toBeGreaterThan(30);
    const self = fileURLToPath(import.meta.url);
    const found = files(SRC).filter((f) => f !== self).flatMap((f) => hexIn(readFileSync(f, 'utf8')).filter((h) => theirs.has(h)).map((h) => `${relative(SRC, f)}: ${h}`));
    expect(found).toEqual([]);
  });

  it.runIf(existsSync(join(REFERENCE, 'src/theme/tokens.ts')))('the list holds every hex value in the reference tokens and its @theme block', () => {
    const tokens = readFileSync(join(REFERENCE, 'src/theme/tokens.ts'), 'utf8');
    const css = readFileSync(join(REFERENCE, 'src/index.css'), 'utf8');
    const theme = /@theme\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const missing = [...new Set([...hexIn(tokens), ...hexIn(theme)])].filter((h) => !(REFERENCE_HEX as readonly string[]).includes(h));
    expect(missing).toEqual([]);
  });

  it('defines the kedai families: terracotta, teal, kopi brown, cream paper, deep green, gold and its own ink', () => {
    for (const key of ['terracotta', 'teal', 'kopi', 'paper', 'deepGreen', 'gold', 'ink'] as const) expect(colors[key]).toMatch(/^#[0-9a-f]{6}$/);
    expect(colors.ink).not.toBe('#241a2e');
    const used = [...Object.values(colors), ...agentPalette, ...Object.values(stateStyle).flatMap((s) => [s.color, s.dim]), ...Object.values(chipStyle).flatMap((c) => [c.bg, c.fg])];
    expect(used.filter((h) => (REFERENCE_HEX as readonly string[]).includes(h.toLowerCase()))).toEqual([]);
  });
});
