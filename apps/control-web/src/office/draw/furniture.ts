// Kedai (shophouse) furniture and decor, drawn once into the static layer (H7). SelariKru's own drawing.

import { text, textW } from '../engine/font.ts';
import { C } from '../engine/palette.ts';
import { box, disc, ellipse, line, type Pen } from '../engine/pen.ts';

/** A terracotta pot with a leafy plant: pandan-like blades over a round bush. */
export function plant(p: Pen, cx: number, baseY: number, big = true) {
  const r = big ? 6 : 4;
  ellipse(p, cx + 1, baseY, 5, 1, C.shadow, 0.25);
  p.rect(cx - 4, baseY - 7, 9, 7, C.ink);
  p.rect(cx - 3, baseY - 6, 7, 5, C.pot);
  p.rect(cx - 4, baseY - 8, 9, 2, C.potD);
  p.rect(cx - 2, baseY - 5, 1, 3, C.tileTL);
  disc(p, cx, baseY - 8 - r, r + 1, C.ink);
  disc(p, cx, baseY - 8 - r, r, C.leafD);
  for (const [dx, h] of [[-3, r + 4], [0, r + 6], [3, r + 3]] as const) {
    p.rect(cx + dx, baseY - 8 - h, 1, h, C.leaf);
    p.rect(cx + dx, baseY - 8 - h, 1, 1, C.leafL);
  }
  p.rect(cx - 2, baseY - 9 - r, 2, 1, C.leafL);
}

/** A big street pot by the five-foot way: a glazed jar with bougainvillea. */
export function streetPot(p: Pen, cx: number, baseY: number) {
  ellipse(p, cx + 1, baseY, 7, 2, C.shadow, 0.3);
  p.rect(cx - 6, baseY - 10, 13, 10, C.ink);
  p.rect(cx - 5, baseY - 9, 11, 8, C.tileTeal);
  p.rect(cx - 5, baseY - 6, 11, 1, C.gold);
  p.rect(cx - 4, baseY - 9, 2, 6, C.tileTealD);
  disc(p, cx, baseY - 16, 8, C.ink);
  disc(p, cx, baseY - 16, 7, C.leafD);
  disc(p, cx - 1, baseY - 17, 5, C.leaf);
  for (const [dx, dy] of [[-4, -19], [3, -20], [0, -14], [5, -15], [-5, -14]] as const) p.rect(cx + dx, baseY + dy, 2, 2, C.pink);
}

/** A low rattan stool with a batik cushion. */
export function stool(p: Pen, cx: number, cy: number, cushion: string) {
  ellipse(p, cx + 1, cy + 5, 6, 2, C.shadow, 0.25);
  p.rect(cx - 5, cy - 2, 11, 7, C.ink);
  p.rect(cx - 4, cy - 1, 9, 5, C.wood);
  for (let x = cx - 4; x < cx + 5; x += 2) p.rect(x, cy, 1, 4, C.woodD);
  p.rect(cx - 4, cy - 2, 9, 3, cushion);
  p.rect(cx - 2, cy - 2, 1, 1, C.white);
  p.rect(cx + 2, cy - 1, 1, 1, C.gold);
}

export function monitorFrame(p: Pen, mx: number, my: number) {
  box(p, mx, my, 22, 15, C.bezel, C.ink);
  p.rect(mx + 2, my + 2, 18, 11, C.screen);
  p.rect(mx + 9, my + 15, 4, 3, C.woodD);
  p.rect(mx + 6, my + 18, 10, 1, C.deskDD);
}

/** A name plate: cream card with a teal edge. */
export function plate(p: Pen, label: string, cx: number, y: number) {
  const w = textW(label);
  const x = Math.round(cx - w / 2) - 3;
  box(p, x, y, w + 6, 8, C.cream, C.ink);
  p.rect(x + 1, y + 6, w + 4, 1, C.teal);
  text(p, label, Math.round(cx - w / 2), y + 1, C.ink);
}

/** A hanging signboard: a coloured board with a gold rim and its words. */
export function signboard(p: Pen, x: number, y: number, w: number, label: string, bg: string = C.deep, fg: string = C.gold) {
  p.rect(x + 3, y - 3, 1, 3, C.ink);
  p.rect(x + w - 4, y - 3, 1, 3, C.ink);
  box(p, x, y, w, 11, bg, C.ink);
  p.rect(x + 1, y + 1, w - 2, 1, C.goldDark);
  text(p, label, Math.round(x + w / 2 - textW(label) / 2), y + 3, fg);
}

