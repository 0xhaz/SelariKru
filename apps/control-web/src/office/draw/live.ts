// The live layer of the kedai studio (H7), redrawn every frame: desk screens and lamps, the delivery path with its tiffin carriers, the verifier's
// gate, the local racks, the pull request shelves, the louvre window and clock, the desk AI marks, the rooftop cloud deck and the fallback path.
// SelariKru's own drawing. What each part shows is read from the office world (model.ts); nothing here decides a state.

import { stateStyle, type RobotState } from '../../theme/tokens.ts';
import type { OfficeAgent, OfficePr, OfficeRack } from '../model.ts';
import { fit, tag, text, textW } from '../engine/font.ts';
import { C } from '../engine/palette.ts';
import { box, disc, drawRows, line, type Pen } from '../engine/pen.ts';
import type { DeskSpot, OfficeLayout, PxRect, Rack } from '../layout/layout.ts';
import { VERIFIER, VERIFIER_BLINK, VERIFIER_PAL } from './robots.ts';
import { dishSpot } from './static.ts';

const blink = (t: number, hz: number) => Math.floor(t * hz) % 2 === 1;

/** A desk's monitor: lines of code while working, otherwise a picture of the state. */
export function drawScreen(p: Pen, sx: number, sy: number, state: RobotState, color: string, t: number, variant: number) {
  p.rect(sx, sy, 18, 11, C.screen);
  const st = stateStyle[state];
  if (state === 'needs_input') {
    p.rect(sx, sy, 18, 11, blink(t, 4) ? st.dim : C.screen);
    p.rect(sx + 8, sy + 2, 2, 5, blink(t, 4) ? C.white : st.color);
    p.rect(sx + 8, sy + 8, 2, 1, blink(t, 4) ? C.white : st.color);
  } else if (state === 'in_review') {
    // An hourglass.
    const c = st.color;
    p.rect(sx + 6, sy + 2, 6, 1, c); p.rect(sx + 7, sy + 3, 4, 1, c); p.rect(sx + 8, sy + 4, 2, 2, c); p.rect(sx + 7, sy + 6, 4, 1, c); p.rect(sx + 6, sy + 7, 6, 1, c);
  } else if (state === 'verified') {
    for (let i = 0; i < 8; i++) p.rect(sx + 5 + i, sy + (i < 3 ? 5 + i : 10 - i), 1, 1, st.color);
  } else if (state === 'offline') {
    p.rect(sx, sy, 18, 11, C.deep2);
  } else if (state === 'unknown') {
    text(p, '?', sx + 8, sy + 3, C.lav);
  } else if (state === 'blocked') {
    p.rect(sx + 6, sy + 2, 2, 7, st.color);
    p.rect(sx + 10, sy + 2, 2, 7, st.color);
  } else if (state === 'idle') {
    // A screensaver: a kopi cup with steam, in the worker's colour.
    p.rect(sx + 6, sy + 5, 5, 4, color);
    p.rect(sx + 11, sy + 6, 1, 2, color);
    const k = Math.floor(t * 2 + variant) % 3;
    p.rect(sx + 7 + (k % 2), sy + 2 - (k === 2 ? 1 : 0), 1, 2, C.lav);
  } else {
    // Scrolling code in kedai colours.
    const step = Math.floor(t * 3);
    for (let i = 0; i < 5; i++) {
      const n = (step + i) * 7 + variant * 13;
      const indent = (n % 3) * 2;
      const len = 3 + ((n * 5) % 9);
      p.rect(sx + 1 + indent, sy + 1 + i * 2, len, 1, [C.teal, C.gold, C.cream, C.leafL, C.peach][n % 5]!);
    }
    if (blink(t, 3)) p.rect(sx + 1, sy + 10, 2, 1, C.white);
  }
}

