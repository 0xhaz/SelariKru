// The live layer of the kedai studio (H7), redrawn every frame. SelariKru's own drawing: desk screens and lanterns, the paved delivery lane with its
// tiffin carriers, the verifier's gate, the almari rack lamps, the pull request tins, the sky between the louvres and the wall clock, the desk AI
// plates, the rooftop CLOUD sign and dish, and the fallback route up the stair. What each part shows is read from the office world (model.ts).

import { stateStyle, type RobotState } from '../../theme/tokens.ts';
import type { OfficeAgent, OfficePr, OfficeRack } from '../model.ts';
import { fit, tag, text, textW } from '../engine/font.ts';
import { C } from '../engine/palette.ts';
import { disc, drawRows, line, type Pen } from '../engine/pen.ts';
import { STAIR_X, type DeskSpot, type OfficeLayout, type PxRect, type Rack } from '../layout/layout.ts';
import { framed, uplinkDish } from './furniture.ts';
import { VERIFIER, VERIFIER_BLINK, VERIFIER_PAL } from './robots.ts';
import { dishSpot } from './static.ts';
import type { OfficeRoof, RoofBox } from '../roof.ts';

/** True on the second half of each period of `rate` per second. */
const pulseOn = (time: number, rate: number): boolean => ((time * rate) | 0) % 2 === 1;

/** What a desk's screen shows: lines of code while working, otherwise a small picture of the state. */
export function screenFace(p: Pen, sx: number, sy: number, state: RobotState, accent: string, time: number, seed: number) {
  const look = stateStyle[state];
  p.rect(sx, sy, 18, 11, state === 'offline' ? C.deep2 : C.screen);
  switch (state) {
    case 'needs_input': {
      const flash = pulseOn(time, 4);
      if (flash) p.rect(sx, sy, 18, 11, look.dim);
      p.rect(sx + 8, sy + 2, 2, 5, flash ? C.white : look.color);
      p.rect(sx + 8, sy + 8, 2, 1, flash ? C.white : look.color);
      return;
    }
    case 'in_review':
      for (const [dx, dy, w] of [[6, 2, 6], [7, 3, 4], [8, 4, 2], [8, 5, 2], [7, 6, 4], [6, 7, 6]] as const) p.rect(sx + dx, sy + dy, w, 1, look.color);
      return;
    case 'verified':
      for (const [dx, dy] of [[5, 5], [6, 6], [7, 7], [8, 6], [9, 5], [10, 4], [11, 3], [12, 2]] as const) p.rect(sx + dx, sy + dy, 1, 1, look.color);
      return;
    case 'unknown':
      text(p, '?', sx + 8, sy + 3, C.lav);
      return;
    case 'blocked':
      for (const bar of [6, 10]) p.rect(sx + bar, sy + 2, 2, 7, look.color);
      return;
    case 'idle': {
      // A kopi glass with rising steam, in the worker's colour.
      p.rect(sx + 7, sy + 4, 4, 5, accent);
      p.rect(sx + 11, sy + 5, 1, 2, accent);
      const wisp = ((time * 2 + seed) | 0) % 3;
      p.rect(sx + 8 + (wisp & 1), sy + 1 + (wisp >> 1), 1, 2, C.lav);
      return;
    }
    case 'offline':
      return;
    default: {
      const rows = (time * 3) | 0;
      const inks = [C.teal, C.gold, C.cream, C.leafL, C.peach];
      for (let r = 0; r < 5; r++) {
        const code = (rows + r) * 11 + seed * 7;
        p.rect(sx + 1 + (code % 4), sy + 1 + r * 2, 4 + ((code * 3) % 8), 1, inks[code % inks.length]!);
      }
      if (pulseOn(time, 3)) p.rect(sx + 1, sy + 10, 2, 1, C.white);
    }
  }
}

