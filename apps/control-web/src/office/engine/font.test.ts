import { describe, expect, it } from 'vitest';
import { clipGraphemes, fit, needsGlyphs, text, textW } from './font.ts';
import type { Pen } from './pen.ts';

/** H11 fix round 1 (M3): names in any script reach the office as text the canvas draws, cut by grapheme, never as "?" boxes or half a character. */
describe('non-Latin names on plates and tags', () => {
  it('clips by grapheme, not by UTF-16 unit', () => {
    expect(clipGraphemes('👩🏽‍💻Aisyah', 2)).toBe('👩🏽‍💻A');
    expect(clipGraphemes('李明华', 2)).toBe('李明');
    expect([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clipGraphemes('நிலா', 1))]).toHaveLength(1);
    expect(fit('李明华李明华李明华李明华李明华', 20)).not.toMatch(/�/);
  });

  it('a name the bitmap font has no glyphs for is drawn with the canvas font, not as question marks', () => {
    const rects: unknown[] = [];
    const glyphs: string[] = [];
    const pen: Pen = { rect: (...a) => void rects.push(a), glyphs: (s) => void glyphs.push(s), measure: (s) => s.length * 7 };
    expect(needsGlyphs('李明')).toBe(true);
    expect(needsGlyphs('AISYAH · BACKEND')).toBe(false);
    text(pen, '李明', 0, 0, '#000');
    expect(glyphs).toEqual(['李明']);
    expect(rects).toEqual([]);
    expect(textW('李明', 1, pen)).toBe(14);
  });
});