/** A row of small lanterns along the top louvre, in the state's colour. Needs input blinks; a working desk has one lantern brighter, moving along. */
export function drawDeskStrip(p: Pen, d: DeskSpot, ox: number, oy: number, state: RobotState, t: number) {
  const st = stateStyle[state];
  const quiet = state === 'idle' || state === 'offline' || state === 'unknown';
  const col = state === 'needs_input' && blink(t, 6) ? C.white : quiet ? st.dim : st.color;
  const X = ox + d.x0 * 16;
  const Y = oy + d.y0 * 16;
  const run = Math.floor(t * 6) % 7;
  for (let tx = 0; tx < 7; tx++) {
    if (tx === 1) continue;
    p.rect(X + tx * 16, Y, 16, 2, C.ink);
    for (const lx of [4, 11]) {
      p.rect(X + tx * 16 + lx, Y + 1, 3, 3, C.ink);
      p.rect(X + tx * 16 + lx + 1, Y + 1, 1, 2, state === 'working' && tx === run ? C.white : col);
    }
  }
}

/** The plan table's pendant lamp, in the colour of what the plan board shows. */
export function drawLeadLamp(p: Pen, ox: number, oy: number, state: RobotState, t: number) {
  const st = stateStyle[state];
  p.rect(ox + 280, oy + 64, 1, 12, C.ink);
  box(p, ox + 276, oy + 75, 9, 5, C.ink, C.ink);
  p.rect(ox + 277, oy + 76, 7, 3, state === 'needs_input' && blink(t, 6) ? st.dim : st.color);
}

/** The delivery path: a timber roller lane from the desks to the verifier and on into the rack room. */
export function drawBelt(p: Pen, l: OfficeLayout, t: number) {
  const b = l.belt;
  const off = Math.floor(t * 26) % 6;
  const y = b.y - 9;
  const x1 = b.topY !== null ? b.x1 + 9 : b.x1;
  p.rect(b.x0 - 6, y, x1 - b.x0 + 6, 18, C.ink);
  p.rect(b.x0 - 4, y + 2, x1 - b.x0 + 2, 14, C.woodD);
  for (let x = b.x0 - 4 + off; x < x1 - 2; x += 6) { p.rect(x, y + 3, 2, 12, C.wood); p.rect(x, y + 3, 1, 12, C.woodL); }
  p.rect(b.x0 - 4, y + 2, x1 - b.x0 + 2, 1, C.gold);
  p.rect(b.x0 - 4, y + 15, x1 - b.x0 + 2, 1, C.gold);
  p.rect(b.x0 - 8, y + 1, 4, 16, C.terracotta);
  if (b.topY !== null) {
    const vx = b.x1 - 9;
    p.rect(vx, b.topY, 18, b.y - b.topY + 9, C.ink);
    p.rect(vx + 2, b.topY + 2, 14, b.y - b.topY + 4, C.woodD);
    for (let yy = b.y - off; yy > b.topY + 2; yy -= 6) { p.rect(vx + 3, yy, 12, 2, C.wood); p.rect(vx + 3, yy, 12, 1, C.woodL); }
    p.rect(vx + 2, b.topY + 2, 1, b.y - b.topY, C.gold);
    p.rect(vx + 15, b.topY + 2, 1, b.y - b.topY, C.gold);
    p.rect(vx + 1, b.topY - 6, 16, 6, C.deskDD);
  }
}

export type GateMode = 'idle' | 'reviewing' | 'passed' | 'changes';

