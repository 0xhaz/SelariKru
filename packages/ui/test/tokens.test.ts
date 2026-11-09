import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/contrast.ts';

const css = readFileSync(resolve(import.meta.dirname, '../src/tokens.css'), 'utf8');

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}
const dark = tokens(css.slice(css.indexOf('@theme'), css.indexOf('}')));
const lightStart = css.indexOf('[data-theme="light"]');
const light = { ...dark, ...tokens(css.slice(lightStart, css.indexOf('}', lightStart))) };

const SURFACES = ['bg', 'panel', 'panel-2'];
const TEXT = ['fg', 'muted', 'active', 'success', 'warning', 'danger'];
const TONES = ['active', 'success', 'warning', 'danger'];

describe.each([['dark', dark], ['light', light]] as const)('%s theme', (_name, t) => {
  it.each(SURFACES.flatMap((s) => TEXT.map((c) => [c, s] as const)))('%s text on %s meets AA', (c, s) => {
    expect(contrastRatio(t[c]!, t[s]!)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(TONES)('%s and body text on its own tint meet AA', (tone) => {
    const tint = t[`${tone}-tint`]!;
    for (const c of [tone, 'fg', 'muted']) expect(contrastRatio(t[c]!, tint), `${c} on ${tone}-tint`).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['active', 'warning'])('background-colored text on a solid %s fill meets AA', (fill) => {
    expect(contrastRatio(t['bg']!, t[fill]!)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(SURFACES)('the strong control border is visible on %s', (s) => {
    expect(contrastRatio(t['line-strong']!, t[s]!)).toBeGreaterThanOrEqual(3);
  });
});

describe('dark tokens', () => {
  it('keep the proposed values from the design document', () => {
    expect(dark).toMatchObject({ bg: '#0b1020', panel: '#151e30', fg: '#f1f5f9', muted: '#b8c4d6', active: '#70b7ff', success: '#70d6a3', warning: '#ffd27a', danger: '#ff9a9a' });
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a color on itself', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#70b7ff', '#70b7ff')).toBeCloseTo(1, 5);
  });
});
