// Kedai (shophouse) furniture and decor for the static layer (H7). SelariKru's own designs: nothing here is taken from another product's art.
// Every piece is built from a few helpers (`slab`, `framed`) so the shapes read as timber, tile and enamel rather than flat boxes.

import { clipGraphemes, text, textW } from '../engine/font.ts';
import { C } from '../engine/palette.ts';
import { disc, ellipse, line, type Pen } from '../engine/pen.ts';

/** A solid slab with a 1 px ink rim, a lit top edge and a darker foot. */
export function slab(p: Pen, x: number, y: number, w: number, h: number, face: string, lit: string, foot: string): void {
  p.rect(x, y, w, h, C.ink);
  p.rect(x + 1, y + 1, w - 2, h - 2, face);
  p.rect(x + 1, y + 1, w - 2, 1, lit);
  p.rect(x + 1, y + h - 2, w - 2, 1, foot);
}

/** A framed board: an ink outline, a frame colour, and an inset field. */
export function framed(p: Pen, x: number, y: number, w: number, h: number, frame: string, field: string, inset = 2): void {
  p.rect(x, y, w, h, C.ink);
  p.rect(x + 1, y + 1, w - 2, h - 2, frame);
  p.rect(x + inset, y + inset, w - inset * 2, h - inset * 2, field);
}

/** Pandan in a glazed jar: tall pointed blades fanning out of a squat pot. */
export function pandanJar(p: Pen, cx: number, footY: number, tall = true): void {
  const reach = tall ? 15 : 10;
  ellipse(p, cx, footY, 6, 1, C.shadow, 0.22);
  framed(p, cx - 5, footY - 8, 11, 8, C.tileTeal, C.tileTeal, 1);
  p.rect(cx - 4, footY - 6, 9, 1, C.gold);
  p.rect(cx - 3, footY - 9, 7, 1, C.tileTealD);
  for (const [dx, lean] of [[-3, -2], [-1, -1], [0, 0], [1, 1], [3, 2]] as const) {
    const top = footY - 9 - reach + Math.abs(dx) * 2;
    line(p, cx + dx, footY - 9, cx + dx + lean * 2, top, C.leafD);
    p.rect(cx + dx + lean * 2, top, 1, 2, C.leafL);
  }
}

/** A big glazed street jar with bougainvillea, for the five-foot way and the kerb. */
export function streetJar(p: Pen, cx: number, footY: number): void {
  ellipse(p, cx, footY, 8, 2, C.shadow, 0.28);
  framed(p, cx - 6, footY - 11, 13, 11, C.terracotta, C.tileTL, 2);
  p.rect(cx - 4, footY - 7, 9, 1, C.roofD);
  disc(p, cx, footY - 17, 8, C.ink);
  disc(p, cx, footY - 17, 7, C.leafD);
  disc(p, cx + 1, footY - 18, 4, C.leaf);
  for (let k = 0; k < 6; k++) p.rect(cx - 5 + ((k * 7) % 11), footY - 23 + ((k * 5) % 9), 2, 2, k % 2 ? C.pink : C.terracotta);
}

/** A round rattan stool topped with a batik cushion. */
export function rattanStool(p: Pen, cx: number, cy: number, cushion: string): void {
  ellipse(p, cx, cy + 5, 6, 2, C.shadow, 0.22);
  disc(p, cx, cy, 6, C.ink);
  disc(p, cx, cy, 5, C.wood);
  for (let a = 0; a < 8; a++) p.rect(cx + Math.round(Math.cos(a) * 4), cy + Math.round(Math.sin(a) * 4), 1, 1, C.woodD);
  disc(p, cx, cy - 1, 3, cushion);
  p.rect(cx - 1, cy - 2, 1, 1, C.gold);
}

/** The screen on its timber stand. The live layer draws what it shows inside the 18×11 area at (sx, sy). */
export function screenStand(p: Pen, sx: number, sy: number): void {
  framed(p, sx - 2, sy - 2, 22, 15, C.tealDark, C.screen, 2);
  p.rect(sx + 6, sy + 13, 6, 2, C.ink);
  p.rect(sx + 7, sy + 13, 4, 2, C.woodD);
  p.rect(sx + 3, sy + 15, 12, 2, C.ink);
  p.rect(sx + 4, sy + 15, 10, 1, C.wood);
}

/** A name card: cream enamel with a teal rule underneath the name. */
export function nameCard(p: Pen, name: string, midX: number, top: number): void {
  const span = textW(name) + 6;
  const left = Math.round(midX - span / 2);
  framed(p, left, top, span, 8, C.cream, C.cream, 1);
  p.rect(left + 1, top + 6, span - 2, 1, C.teal);
  text(p, name, left + 3, top + 1, C.ink);
}