/** The verifier's gate: a timber gateway with a signboard, a scanning window, and the inspector on top. */
export function drawGate(p: Pen, g: PxRect, mode: GateMode, since: number, t: number, label: string) {
  const x0 = g.x;
  const w = g.w;
  const cx = Math.round(x0 + w / 2);
  const top = g.y;
  p.rect(x0, top, w, 46, C.ink);
  p.rect(x0 + 1, top + 1, w - 2, 11, C.roof);
  for (let x = x0 + 2; x < x0 + w - 2; x += 4) p.rect(x, top + 2, 2, 9, C.roofD);
  p.rect(x0 + 1, top + 12, w - 2, 33, C.wood);
  p.rect(x0 + 1, top + 12, 6, 33, C.deskD);
  p.rect(x0 + w - 7, top + 12, 6, 33, C.deskD);
  p.rect(x0 + 12, top + 15, 44, 22, C.ink);
  p.rect(x0 + 13, top + 16, 42, 20, C.screen);
  for (let y = top + 18; y < top + 35; y += 4) p.rect(x0 + 14, y, 40, 1, C.deep);
  if (mode === 'reviewing') {
    p.rect(cx - 5, top + 21, 10, 9, C.gold);
    p.rect(cx - 4, top + 22, 8, 7, C.screen);
    p.rect(cx - 1, top + 22, 2, 7, C.gold);
    p.rect(x0 + 13 + Math.floor((t * 30) % 42), top + 16, 1, 20, C.teal);
  } else if (mode === 'passed') text(p, 'OK', cx - 3, top + 23, C.leafL);
  else if (mode === 'changes') text(p, 'FIX', cx - 5, top + 23, C.red);
  const lbl = fit(label.toUpperCase(), w - 6);
  box(p, cx - textW(lbl) / 2 - 3, top + 37, textW(lbl) + 6, 8, C.deep, C.ink);
  text(p, lbl, cx - textW(lbl) / 2, top + 38, C.gold);
  [5, 15, w - 18, w - 8].forEach((lx, i) => {
    let col: string = C.deskDD;
    if (mode === 'reviewing') col = i === Math.floor(t * 8) % 4 ? C.gold : C.goldDark;
    else if (mode === 'passed') col = blink(t, 8) ? C.leafL : C.leafD;
    else if (mode === 'changes') col = blink(t, 8) ? C.red : C.roofD;
    p.rect(x0 + lx, top + 3, 6, 5, C.ink);
    p.rect(x0 + lx + 1, top + 4, 4, 3, col);
  });
  let hop = 0;
  if (mode === 'reviewing') hop = Math.round(Math.abs(Math.sin(t * 8)) * 2);
  else if (mode === 'passed') hop = Math.round(Math.sin(Math.min(1, since / 0.6) * Math.PI) * 6);
  disc(p, cx, top + 1, 4, C.ink, 0.25);
  drawRows(p, Math.floor(t * 10) % 31 === 0 ? VERIFIER_BLINK : VERIFIER, VERIFIER_PAL, cx - 5, top - 10 - hop);
}

/** One local rack per worker's sandbox: its lights run while its worker holds an attempt, and stay dark otherwise. */
export function drawRacks(
  p: Pen, racks: Rack[], envs: readonly OfficeRack[], stateOf: (agentId: string | null) => RobotState | null,
  pulse: (name: string) => number, t: number,
) {
  for (const r of racks) {
    const env = envs.find((e) => e.agentId === r.agentId);
    const st = stateOf(r.agentId);
    const ACT: Record<RobotState, number> = { working: 0.8, in_review: 0.45, verified: 0.6, needs_input: 0.12, blocked: 0.12, idle: 0.1, offline: 0, unknown: 0.05 };
    const activity = env && !env.running ? 0.03 : st ? ACT[st] : 0.35;
    const seedT = Math.floor(t * 10);
    const pz = pulse(r.name);
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 3; j++) {
        const h = Math.sin((seedT + 1) * 12.9898 + (i * 3 + j) * 78.233 + r.x) * 43758.5453;
        const rnd = h - Math.floor(h);
        let col: string = C.deep2;
        if (pz > 0.05) col = blink(t, 12) ? C.leafL : C.leafD;
        else if (rnd < activity) col = j === 2 && rnd < 0.08 ? C.gold : (i + j) % 3 ? C.leafL : C.teal;
        p.rect(r.x + 17 + j * 3, r.y + 14 + i * 10, 2, 2, col);
      }
    if (env?.running) {
      // A lit rack wears a gold lamp on top, so "running" does not rest on the blinking lights alone.
      p.rect(r.x + 13, r.y - 4, 6, 4, C.ink);
      p.rect(r.x + 14, r.y - 3, 4, 2, C.gold);
    }
    if (pz > 0.05) {
      p.rect(r.x, r.y - 1, 32, 2, C.leafL, pz);
      p.rect(r.x, r.y + r.h - 1, 32, 2, C.leafL, pz);
      p.rect(r.x, r.y - 1, 2, r.h, C.leafL, pz);
      p.rect(r.x + 30, r.y - 1, 2, r.h, C.leafL, pz);
    }
  }
}

