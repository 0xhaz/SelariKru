import { describe, expect, it } from 'vitest';
import { generateLayout } from './layout.ts';

/** H11: the office grows with the team: one desk per worker, in rows, readable for 1 to 6 workers (and more). */
describe('the office layout grows with the team', () => {
  for (let n = 1; n <= 8; n++) {
    it(`${n} worker${n === 1 ? '' : 's'}: one desk each, none overlapping, all inside the building`, () => {
      const agents = Array.from({ length: n }, (_, i) => ({ id: `w${i}`, name: `W${i}`, color: '#2fa39a', active: i % 2 === 0 }));
      const l = generateLayout({ agents, projectName: 'P', leadLabel: 'PLAN' });
      expect(l.desks).toHaveLength(n);
      for (const [i, a] of l.desks.entries()) {
        expect(a.rect.x + a.rect.w).toBeLessThanOrEqual(l.ox + l.W * 16);
        expect(a.rect.y + a.rect.h).toBeLessThanOrEqual(l.oy + l.H * 16);
        for (const b of l.desks.slice(i + 1)) expect(a.rect.x + a.rect.w <= b.rect.x || b.rect.x + b.rect.w <= a.rect.x || a.rect.y + a.rect.h <= b.rect.y || b.rect.y + b.rect.h <= a.rect.y).toBe(true);
      }
      // Rows, not one long line: never more than 5 desks across.
      expect(new Set(l.desks.map((d) => d.x0)).size).toBeLessThanOrEqual(5);
    });
  }

  it('the layout key changes when a worker becomes active or inactive, so the static layer is redrawn with its desk dimmed or lit', () => {
    const a = generateLayout({ agents: [{ id: 'w0', name: 'W', color: '#2fa39a', active: true }], projectName: 'P', leadLabel: 'PLAN' });
    const b = generateLayout({ agents: [{ id: 'w0', name: 'W', color: '#2fa39a', active: false }], projectName: 'P', leadLabel: 'PLAN' });
    expect(a.key).not.toBe(b.key);
  });
});
