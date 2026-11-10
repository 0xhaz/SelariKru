// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Owns the office canvas. It reads the office world it is given and never writes project data: hover, clicks and zoom go out through the
// hooks. The reference ran on PixiJS; this draws the same pixel art with a plain 2D canvas.

import { stateStyle, type RobotState } from '../theme/tokens.ts';
import { Bot, seatOf, think } from './actors/bots.ts';
import { Effects } from './actors/effects.ts';
import { BeltPath, restingPlace, updateParcels, type Parcel } from './actors/parcels.ts';
import { PlanNotes } from './actors/planNotes.ts';
import * as live from './draw/live.ts';
import { drawEmote, drawFace, drawNameTag, drawSelection, drawShadow } from './draw/overlay.ts';
import { buildStatic } from './draw/static.ts';
import { Camera, type Insets, type WorldTransform } from './engine/camera.ts';
import { C } from './engine/palette.ts';
import { CanvasPen } from './engine/pen.ts';
import { mulberry32 } from './engine/random.ts';
import { generateLayout, layoutKey, tileCentre, type LayoutInput, type OfficeLayout, type PxRect } from './layout/layout.ts';
import type { OfficeParcel, OfficeWorld } from './model.ts';
import { attachInput, type SceneHooks } from './sceneInput.ts';

export class OfficeScene {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly transform: WorldTransform = { x: 0, y: 0, scale: 2 };
  readonly camera: Camera;
  world: OfficeWorld | null = null;
  layout: OfficeLayout | null = null;
  private staticCanvas: HTMLCanvasElement | null = null;
  belt: BeltPath | null = null;
  readonly bots = new Map<string, Bot>();
  private parcels: Parcel[] = [];
  private prs = new Map<number, OfficeParcel>();
  private readonly notes = new PlanNotes();
  private readonly effects = new Effects();
  private gateMode: { mode: live.GateMode; at: number } = { mode: 'idle', at: 0 };
  hover: { rect: PxRect; agentId: string | null } | null = null;
  private t = 0;
  private dt = 0;
  private last = 0;
  private raf = 0;
  private dirty = true;
  readonly reducedMotion: boolean;
  private readonly rand = mulberry32(3);
  private readonly cleanups: (() => void)[] = [];
  private homed = false;