/** Small lanterns along a cubicle's top rail, in the state's colour. Needs input flashes; a working desk has one lantern brighter, moving along. */
export function deskLanterns(p: Pen, d: DeskSpot, ox: number, oy: number, state: RobotState, time: number) {
  const look = stateStyle[state];
  const quiet = state === 'idle' || state === 'offline' || state === 'unknown';
  const glow = state === 'needs_input' && pulseOn(time, 6) ? C.white : quiet ? look.dim : look.color;
  const lead = ((time * 5) | 0) % 12;
  let n = 0;
  for (const seg of [0, 2, 3, 4, 5, 6]) {
    for (const off of [3, 10]) {
      const lx = ox + (d.x0 + seg) * 16 + off;
      const ly = oy + d.y0 * 16;
      p.rect(lx, ly, 3, 4, C.ink);
      p.rect(lx + 1, ly + 1, 1, 2, state === 'working' && n === lead ? C.white : glow);
      n += 1;
    }
  }
}

/** The plan table's pendant lamp, in the colour of what the plan board shows. */
export function planLamp(p: Pen, ox: number, oy: number, state: RobotState, time: number) {
  const look = stateStyle[state];
  line(p, ox + 280, oy + 64, ox + 280, oy + 75, C.ink);
  framed(p, ox + 276, oy + 75, 9, 5, C.ink, state === 'needs_input' && pulseOn(time, 6) ? look.dim : look.color, 1);
}

/**
 * The delivery lane: terracotta pavers between gold kerbs, with a running line of chevrons showing which way the tiffins go, up the chute into the
 * rack room at the far end.
 */
export function deliveryLane(p: Pen, l: OfficeLayout, time: number) {
  const lane = l.belt;
  const shift = ((time * 24) | 0) % 8;
  const far = lane.topY !== null ? lane.x1 + 9 : lane.x1;
  const top = lane.y - 9;
  framed(p, lane.x0 - 6, top, far - lane.x0 + 6, 18, C.goldDark, C.tileTD, 2);
  for (let px = lane.x0 - 4; px < far - 2; px += 8) p.rect(px, top + 2, 1, 14, C.grout);
  for (let cx = lane.x0 + shift; cx < far - 6; cx += 8) { p.rect(cx, top + 7, 2, 1, C.tileTL); p.rect(cx + 1, top + 8, 2, 2, C.tileTL); p.rect(cx, top + 10, 2, 1, C.tileTL); }
  if (lane.topY !== null) {
    const cx = lane.x1 - 9;
    framed(p, cx, lane.topY, 18, lane.y - lane.topY + 9, C.goldDark, C.tileTD, 2);
    for (let cy = lane.y - shift; cy > lane.topY + 4; cy -= 8) { p.rect(cx + 7, cy, 1, 2, C.tileTL); p.rect(cx + 8, cy - 1, 2, 2, C.tileTL); p.rect(cx + 10, cy, 1, 2, C.tileTL); }
    p.rect(cx + 1, lane.topY - 6, 16, 6, C.deskDD);
  }
}

/** How the gate looks: resting, scanning a candidate while a task verifies, a pass, or changes requested. */
export type GateLook = 'idle' | 'reviewing' | 'passed' | 'changes';