/** Pull requests as labelled tins on the shelves. Colour only from the run's verification record: green verified, grey not verified, amber out of date. */
export function drawPrBoard(p: Pen, b: PxRect, prs: readonly OfficePr[]) {
  prs.slice(-6).forEach((pr, i) => {
    const x = b.x + 3 + (i % 3) * 20;
    const y = b.y + 11 + Math.floor(i / 3) * 14;
    const col = pr.merged ? C.leafD : pr.verification === 'verified' ? C.green : pr.verification === 'out_of_date' ? C.orange : C.metalD;
    p.rect(x + 1, y + 1, 18, 12, C.ink, 0.3);
    box(p, x, y, 18, 12, pr.merged ? C.tileD : C.cream, C.ink);
    text(p, `#${pr.num % 1000}`, x + 2, y + 2, C.ink);
    p.rect(x + 2, y + 8, 14, 3, col);
    if (pr.verification === 'out_of_date' && !pr.merged) text(p, 'OLD', x + 3, y - 6, C.goldDark);
  });
}

/** Dots moving along each desk's cable tray to its rack, faster while the worker works. */
export function drawCables(
  p: Pen, l: OfficeLayout, stateOf: (agentId: string) => RobotState | null, colorOf: (id: string) => string, t: number,
) {
  for (const cb of l.cables) {
    const st = stateOf(cb.agentId) ?? 'idle';
    const SPEED: Record<RobotState, number> = { working: 60, in_review: 24, verified: 40, needs_input: 4, blocked: 4, idle: 8, offline: 0, unknown: 2 };
    const phase = (t * SPEED[st]) % 14;
    let acc = 0;
    for (let i = 0; i < cb.pts.length - 1; i++) {
      const [x0, y0] = cb.pts[i]!;
      const [x1, y1] = cb.pts[i + 1]!;
      const len = Math.abs(x1 - x0) + Math.abs(y1 - y0);
      for (let d = (14 - ((((acc - phase) % 14) + 14) % 14)) % 14; d < len; d += 14) {
        const f = d / len;
        const col = st === 'needs_input' ? C.red : st === 'idle' ? colorOf(cb.agentId) : C.cream;
        p.rect(Math.round(x0 + (x1 - x0) * f) - 1, Math.round(y0 + (y1 - y0) * f) - 1, 3, 3, col, st === 'idle' ? 0.5 : 0.9);
      }
      acc += len;
    }
  }
}

