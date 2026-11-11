// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Robot workers: where they walk and what they show, derived from the worker's state. Walking is decoration: where a robot stands never
// says anything the team panel does not.

import type { RobotState } from '../../theme/tokens.ts';
import type { Tile } from '../engine/path.ts';
import { ROBOT_H, ROBOT_W, robotCanvases, type Facing } from '../draw/robots.ts';
import { tileCentre, type DeskAgent, type OfficeLayout } from '../layout/layout.ts';
import { ErrandQueue, type ErrandPlace } from './errands.ts';

export type Face = 'up' | 'down' | 'left' | 'right';
export type EmoteType = 'talk' | 'coffee' | 'mail' | 'ok' | 'heart';

type Errand = { kind: 'plan' } | { kind: 'drop'; onArrive: () => void; deadline: number } | { kind: 'coffee' } | { kind: 'wander' };

const SPEED = 52; // px per second

export class Bot {
  x = 0;
  y = 0;
  path: Tile[] = [];
  face: Face = 'up';
  seated = false;
  errand: Errand | null = null;
  pause = 0; // seconds to linger before the next idle errand
  emote: { type: EmoteType; until: number } | null = null;
  carry: number | null = null; // 1 while carrying a tiffin to the lane
  /** Its event-driven errands (H7 fix): one at a time, each following a real event. */
  readonly queue = new ErrandQueue();
  headY = 0;
  /** The sprite to draw this frame, and where. */
  sprite: HTMLCanvasElement;
  spriteX = 0;
  spriteY = 0;
  private sprites: Record<Facing, HTMLCanvasElement>;

  constructor(public config: DeskAgent, public index: number) {
    this.sprites = robotCanvases(config.color);
    this.sprite = this.sprites.back;
  }

  get color(): string {
    return this.config.color;
  }

  restyle(config: DeskAgent): void {
    if (config.color !== this.config.color) this.sprites = robotCanvases(config.color);
    this.config = config;
  }

  tile(l: OfficeLayout): Tile {
    return [Math.floor((this.x - l.ox) / 16), Math.floor((this.y - l.oy) / 16)];
  }

  goTo(l: OfficeLayout, target: Tile): void {
    const [sx, sy] = l.grid.nearest(...this.tile(l));
    this.path = l.grid.find(sx, sy, target[0], target[1]);
    this.seated = false;
  }

  /** Under reduced motion a robot does not walk: it is placed where its path ends. */
  jump(l: OfficeLayout): void {
    const last = this.path.at(-1);
    if (!last) return;
    Object.assign(this, tileCentre(l, last));
    this.path = [];
  }

  move(dt: number, l: OfficeLayout): void {
    const first = this.path[0];
    if (!first) return;
    const next = tileCentre(l, first);
    const dx = next.x - this.x;
    const dy = next.y - this.y;
    const dist = Math.hypot(dx, dy);
    const step = SPEED * dt;
    if (Math.abs(dx) > Math.abs(dy)) this.face = dx > 0 ? 'right' : 'left';
    else if (Math.abs(dy) > 0.01) this.face = dy > 0 ? 'down' : 'up';
    if (dist <= step) {
      this.x = next.x;
      this.y = next.y;
      this.path.shift();
    } else {
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;
    }
  }

  /** Picks the sprite and its position for this frame. A worker stands on the floor; it bobs one pixel while it walks. */
  render(t: number, state: RobotState): void {
    const moving = this.path.length > 0;
    const bob = moving ? Math.floor(t * 8 + this.index) % 2 : 0;
    this.spriteX = Math.round(this.x) - ROBOT_W / 2;
    this.spriteY = Math.round(this.y) - ROBOT_H - bob;
    let f: Facing = 'front';
    if (this.face === 'up') f = this.seated && state === 'working' && Math.floor(t * 8) % 2 ? 'type' : 'back';
    else if (this.face === 'right') f = 'side';
    else if (this.face === 'left') f = 'sideL';
    this.sprite = this.sprites[f];
    this.headY = this.spriteY;
  }
}

/** Robots that sit at their desk: everything but idle. An unknown robot stays where it was last seen. */
const AT_DESK: ReadonlySet<RobotState> = new Set(['working', 'needs_input', 'in_review', 'verified', 'blocked', 'offline']);