/** The verifier's gate: a timber gateway under a clay roof, its scanning window, its signboard, and the inspector standing on top. */
export function verifierGate(p: Pen, g: PxRect, look: GateLook, since: number, time: number, label: string) {
  const mid = Math.round(g.x + g.w / 2);
  framed(p, g.x, g.y, g.w, 46, C.wood, C.wood, 1);
  p.rect(g.x + 1, g.y + 1, g.w - 2, 11, C.roof);
  for (let tile = g.x + 3; tile < g.x + g.w - 3; tile += 5) p.rect(tile, g.y + 2, 3, 9, C.roofD);
  for (const post of [g.x + 1, g.x + g.w - 8]) p.rect(post, g.y + 12, 7, 33, C.deskD);
  framed(p, g.x + 12, g.y + 15, 44, 22, C.ink, C.screen, 1);
  for (let scan = g.y + 18; scan < g.y + 35; scan += 4) p.rect(g.x + 14, scan, 40, 1, C.deep);
  if (look === 'reviewing') {
    framed(p, mid - 5, g.y + 21, 10, 9, C.gold, C.screen, 1);
    p.rect(mid - 1, g.y + 22, 2, 7, C.gold);
    p.rect(g.x + 13 + ((time * 30) % 42 | 0), g.y + 16, 1, 20, C.teal);
  } else if (look === 'passed') text(p, 'OK', mid - 3, g.y + 23, C.leafL);
  else if (look === 'changes') text(p, 'FIX', mid - 5, g.y + 23, C.red);
  const word = fit(label.toUpperCase(), g.w - 6);
  framed(p, mid - textW(word) / 2 - 3, g.y + 37, textW(word) + 6, 8, C.deep, C.deep, 1);
  text(p, word, mid - textW(word) / 2, g.y + 38, C.gold);
  const lamps = [6, 16, g.w - 22, g.w - 12];
  lamps.forEach((lx, k) => {
    const lit = look === 'reviewing' ? (k === ((time * 8) | 0) % 4 ? C.gold : C.goldDark)
      : look === 'passed' ? (pulseOn(time, 8) ? C.leafL : C.leafD)
        : look === 'changes' ? (pulseOn(time, 8) ? C.red : C.roofD) : C.deskDD;
    framed(p, g.x + lx, g.y + 3, 6, 5, C.ink, lit, 1);
  });
  const hop = look === 'reviewing' ? Math.round(Math.abs(Math.sin(time * 8)) * 2) : look === 'passed' ? Math.round(Math.sin(Math.min(1, since / 0.6) * Math.PI) * 6) : 0;
  disc(p, mid, g.y + 1, 4, C.ink, 0.25);
  drawRows(p, ((time * 10) | 0) % 31 === 0 ? VERIFIER_BLINK : VERIFIER, VERIFIER_PAL, mid - 5, g.y - 10 - hop);
}

/**
 * The lamps on each worker's almari rack: they chase down the panel while its worker holds an attempt, faster for busier states, and stay dark
 * otherwise. A running rack also wears a gold lamp on top, so "running" never rests on the moving lights alone.
 */
export function rackLamps(
  p: Pen, racks: Rack[], envs: readonly OfficeRack[], stateOf: (agentId: string | null) => RobotState | null, pulse: (name: string) => number, time: number,
) {
  const PACE: Record<RobotState, number> = { working: 9, in_review: 5, verified: 6, needs_input: 2, blocked: 2, idle: 1, offline: 0, unknown: 1 };
  for (const r of racks) {
    const env = envs.find((e) => e.agentId === r.agentId);
    const pace = env?.running ? PACE[stateOf(r.agentId) ?? 'idle'] : 0;
    const head = (time * pace) | 0;
    const flash = pulse(r.name);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 3; col++) {
        const step = row * 3 + col;
        let lamp: string = C.deep2;
        if (flash > 0.05) lamp = pulseOn(time, 12) ? C.leafL : C.leafD;
        else if (pace > 0 && (step + head) % 6 < 2) lamp = col === 2 ? C.gold : row % 2 ? C.teal : C.leafL;
        p.rect(r.x + 17 + col * 3, r.y + 14 + row * 10, 2, 2, lamp);
      }
    }
    if (env?.running) framed(p, r.x + 13, r.y - 4, 6, 4, C.ink, C.gold, 1);
    if (flash > 0.05) for (const [x, y, w, h] of [[r.x, r.y - 1, 32, 2], [r.x, r.y + r.h - 1, 32, 2], [r.x, r.y - 1, 2, r.h], [r.x + 30, r.y - 1, 2, r.h]] as const) p.rect(x, y, w, h, C.leafL, flash);
  }
}

/**
 * Pull requests as round biscuit tins on the shelves, newest last, three to a shelf. Colour only from the run's verification record: green verified,
 * grey not verified, amber out of date (with OLD above it).
 */
export function prTins(p: Pen, b: PxRect, prs: readonly OfficePr[]) {
  const shown = prs.slice(Math.max(0, prs.length - 6));
  for (let k = 0; k < shown.length; k++) {
    const pr = shown[k]!;
    const left = b.x + 4 + (k % 3) * 20;
    const top = b.y + 10 + ((k / 3) | 0) * 14;
    const band = pr.merged ? C.leafD : pr.verification === 'verified' ? C.green : pr.verification === 'out_of_date' ? C.orange : C.metalD;
    framed(p, left, top, 17, 13, pr.merged ? C.tileD : C.cream, pr.merged ? C.tileD : C.cream, 1);
    p.rect(left + 1, top + 1, 15, 2, C.metalL);
    text(p, `#${pr.num % 1000}`, left + 2, top + 3, C.ink);
    p.rect(left + 2, top + 9, 13, 2, band);
    if (pr.verification === 'out_of_date' && !pr.merged) text(p, 'OLD', left + 3, top - 6, C.goldDark);
  }
}

