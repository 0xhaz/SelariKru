import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * H7 motion check, read from the stylesheet itself: drawers and dialogs enter in 150 to 250 ms, only transform and opacity ever animate or transition,
 * and every rule that moves something is switched off under reduced motion. Exits have no animation, so an exit is never slower than an entrance.
 */
const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

const blocks = (re: RegExp): { name: string; body: string }[] => [...css.matchAll(re)].map((m) => ({ name: m[1]!, body: m[2]! }));
const keyframes = blocks(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g);
const ms = (v: string): number => (v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000);

describe('motion rules', () => {
  it('keyframes change only transform and opacity', () => {
    expect(keyframes.length).toBeGreaterThan(0);
    for (const k of keyframes) {
      const props = [...k.body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(props.filter((p) => p !== 'transform' && p !== 'opacity'), k.name).toEqual([]);
    }
  });

  it('transitions name only transform or opacity', () => {
    const transitions = [...css.matchAll(/transition\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim()).filter((v) => v !== 'none');
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) expect(t.split(',').map((x) => x.trim().split(/\s+/)[0]).filter((p) => p !== 'transform' && p !== 'opacity'), t).toEqual([]);
  });

  it('drawers, dialogs and menus enter in 150 to 250 ms', () => {
    for (const cls of ['motion-drawer', 'motion-dialog', 'motion-menu']) {
      const rule = new RegExp(`\\.${cls}\\s*\\{[^}]*animation:\\s*[\\w-]+\\s+([\\d.]+m?s)`).exec(css);
      expect(rule, cls).not.toBeNull();
      const d = ms(rule![1]!);
      expect(d, cls).toBeGreaterThanOrEqual(150);
      expect(d, cls).toBeLessThanOrEqual(250);
    }
  });

  it('reduced motion turns off every class that animates or transitions', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    const moving = [...css.matchAll(/\n\s*\.([\w-]+)\s*\{[^}]*(?:animation|transition)\s*:\s*(?!none)[^;]+;/g)].map((m) => m[1]!);
    expect(moving.length).toBeGreaterThan(0);
    for (const cls of moving) expect(reduced, cls).toContain(`.${cls}`);
    expect(reduced).toMatch(/animation:\s*none/);
    expect(reduced).toMatch(/transition:\s*none/);
  });
});
