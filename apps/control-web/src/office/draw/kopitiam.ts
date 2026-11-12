// H9: the kopitiam (pantry and break corner), the shared table, the reading nook, the "+N roles" sign and the desk monitor's sandbox tag. SelariKru's own
// drawing, built from the same helpers and palette as the rest of the kedai: nothing here is taken, traced or recoloured from another product's art.

import { text, textW } from '../engine/font.ts';
import { C } from '../engine/palette.ts';
import { disc, ellipse, line, type Pen } from '../engine/pen.ts';
import type { DeskSpot } from '../layout/layout.ts';
import { batikCloth, framed, signboard, slab } from './furniture.ts';

/** The kopitiam's floor: small cream tiles with a green rim, a classic coffee-shop mosaic, laid in 8 px squares. */
export function kopitiamFloor(p: Pen, x: number, y: number, w: number, h: number): void {
  p.rect(x, y, w, h, C.tileD);
  for (let ty = y; ty < y + h; ty += 8) {
    for (let tx = x; tx < x + w; tx += 8) {
      const accent = ((tx - x) / 8) % 4 === 0 && ((ty - y) / 8) % 4 === 0;
      p.rect(tx + 1, ty + 1, 7, 7, accent ? C.rugG : C.cream);
      if (!accent) p.rect(tx + 2, ty + 2, 1, 1, C.tileL);
    }
  }
}

/** The counter along the back wall: a timber front with panels, a marble top, glass jars of biscuits, and the kopi urn with its tap and steam spout. */
export function kopiCounter(p: Pen, x: number, y: number, w: number): void {
  p.rect(x + 2, y + 31, w - 2, 2, C.shadow, 0.22);
  slab(p, x, y + 10, w, 22, C.wood, C.woodL, C.woodD);
  for (let panel = x + 6; panel < x + w - 4; panel += 12) framed(p, panel, y + 14, 9, 14, C.woodD, C.wood, 1);
  slab(p, x - 1, y + 6, w + 2, 6, C.white, C.white, C.metal);
  for (let vein = x + 3; vein < x + w - 2; vein += 9) p.rect(vein, y + 8, 4, 1, C.metalL);
  // The urn: a tall steel drum on the counter, with a brass tap and a lid knob.
  const ux = x + Math.round(w / 2) - 7;
  slab(p, ux, y - 14, 14, 21, C.metalL, C.white, C.metalD);
  p.rect(ux + 1, y - 6, 12, 1, C.metalD);
  p.rect(ux + 5, y - 17, 4, 3, C.ink);
  p.rect(ux + 6, y - 16, 2, 1, C.metal);
  p.rect(ux + 14, y - 2, 3, 2, C.goldDark);
  p.rect(ux + 16, y, 1, 2, C.ink);
  // Biscuit jars with red lids, and a stack of saucers.
  for (const [jx, fill] of [[x + 4, C.peach], [x + 11, C.gold], [x + w - 14, C.leafL]] as const) {
    framed(p, jx, y - 3, 6, 9, C.skyL, fill, 1);
    p.rect(jx, y - 4, 6, 2, C.terracotta);
  }
  for (let s = 0; s < 3; s++) p.rect(x + w - 6, y + 4 - s * 2, 5, 1, s % 2 ? C.white : C.tileTL);
}

/** The menu board on the kopitiam wall: a green board with chalk lines and three prices. */
export function menuBoard(p: Pen, x: number, y: number): void {
  framed(p, x, y, 40, 24, C.woodD, C.deep, 2);
  text(p, 'KOPI', x + 4, y + 4, C.cream);
  text(p, 'TEH', x + 4, y + 10, C.cream);
  text(p, 'MILO', x + 4, y + 16, C.cream);
  for (const row of [6, 12, 18]) p.rect(x + 24, y + row, 10, 1, C.gold);
}

/** A tall fridge: white enamel, a long chrome handle, and a sticker. */
export function fridge(p: Pen, x: number, y: number): void {
  p.rect(x + 2, y + 33, 28, 2, C.shadow, 0.25);
  slab(p, x, y, 30, 34, C.white, C.white, C.metal);
  p.rect(x + 1, y + 12, 28, 1, C.metal);
  p.rect(x + 24, y + 4, 2, 6, C.metalD);
  p.rect(x + 24, y + 16, 2, 12, C.metalD);
  framed(p, x + 4, y + 18, 8, 6, C.gold, C.terracotta, 1);
}

/** A standing fan seen from above: a round guard with three blades and a centre cap. `spin` turns the blades (0 under reduced motion). */
export function standingFan(p: Pen, cx: number, cy: number, spin = 0): void {
  ellipse(p, cx, cy + 9, 6, 2, C.shadow, 0.25);
  disc(p, cx, cy, 8, C.ink);
  disc(p, cx, cy, 7, C.skyL);
  for (let k = 0; k < 3; k++) {
    const a = spin + (k * Math.PI * 2) / 3;
    line(p, cx, cy, cx + Math.round(Math.cos(a) * 6), cy + Math.round(Math.sin(a) * 6), C.louvreD);
    p.rect(cx + Math.round(Math.cos(a) * 5) - 1, cy + Math.round(Math.sin(a) * 5) - 1, 3, 3, C.louvre);
  }
  disc(p, cx, cy, 2, C.metalD);
  for (let r = 0; r < 16; r++) p.rect(cx + Math.round(Math.cos((r / 16) * Math.PI * 2) * 7), cy + Math.round(Math.sin((r / 16) * Math.PI * 2) * 7), 1, 1, C.metalD);
}