/** A hanging signboard: a coloured board on two cords, gold rule along its top, words centred. */
export function signboard(p: Pen, x: number, y: number, w: number, label: string, bg: string = C.deep, fg: string = C.gold): void {
  for (const cord of [x + 3, x + w - 4]) p.rect(cord, y - 3, 1, 3, C.ink);
  framed(p, x, y, w, 11, bg, bg, 1);
  p.rect(x + 1, y + 1, w - 2, 1, C.goldDark);
  text(p, label, Math.round(x + (w - textW(label)) / 2), y + 3, fg);
}

/**
 * A worker's timber desk: a tabletop with planks, a rattan modesty panel, a screen on its stand, a keyboard tray, a kopi glass, and one small thing
 * of the worker's own (a kuih tray, a pandan pot or notebooks). `left, top` is the desk area; the screen's live area is at (left + 15, top + 12 - 16).
 */
export function kedaiDesk(p: Pen, left: number, top: number, variant: number): void {
  p.rect(left + 3, top + 28, 44, 2, C.shadow, 0.22);
  slab(p, left, top + 4, 48, 17, C.desk, C.woodL, C.deskD);
  for (let plank = 1; plank < 5; plank++) p.rect(left + plank * 10, top + 5, 1, 15, C.deskD);
  // The rattan panel under the top.
  framed(p, left + 2, top + 20, 44, 7, C.deskD, C.wood, 1);
  for (let x = left + 4; x < left + 45; x += 3) p.rect(x, top + 21, 1, 5, C.woodD);
  // Keyboard tray.
  framed(p, left + 15, top + 13, 18, 5, C.metalL, C.metalL, 1);
  for (let key = 0; key < 5; key++) p.rect(left + 17 + key * 3, top + 15, 2, 1, C.metalD);
  // A tall kopi glass with its saucer.
  p.rect(left + 37, top + 15, 7, 1, C.ink);
  framed(p, left + 38, top + 8, 5, 7, C.white, C.kopiL, 1);
  p.rect(left + 39, top + 9, 3, 1, C.cream);
  const props = [
    () => { framed(p, left + 3, top + 11, 11, 4, C.metal, C.metalL, 1); for (const [k, col] of [[0, C.leafL], [1, C.pink], [2, C.gold]] as const) p.rect(left + 5 + k * 3, top + 9, 2, 2, col); },
    () => { framed(p, left + 4, top + 11, 7, 5, C.pot, C.pot, 1); for (const k of [0, 2, 4]) p.rect(left + 5 + k, top + 5 + (k === 2 ? 0 : 2), 1, 6 - (k === 2 ? 0 : 2), k === 2 ? C.leafL : C.leaf); },
    () => { for (const [k, col] of [[0, C.terracotta], [1, C.teal], [2, C.gold]] as const) p.rect(left + 4 + (k % 2), top + 12 - k * 2, 8 - (k % 2), 2, col); },
  ];
  props[variant % props.length]!();
  screenStand(p, left + 15, top - 4);
}

/** Timber louvre screens round a cubicle: two side posts with slats, and a top rail with a gap for the way in (tile 1). */
export function louvreScreens(p: Pen, left: number, top: number, tiles: number): void {
  const span = tiles * 16;
  for (const postX of [left + 5, left + span - 11]) {
    framed(p, postX, top, 6, span + 4, C.wood, C.wood, 1);
    for (let y = top + 3; y < top + span; y += 4) p.rect(postX + 1, y, 4, 1, C.woodD);
    p.rect(postX + 1, top + span, 4, 3, C.deskD);
  }
  const rail = (x0: number, x1: number): void => {
    framed(p, x0, top - 1, x1 - x0, 17, C.wood, C.wood, 1);
    p.rect(x0 + 1, top, x1 - x0 - 2, 1, C.woodL);
    for (let y = top + 3; y < top + 13; y += 3) p.rect(x0 + 1, y, x1 - x0 - 2, 1, C.woodD);
    p.rect(x0 + 1, top + 13, x1 - x0 - 2, 2, C.deskD);
  };
  rail(left, left + 16);
  rail(left + 32, left + span);
}

/**
 * A worker's local rack: a two-door almari (cupboard) in dark timber, with a panel of lamp holes the live layer lights, and its name card on top.
 * `top` and `h` are the rack's box; the lamp panel is a 3 × 8 grid starting at (x + 17, top + 14).
 */