/** One bright pulse travels each cable tray from desk to rack while its worker is active; idle and offline trays stay still. */
export function cablePulses(p: Pen, l: OfficeLayout, stateOf: (agentId: string) => RobotState | null, time: number) {
  const PACE: Record<RobotState, number> = { working: 70, in_review: 30, verified: 45, needs_input: 0, blocked: 0, idle: 0, offline: 0, unknown: 0 };
  for (const cable of l.cables) {
    const st = stateOf(cable.agentId) ?? 'idle';
    if (PACE[st] === 0) continue;
    const legs = cable.pts.slice(1).map(([x, y], k) => ({ from: cable.pts[k]!, to: [x, y] as const, len: Math.abs(x - cable.pts[k]![0]) + Math.abs(y - cable.pts[k]![1]) }));
    const total = legs.reduce((sum, leg) => sum + leg.len, 0);
    let left = (time * PACE[st]) % Math.max(1, total);
    for (const leg of legs) {
      if (left > leg.len) { left -= leg.len; continue; }
      const f = leg.len === 0 ? 0 : left / leg.len;
      p.rect(Math.round(leg.from[0] + (leg.to[0] - leg.from[0]) * f) - 1, Math.round(leg.from[1] + (leg.to[1] - leg.from[1]) * f) - 1, 3, 3, C.cream);
      break;
    }
  }
}

/** The hour hand's tip for each hour on the 7 px clock face, and the minute hand's for each five minutes. */
const HOUR_TIP: readonly (readonly [number, number])[] = [[0, -3], [1, -3], [2, -2], [3, 0], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 0], [-2, -2], [-1, -3]];
const MINUTE_TIP: readonly (readonly [number, number])[] = [[0, -5], [2, -4], [4, -3], [5, 0], [4, 3], [2, 4], [0, 5], [-2, 4], [-4, 3], [-5, 0], [-4, -3], [-2, -4]];

/** The sky between the louvres, by the local hour (day, dusk or night), and the wall clock's hands. */
export function skyAndClock(p: Pen, l: OfficeLayout, time: number) {
  const pane = { x: l.ox + l.lounge.x0 * 16 + 81, y: l.oy + 22, w: 30, h: 28 };
  const now = new Date();
  const hour = now.getHours();
  const night = hour >= 20 || hour < 6;
  const dusk = hour === 18 || hour === 19 || hour === 6;
  const skyTop = night ? C.skyN : dusk ? C.terracotta : C.sky;
  const skyLow = night ? C.deep2 : dusk ? C.gold : C.skyL;
  for (let row = 0; row < pane.h; row += 2) p.rect(pane.x, pane.y + row, pane.w, 2, row < pane.h / 2 ? skyTop : skyLow);
  if (night) for (const [sx, sy] of [[4, 4], [12, 9], [20, 3], [26, 11]] as const) p.rect(pane.x + sx, pane.y + sy, 1, 1, Math.sin(time * 2 + sx) > -0.3 ? C.cream : C.lav);
  else {
    const drift = (time * 3) % (pane.w + 14);
    p.rect(pane.x + drift - 14, pane.y + 7, 12, 3, C.cloud);
    p.rect(pane.x + drift - 11, pane.y + 5, 6, 2, C.cloud);
  }
  // A row of shophouse roofs across the street, under the sky.
  for (let rx = 0; rx < pane.w; rx += 10) { p.rect(pane.x + rx, pane.y + pane.h - 7, 9, 7, C.wallD); p.rect(pane.x + rx, pane.y + pane.h - 9, 9, 2, C.roof); }
  const cx = l.ox + l.lounge.x0 * 16 - 8;
  const cy = l.oy + 36;
  const [hx, hy] = HOUR_TIP[hour % 12]!;
  const [mx, my] = MINUTE_TIP[Math.floor(now.getMinutes() / 5) % 12]!;
  line(p, cx, cy, cx + mx, cy + my, C.ink);
  line(p, cx, cy, cx + hx, cy + hy, C.terracotta);
}