/** A round marble-top table on a cast-iron foot, with two kopi glasses on it. 32 px across, centred on (cx, cy). */
export function marbleTable(p: Pen, cx: number, cy: number): void {
  ellipse(p, cx, cy + 12, 14, 3, C.shadow, 0.22);
  disc(p, cx, cy, 14, C.ink);
  disc(p, cx, cy, 13, C.white);
  for (const [dx, dy, w] of [[-8, -4, 6], [2, 3, 7], [-3, 7, 4]] as const) p.rect(cx + dx, cy + dy, w, 1, C.metalL);
  framed(p, cx - 6, cy - 3, 4, 5, C.white, C.kopi, 1);
  framed(p, cx + 3, cy - 6, 4, 5, C.white, C.kopiL, 1);
}

/** A round wooden kopitiam stool, seen from above. */
export function kopiStool(p: Pen, cx: number, cy: number): void {
  ellipse(p, cx, cy + 4, 5, 1, C.shadow, 0.22);
  disc(p, cx, cy, 5, C.ink);
  disc(p, cx, cy, 4, C.woodL);
  p.rect(cx - 2, cy - 1, 4, 1, C.wood);
}

/** The shared table: a long timber table with a batik runner, papers and a teapot, where the PM meets the team. */
export function sharedTable(p: Pen, x: number, y: number, w: number, h: number): void {
  p.rect(x + 3, y + h, w - 4, 3, C.shadow, 0.22);
  slab(p, x, y, w, h, C.desk, C.woodL, C.deskD);
  for (let plank = x + 12; plank < x + w - 4; plank += 16) p.rect(plank, y + 1, 1, h - 2, C.deskD);
  batikCloth(p, x + 6, y + Math.round(h / 2) - 5, w - 12, 10, C.batikC, C.roofD, C.gold);
  for (const [px, py] of [[x + 14, y + 4], [x + w - 26, y + h - 10]] as const) { framed(p, px, py, 12, 8, C.cream, C.white, 1); for (let r = 2; r < 7; r += 2) p.rect(px + 2, py + r, 8, 1, C.metal); }
  disc(p, x + Math.round(w / 2), y + 6, 4, C.ink);
  disc(p, x + Math.round(w / 2), y + 6, 3, C.tileTeal);
  p.rect(x + Math.round(w / 2) + 3, y + 5, 3, 1, C.ink);
}

/** The reading nook's bench: a timber bench with two batik cushions. */
export function nookBench(p: Pen, x: number, y: number, w: number): void {
  p.rect(x + 2, y + 13, w - 2, 2, C.shadow, 0.22);
  slab(p, x, y, w, 13, C.wood, C.woodL, C.woodD);
  for (let slat = x + 4; slat < x + w - 2; slat += 5) p.rect(slat, y + 2, 1, 9, C.woodD);
  for (const [cx, col] of [[x + 6, C.batikA], [x + w - 20, C.batikB]] as const) framed(p, cx, y + 2, 14, 8, col, col, 1);
}

/** A water dispenser: a blue bottle upside down on a white stand. */
export function waterCooler(p: Pen, x: number, y: number): void {
  framed(p, x + 1, y + 12, 12, 16, C.white, C.white, 1);
  p.rect(x + 3, y + 18, 2, 2, C.terracotta);
  p.rect(x + 8, y + 18, 2, 2, C.cloudMark);
  framed(p, x + 2, y, 10, 13, C.skyL, C.cloudMarkL, 1);
}

/** H9: one small sign for the roles no worker holds yet. It opens Team settings (the canvas hit), and the office summary says the same in words. */
export function rolesSign(p: Pen, x: number, y: number, w: number, count: number): void {
  for (const cord of [x + 4, x + w - 5]) p.rect(cord, y - 3, 1, 3, C.ink);
  framed(p, x, y, w, 18, C.cream, C.cream, 1);
  p.rect(x + 1, y + 1, w - 2, 1, C.goldDark);
  const top = `+${count} ROLE${count === 1 ? '' : 'S'}`;
  text(p, top, Math.round(x + (w - textW(top)) / 2), y + 3, C.ink);
  const low = 'NO WORKER YET';
  text(p, low, Math.round(x + (w - textW(low)) / 2), y + 10, C.inkSoft);
}

/** The kopitiam's hanging sign. */
export function kopitiamSign(p: Pen, x: number, y: number, w: number): void {
  signboard(p, x, y, w, 'KOPITIAM', C.rugG, C.cream);
}

/**
 * H9: a worker's sandbox, shown on its desk monitor's foot (it was a rack): SBX with a lamp, lit green while an attempt runs, grey when idle. It is about
 * execution, so it sits apart from the desk's AI plate, which says where AI ran.
 */
export function sandboxTag(p: Pen, sx: number, sy: number, running: boolean): void {
  framed(p, sx - 3, sy, 24, 8, C.ink, running ? C.deviceL : C.metalL, 1);
  disc(p, sx + 1, sy + 4, 1, running ? C.device : C.metalD);
  text(p, 'SBX', sx + 5, sy + 2, running ? C.device : C.metalDD);
}

/** A desk whose worker is not active, or is on a break in the kopitiam, is dimmed and says which. */
export function deskDim(p: Pen, d: DeskSpot, ox: number, oy: number, word: string): void {
  const left = ox + d.x0 * 16;
  const top = oy + d.y0 * 16;
  p.rect(left + 6, top, 7 * 16 - 12, 7 * 16 + 4, C.ink, 0.42);
  framed(p, left + 56 - Math.ceil(textW(word) / 2) - 3, top + 4 * 16 - 2, textW(word) + 6, 9, C.ink, C.ink, 1);
  text(p, word, left + 56 - textW(word) / 2, top + 4 * 16, C.metalL);
}
