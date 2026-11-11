// The static layer of the kedai (shophouse) studio (H7), drawn once per layout. SelariKru's own drawing: the street and five-foot way, the sky and the
// open rooftop deck with its railing and uplink, the Peranakan-style floor tiles, the lime-washed walls with timber louvres, and the furniture.

import { mulberry32 } from '../engine/random.ts';
import { text, textW } from '../engine/font.ts';
import { C } from '../engine/palette.ts';
import { CanvasPen, disc, ellipse, makeCanvas, type Pen } from '../engine/pen.ts';
import { MARGIN, ROOF, STAIR_X, TS, type LayoutInput, type OfficeLayout } from '../layout/layout.ts';
import {
  almariRack, batikCloth, framed, kedaiDesk, louvreScreens, louvreWindow, nameCard, pandanJar, prShelves, rattanStool, signboard, slab, stair, streetJar, walkArch,
} from './furniture.ts';

/** The sign on the shop front: the project's name, or the product's when there is none. Never another product's name. */
export function officeSign(name: string): string {
  return name.trim().slice(0, 19).toUpperCase() || 'SELARIKRU';
}

/** Where the uplink dish stands, in building px: inside the roof's CLOUD box, at its right (round 4). Shared with the live layer, which lights it. */
export function dishSpot(l: OfficeLayout): { x: number; y: number } {
  const box = l.roofBoxes.cloud;
  return { x: box.x + box.w - 30, y: box.y + 26 };
}

/** One floor tile. Terracotta plain, or a Peranakan teal tile with a four-petal flower, by a fixed pattern. */
function floorTile(p: Pen, x: number, y: number, tx: number, ty: number): void {
  const peranakan = (tx * 5 + ty * 3) % 11 === 0;
  p.rect(x, y, 16, 16, C.grout);
  if (!peranakan) {
    p.rect(x + 1, y + 1, 15, 15, (tx ^ ty) & 1 ? C.tileT : C.tileTD);
    if ((tx * 7 + ty) % 5 === 0) p.rect(x + 4, y + 11, 3, 1, C.tileTL);
    return;
  }
  p.rect(x + 1, y + 1, 15, 15, C.cream);
  p.rect(x + 2, y + 2, 13, 13, C.tileTeal);
  for (const [dx, dy] of [[0, -4], [4, 0], [0, 4], [-4, 0]] as const) disc(p, x + 8 + dx, y + 8 + dy, 2, C.tileTealD);
  disc(p, x + 8, y + 8, 2, C.gold);
  p.rect(x + 8, y + 8, 1, 1, C.terracotta);
}