/** A candidate on the lane: a three-tier tiffin carrier with its handle, tagged with the start of its commit. */
export function tiffin(p: Pen, cx: number, cy: number, label: string) {
  const x = Math.round(cx) - 4;
  const y = Math.round(cy) - 8;
  p.rect(x + 2, y - 2, 5, 1, C.ink);
  for (const side of [x + 2, x + 6]) p.rect(side, y - 1, 1, 2, C.ink);
  const tiers = [C.teal, C.terracotta, C.gold];
  p.rect(x, y + 1, 9, 9, C.ink);
  tiers.forEach((tier, k) => { p.rect(x + 1, y + 2 + k * 3, 7, 2, tier); p.rect(x + 1, y + 2 + k * 3, 2, 1, C.white); });
  tag(p, label, cx, y - 9, C.ink, C.gold);
}

/** The run's name on a gold-lettered strip over the plan board. */
export function planBanner(p: Pen, l: OfficeLayout, title: string) {
  const board = l.plan.board;
  // Kept clear of the stair (round 2): the title uses the wall from the left beam to just before the stair, so the plan revision still shows.
  const left = l.ox + 18;
  const room = l.ox + STAIR_X * 16 - 4 - left;
  tag(p, fit(title.toUpperCase(), room), left + room / 2, board.y - 11, C.deep, C.gold);
}

/**
 * The desk's AI plate (H4, enlarged for video in H7): a chip for this device or a cloud for Gemini in the cloud, with its word (DEVICE or CLOUD).
 * Observed is filled; expected (a call still in flight) is outlined with a "?" beside it, so the two differ without motion, and it flashes when motion
 * is allowed. The office summary and the team cards say the same in words.
 */
export function aiPlate(p: Pen, d: DeskSpot, ox: number, oy: number, ai: NonNullable<OfficeAgent['ai']>, time: number) {
  const expected = ai.state === 'expected';
  if (expected && pulseOn(time, 4)) return;
  const device = ai.place === 'device';
  const word = device ? 'DEVICE' : 'CLOUD';
  const ink = device ? C.device : C.cloudMark;
  const paleInk = device ? C.deviceL : C.cloudMarkL;
  const x = ox + d.x0 * 16 + 52;
  const y = oy + d.y0 * 16 - 15;
  const w = 22 + textW(word) + (expected ? 6 : 0);
  framed(p, x - 1, y - 1, w + 2, 14, C.ink, expected ? C.cream : ink, 1);
  const icon = { x: x + 2, y: y + 2 };
  p.rect(icon.x, icon.y, 14, 8, expected ? C.white : paleInk);
  if (expected) for (let dash = 0; dash < 14; dash += 2) { p.rect(icon.x + dash, icon.y, 1, 1, ink); p.rect(icon.x + dash, icon.y + 7, 1, 1, ink); }
  if (device) {
    framed(p, icon.x + 4, icon.y + 1, 6, 6, ink, expected ? C.white : paleInk, 1);
    for (const pin of [2, 4]) { p.rect(icon.x + 2, icon.y + pin, 2, 1, ink); p.rect(icon.x + 10, icon.y + pin, 2, 1, ink); }
  } else {
    p.rect(icon.x + 2, icon.y + 4, 10, 3, ink);
    p.rect(icon.x + 3, icon.y + 2, 4, 2, ink);
    p.rect(icon.x + 6, icon.y + 1, 4, 3, ink);
  }
  text(p, word, x + 18, y + 4, expected ? ink : C.white);
  if (expected) text(p, '?', x + 19 + textW(word) + 2, y + 4, C.ink);
}

/** How a roof box looks right now: a fresh discard, a fresh answer, a call expected here, or resting. */
export type RoofLook = 'violation' | 'observed' | 'expected' | 'idle';

/** Which look a box shows: a new discard first, then a new answer, then a call in flight. */
export function roofLook(box: RoofBox, fresh: { observed: boolean; violation: boolean }): RoofLook {
  if (fresh.violation && box.violation) return 'violation';
  if (fresh.observed && box.observed) return 'observed';
  if (box.expected.length > 0) return 'expected';
  return 'idle';
}