/** Where an errand step goes, in tiles (a negative row is on the rooftop). */
export function placeTile(bot: Bot, l: OfficeLayout, place: ErrandPlace): Tile {
  switch (place) {
    case 'plan': return l.lead.seat;
    case 'drop': return l.desks.find((d) => d.agentId === bot.config.id)?.drop ?? l.door;
    case 'prs': return l.prBoard ? l.grid.nearest(Math.floor((l.prBoard.x - l.ox) / 16) + 1, Math.floor((l.prBoard.y - l.oy + l.prBoard.h) / 16) + 2) : l.door;
    case 'roofDevice': return l.roofWalk.deviceSpots[bot.index % Math.max(1, l.roofWalk.deviceSpots.length)] ?? l.roofWalk.top;
    case 'roofCloud': return l.roofWalk.cloudSpots[bot.index % Math.max(1, l.roofWalk.cloudSpots.length)] ?? l.roofWalk.top;
    case 'here': return bot.tile(l);
    default: return seatOf(bot, l) ?? l.door;
  }
}

/** Walks to a tile, by the stair when the rooftop is on either end of the way (the rooftop is outside the walk grid, so the climb is a straight line). */
export function routeTo(bot: Bot, l: OfficeLayout, target: Tile): void {
  const here = bot.tile(l);
  const onRoof = here[1] < 0;
  const toRoof = target[1] < 0;
  const { foot, top } = l.roofWalk;
  if (!onRoof && !toRoof) { bot.goTo(l, target); return; }
  if (onRoof && toRoof) { bot.path = [[target[0], here[1]], target]; bot.seated = false; return; }
  if (!onRoof) { bot.goTo(l, foot); bot.path.push(top, [target[0], top[1]], target); return; }
  bot.path = [[top[0], here[1]], top, foot];
  bot.path.push(...l.grid.find(foot[0], foot[1], target[0], target[1]));
  bot.seated = false;
}

/** Runs the current errand step. Returns false when the robot has no errand. */
function runErrand(bot: Bot, l: OfficeLayout, simT: number): boolean {
  const step = bot.queue.current();
  if (!step) return false;
  if (!bot.queue.there) {
    const target = placeTile(bot, l, step.to);
    const [tx, ty] = bot.tile(l);
    if (step.to === 'here' || (tx === target[0] && ty === target[1])) {
      bot.queue.arrived(simT);
      bot.carry = null;
      if (step.emote) bot.emote = { type: step.emote, until: simT + Math.max(1.6, step.linger ?? 0) };
      if (step.to === 'seat') { bot.seated = true; bot.face = 'up'; }
      else if (step.to !== 'here') bot.face = 'down';
    } else {
      bot.carry = step.carry ? 1 : null;
      routeTo(bot, l, target);
      if (!bot.path.length) bot.queue.arrived(simT);
    }
    return true;
  }
  bot.queue.tick(simT);
  return true;
}

/** Decides each robot's next move: its errand first, then what its worker's state asks for. */
export function think(bot: Bot, l: OfficeLayout, state: RobotState, simT: number, rand: () => number): void {
  if (bot.path.length) return;
  if (runErrand(bot, l, simT)) return;
  const seat = seatOf(bot, l);
  const atSeat = seat && Math.abs(bot.x - tileCentre(l, seat).x) < 1 && Math.abs(bot.y - tileCentre(l, seat).y) < 1;

  const e = bot.errand;
  if (e) {
    if (e.kind === 'drop') {
      bot.errand = null;
      e.onArrive();
      return;
    }
    if (e.kind === 'plan') bot.emote = { type: 'talk', until: simT + 1.6 };
    if (e.kind === 'coffee') bot.emote = { type: 'coffee', until: simT + 2.4 };
    bot.errand = null;
    bot.pause = e.kind === 'wander' ? 2 + rand() * 3 : 1.8;
    return;
  }
  if (bot.pause > 0) return;
  if (state === 'unknown') return;

  if (AT_DESK.has(state)) {
    if (seat && !atSeat) bot.goTo(l, seat);
    else {
      bot.seated = true;
      bot.face = 'up';
    }
    return;
  }
  // Idle: coffee, then wander.
  if (rand() < 0.5 && l.lounge.coffee.length) {
    bot.errand = { kind: 'coffee' };
    bot.goTo(l, l.lounge.coffee[bot.index % l.lounge.coffee.length]!);
  } else if (l.wander.length) {
    bot.errand = { kind: 'wander' };
    bot.goTo(l, l.wander[Math.floor(rand() * l.wander.length)]!);
  }
  if (!bot.path.length) bot.errand = null;
}

export function seatOf(bot: Bot, l: OfficeLayout): Tile | null {
  return l.desks.find((d) => d.agentId === bot.config.id)?.seat ?? null;
}

export function sendOnErrand(bot: Bot, l: OfficeLayout, errand: Errand, target: Tile): void {
  bot.errand = errand;
  bot.pause = 0;
  bot.goTo(l, target);
  if (!bot.path.length && errand.kind === 'drop') {
    bot.errand = null;
    errand.onArrive();
  }
}