/** The sky between the louvres (day or night by the local clock) and the clock's hands. */
export function drawWindowAndClock(p: Pen, l: OfficeLayout, t: number) {
  const W = { x: l.ox + l.lounge.x0 * 16 + 81, y: l.oy + 22, w: 30, h: 28 };
  const hour = new Date().getHours();
  const night = hour < 7 || hour >= 19;
  p.rect(W.x, W.y, W.w, W.h, night ? C.skyN : C.sky);
  if (night) {
    for (const [sx, sy] of [[4, 5], [19, 12], [9, 20], [25, 7]] as const) p.rect(W.x + sx, W.y + sy, 1, 1, Math.sin(t * 2 + sx) > -0.3 ? C.cream : C.lav);
    disc(p, W.x + 22, W.y + 8, 3, C.cream);
  } else {
    const cx = W.x + ((t * 3) % (W.w - 12));
    p.rect(cx, W.y + 8, 12, 3, C.cloud);
    p.rect(cx + 3, W.y + 6, 6, 2, C.cloud);
    p.rect(W.x, W.y + W.h - 6, W.w, 6, C.leafD);
    for (let x = W.x; x < W.x + W.w; x += 5) p.rect(x, W.y + W.h - 9, 3, 3, C.leaf);
  }
  p.rect(W.x + W.w / 2 - 1, W.y, 2, W.h, C.louvreD);
  const cx = l.ox + l.lounge.x0 * 16 - 8;
  const cy = l.oy + 36;
  const d = new Date();
  const m = d.getMinutes();
  const am = (m / 60) * Math.PI * 2 - Math.PI / 2;
  const ah = (((d.getHours() % 12) + m / 60) / 12) * Math.PI * 2 - Math.PI / 2;
  line(p, cx, cy, cx + Math.cos(am) * 5, cy + Math.sin(am) * 5, C.ink);
  line(p, cx, cy, cx + Math.cos(ah) * 3, cy + Math.sin(ah) * 3, C.terracotta);
}

/** A candidate on the delivery path: a three-tier tiffin carrier, tagged with the start of its commit. */
export function drawParcelTagged(p: Pen, cx: number, cy: number, label: string, _color?: string) {
  const x = Math.round(cx) - 4;
  const y = Math.round(cy) - 8;
  p.rect(x + 3, y - 2, 3, 1, C.ink);
  p.rect(x + 2, y - 1, 1, 2, C.ink);
  p.rect(x + 6, y - 1, 1, 2, C.ink);
  p.rect(x, y + 1, 9, 9, C.ink);
  for (let i = 0; i < 3; i++) {
    p.rect(x + 1, y + 2 + i * 3, 7, 2, [C.teal, C.terracotta, C.gold][i]!);
    p.rect(x + 1, y + 2 + i * 3, 2, 1, C.white);
  }
  tag(p, label, cx, y - 9, C.ink, C.gold);
}

export function drawPlanTitle(p: Pen, l: OfficeLayout, title: string) {
  const b = l.plan.board;
  tag(p, fit(title.toUpperCase(), b.w), b.x + b.w / 2, b.y - 11, C.deep, C.gold);
}

/**
 * The desk's AI mark (H4, enlarged in H7 for video): a chip for this device or a cloud for Gemini in the cloud, on a plate with its word (DEVICE or
 * CLOUD) beside it. An observed mark is filled. An expected one, for a call still in flight, is only outlined with a "?" beside it, so the two differ
 * without motion; it also blinks when motion is allowed. Paired with words in the office summary and the team cards.
 */
export function drawAiMark(p: Pen, d: DeskSpot, ox: number, oy: number, ai: NonNullable<OfficeAgent['ai']>, t: number) {
  const word = ai.place === 'device' ? 'DEVICE' : 'CLOUD';
  const X = ox + d.x0 * 16 + 3 * 16 + 4;
  const Y = oy + d.y0 * 16 - 15;
  const expected = ai.state === 'expected';
  if (expected && blink(t, 4)) return;
  const fill = ai.place === 'device' ? C.device : C.cloudMark;
  const light = ai.place === 'device' ? C.deviceL : C.cloudMarkL;
  const w = 18 + textW(word) + 4 + (expected ? 6 : 0);
  // The plate.
  p.rect(X - 1, Y - 1, w + 2, 14, C.ink);
  p.rect(X, Y, w, 12, expected ? C.cream : fill);
  // The icon box.
  p.rect(X + 2, Y + 2, 14, 8, expected ? C.white : light);
  if (expected) for (let i = 0; i < 14; i += 2) { p.rect(X + 2 + i, Y + 2, 1, 1, fill); p.rect(X + 2 + i, Y + 9, 1, 1, fill); }
  const ink = fill;
  if (ai.place === 'device') {
    // A chip: a square with legs.
    p.rect(X + 6, Y + 3, 6, 6, ink);
    p.rect(X + 7, Y + 4, 4, 4, expected ? C.white : light);
    for (const ly of [4, 6]) { p.rect(X + 4, Y + ly, 2, 1, ink); p.rect(X + 12, Y + ly, 2, 1, ink); }
  } else {
    // A cloud.
    p.rect(X + 4, Y + 6, 10, 3, ink);
    p.rect(X + 5, Y + 4, 4, 2, ink);
    p.rect(X + 8, Y + 3, 4, 3, ink);
  }
  text(p, word, X + 18, Y + 4, expected ? fill : C.white);
  if (expected) text(p, '?', X + 18 + textW(word) + 3, Y + 4, C.ink);
}

