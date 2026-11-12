import { describe, expect, it } from 'vitest';
import { generateLayout } from './layout.ts';

const agents = (n: number, extra: Partial<{ active: boolean }> = {}) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, name: `W${i}`, color: '#2fa39a', active: i % 2 === 0, ...extra }));

/** H11, H9: the office grows with the team: a grid of worker desks, two rows of up to four, readable for 1 to 8 workers (and more). */
describe('the office layout grows with the team', () => {
  for (let n = 1; n <= 9; n++) {
    it(`${n} worker${n === 1 ? '' : 's'}: one desk each, none overlapping, all inside the building, at most four across`, () => {
      const l = generateLayout({ agents: agents(n), projectName: 'P', leadLabel: 'PLAN' });
      expect(l.desks).toHaveLength(n);
      for (const [i, a] of l.desks.entries()) {
        expect(a.rect.x + a.rect.w).toBeLessThanOrEqual(l.ox + l.W * 16);
        expect(a.rect.y + a.rect.h).toBeLessThanOrEqual(l.oy + l.H * 16);
        for (const b of l.desks.slice(i + 1)) expect(a.rect.x + a.rect.w <= b.rect.x || b.rect.x + b.rect.w <= a.rect.x || a.rect.y + a.rect.h <= b.rect.y || b.rect.y + b.rect.h <= a.rect.y).toBe(true);
      }
      // H9: a grid of up to four across; up to eight workers fit in two rows.
      expect(new Set(l.desks.map((d) => d.x0)).size).toBe(Math.min(4, n));
      expect(new Set(l.desks.map((d) => d.y0)).size).toBe(Math.ceil(n / 4));
    });
  }

  it('the layout key changes when a worker becomes active or inactive, so the static layer is redrawn with its desk dimmed or lit', () => {
    const a = generateLayout({ agents: [{ id: 'w0', name: 'W', color: '#2fa39a', active: true }], projectName: 'P', leadLabel: 'PLAN' });
    const b = generateLayout({ agents: [{ id: 'w0', name: 'W', color: '#2fa39a', active: false }], projectName: 'P', leadLabel: 'PLAN' });
    expect(a.key).not.toBe(b.key);
  });
});

describe('H9: roles with no worker get no desk, only one small sign', () => {
  it('a role no worker holds has no desk and no rack; one "+N roles" sign counts them', () => {
    const l = generateLayout({ agents: [{ id: 'w1', name: 'A', color: '#000' }, { id: 'role:qa', name: 'Qa', color: '#000', active: false, notStarted: true }, { id: 'role:web', name: 'Web', color: '#000', active: false, notStarted: true }], projectName: 'P', leadLabel: 'PLAN' });
    expect(l.desks.map((d) => d.agentId)).toEqual(['w1']);
    expect(l.racks).toEqual([]);
    expect(l.rolesSign).toMatchObject({ count: 2 });
    expect(l.hits.filter((h) => h.kind === 'roles')).toHaveLength(1);
  });

  it('with every role held there is no sign', () => {
    expect(generateLayout({ agents: agents(3), projectName: 'P', leadLabel: 'PLAN' }).rolesSign).toBeNull();
  });
});

describe('H9: the floor: the PM at the top centre, a shared table in the middle, and a kopitiam where the sandbox racks were', () => {
  const l = generateLayout({ agents: agents(6), projectName: 'P', leadLabel: 'PLAN' });
  const hallCentre = (1 + l.mainW) / 2;

  it('has no sandbox racks, no cables and no rack room', () => {
    expect(l.racks).toEqual([]);
    expect(l.cables).toEqual([]);
    expect(l.serverRoom).toBeNull();
    expect(l.hits.some((h) => h.kind === 'env')).toBe(false);
  });

  it('the Project Manager sits at the top centre of the hall', () => {
    expect(Math.abs(l.lead.seat[0] + 0.5 - hallCentre)).toBeLessThanOrEqual(1.5);
    expect(l.lead.seat[1]).toBeLessThanOrEqual(8);
  });

  it('the shared table is in the middle of the floor, below the PM and above the desks, with places to meet that can be walked to', () => {
    const t = l.table;
    const cx = (t.rect.x - l.ox) / 16 + t.rect.w / 32;
    expect(Math.abs(cx - hallCentre)).toBeLessThanOrEqual(1.5);
    expect(t.rect.y).toBeGreaterThan(l.lead.rect.y);
    expect(t.rect.y + t.rect.h).toBeLessThan(Math.min(...l.desks.map((d) => d.rect.y)));
    expect(t.spots.length).toBeGreaterThanOrEqual(2);
    const seat = l.desks[0]!.seat;
    for (const s of [t.pmSpot, ...t.spots]) {
      expect(l.grid.ok(s[0], s[1])).toBe(true);
      expect(l.grid.find(seat[0], seat[1], s[0], s[1]).length).toBeGreaterThan(0);
    }
  });

  it('the kopitiam is a room right of the hall, inside the building, with places to sit or stand that can be walked to from every desk', () => {
    const k = l.kopitiam;
    expect(k.x0).toBeGreaterThan(l.mainW);
    expect(k.x0 + k.w).toBeLessThanOrEqual(l.W - 1);
    expect(k.spots.length).toBeGreaterThanOrEqual(8);
    expect(k.spots.some((s) => s.sit)).toBe(true);
    expect(k.spots.some((s) => !s.sit)).toBe(true);
    for (const d of l.desks) for (const s of k.spots) {
      expect(s.tile[0]).toBeGreaterThanOrEqual(k.x0);
      expect(l.grid.find(d.seat[0], d.seat[1], s.tile[0], s.tile[1]).length).toBeGreaterThan(0);
    }
    expect(new Set(k.spots.map((s) => s.tile.join(','))).size).toBe(k.spots.length);
  });
});
