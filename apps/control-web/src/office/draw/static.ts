// The static layer of the kedai (shophouse) studio (H7), drawn once per layout: the street and the five-foot way, the rooftop deck, the tiled
// ground floor, the lime-washed walls with timber louvres, and the furniture. SelariKru's own drawing.

import { mulberry32 } from '../engine/random.ts';
import { text, textW } from '../engine/font.ts';
import { C } from '../engine/palette.ts';
import { box, CanvasPen, disc, ellipse, makeCanvas } from '../engine/pen.ts';
import { ROOF, type LayoutInput, type OfficeLayout } from '../layout/layout.ts';
import { arch, batikRug, dishBody, louvreScreens, louvreWindow, plant, plate, prShelves, rackBody, signboard, stool, streetPot, workDesk } from './furniture.ts';

/** The sign on the shop front: the project's name, or the product's when there is none. Never another product's name. */
export function officeSign(name: string): string {
  return name.trim().slice(0, 19).toUpperCase() || 'SELARIKRU';
}

/** Where the rooftop's dish stands, in building px (its base is on the deck). Shared with the live layer. */
export function dishSpot(l: OfficeLayout): { x: number; y: number } {
  return { x: l.W * 16 - 64, y: -ROOF * 16 + 12 };
}

export function buildStatic(l: OfficeLayout, input: LayoutInput): HTMLCanvasElement {
  const canvas = makeCanvas(l.worldW, l.worldH);
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  const p = new CanvasPen(g);
  const R = mulberry32(7);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(R() * arr.length)]!;
  const bw = l.W * 16; // building px
  const bh = l.H * 16;
  const roofH = ROOF * 16;

  // ------------------------------------------------ the street, kerbs and street pots
  p.rect(0, 0, l.worldW, l.worldH, C.street);
  for (let i = 0; i < (l.worldW * l.worldH) / 180; i++) p.rect(Math.floor(R() * l.worldW), Math.floor(R() * l.worldH), 1, 1, R() < 0.5 ? C.streetD : C.streetL);
  // A kerb around the plot, and lane dashes on the street below it.
  p.rect(l.ox - 34, l.oy - roofH - 6, bw + 40, bh + roofH + 12, C.kerb);
  p.rect(l.ox - 32, l.oy - roofH - 4, bw + 36, bh + roofH + 8, C.wayD);
  for (let x = 12; x < l.worldW - 12; x += 28) p.rect(x, l.worldH - 14, 14, 2, C.gold, 0.7);
  const doorY = l.oy + l.door[1] * 16;

  // ------------------------------------------------ the five-foot way: a covered walk along the shop front, with its arches
  const wayX = l.ox - 30;
  p.rect(wayX, l.oy, 30, bh, C.way);
  for (let y = l.oy; y < l.oy + bh; y += 8) for (let x = wayX; x < l.ox; x += 8) if (((x + y) / 8) % 2 === 0) p.rect(x, y, 8, 8, C.wayL);
  p.rect(wayX - 6, l.oy - 2, 6, bh + 4, C.roofD);
  for (let y = l.oy; y < l.oy + bh; y += 4) p.rect(wayX - 6, y, 6, 1, C.roof);
  for (let y = l.oy + 8; y < l.oy + bh - 24; y += 48) {
    if (Math.abs(y + 12 - doorY) < 24) continue;
    arch(p, wayX - 2, y, 6, 22);
  }
  p.rect(0, doorY, wayX, 16, C.wayD);
  for (let x = 2; x < wayX; x += 6) p.rect(x, doorY + 7, 3, 2, C.wayL);
  streetPot(p, wayX - 14, doorY - 6);
  streetPot(p, wayX - 14, doorY + 34);
  for (let x = l.ox + 40; x < l.ox + bw - 20; x += 96 + Math.floor(R() * 40)) streetPot(p, x, l.oy + bh + 30);
  for (let y = l.oy + 40; y < l.oy + bh; y += 110) streetPot(p, l.ox + bw + 22, y);

  g.save();
  g.translate(l.ox, l.oy);
  const mainPx = (l.mainW + 1) * 16;
  const L = l.lounge.x0 * 16;

  // ------------------------------------------------ the rooftop deck ("Cloud"): planks, parapet, plants, string lights, a water tank and the dish
  {
    const y0 = -roofH;
    p.rect(0, y0, bw, roofH, C.deck);
    for (let y = y0 + 2; y < 0; y += 6) {
      p.rect(0, y, bw, 1, C.deckD);
      for (let x = (y % 12 === 0 ? 0 : 24); x < bw; x += 48) p.rect(x, y - 5, 1, 5, C.deckD);
    }
    p.rect(0, y0, bw, 3, C.ink);
    p.rect(0, y0 + 3, bw, 2, C.wallL);
    p.rect(0, y0, 3, roofH, C.ink);
    p.rect(bw - 3, y0, 3, roofH, C.ink);
    // String lights from one end to the other.
    for (let x = 6; x < bw - 6; x += 2) {
      const sag = Math.round(Math.sin(((x % 96) / 96) * Math.PI) * 4);
      p.rect(x, y0 + 8 + sag, 1, 1, C.ink);
      if (x % 12 === 0) p.rect(x - 1, y0 + 9 + sag, 3, 2, C.gold);
    }
    // The stair hatch, a water tank and pots.
    box(p, 12, y0 + 24, 26, 18, C.roofD, C.ink);
    for (let i = 0; i < 4; i++) p.rect(15, y0 + 27 + i * 4, 20, 1, C.roof);
    box(p, 52, y0 + 18, 22, 26, C.metalL, C.ink);
    p.rect(54, y0 + 22, 18, 1, C.metalD);
    p.rect(54, y0 + 34, 18, 1, C.metalD);
    plant(p, 90, y0 + 44);
    plant(p, mainPx - 40, y0 + 44, false);
    const d = dishSpot(l);
    dishBody(p, d.x, d.y);
  }

  // ------------------------------------------------ floors: terracotta tiles with teal tiles set in, on the whole ground floor
  g.save();
  g.beginPath();
  g.rect(16, 64, mainPx - 16, bh - 80);
  g.clip();
  for (let ty = 0; ty * 16 < bh; ty++) {
    for (let tx = 1; tx * 16 < mainPx; tx++) {
      const x = tx * 16;
      const y = 64 + ty * 16;
      const teal = (tx + ty * 3) % 7 === 0;
      p.rect(x, y, 16, 16, C.grout);
      p.rect(x + 1, y + 1, 15, 15, teal ? C.tileTeal : (tx + ty) % 2 ? C.tileT : C.tileTD);
      if (teal) {
        p.rect(x + 7, y + 3, 2, 10, C.tileTealD);
        p.rect(x + 3, y + 7, 10, 2, C.tileTealD);
        p.rect(x + 7, y + 7, 2, 2, C.gold);
      } else if (R() < 0.18) p.rect(x + 3 + Math.floor(R() * 9), y + 3 + Math.floor(R() * 9), 2, 1, C.tileTL);
    }
  }
  g.restore();

  // The name set into the floor in teal tiles.
  const logo = 'SELARIKRU';
  text(p, logo, Math.round(mainPx / 2 - textW(logo, 2) / 2), 13 * 16 + 4, C.tileTealD, 2);

  // The plan table's batik rug.
  batikRug(p, 176, 64, 144, 96, C.batikA, C.batikAD, C.gold);
  // Each desk's batik rug.
  for (const d of l.desks) batikRug(p, (d.x0 + 1) * 16, (d.y0 + 1) * 16, 80, 96, d.carpet[0], d.carpet[1], C.cream);
  // The kopi corner: cream and kopi tiles, and a round marble table.
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx * 8 < mainPx - L; tx++) p.rect(L + tx * 8, 64 + ty * 8, 8, 8, (tx + ty) % 2 ? C.tileD : C.tileL);
  batikRug(p, L + 16, 112, 96, 80, C.rugG, C.rugGD, C.gold);
  // The stand-up corner: a round mat.
  ellipse(p, 88, 150, 42, 28, C.ink);
  ellipse(p, 88, 150, 41, 27, C.batikB);
  ellipse(p, 88, 150, 34, 21, C.terracotta);
  ellipse(p, 88, 150, 26, 15, C.batikB);
  for (let a = 0; a < 12; a++) p.rect(88 + Math.round(Math.cos((a / 12) * Math.PI * 2) * 30), 150 + Math.round(Math.sin((a / 12) * Math.PI * 2) * 18), 2, 2, C.cream);

  // The rack room's floor: dark timber.
  const sr = l.serverRoom;
  if (sr) {
    const sx = sr.x0 * 16;
    const sw = sr.w * 16;
    p.rect(sx, 64, sw, bh - 80, C.deskD);
    for (let y = 64; y < bh - 16; y += 6) { p.rect(sx, y, sw, 1, C.deskDD); p.rect(sx + ((y / 6) % 3) * 13, y + 1, 1, 5, C.deskDD); }
  }

  // Cable trays from each desk to its rack, in the worker's colour.
  for (const cb of l.cables) {
    const color = input.agents.find((a) => a.id === cb.agentId)?.color ?? C.teal;
    for (let i = 0; i < cb.pts.length - 1; i++) {
      const [x0, y0] = cb.pts[i]!;
      const [x1, y1] = cb.pts[i + 1]!;
      const ax = Math.min(x0, x1) - l.ox;
      const ay = Math.min(y0, y1) - l.oy;
      p.rect(ax - 1, ay - 1, Math.abs(x1 - x0) + 3, Math.abs(y1 - y0) + 3, C.deskDD);
      p.rect(ax, ay, Math.abs(x1 - x0) + 1, Math.abs(y1 - y0) + 1, color, 0.6);
    }
  }

  // ------------------------------------------------ walls: a timber beam on top, lime wash, a teal dado and a kopi skirting
  p.rect(0, 0, bw, 16, C.wallTop);
  for (let x = 0; x < bw; x += 12) p.rect(x, 2, 8, 1, C.wallTopL);
  p.rect(0, 15, bw, 1, C.roofD);
  p.rect(0, 16, mainPx, 44, C.wall);
  for (let i = 0; i < mainPx / 6; i++) p.rect(Math.floor(R() * mainPx), 17 + Math.floor(R() * 26), 2, 1, C.wallD);
  p.rect(0, 44, mainPx, 2, C.wallTrimD);
  p.rect(0, 46, mainPx, 14, C.wallTrim);
  for (let x = 6; x < mainPx; x += 12) { p.rect(x, 49, 4, 4, C.tileTealD); p.rect(x + 1, 50, 2, 2, C.gold); }
  p.rect(0, 60, bw, 4, C.base);
  p.rect(0, 60, bw, 1, C.woodL);
  if (sr) {
    p.rect(mainPx, 16, bw - mainPx, 44, C.wallD);
    for (let x = mainPx; x < bw; x += 8) p.rect(x, 16, 1, 44, C.wall);
    signboard(p, sr.x0 * 16 + 4, 2, sr.w * 16 - 8, 'ON THIS DEVICE', C.deep, C.gold);
  }
  p.rect(0, 16, bw, 2, C.ink, 0.25);
  p.rect(0, 0, 16, bh, C.wallTop);
  p.rect(15, 16, 1, bh - 32, C.wallTopL);
  p.rect(bw - 16, 0, 16, bh, C.wallTop);
  p.rect(bw - 16, 16, 1, bh - 32, C.wallTopL);
  p.rect(0, bh - 16, bw, 16, C.wallTop);
  p.rect(16, bh - 16, bw - 32, 1, C.wallTopL);
  // The shop door: folding timber doors, open.
  p.rect(0, doorY - l.oy, 16, 16, C.wayD);
  p.rect(0, doorY - l.oy - 3, 20, 3, C.louvreD);
  p.rect(0, doorY - l.oy + 16, 20, 3, C.louvreD);
  // The rack room's timber screen.
  if (sr) {
    const gx = sr.glassX * 16;
    p.rect(gx, 64, 16, bh - 80, C.wood);
    for (let y = 64; y < bh - 16; y += 3) p.rect(gx + 2, y, 12, 1, C.woodD);
    p.rect(gx, 64, 1, bh - 80, C.ink);
    p.rect(gx + 15, 64, 1, bh - 80, C.ink);
  }

  // ------------------------------------------------ back-wall decor
  // The plan board: a timber frame on paper, with its four columns.
  const B = { x: l.plan.board.x - l.ox, y: l.plan.board.y - l.oy, w: l.plan.board.w };
  box(p, B.x - 3, B.y - 2, B.w + 6, 46, C.shelfD, C.ink);
  p.rect(B.x, B.y, B.w, 40, C.cream);
  p.rect(B.x, B.y + 38, B.w, 2, C.tileD);
  p.rect(B.x + 6, B.y + 41, B.w - 12, 2, C.woodD);
  const heads: [string, string][] = [['TODO', C.lav], ['DOING', C.teal], ['REVIEW', C.goldDark], ['DONE', C.leafD]];
  heads.forEach(([h, col], k) => {
    const cx = B.x + k * 35;
    if (k) p.rect(cx, B.y + 2, 1, 35, C.tileD);
    text(p, h, cx + (35 - textW(h)) / 2 + 1, B.y + 2, C.ink);
    p.rect(cx + 3, B.y + 8, 30, 1, col);
  });
  // The shop's signboard: deep green with gold letters.
  box(p, 206, 20, 84, 28, C.deep, C.ink);
  p.rect(208, 22, 80, 1, C.goldDark);
  p.rect(208, 45, 80, 1, C.goldDark);
  const sign = officeSign(input.projectName);
  const ss = textW(sign, 2) <= 76 ? 2 : 1;
  text(p, sign, 249 - textW(sign, ss) / 2, ss === 2 ? 30 : 33, C.deep2, ss);
  text(p, sign, 248 - textW(sign, ss) / 2, ss === 2 ? 29 : 32, C.gold, ss);
  // A batik banner.
  box(p, 180, 20, 22, 34, C.batikC, C.ink);
  for (let y = 24; y < 50; y += 6) { p.rect(184, y, 14, 1, C.gold); p.rect(188 + ((y / 6) % 2) * 4, y + 2, 2, 2, C.cream); }
  p.rect(179, 18, 24, 2, C.woodD);
  // The clock.
  disc(p, L - 8, 36, 8, C.ink);
  disc(p, L - 8, 36, 7, C.cream);
  for (const [dx, dy] of [[0, -5], [5, 0], [0, 5], [-5, 0]] as const) p.rect(L - 8 + dx, 36 + dy, 1, 1, C.ink);
  // Timber louvre windows over the kopi corner.
  louvreWindow(p, L + 66, 22, 60, 28);
  p.rect(L + 62, 53, 68, 3, C.woodD);

  // ------------------------------------------------ the lead corner: a kedai shelf of jars, plants and the plan table
  box(p, 288, 30, 32, 44, C.shelfD, C.ink);
  p.rect(290, 32, 28, 40, C.woodD);
  for (let s = 0; s < 3; s++) {
    const sy = 34 + s * 13;
    p.rect(290, sy + 10, 28, 2, C.shelfD);
    for (let bx = 291; bx < 315; bx += 7) {
      // Glass jars (balang) with red lids, holding biscuits.
      p.rect(bx, sy + 3, 6, 7, C.ink);
      p.rect(bx + 1, sy + 4, 4, 6, C.skyL);
      p.rect(bx + 1, sy + 7, 4, 3, pick([C.gold, C.kopiL, C.peach, C.tileTL]));
      p.rect(bx, sy + 2, 6, 2, C.terracotta);
    }
  }
  plant(p, 184, 78);
  {
    // The plan table: always furnished, labelled with what it stands for. No robot sits here.
    p.rect(210, 102, 76, 3, C.shadow, 0.25);
    box(p, 208, 82, 80, 18, C.desk, C.ink);
    for (let x = 214; x < 286; x += 10) p.rect(x, 83, 1, 16, C.woodL);
    box(p, 208, 98, 80, 7, C.deskD, C.ink);
    box(p, 222, 70, 22, 15, C.bezel, C.ink);
    box(p, 248, 70, 22, 15, C.bezel, C.ink);
    box(p, 230, 92, 30, 4, C.metalL, C.ink);
    box(p, 212, 86, 6, 6, C.white, C.ink);
    p.rect(213, 87, 4, 2, C.kopi);
    plate(p, input.leadLabel.toUpperCase().slice(0, 8), 249, 99);
  }
  // The stand-up corner: rattan stools with batik cushions, and a tiffin stand.
  plant(p, 24, 76);
  stool(p, 56, 136, C.batikA);
  stool(p, 136, 136, C.batikD);
  stool(p, 88, 168, C.batikC);
  box(p, 18, 172, 13, 12, C.metalL, C.ink);
  for (let i = 0; i < 3; i++) p.rect(19, 174 + i * 3, 11, 1, C.teal);
  p.rect(23, 169, 3, 3, C.ink);

  // ------------------------------------------------ the kopi corner
  box(p, L, 54, 48, 10, C.cream, C.ink);
  box(p, L, 63, 48, 14, C.wood, C.ink);
  for (let x = L + 4; x < L + 46; x += 8) p.rect(x, 65, 1, 10, C.woodD);
  // The kopi urn and cups.
  box(p, L + 17, 34, 14, 22, C.metalL, C.ink);
  p.rect(L + 18, 40, 12, 2, C.metalD);
  p.rect(L + 23, 31, 2, 3, C.ink);
  p.rect(L + 22, 50, 4, 2, C.ink);
  for (const cx of [L + 4, L + 9, L + 36, L + 41]) { box(p, cx, 56, 4, 5, C.white, C.ink); p.rect(cx + 1, 57, 2, 1, C.kopi); }
  signboard(p, L + 1, 22, 20, 'KOPI', C.terracotta, C.cream);
  // A drinks chiller.
  box(p, L + 49, 26, 14, 50, C.cream, C.ink);
  p.rect(L + 51, 30, 10, 18, C.skyL);
  for (let y = 32; y < 48; y += 5) for (let x = L + 52; x < L + 60; x += 3) p.rect(x, y, 2, 3, pick([C.terracotta, C.gold, C.leafL, C.teal]));
  p.rect(L + 52, 52, 3, 3, C.terracotta);
  // A water dispenser by the wall.
  const right = mainPx - 16;
  box(p, right + 1, 48, 12, 26, C.cream, C.ink);
  box(p, right + 2, 36, 10, 13, C.skyL, C.ink);
  // A long timber bench and a marble kopitiam table.
  p.rect(L + 32, 140, 66, 3, C.shadow, 0.25);
  box(p, L + 30, 122, 68, 8, C.woodD, C.ink);
  box(p, L + 32, 128, 64, 10, C.wood, C.ink);
  for (let x = L + 36; x < L + 94; x += 6) p.rect(x, 129, 1, 8, C.woodD);
  disc(p, L + 64, 166, 9, C.ink);
  disc(p, L + 64, 166, 8, C.metalL);
  p.rect(L + 60, 163, 3, 1, C.metal);
  box(p, L + 61, 160, 5, 5, C.white, C.ink);
  // A radio cabinet.
  box(p, right + 1, 100, 14, 34, C.deskD, C.ink);
  p.rect(right + 3, 103, 10, 8, C.wood);
  for (let y = 104; y < 110; y += 2) p.rect(right + 4, y, 8, 1, C.woodLine);
  disc(p, right + 6, 117, 2, C.gold);
  disc(p, right + 11, 117, 2, C.gold);
  plant(p, L - 8, 76);
  plant(p, right + 8, 204, false);

  // ------------------------------------------------ desks
  for (const d of l.desks) {
    const X = d.x0 * 16;
    const Y = d.y0 * 16;
    workDesk(p, (d.x0 + 2) * 16, Y + 16, d.index);
    louvreScreens(p, X, Y, 7);
    const name = input.agents.find((a) => a.id === d.agentId)?.name.toUpperCase().slice(0, 10) ?? '';
    plate(p, name, X + 64, Y + 4);
  }

  // ------------------------------------------------ PR shelves, racks, the post box
  if (l.prBoard) prShelves(p, l.prBoard.x - l.ox, l.prBoard.y - l.oy, l.prBoard.w, l.prBoard.h, 'PULL REQS');
  for (const r of l.racks) rackBody(p, r.x - l.ox, r.y - l.oy, r.h, r.name);
  if (l.mailbox) {
    const m = { x: l.mailbox.x - l.ox, y: l.mailbox.y - l.oy };
    box(p, m.x, m.y, 22, 30, C.terracotta, C.ink);
    p.rect(m.x + 3, m.y + 10, 16, 6, C.ink);
    text(p, 'MAIN', m.x + 4, m.y + 3, C.cream);
  }
  g.restore();
  return canvas;
}
