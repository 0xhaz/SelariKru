import { describe, expect, it } from 'vitest';
import { generateLayout, tileCentre, type OfficeLayout } from '../layout/layout.ts';
import type { Facing } from '../draw/robots.ts';
import { Bot } from './bots.ts';
import { createPm, pmSpot, thinkPm, type PmContext } from './pm.ts';

const sprites = {} as Record<Facing, HTMLCanvasElement>;
const layout = (): OfficeLayout => generateLayout({ agents: [{ id: 'w1', name: 'W1', color: '#2fa39a' }, { id: 'w2', name: 'W2', color: '#c06a4a' }], projectName: 'P', leadLabel: 'PLAN' });

/** Runs the PM for `seconds` of animation; returns every tile it stood on and the steps it arrived at. */
function run(pm: Bot, l: OfficeLayout, ctx: PmContext, seconds: number, from = 0): { tiles: string[]; arrived: string[]; t: number } {
  const tiles: string[] = [];
  const arrived: string[] = [];
  let t = from;
  for (let i = 0; i < seconds * 20; i++) {
    t += 0.05;
    const step = thinkPm(pm, l, ctx, t);
    if (step) arrived.push(step.agentId ? `${step.to}:${step.agentId}` : step.to);
    pm.move(0.05, l);
    const [x, y] = pm.tile(l);
    if (tiles.at(-1) !== `${x},${y}`) tiles.push(`${x},${y}`);
  }
  return { tiles, arrived, t };
}
const at = (pm: Bot, l: OfficeLayout, tile: readonly [number, number]) => { const c = tileCentre(l, [tile[0], tile[1]]); return Math.hypot(c.x - pm.x, c.y - pm.y) < 1; };

describe('P1: the Project Manager walks like the crew, on the walk grid, only on its errands', () => {
  it('with no errand it rests at its desk, seated and facing the desk; it never wanders', () => {
    const l = layout();
    const pm = createPm(l, sprites);
    const ctx: PmContext = { meeting: false, agentTile: () => null };
    const { tiles } = run(pm, l, ctx, 5);
    expect(tiles).toEqual([`${l.lead.seat[0]},${l.lead.seat[1]}`]);
    expect(pm.seated).toBe(true);
    expect(pm.face).toBe('up');
  });

  it('walks to the shared table tile by tile, one step at a time (no teleport), and back to its desk', () => {
    const l = layout();
    const pm = createPm(l, sprites);
    pm.queue.push([{ to: 'pmTable' }]);
    const there = run(pm, l, { meeting: true, agentTile: () => null }, 15);
    expect(at(pm, l, l.table.pmSpot)).toBe(true);
    expect(there.tiles.length).toBeGreaterThan(2);
    for (let i = 1; i < there.tiles.length; i++) {
      const [ax, ay] = there.tiles[i - 1]!.split(',').map(Number);
      const [bx, by] = there.tiles[i]!.split(',').map(Number);
      expect(Math.abs(ax! - bx!) + Math.abs(ay! - by!)).toBe(1);
    }
    pm.queue.push([{ to: 'pmHome' }]);
    run(pm, l, { meeting: false, agentTile: () => null }, 15, there.t);
    expect(at(pm, l, l.lead.seat)).toBe(true);
    expect(pm.seated).toBe(true);
  });

  it('goes to the plan board, then to a worker away from its desk, and stands beside it facing it, then home', () => {
    const l = layout();
    const pm = createPm(l, sprites);
    const worker: [number, number] = [10, 11];
    const ctx: PmContext = { meeting: false, agentTile: (id) => (id === 'w2' ? worker : null) };
    pm.queue.push([{ to: 'pmBoard', linger: 1, emote: 'talk' }, { to: 'pmHome' }]);
    pm.queue.push([{ to: 'pmDelegate', agentId: 'w2', linger: 1, emote: 'talk' }, { to: 'pmHome' }]);
    const r = run(pm, l, ctx, 40);
    // Straight from the board to the worker: the walk home between the two trips is skipped.
    expect(r.arrived).toEqual(['pmBoard', 'pmDelegate:w2', 'pmHome']);
    const beside = pmSpot(pm, l, { to: 'pmDelegate', agentId: 'w2' }, ctx);
    expect(Math.abs(beside.tile[0] - worker[0]) + Math.abs(beside.tile[1] - worker[1])).toBe(1);
    expect(at(pm, l, l.lead.seat)).toBe(true);
  });

  it('at the plan board it faces the board; at the table it faces the table; it shows the talk emote where the step says', () => {
    const l = layout();
    const pm = createPm(l, sprites);
    expect(pmSpot(pm, l, { to: 'pmBoard' }, { meeting: false, agentTile: () => null })).toMatchObject({ tile: l.plan.spot, face: 'up', seated: false });
    expect(pmSpot(pm, l, { to: 'pmTable' }, { meeting: true, agentTile: () => null })).toMatchObject({ tile: l.table.pmSpot, face: 'right' });
    expect(pmSpot(pm, l, { to: 'pmHome' }, { meeting: true, agentTile: () => null }).tile).toEqual(l.table.pmSpot);
    expect(pmSpot(pm, l, { to: 'pmHome' }, { meeting: false, agentTile: () => null })).toMatchObject({ tile: l.lead.seat, seated: true, face: 'up' });
    pm.queue.push([{ to: 'pmBoard', linger: 2, emote: 'talk' }]);
    let shown = false;
    let t = 0;
    for (let i = 0; i < 400 && !shown; i++) { t += 0.05; thinkPm(pm, l, { meeting: false, agentTile: () => null }, t); pm.move(0.05, l); shown = pm.emote?.type === 'talk'; }
    expect(shown).toBe(true);
    expect(at(pm, l, l.plan.spot)).toBe(true);
  });
});
