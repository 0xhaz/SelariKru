// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Robot workers: where they walk and what they show, derived from the worker's state. Walking is decoration: where a robot stands never
// says anything the team panel does not.

import type { RobotState } from '../../theme/tokens.ts';
import type { Tile } from '../engine/path.ts';
import { ROBOT_H, ROBOT_W, robotCanvases, type Facing } from '../draw/robots.ts';
import { tileCentre, type DeskAgent, type OfficeLayout } from '../layout/layout.ts';

export type Face = 'up' | 'down' | 'left' | 'right';
export type EmoteType = 'talk' | 'coffee';

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
  carry: number | null = null; // PR number being carried
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

/** Decides each robot's next move from its worker's state. */
export function think(bot: Bot, l: OfficeLayout, state: RobotState, simT: number, rand: () => number): void {
  if (bot.path.length) return;
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