/** A timber desk with a monitor, a kopi cup and one small prop. `dx, dy` = top-left of the desk area. */
export function workDesk(p: Pen, dx: number, dy: number, prop: number) {
  p.rect(dx + 2, dy + 27, 46, 3, C.shadow, 0.25);
  box(p, dx, dy + 4, 48, 18, C.desk, C.ink);
  for (let x = dx + 6; x < dx + 46; x += 9) p.rect(x, dy + 5, 1, 16, C.woodL);
  box(p, dx, dy + 20, 48, 6, C.deskD, C.ink);
  p.rect(dx + 2, dy + 26, 3, 4, C.deskDD);
  p.rect(dx + 43, dy + 26, 3, 4, C.deskDD);
  box(p, dx + 15, dy + 14, 18, 4, C.metalL, C.ink);
  for (let x = dx + 17; x < dx + 31; x += 3) p.rect(x, dy + 15, 2, 1, C.metalD);
  // Kopi in a cup and saucer.
  p.rect(dx + 36, dy + 13, 8, 1, C.white);
  box(p, dx + 37, dy + 8, 6, 5, C.white, C.ink);
  p.rect(dx + 38, dy + 9, 4, 1, C.kopi);
  p.rect(dx + 43, dy + 9, 1, 2, C.ink);
  if (prop % 3 === 0) {
    // A tray of kuih.
    p.rect(dx + 3, dy + 12, 10, 3, C.ink);
    p.rect(dx + 4, dy + 12, 8, 2, C.metalL);
    p.rect(dx + 4, dy + 10, 2, 2, C.leafL); p.rect(dx + 7, dy + 10, 2, 2, C.pink); p.rect(dx + 10, dy + 10, 2, 2, C.gold);
  } else if (prop % 3 === 1) {
    // A small pot of pandan.
    box(p, dx + 4, dy + 11, 7, 5, C.pot, C.ink);
    p.rect(dx + 5, dy + 5, 1, 6, C.leaf); p.rect(dx + 7, dy + 4, 1, 7, C.leafL); p.rect(dx + 9, dy + 6, 1, 5, C.leaf);
  } else {
    // A stack of notebooks.
    p.rect(dx + 4, dy + 12, 8, 2, C.terracotta);
    p.rect(dx + 5, dy + 10, 7, 2, C.teal);
    p.rect(dx + 4, dy + 8, 7, 2, C.gold);
  }
  monitorFrame(p, dx + 13, dy - 6);
}

/** Timber louvre screens around a desk: two sides and a top with a door gap at tile 1. */
export function louvreScreens(p: Pen, X: number, Y: number, tiles: number) {
  for (const col of [0, tiles - 1]) {
    const cx = X + col * 16 + 8;
    p.rect(cx - 3, Y, 6, tiles * 16 + 4, C.ink);
    p.rect(cx - 2, Y + 1, 4, tiles * 16 + 2, C.wood);
    for (let y = Y + 4; y < Y + tiles * 16; y += 4) p.rect(cx - 2, y, 4, 1, C.woodD);
    p.rect(cx - 2, Y + tiles * 16 - 1, 4, 4, C.deskD);
  }
  for (let t = 0; t < tiles; t++) {
    if (t === 1) continue;
    const x = X + t * 16;
    p.rect(x, Y - 1, 16, 1, C.ink);
    p.rect(x, Y, 16, 2, C.woodL);
    p.rect(x, Y + 2, 16, 11, C.wood);
    for (let y = Y + 4; y < Y + 13; y += 3) p.rect(x, y, 16, 1, C.woodD);
    p.rect(x, Y + 13, 16, 2, C.deskD);
    p.rect(x, Y + 15, 16, 1, C.ink);
    p.rect(x + 15, Y + 2, 1, 11, C.woodLine);
  }
  const gx = X + 16;
  p.rect(gx - 1, Y - 1, 2, 17, C.ink);
  p.rect(gx + 15, Y - 1, 2, 17, C.ink);
}