  constructor(private readonly host: HTMLElement, readonly hooks: SceneHooks, insets: () => Insets) {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pixelated block h-full w-full';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.camera = new Camera(this.transform, () => ({ w: this.host.clientWidth, h: this.host.clientHeight }), insets, () => this.reducedMotion);
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(this.host.clientWidth * dpr));
      this.canvas.height = Math.max(1, Math.round(this.host.clientHeight * dpr));
      if (this.layout && !this.homed) { this.camera.home(false); this.homed = true; } else this.camera.apply();
      this.invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    this.cleanups.push(() => observer.disconnect());
    resize();
    this.cleanups.push(attachInput(this));
    if (!this.reducedMotion) this.raf = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.canvas.remove();
  }

  /** Asks for one more frame. Under reduced motion nothing animates, so the canvas is drawn only when something changed. */
  invalidate(): void {
    this.dirty = true;
    if (this.reducedMotion && this.raf === 0) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  zoomBy(delta: number): void {
    this.camera.zoomBy(delta);
    this.invalidate();
  }

  focusAgent(id: string): void {
    const b = this.bots.get(id);
    if (!b) return;
    this.camera.flyTo(b.x, b.y - 10, Math.max(this.camera.zoom, Math.min(4, this.camera.fitZoom() + 1)));
    this.invalidate();
  }

  home(): void {
    this.camera.home();
    this.invalidate();
  }

  stateOf(id: string | null): RobotState {
    return this.world?.agents.find((a) => a.id === id)?.state ?? 'unknown';
  }

  colorOf(id: string | null): string {
    return this.world?.agents.find((a) => a.id === id)?.color ?? '#ffe9a8'; // no owner: a plain yellow note
  }

  botRect(b: Bot): PxRect {
    return { x: Math.round(b.x) - 7, y: b.headY - 1, w: 14, h: Math.round(b.y) - b.headY + 3 };
  }

  // ------------------------------------------------------------ sync

  setWorld(world: OfficeWorld): void {
    this.world = world;
    const input: LayoutInput = { agents: world.agents.map((a) => ({ id: a.id, name: a.name, color: a.color })), projectName: world.projectName };
    const key = layoutKey(input);
    const first = this.layout === null;
    if (!this.layout || this.layout.key !== key) {
      const l = generateLayout(input);
      this.layout = l;
      this.belt = new BeltPath(l);
      this.staticCanvas = buildStatic(l, input);
      this.camera.setWorldSize(l.worldW, l.worldH);
      if (first) { this.camera.home(false); this.homed = this.host.clientWidth > 0; }
      for (const b of this.bots.values()) {
        b.errand = null;
        b.path = [];
        Object.assign(b, tileCentre(l, l.grid.nearest(...b.tile(l))));
      }
    }
    const l = this.layout;
    const ids = new Set(input.agents.map((a) => a.id));
    for (const id of [...this.bots.keys()]) if (!ids.has(id)) this.bots.delete(id);
    input.agents.forEach((a, i) => {
      const existing = this.bots.get(a.id);
      if (existing) {
        existing.restyle(a);
        existing.index = i;
        return;
      }
      const bot = new Bot(a, i);
      // On first sight a robot starts at its desk; one that joins later walks in from the door.
      const seat = seatOf(bot, l);
      Object.assign(bot, tileCentre(l, first || !seat || this.reducedMotion ? (seat ?? l.door) : l.door));
      this.bots.set(a.id, bot);
    });

    // Parcels: one per pull request. Closed-without-merge ones leave the office.
    const belt = this.belt!;
    const prev = this.prs;
    this.prs = new Map(world.parcels.filter((p) => !p.closed).map((p) => [p.num, p]));
    this.parcels = this.parcels.filter((p) => this.prs.has(p.num) && p.mode !== 'gone');
    for (const pr of this.prs.values()) {
      if (this.parcels.some((p) => p.num === pr.num)) continue;
      if (pr.merged && !prev.has(pr.num)) continue; // already merged when first seen: nothing to deliver
      const fresh = first || this.reducedMotion;
      this.parcels.push({ num: pr.num, mode: 'belt', s: fresh ? restingPlace(pr, belt) : 0 });
    }
    for (const pr of this.prs.values()) {
      const before = prev.get(pr.num);
      if (before && before.review !== pr.review && pr.review === 'changes') this.gateMode = { mode: 'changes', at: this.t };
    }
    if (this.reducedMotion) {
      for (const p of this.parcels) {
        const pr = this.prs.get(p.num)!;
        if (pr.merged) p.mode = 'gone';
        else p.s = restingPlace(pr, belt);
      }
    }
    this.invalidate();
  }

  // ------------------------------------------------------------ frame

  private readonly tick = (now: number): void => {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.step(dt);
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  private step(dt: number): void {
    const l = this.layout;
    if (!l || !this.belt) return;
    this.t += dt;
    this.dt = dt;
    const t = this.t;
    this.camera.update(dt);
    for (const bot of this.bots.values()) {
      const state = this.stateOf(bot.config.id);
      bot.pause = Math.max(0, bot.pause - dt);
      if (state !== 'idle' && bot.errand && (bot.errand.kind === 'coffee' || bot.errand.kind === 'wander')) {
        bot.errand = null;
        bot.path = [];
        bot.pause = 0;
      }
      think(bot, l, state, t, this.rand);
      bot.move(dt, l);
    }
    updateParcels(this.parcels, this.prs, this.belt, dt, (p) => {
      const pos = this.belt!.pos(this.belt!.len);
      this.effects.text(`#${p.num} MERGED`, pos.x, pos.y - 26, C.green);
    });
    this.effects.update(dt);
    const verifying = this.world?.verifying ?? false;
    if (this.gateMode.mode === 'changes' && t - this.gateMode.at > 1.6) this.gateMode = { mode: 'idle', at: t };
    if (this.gateMode.mode === 'idle' && verifying) this.gateMode = { mode: 'reviewing', at: t };
    if (this.gateMode.mode === 'reviewing' && !verifying) this.gateMode = { mode: 'idle', at: t };
  }

  /** Under reduced motion: robots sit where their state puts them, without walking, and nothing blinks. */
  private settle(): void {
    const l = this.layout;
    if (!l) return;
    for (const bot of this.bots.values()) {
      const state = this.stateOf(bot.config.id);
      bot.errand = null;
      bot.pause = 0;
      think(bot, l, state === 'idle' ? 'working' : state, 0, () => 0);
      bot.jump(l);
      think(bot, l, state === 'idle' ? 'working' : state, 0, () => 0);
      if (state === 'idle') { bot.seated = false; bot.face = 'down'; }
    }
    this.gateMode = { mode: this.world?.verifying ? 'reviewing' : 'idle', at: 0 };
  }

  private draw(): void {
    const l = this.layout;
    const world = this.world;
    if (!this.dirty && this.reducedMotion) return;
    this.dirty = false;
    const g = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = C.grass;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!l || !world || !this.staticCanvas) return;
    if (this.reducedMotion) this.settle();
    const t = this.reducedMotion ? 0 : this.t;
    const slow = Math.floor(t * 8) / 8; // the reference's slow layer ran at about 8 fps
    const s = this.transform.scale * dpr;
    g.setTransform(s, 0, 0, s, this.transform.x * dpr, this.transform.y * dpr);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.staticCanvas, 0, 0);
    const p = new CanvasPen(g);

    live.drawWindowAndClock(p, l, slow);
    for (const d of l.desks) live.drawScreen(p, l.ox + (d.x0 + 2) * 16 + 15, l.oy + d.y0 * 16 + 12, this.stateOf(d.agentId), this.colorOf(d.agentId), slow, d.index);
    live.drawPrBoard(p, l.prBoard, [...this.prs.values()].sort((a, b) => a.num - b.num));

    live.drawPlanTitle(p, l, 'CURRENT RUN');
    this.notes.update(world.notes, l.plan.board, this.dt, t, this.reducedMotion);
    this.notes.draw(p, world.notes, (id) => this.colorOf(id), t);
    for (const d of l.desks) live.drawDeskStrip(p, d, l.ox, l.oy, this.stateOf(d.agentId), t);
    live.drawBelt(p, l, t);
    for (const parcel of this.parcels) {
      if (parcel.mode === 'gone') continue;
      const pos = this.belt!.pos(parcel.s);
      live.drawParcel(p, pos.x, pos.y, parcel.num, C.yellow, true);
    }
    live.drawGate(p, l.gate, this.gateMode.mode, t - this.gateMode.at, t, 'VERIFY');

    const bots = [...this.bots.values()];
    for (const bot of bots) bot.render(t, this.stateOf(bot.config.id));
    for (const bot of bots) drawShadow(p, bot);
    for (const bot of [...bots].sort((a, b) => a.y - b.y)) g.drawImage(bot.sprite, bot.spriteX, bot.spriteY);
    for (const bot of bots) {
      const state = this.stateOf(bot.config.id);
      drawFace(p, bot, state, t);
      drawEmote(p, bot, state, t, t);
    }
    // Under reduced motion every name shows, so no robot has to be hovered to be told apart.
    for (const bot of bots) if (this.reducedMotion || bot.path.length || this.hover?.agentId === bot.config.id) drawNameTag(p, bot);
    this.effects.draw(p, (id) => { const b = this.bots.get(id); return b ? { x: b.x, y: b.headY + 10 } : null; });
    if (this.hover) drawSelection(p, this.hover.rect, this.reducedMotion ? 0.5 : t);
  }

  /** Where a robot is on screen, in CSS pixels relative to the canvas. For tests and the camera; null when it is not in the office. */
  robotOnScreen(id: string): { x: number; y: number } | null {
    const b = this.bots.get(id);
    if (!b) return null;
    const r = this.botRect(b);
    return this.camera.worldToScreen(r.x + r.w / 2, r.y + r.h / 2);
  }

  /** The words for what the pointer is over, for the tooltip. */
  describe(kind: 'agent' | 'plan' | 'prs' | 'gate', id: string): { title: string; sub?: string } {
    const w = this.world;
    if (!w) return { title: '' };
    if (kind === 'agent') {
      const a = w.agents.find((x) => x.id === id);
      return a ? { title: `${a.name} · ${stateStyle[a.state].glyph} ${a.label}`, sub: a.taskTitle ?? 'No task' } : { title: id };
    }
    if (kind === 'plan') return { title: 'Plan wall', sub: `${w.notes.length} task${w.notes.length === 1 ? '' : 's'} on the current run. Opens Pipeline.` };
    const open = w.parcels.filter((x) => !x.merged && !x.closed).length;
    if (kind === 'gate') return { title: 'Verification gate', sub: `${w.verifying ? 'A task is verifying' : 'Nothing is verifying'}. Opens Evidence and PR.` };
    return { title: 'Pull requests', sub: `${open} open. Opens Evidence and PR.` };
  }
}