/** A small padlock: restricted work, kept on this device. */
function padlock(p: Pen, x: number, y: number) {
  p.rect(x + 1, y, 5, 1, C.ink); p.rect(x + 1, y, 1, 4, C.ink); p.rect(x + 5, y, 1, 4, C.ink);
  framed(p, x, y + 3, 7, 6, C.ink, C.gold, 1);
  p.rect(x + 3, y + 5, 1, 2, C.ink);
}

/**
 * The rooftop inference deck (round 4): ON THIS DEVICE · GEMINI NANO on the left and CLOUD · GEMINI on the right, with the uplink dish. Each box shows its
 * count (each task's last call in the run, as the top-bar counter counts), a dashed gold outline while a call is expected there (it pulses when motion
 * is allowed; the dashes and the EXPECTED words carry it without motion), a solid fill and "<task> · RAN HERE" when a conforming answer has just
 * landed, a red flash and DISCARDED for a route violation from that side, and a padlock on the device box while a restricted task's call runs. A
 * conforming fallback draws an arrow from the device box to the cloud box labelled FELL BACK.
 */
export function roofDeck(p: Pen, l: OfficeLayout, roof: OfficeRoof, fresh: { device: { observed: boolean; violation: boolean }; cloud: { observed: boolean; violation: boolean } }, time: number) {
  const boxes = [
    { box: roof.device, rect: l.roofBoxes.device, title: 'ON THIS DEVICE · GEMINI NANO', solid: C.device, pale: C.deviceL },
    { box: roof.cloud, rect: l.roofBoxes.cloud, title: 'CLOUD · GEMINI', solid: C.cloudMark, pale: C.cloudMarkL },
  ] as const;
  for (const { box, rect, title, solid, pale } of boxes) {
    const x = l.ox + rect.x;
    const y = l.oy + rect.y;
    const look = roofLook(box, fresh[box.place]);
    const fill = look === 'violation' ? (pulseOn(time, 6) ? C.red : C.roofD) : look === 'observed' ? solid : C.deep2;
    framed(p, x, y, rect.w, rect.h, C.ink, fill, 1);
    // Title plate.
    framed(p, x + 3, y + 3, Math.min(rect.w - 6, textW(title) + 6), 9, C.ink, look === 'observed' ? pale : C.deep, 1);
    text(p, title, x + 6, y + 5, look === 'observed' ? C.ink : C.gold);
    // Expected: a dashed gold outline (pulsing when motion is allowed).
    if (box.expected.length > 0) {
      const on = time === 0 || pulseOn(time, 3);
      for (let dx = 0; dx < rect.w; dx += 6) { p.rect(x + dx, y - 2, 3, 2, on ? C.gold : C.goldDark); p.rect(x + dx, y + rect.h, 3, 2, on ? C.gold : C.goldDark); }
      for (let dy = 0; dy < rect.h; dy += 6) { p.rect(x - 2, y + dy, 2, 3, on ? C.gold : C.goldDark); p.rect(x + rect.w, y + dy, 2, 3, on ? C.gold : C.goldDark); }
      text(p, fit(`EXPECTED: ${box.expected.join(', ')}`, rect.w - 10), x + 5, y + 16, C.gold);
    }
    // What last ran here, or what was discarded.
    if (look === 'violation' && box.violation) tag(p, fit(`DISCARDED: ${box.violation.task.toUpperCase()}`, rect.w - 12), x + rect.w / 2, y + rect.h - 22, C.ink, C.red);
    else if (box.violation) text(p, fit(`DISCARDED: ${box.violation.task.toUpperCase()}`, rect.w - 10), x + 5, y + rect.h - 22, C.red);
    else if (box.observed && look !== 'observed') text(p, fit(`LAST: ${box.observed.task.toUpperCase()}`, rect.w - 70), x + 5, y + rect.h - 22, C.metalL);
    if (look === 'observed' && box.observed) tag(p, fit(`${box.observed.task.toUpperCase()} · RAN HERE`, rect.w - 12), x + rect.w / 2, y + rect.h - 30, C.ink, C.white);
    // The count.
    const count = `${box.count} TASK${box.count === 1 ? '' : 'S'}`;
    framed(p, x + 3, y + rect.h - 12, textW(count) + 6, 9, C.ink, C.cream, 1);
    text(p, count, x + 6, y + rect.h - 10, C.ink);
    if (box.place === 'device' && box.locked) padlock(p, x + rect.w - 12, y + 3);
  }
  // The uplink dish, in the cloud box; it lights and beams while a cloud call is in flight.
  const d = dishSpot(l);
  uplinkDish(p, l.ox + d.x, l.oy + d.y);
  const tipX = l.ox + d.x + 17;
  const tipY = l.oy + d.y + 1;
  const lit = roof.cloud.expected.length > 0;
  framed(p, tipX - 1, tipY - 1, 3, 3, C.ink, lit ? C.gold : C.metalDD, 1);
  if (lit) {
    const ring = time === 0 ? 3 : ((time * 6) | 0) % 4;
    for (let k = 0; k < 4; k++) {
      const r = 4 + k * 4;
      const strength = k === ring ? 1 : 0.45;
      p.rect(tipX + r, tipY - r, 3, 1, C.gold, strength);
      p.rect(tipX + r + 2, tipY - r + 1, 1, 2, C.gold, strength);
    }
  }
  // A conforming fallback: an arrow from the device box to the cloud box.
  if (roof.fellBack) {
    const dev = l.roofBoxes.device;
    const cloud = l.roofBoxes.cloud;
    const ay = l.oy + dev.y + dev.h / 2;
    const ax0 = l.ox + dev.x + dev.w - 30;
    const ax1 = l.ox + cloud.x + 18;
    p.rect(ax0, ay - 1, ax1 - ax0, 3, C.ink);
    p.rect(ax0, ay, ax1 - ax0, 1, C.gold);
    for (let k = 0; k < 4; k++) p.rect(ax1 - k, ay - k, 1, k * 2 + 1, C.gold);
    if (time > 0) p.rect(ax0 + ((time * 40) % (ax1 - ax0)), ay - 1, 3, 3, C.white);
    tag(p, fit(`FELL BACK: ${roof.fellBack.task.toUpperCase()}`, 120), (ax0 + ax1) / 2, ay - 12, C.ink, C.gold);
  }
}