export function buildStatic(l: OfficeLayout, input: LayoutInput): HTMLCanvasElement {
  const surface = makeCanvas(l.worldW, l.worldH);
  const ctx = surface.getContext('2d') as CanvasRenderingContext2D;
  const p = new CanvasPen(ctx);
  const rand = mulberry32(11);
  const width = l.W * TS;
  const depth = l.H * TS;
  const roofDepth = ROOF * TS;
  const shopFront = l.oy + l.door[1] * TS;

  // ------------------------------------------------ the sky above the roofline, then the street below it
  const skyBottom = MARGIN * TS;
  for (let band = 0; band < skyBottom; band += 4) p.rect(0, band, l.worldW, 4, band < skyBottom / 2 ? C.sky : C.skyL);
  for (const [cx, cy, cw] of [[40, 14, 26], [l.worldW * 0.45, 22, 34], [l.worldW - 90, 10, 22]] as const) {
    ellipse(p, Math.round(cx), cy, Math.round(cw / 2), 4, C.cloud);
    ellipse(p, Math.round(cx) + 6, cy - 3, Math.round(cw / 4), 3, C.cloud);
  }
  p.rect(0, skyBottom, l.worldW, l.worldH - skyBottom, C.street);
  for (let sy = skyBottom; sy < l.worldH; sy += 32) {
    p.rect(0, sy, l.worldW, 1, C.streetD);
    for (let sx = (sy / 32) % 2 ? 16 : 0; sx < l.worldW; sx += 32) p.rect(sx, sy, 1, 32, C.streetD);
  }
  for (let speck = 0; speck < 260; speck++) p.rect(Math.floor(rand() * l.worldW), skyBottom + Math.floor(rand() * (l.worldH - skyBottom)), 2, 1, C.streetL);
  for (let dash = 10; dash < l.worldW - 20; dash += 30) p.rect(dash, l.worldH - 14, 16, 2, C.goldDark);
  // The kerb round the plot.
  framed(p, l.ox - 34, l.oy - roofDepth - 2, width + 40, depth + roofDepth + 8, C.kerb, C.wayD, 2);

  // ------------------------------------------------ the five-foot way: a covered walk along the shop front with its arches
  const walkX = l.ox - 30;
  for (let wy = l.oy; wy < l.oy + depth; wy += 8) for (let wx = walkX; wx < l.ox; wx += 8) p.rect(wx, wy, 8, 8, ((wx - walkX) / 8 + (wy - l.oy) / 8) % 2 ? C.way : C.wayL);
  framed(p, walkX - 7, l.oy - 2, 7, depth + 4, C.roof, C.roof, 1);
  for (let ry = l.oy + 2; ry < l.oy + depth; ry += 5) p.rect(walkX - 6, ry, 5, 1, C.roofD);
  for (let ay = l.oy + 10; ay + 22 < l.oy + depth; ay += 46) if (Math.abs(ay + 11 - shopFront) > 26) walkArch(p, walkX - 1, ay, 7, 22);
  p.rect(0, shopFront, walkX, TS, C.wayD);
  for (let step = 3; step < walkX; step += 7) p.rect(step, shopFront + 7, 4, 2, C.wayL);
  streetJar(p, walkX - 14, shopFront - 6);
  streetJar(p, walkX - 14, shopFront + 36);
  for (let jx = l.ox + 50; jx < l.ox + width - 24; jx += 120) streetJar(p, jx, l.oy + depth + 30);
  for (let jy = l.oy + 50; jy < l.oy + depth; jy += 120) streetJar(p, l.ox + width + 22, jy);

  ctx.save();
  ctx.translate(l.ox, l.oy);
  const hall = (l.mainW + 1) * TS;
  const kopiX = l.lounge.x0 * TS;

  // ------------------------------------------------ the rooftop: clay deck tiles, a railing, plants, a water tank, the hatch and the uplink dish
  {
    const deckTop = -roofDepth;
    for (let ty = 0; ty < ROOF; ty++) {
      for (let tx = 0; tx < l.W; tx++) {
        const x = tx * TS;
        const y = deckTop + ty * TS;
        p.rect(x, y, TS, TS, C.deckD);
        p.rect(x + 1, y + 1, TS - 1, TS - 1, (tx + ty) % 3 === 0 ? C.deckL : C.deck);
      }
    }
    // The railing on the roof's edges: posts and a rail, the sky beyond.
    p.rect(0, deckTop, width, 3, C.ink);
    for (let post = 0; post <= width; post += 12) p.rect(Math.min(post, width - 2), deckTop - 6, 2, 8, C.ink);
    p.rect(0, deckTop - 6, width, 2, C.metalL);
    for (const edge of [0, width - 3]) p.rect(edge, deckTop, 3, roofDepth, C.ink);
    // String lights across the deck.
    for (let lx = 6; lx < width - 6; lx += 3) {
      const sag = Math.round(Math.sin(((lx % 120) / 120) * Math.PI) * 5);
      p.rect(lx, deckTop + 10 + sag, 1, 1, C.ink);
      if (lx % 15 === 0) { p.rect(lx - 1, deckTop + 11 + sag, 3, 3, C.ink); p.rect(lx, deckTop + 12 + sag, 1, 1, C.gold); }
    }
    // The hatch at the head of the stair. The two inference boxes are drawn live (round 4); only the cloud box's dish is part of the building.
    framed(p, STAIR_X * TS - 2, -TS * 2 + 2, TS + 4, TS * 2 - 2, C.roofD, C.deskD, 2);
    text(p, 'UP', STAIR_X * TS + 4, -TS * 2 + 6, C.cream);
  }

  // ------------------------------------------------ the ground floor: Peranakan tiles, with an entrance mat that carries the name
  ctx.save();
  ctx.beginPath();
  ctx.rect(TS, 64, hall - TS, depth - 80);
  ctx.clip();
  for (let row = 0; row * TS < depth; row++) for (let col = 1; col * TS < hall; col++) floorTile(p, col * TS, 64 + row * TS, col, row);
  ctx.restore();
  {
    // The entrance mat just inside the door: no desk or label ever sits here.
    const matY = l.door[1] * TS - 3;
    framed(p, TS + 2, matY, 46, 22, C.kopi, C.kopiL, 2);
    for (let mx = TS + 5; mx < TS + 46; mx += 4) p.rect(mx, matY + 3, 2, 1, C.kopi);
    text(p, 'SELARIKRU', TS + 7, matY + 9, C.cream);
  }

  // Batik cloths under the plan table, under each desk and in the kopi corner.
  batikCloth(p, 176, 64, 144, 96, C.batikA, C.batikAD, C.gold);
  for (const desk of l.desks) batikCloth(p, (desk.x0 + 1) * TS, (desk.y0 + 1) * TS, 80, 96, desk.carpet[0], desk.carpet[1], C.cream);
  // Kopi corner floor: cream and kopi chequers.
  for (let cy = 64; cy < 96; cy += 8) for (let cx = kopiX; cx < hall; cx += 8) p.rect(cx, cy, 8, 8, ((cx - kopiX) / 8 + (cy - 64) / 8) % 2 ? C.tileD : C.tileL);
  batikCloth(p, kopiX + 16, 112, 96, 80, C.rugG, C.rugGD, C.gold);
  // The stand-up corner: a round woven mat.
  for (const [rx, ry, col] of [[42, 28, C.ink], [41, 27, C.batikB], [33, 20, C.terracotta], [25, 14, C.batikB]] as const) ellipse(p, 88, 150, rx, ry, col);
  for (let k = 0; k < 16; k++) p.rect(88 + Math.round(Math.cos((k / 16) * Math.PI * 2) * 29), 150 + Math.round(Math.sin((k / 16) * Math.PI * 2) * 17), 2, 2, C.cream);

  // The rack room: dark timber boards.
  const racks = l.serverRoom;
  if (racks) {
    const left = racks.x0 * TS;
    const span = racks.w * TS;
    for (let by = 64; by < depth - TS; by += 8) {
      p.rect(left, by, span, 8, C.deskD);
      p.rect(left, by + 7, span, 1, C.deskDD);
      p.rect(left + ((by / 8) % 4) * 11, by, 1, 7, C.deskDD);
    }
  }

  // Cable trays, each in its worker's colour, laid along the cable's corners.
  for (const cable of l.cables) {
    const tint = input.agents.find((a) => a.id === cable.agentId)?.color ?? C.teal;
    cable.pts.slice(1).forEach(([toX, toY], k) => {
      const [fromX, fromY] = cable.pts[k]!;
      const x = Math.min(fromX, toX) - l.ox - 1;
      const y = Math.min(fromY, toY) - l.oy - 1;
      const w = Math.abs(toX - fromX) + 3;
      const h = Math.abs(toY - fromY) + 3;
      p.rect(x, y, w, h, C.deskDD);
      p.rect(x + 1, y + 1, w - 2, h - 2, tint, 0.6);
    });
  }

  // ------------------------------------------------ the walls: a timber frame round the shop, lime wash and a teal dado on the back wall
  const beam = (x: number, y: number, w: number, h: number): void => {
    p.rect(x, y, w, h, C.wallTop);
    if (w > h) for (let bx = x + 3; bx < x + w; bx += 14) p.rect(bx, y + 3, 8, 1, C.wallTopL);
    else for (let by = y + 3; by < y + h; by += 14) p.rect(x + 3, by, 1, 8, C.wallTopL);
  };
  beam(0, 0, width, TS);
  beam(0, 0, TS, depth);
  beam(width - TS, 0, TS, depth);
  beam(0, depth - TS, width, TS);
  p.rect(TS, 16, hall - TS, 28, C.wall);
  for (let stroke = 0; stroke < hall / 4; stroke++) p.rect(TS + Math.floor(rand() * (hall - TS)), 18 + Math.floor(rand() * 24), 1, 3, C.wallD);
  p.rect(TS, 44, hall - TS, 16, C.wallTrim);
  p.rect(TS, 44, hall - TS, 2, C.wallTrimD);
  for (let stud = TS + 6; stud < hall; stud += 12) { p.rect(stud, 49, 4, 4, C.tileTealD); p.rect(stud + 1, 50, 2, 2, C.gold); }
  p.rect(TS, 60, width - TS * 2, 4, C.kopi);
  p.rect(TS, 60, width - TS * 2, 1, C.woodL);
  if (racks) {
    p.rect(hall, 16, width - hall - TS, 44, C.wallD);
    for (let plank = hall; plank < width - TS; plank += 6) p.rect(plank, 16, 1, 44, C.wall);
    // The racks are where code runs (sandboxes), not where AI runs: that is the roof's ON THIS DEVICE box (round 4).
    signboard(p, racks.x0 * TS + 4, 2, racks.w * TS - 8, 'SANDBOXES', C.kopi, C.cream);
    text(p, 'ON THIS DEVICE', racks.x0 * TS + (racks.w * TS - textW('ON THIS DEVICE')) / 2, 18, C.ink);
    // The rack room's timber screen, slatted.
    const screenX = racks.glassX * TS;
    framed(p, screenX, 64, TS, depth - 80, C.wood, C.wood, 1);
    for (let slat = 66; slat < depth - 18; slat += 3) p.rect(screenX + 2, slat, 12, 1, C.woodD);
  }
  // The stair from the floor up through the back wall to the roof hatch.
  stair(p, STAIR_X * TS, 0, 64);
  // The shop's folding doors, open.
  p.rect(0, shopFront - l.oy, TS, TS, C.wayD);
  for (const jamb of [-3, TS]) p.rect(0, shopFront - l.oy + jamb, 20, 3, C.louvreD);

  // ------------------------------------------------ the back wall's fittings
  // The plan board: a timber frame on cream paper with its four columns. The notes on it are drawn live.
  const board = l.plan.board;
  const bx = board.x - l.ox;
  const by = board.y - l.oy;
  framed(p, bx - 3, by - 2, board.w + 6, 46, C.shelfD, C.cream, 3);
  p.rect(bx, by + 38, board.w, 2, C.tileD);
  p.rect(bx + 6, by + 41, board.w - 12, 2, C.woodD);
  const columns = [['TODO', C.lav], ['DOING', C.teal], ['REVIEW', C.goldDark], ['DONE', C.leafD]] as const;
  for (let k = 0; k < columns.length; k++) {
    const [word, rule] = columns[k]!;
    const colLeft = bx + 35 * k;
    if (k > 0) p.rect(colLeft, by + 2, 1, 35, C.tileD);
    text(p, word, colLeft + 1 + Math.floor((35 - textW(word)) / 2), by + 2, C.ink);
    p.rect(colLeft + 3, by + 8, 30, 1, rule);
  }
  // The shop signboard: deep green, gold letters with a shadow.
  framed(p, 206, 20, 84, 28, C.deep, C.deep, 1);
  for (const rule of [22, 45]) p.rect(208, rule, 80, 1, C.goldDark);
  const sign = officeSign(input.projectName);
  const scale = textW(sign, 2) > 76 ? 1 : 2;
  const signY = scale === 2 ? 29 : 32;
  text(p, sign, 249 - textW(sign, scale) / 2, signY + 1, C.deep2, scale);
  text(p, sign, 248 - textW(sign, scale) / 2, signY, C.gold, scale);
  // A batik banner on a rod.
  p.rect(179, 18, 24, 2, C.woodD);
  framed(p, 180, 20, 22, 34, C.batikC, C.batikC, 1);
  for (let k = 0; k < 4; k++) { p.rect(184, 24 + k * 7, 14, 1, C.gold); p.rect(189 + (k % 2) * 3, 26 + k * 7, 2, 2, C.cream); }
  // The wall clock (its hands are drawn live).
  disc(p, kopiX - 8, 36, 8, C.ink);
  disc(p, kopiX - 8, 36, 7, C.cream);
  for (let mark = 0; mark < 12; mark += 3) p.rect(kopiX - 8 + Math.round(Math.sin((mark / 12) * Math.PI * 2) * 5), 36 - Math.round(Math.cos((mark / 12) * Math.PI * 2) * 5), 1, 1, C.ink);
  // Louvre windows over the kopi corner, with a sill.
  louvreWindow(p, kopiX + 66, 22, 60, 28);
  p.rect(kopiX + 62, 53, 68, 3, C.woodD);

  // ------------------------------------------------ the lead corner: a shelf of balang jars, plants and the PLAN table
  framed(p, 288, 30, 32, 44, C.shelfD, C.woodD, 2);
  for (let shelf = 0; shelf < 3; shelf++) {
    const sy = 34 + shelf * 13;
    p.rect(290, sy + 10, 28, 2, C.shelfD);
    for (let jar = 0; jar < 4; jar++) {
      const jx = 291 + jar * 7;
      framed(p, jx, sy + 3, 6, 7, C.skyL, [C.gold, C.kopiL, C.peach, C.tileTL][(jar + shelf) % 4]!, 1);
      p.rect(jx, sy + 2, 6, 2, C.terracotta);
    }
  }
  pandanJar(p, 184, 78);
  // The plan table: always furnished, labelled with what it stands for. No robot sits here.
  p.rect(212, 104, 72, 2, C.shadow, 0.22);
  slab(p, 208, 82, 80, 18, C.desk, C.woodL, C.deskD);
  for (let plank = 218; plank < 286; plank += 12) p.rect(plank, 83, 1, 16, C.deskD);
  framed(p, 208, 98, 80, 7, C.deskD, C.wood, 1);
  for (const sx of [224, 250]) framed(p, sx - 2, 70, 22, 15, C.tealDark, C.screen, 2);
  framed(p, 230, 92, 30, 4, C.metalL, C.metalL, 1);
  framed(p, 212, 86, 6, 6, C.white, C.kopi, 2);
  nameCard(p, input.leadLabel.toUpperCase().slice(0, 8), 249, 99);
  // The stand-up corner: rattan stools and a tiffin stand.
  pandanJar(p, 24, 76);
  rattanStool(p, 56, 136, C.batikA);
  rattanStool(p, 136, 136, C.batikD);
  rattanStool(p, 88, 168, C.batikC);
  framed(p, 18, 172, 13, 12, C.metalL, C.metalL, 1);
  for (let tier = 0; tier < 3; tier++) p.rect(19, 174 + tier * 3, 11, 1, C.teal);

  // ------------------------------------------------ the kopi corner: counter and urn, glasses, a chiller, water, a bench, a marble table, a radio
  slab(p, kopiX, 54, 48, 10, C.cream, C.white, C.tileD);
  slab(p, kopiX, 63, 48, 14, C.wood, C.woodL, C.woodD);
  for (let panel = kopiX + 4; panel < kopiX + 46; panel += 8) p.rect(panel, 65, 1, 10, C.woodD);
  slab(p, kopiX + 17, 34, 14, 22, C.metalL, C.white, C.metalD);
  p.rect(kopiX + 23, 31, 2, 3, C.ink);
  p.rect(kopiX + 22, 50, 4, 2, C.ink);
  for (const gx of [kopiX + 4, kopiX + 9, kopiX + 36, kopiX + 41]) framed(p, gx, 56, 4, 5, C.white, C.kopiL, 1);
  signboard(p, kopiX + 1, 22, 20, 'KOPI', C.terracotta, C.cream);
  framed(p, kopiX + 49, 26, 14, 50, C.cream, C.skyL, 2);
  for (let cy = 30; cy < 46; cy += 5) for (let cx = kopiX + 52; cx < kopiX + 60; cx += 3) p.rect(cx, cy, 2, 3, [C.terracotta, C.gold, C.leafL, C.teal][(cx + cy) % 4]!);
  const east = hall - TS;
  framed(p, east + 1, 48, 12, 26, C.cream, C.cream, 1);
  framed(p, east + 2, 36, 10, 13, C.skyL, C.skyL, 1);
  p.rect(kopiX + 32, 140, 66, 2, C.shadow, 0.22);
  slab(p, kopiX + 30, 122, 68, 8, C.woodD, C.wood, C.deskDD);
  slab(p, kopiX + 32, 128, 64, 10, C.wood, C.woodL, C.woodD);
  for (let slat = kopiX + 36; slat < kopiX + 94; slat += 6) p.rect(slat, 129, 1, 8, C.woodD);
  disc(p, kopiX + 64, 166, 9, C.ink);
  disc(p, kopiX + 64, 166, 8, C.metalL);
  framed(p, kopiX + 61, 160, 5, 5, C.white, C.kopiL, 1);
  framed(p, east + 1, 100, 14, 34, C.deskD, C.deskD, 1);
  framed(p, east + 3, 103, 10, 8, C.wood, C.wood, 1);
  for (let grille = 104; grille < 110; grille += 2) p.rect(east + 4, grille, 8, 1, C.woodLine);
  for (const knob of [east + 6, east + 11]) disc(p, knob, 117, 2, C.gold);
  pandanJar(p, kopiX - 8, 76);
  pandanJar(p, east + 8, 204, false);

  // ------------------------------------------------ desks with their louvre screens and name cards
  for (const desk of l.desks) {
    const left = desk.x0 * TS;
    const top = desk.y0 * TS;
    kedaiDesk(p, left + 2 * TS, top + TS, desk.index);
    louvreScreens(p, left, top, 7);
    nameCard(p, input.agents.find((a) => a.id === desk.agentId)?.name.toUpperCase().slice(0, 10) ?? '', left + 64, top + 4);
  }

  // ------------------------------------------------ PR shelves, the racks, the post box
  if (l.prBoard) prShelves(p, l.prBoard.x - l.ox, l.prBoard.y - l.oy, l.prBoard.w, l.prBoard.h, 'PULL REQS');
  for (const rack of l.racks) almariRack(p, rack.x - l.ox, rack.y - l.oy, rack.h, rack.name);
  if (l.mailbox) {
    const mx = l.mailbox.x - l.ox;
    const my = l.mailbox.y - l.oy;
    framed(p, mx, my, 22, 30, C.terracotta, C.terracotta, 1);
    p.rect(mx + 3, my + 10, 16, 6, C.ink);
    text(p, 'MAIN', mx + 4, my + 3, C.cream);
  }
  ctx.restore();
  return surface;
}