/**
 * The rooftop cloud deck: the CLOUD sign and the uplink dish. While a cloud call is in flight the sign is lit gold and the dish sends a beam; otherwise
 * both are dark. The word is always drawn, so the state never rests on colour alone.
 */
export function drawCloudDeck(p: Pen, l: OfficeLayout, lit: boolean, t: number) {
  const d = dishSpot(l);
  const x = l.ox + d.x;
  const y = l.oy + d.y;
  // The sign, to the left of the dish.
  const sx = x - 62;
  const sy = y + 4;
  p.rect(sx - 1, sy - 1, 54, 16, C.ink);
  p.rect(sx, sy, 52, 14, lit ? C.cloudMark : C.deep2);
  p.rect(sx + 3, sy + 4, 10, 6, lit ? C.cloudMarkL : C.metalDD);
  p.rect(sx + 5, sy + 2, 4, 2, lit ? C.cloudMarkL : C.metalDD);
  text(p, 'CLOUD', sx + 18, sy + 5, lit ? C.gold : C.metalD);
  // The dish's lamp and its beam.
  p.rect(x + 13, y - 1, 4, 4, C.ink);
  p.rect(x + 14, y, 2, 2, lit ? C.gold : C.metalDD);
  if (lit) {
    const k = Math.floor(t * 6) % 3;
    for (let i = 0; i < 3; i++) {
      const r = 4 + i * 4;
      const a = i === k ? 1 : 0.45;
      p.rect(x + 16 + r, y - 2 - r, 2, 1, C.gold, a);
      p.rect(x + 17 + r, y - 1 - r, 1, 2, C.gold, a);
    }
  }
}

/**
 * A fallback, read from a desk's observed record: a dashed path from the desk to the rooftop (fell back to the cloud) or from the rooftop down (fell
 * back to this device), with its words at the top. When motion is allowed one dot travels along it.
 */
export function drawFallbacks(p: Pen, l: OfficeLayout, agents: readonly OfficeAgent[], t: number) {
  const roofY = l.roof.y + l.roof.h - 6;
  for (const a of agents) {
    if (a.ai?.state !== 'observed' || !a.ai.fellBack) continue;
    const d = l.desks.find((x) => x.agentId === a.id);
    if (!d) continue;
    const x = l.ox + d.x0 * 16 + 2 * 16 + 4;
    const fromY = l.oy + d.y0 * 16 - 16;
    const up = a.ai.place === 'cloud';
    for (let y = roofY; y < fromY; y += 4) p.rect(x, y, 2, 2, C.cloudMark);
    const tip = up ? roofY : fromY;
    // The arrow head points the way the call went.
    for (let i = 0; i < 4; i++) p.rect(x - i + (up ? 0 : 0), tip + (up ? i : -i), 2 + i * 2, 1, C.cloudMark);
    const len = fromY - roofY;
    const k = ((t * 40) % len + len) % len;
    if (t > 0) p.rect(x - 1, up ? fromY - k : roofY + k, 4, 4, C.gold);
    tag(p, up ? 'FELL BACK TO CLOUD' : 'FELL BACK TO DEVICE', x + 1, roofY - 12, C.cloudMark, C.white);
  }
}