/** A device call in flight: a soft green glow round the worker's desk screen, so a call that stays on the device is seen too. */
export function deviceGlow(p: Pen, d: DeskSpot, ox: number, oy: number, time: number) {
  const sx = ox + (d.x0 + 2) * 16 + 15;
  const sy = oy + d.y0 * 16 + 12;
  const strength = time > 0 ? 0.35 + 0.25 * Math.sin(time * 5) : 0.5;
  for (const [x, y, w, h] of [[sx - 4, sy - 4, 26, 2], [sx - 4, sy + 13, 26, 2], [sx - 4, sy - 4, 2, 19], [sx + 20, sy - 4, 2, 19]] as const) p.rect(x, y, w, h, C.leafL, strength);
}

/** The small tiffin a robot carries over its head on the way to the lane (H7 fix: only after its attempt really published a change). */
export function carriedTiffin(p: Pen, cx: number, top: number) {
  const x = Math.round(cx) - 3;
  const y = Math.round(top) - 6;
  p.rect(x + 2, y - 1, 3, 1, C.ink);
  p.rect(x, y, 7, 7, C.ink);
  [C.teal, C.terracotta, C.gold].forEach((tier, k) => p.rect(x + 1, y + 1 + k * 2, 5, 1, tier));
}

/** The Project Manager's talk bubble: a cream board with three dots (H11). */
export function pmBubble(p: Pen, cx: number, top: number, time: number) {
  const x = Math.round(cx) - 7;
  framed(p, x, top, 15, 9, C.ink, C.cream, 1);
  for (let k = 0; k < 3; k++) p.rect(x + 4 + k * 3, top + 4 - (time > 0 && ((time * 4) | 0) % 3 === k ? 1 : 0), 2, 1, C.tealDark);
  p.rect(x + 6, top + 9, 2, 2, C.ink);
}

/** The Project Manager's name tag, gold on deep green. */
export function pmTag(p: Pen, name: string, cx: number, top: number) {
  tag(p, fit(name.toUpperCase(), 80), cx, top, C.deep, C.gold);
}