/** A worker's local rack: a timber cabinet with a light panel and a name card. Its lights are drawn live. */
export function rackBody(p: Pen, x: number, y: number, h: number, label: string) {
  p.rect(x + 2, y + h, 30, 3, C.shadow, 0.3);
  box(p, x + 1, y, 30, h, C.deskD, C.ink);
  p.rect(x + 2, y + 1, 1, h - 2, C.wood);
  for (let i = 0; i < 8; i++) {
    const yy = y + 12 + i * 10;
    p.rect(x + 4, yy, 23, 8, C.deskDD);
    p.rect(x + 4, yy + 8, 23, 1, C.woodLine);
    p.rect(x + 6, yy + 3, 8, 1, C.woodD);
  }
  const nm = label.toUpperCase().slice(0, 6);
  box(p, x + 16 - textW(nm) / 2 - 3, y + 3, textW(nm) + 6, 8, C.cream, C.ink);
  text(p, nm, x + 16 - textW(nm) / 2, y + 4, C.ink);
}

/** Wooden shelves for the pull requests, under a signboard. The parcels on them are drawn live. */
export function prShelves(p: Pen, x: number, y: number, w: number, h: number, title: string) {
  p.rect(x + 3, y + h + 26, w - 4, 2, C.shadow, 0.25);
  box(p, x, y, w, h + 26, C.shelfD, C.ink);
  p.rect(x + 2, y + 9, w - 4, h + 15, C.wood);
  for (const sy of [y + 23, y + 37, y + h + 14]) {
    p.rect(x + 2, sy, w - 4, 2, C.deskD);
    p.rect(x + 2, sy + 2, w - 4, 1, C.woodLine);
  }
  signboard(p, x + 4, y - 2, w - 8, title, C.deep, C.gold);
}

/** A batik rug: a border, a field, and a repeated diamond-and-dot motif. */
export function batikRug(p: Pen, x: number, y: number, w: number, h: number, base: string, dark: string, accent: string) {
  p.rect(x, y, w, h, dark);
  p.rect(x + 2, y + 2, w - 4, h - 4, base);
  p.rect(x + 4, y + 4, w - 8, 1, accent);
  p.rect(x + 4, y + h - 5, w - 8, 1, accent);
  for (let yy = y + 9; yy < y + h - 8; yy += 10) {
    for (let xx = x + 8 + ((yy - y) % 20 ? 5 : 0); xx < x + w - 8; xx += 10) {
      p.rect(xx, yy - 2, 1, 1, accent); p.rect(xx - 1, yy - 1, 3, 1, accent); p.rect(xx - 2, yy, 5, 1, dark); p.rect(xx - 1, yy + 1, 3, 1, accent); p.rect(xx, yy + 2, 1, 1, accent);
    }
  }
}

/** Timber louvre window: a frame, two shutters with slats, and the sky between. */
export function louvreWindow(p: Pen, x: number, y: number, w: number, h: number) {
  box(p, x - 2, y - 2, w + 4, h + 4, C.louvreD, C.ink);
  const sw = Math.floor(w / 4);
  for (const sx of [x, x + w - sw]) {
    p.rect(sx, y, sw, h, C.louvre);
    for (let yy = y + 2; yy < y + h - 1; yy += 3) p.rect(sx + 1, yy, sw - 2, 1, C.louvreD);
    p.rect(sx, y, 1, h, C.louvreL);
  }
  p.rect(x + w / 2 - 1, y, 1, h, C.louvreD);
}

/** One arch of the five-foot way: two pillars and a round head. */
export function arch(p: Pen, x: number, y: number, w: number, h: number) {
  p.rect(x, y, 5, h, C.ink);
  p.rect(x + 1, y, 3, h, C.wallL);
  p.rect(x + w - 5, y, 5, h, C.ink);
  p.rect(x + w - 4, y, 3, h, C.wallL);
  for (let i = 0; i <= w; i++) {
    const t = (i / w) * Math.PI;
    const yy = y + 6 - Math.round(Math.sin(t) * 6);
    p.rect(x + i, yy - 1, 1, 2, C.ink);
    p.rect(x + i, y - 2, 1, yy - y + 1, C.wallL);
  }
  p.rect(x, y - 3, w + 1, 1, C.ink);
}

/** The uplink dish on the rooftop deck. Lit (beam and gold lamp) while a cloud call is in flight. */
export function dishBody(p: Pen, x: number, y: number) {
  p.rect(x + 6, y + 10, 3, 8, C.ink);
  p.rect(x + 7, y + 10, 1, 8, C.metalD);
  box(p, x + 2, y + 17, 12, 4, C.metalD, C.ink);
  ellipse(p, x + 8, y + 7, 9, 5, C.ink);
  ellipse(p, x + 8, y + 7, 8, 4, C.metalL);
  ellipse(p, x + 9, y + 8, 5, 2, C.metal);
  line(p, x + 8, y + 7, x + 14, y + 1, C.ink);
}
