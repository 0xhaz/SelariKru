// The Project Manager robot (P1). SelariKru's own. It walks like the crew, on the same walk grid and with the same errand queue, and every walk follows a
// real event (errands.ts: pmErrands): a meeting at the shared table, a plan revision accepted, a task delegated. With no errand it rests at its desk, or at
// the shared table while a meeting is on there. It never wanders.

import type { Facing } from '../draw/robots.ts';
import { PM_COLOR } from '../draw/robots.ts';
import type { Tile } from '../engine/path.ts';
import { tileCentre, type OfficeLayout } from '../layout/layout.ts';
import { Bot, type Face } from './bots.ts';
import type { ErrandStep } from './errands.ts';

/** What the PM's places depend on, read from the scene each frame. */
export interface PmContext {
  /** A meeting is on at the shared table: the PM's home is its place there. */
  readonly meeting: boolean;
  /** Where a worker's robot is now, or null when it is not in the office. */
  readonly agentTile: (agentId: string) => Tile | null;
}

/** The PM's robot id inside the scene. Never a worker id. */
export const PM_BOT_ID = 'pm';

/** A Bot in the PM's own frames, hovering, seated at its desk. */
export function createPm(l: OfficeLayout, sprites: Record<Facing, HTMLCanvasElement>, name = 'Project Manager'): Bot {
  const pm = new Bot({ id: PM_BOT_ID, name, color: PM_COLOR }, 0, sprites);
  pm.hover = true;
  placePm(pm, l, { tile: l.lead.seat, face: 'up', seated: true });
  return pm;
}

export function placePm(pm: Bot, l: OfficeLayout, spot: { tile: Tile; face: Face; seated: boolean }): void {
  Object.assign(pm, tileCentre(l, spot.tile));
  pm.path = [];
  pm.face = spot.face;
  pm.seated = spot.seated;
}

/** Beside a worker: the first open tile left, right, below or above it, and the way to face it from there. */
function beside(l: OfficeLayout, at: Tile): { tile: Tile; face: Face } {
  const around: [Tile, Face][] = [[[at[0] - 1, at[1]], 'right'], [[at[0] + 1, at[1]], 'left'], [[at[0], at[1] + 1], 'up'], [[at[0], at[1] - 1], 'down']];
  for (const [tile, face] of around) if (l.grid.ok(tile[0], tile[1])) return { tile, face };
  return { tile: l.grid.nearest(at[0], at[1]), face: 'down' };
}

/** Where a PM step goes, how it faces there and whether it sits. */
export function pmSpot(pm: Bot, l: OfficeLayout, step: Pick<ErrandStep, 'to' | 'agentId'>, ctx: PmContext): { tile: Tile; face: Face; seated: boolean } {
  const desk = { tile: l.lead.seat, face: 'up' as Face, seated: true };
  const table = { tile: l.table.pmSpot, face: 'right' as Face, seated: false };
  switch (step.to) {
    case 'pmTable': return table;
    case 'pmBoard': return { tile: l.plan.spot, face: 'up', seated: false };
    case 'pmDelegate': {
      const worker = step.agentId ? ctx.agentTile(step.agentId) : null;
      return worker ? { ...beside(l, worker), seated: false } : { tile: pm.tile(l), face: pm.face, seated: false };
    }
    case 'pmHome': return ctx.meeting ? table : desk;
    case 'here': return { tile: pm.tile(l), face: pm.face, seated: pm.seated };
    default: return desk;
  }
}

/**
 * The PM's next move: its errand first, then home. Returns the step it has just arrived at (once), so the scene can show what happens there: the envelope
 * and emotes of a delegation, the pins on the plan board.
 */
export function thinkPm(pm: Bot, l: OfficeLayout, ctx: PmContext, simT: number): ErrandStep | null {
  if (pm.path.length) return null;
  const q = pm.queue;
  // From one trip straight to the next, not home in between.
  q.skipTrailing('pmHome');
  const step = q.current();
  if (step) {
    if (q.there) { q.tick(simT); return null; }
    const spot = pmSpot(pm, l, step, ctx);
    const [tx, ty] = pm.tile(l);
    if (tx !== spot.tile[0] || ty !== spot.tile[1]) {
      pm.goTo(l, spot.tile);
      if (pm.path.length) return null;
    }
    q.arrived(simT);
    pm.face = spot.face;
    pm.seated = spot.seated;
    if (step.emote) pm.emote = { type: step.emote, until: simT + Math.max(1.6, step.linger ?? 0) };
    return step;
  }
  const home = pmSpot(pm, l, { to: 'pmHome' }, ctx);
  const c = tileCentre(l, home.tile);
  if (Math.abs(pm.x - c.x) < 1 && Math.abs(pm.y - c.y) < 1) {
    pm.face = home.face;
    pm.seated = home.seated;
    return null;
  }
  pm.goTo(l, home.tile);
  return null;
}