export function almariRack(p: Pen, x: number, top: number, h: number, name: string): void {
  p.rect(x + 3, top + h, 28, 3, C.shadow, 0.28);
  slab(p, x + 1, top, 30, h, C.deskD, C.wood, C.deskDD);
  p.rect(x + 15, top + 12, 1, h - 14, C.ink);
  for (const door of [x + 3, x + 17]) for (let y = top + 12; y < top + h - 4; y += 20) framed(p, door, y, 12, 18, C.deskDD, C.deskD, 1);
  p.rect(x + 13, top + h / 2, 1, 3, C.gold);
  p.rect(x + 18, top + h / 2, 1, 3, C.gold);
  nameCard(p, clipGraphemes(name.toUpperCase(), 6), x + 16, top + 2);
}

/** Wooden shelves for the pull requests, under a PULL REQS signboard. The tins on them are drawn live. */
export function prShelves(p: Pen, x: number, y: number, w: number, h: number, title: string): void {
  p.rect(x + 3, y + h + 26, w - 4, 2, C.shadow, 0.25);
  slab(p, x, y, w, h + 26, C.shelfD, C.wood, C.deskDD);
  p.rect(x + 2, y + 9, w - 4, h + 15, C.wood);
  for (const board of [23, 37, h + 14]) {
    p.rect(x + 2, y + board, w - 4, 2, C.deskD);
    p.rect(x + 2, y + board + 2, w - 4, 1, C.woodLine);
  }
  signboard(p, x + 4, y - 2, w - 8, title, C.deep, C.gold);
}

/** A batik cloth: a border, a field, and rows of the kawung-style four-dot motif, offset every other row. */
export function batikCloth(p: Pen, x: number, y: number, w: number, h: number, field: string, edge: string, motif: string): void {
  p.rect(x, y, w, h, edge);
  p.rect(x + 2, y + 2, w - 4, h - 4, field);
  for (const ry of [y + 4, y + h - 5]) p.rect(x + 4, ry, w - 8, 1, motif);
  let row = 0;
  for (let my = y + 10; my < y + h - 8; my += 10, row++) {
    for (let mx = x + 9 + (row % 2) * 5; mx < x + w - 8; mx += 10) {
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as const) p.rect(mx + dx, my + dy, 1, 1, motif);
      p.rect(mx, my, 1, 1, edge);
    }
  }
}

/** A timber louvre window: two shutters with angled slats and the opening between them. */
export function louvreWindow(p: Pen, x: number, y: number, w: number, h: number): void {
  framed(p, x - 2, y - 2, w + 4, h + 4, C.louvreD, C.louvreD, 1);
  const leaf = Math.floor(w / 4);
  for (const sx of [x, x + w - leaf]) {
    p.rect(sx, y, leaf, h, C.louvre);
    for (let yy = y + 1; yy < y + h - 1; yy += 3) { p.rect(sx + 1, yy, leaf - 2, 1, C.louvreL); p.rect(sx + 1, yy + 1, leaf - 2, 1, C.louvreD); }
  }
}

/** One arch of the five-foot way, seen from above: two square pillars and the curve of the arch between them. */
export function walkArch(p: Pen, x: number, y: number, w: number, h: number): void {
  for (const px of [x, x + w - 5]) framed(p, px, y, 5, h, C.wallL, C.wallL, 1);
  for (let i = 0; i <= w; i++) {
    const rise = Math.round(Math.sin((i / w) * Math.PI) * 6);
    p.rect(x + i, y + 6 - rise, 1, 1, C.ink);
  }
}

/** The uplink dish on its pedestal, its bowl tilted to the sky. The lamp and beam are drawn live. */
export function uplinkDish(p: Pen, x: number, y: number): void {
  framed(p, x + 2, y + 20, 16, 6, C.metalD, C.metalD, 1);
  p.rect(x + 8, y + 10, 4, 10, C.ink);
  p.rect(x + 9, y + 10, 2, 10, C.metal);
  ellipse(p, x + 10, y + 8, 11, 6, C.ink);
  ellipse(p, x + 10, y + 8, 10, 5, C.metalL);
  ellipse(p, x + 11, y + 9, 6, 3, C.metal);
  line(p, x + 10, y + 8, x + 17, y + 1, C.ink);
  p.rect(x + 16, y, 3, 3, C.ink);
}

/** The stair from the ground floor up through the back wall to the rooftop hatch. */
export function stair(p: Pen, x: number, top: number, bottom: number): void {
  framed(p, x, top, 16, bottom - top, C.deskD, C.deskD, 1);
  for (let y = top + 2; y < bottom - 1; y += 4) { p.rect(x + 2, y, 12, 2, C.wood); p.rect(x + 2, y, 12, 1, C.woodL); }
}
