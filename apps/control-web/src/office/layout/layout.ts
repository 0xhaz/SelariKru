// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Turns the team into an office: room modules on a tile grid. SelariKru's mapping: the desks are our workers, the plan desk is where the Project Manager sits
// (top centre), the review column is our verifier. H7: the building is a kedai (shophouse). Its ground floor is "On this device"; above it sits an open
// rooftop deck, "Cloud", with the uplink.
// H9 (owner, 12 Nov): a grid of worker desks (two rows of up to four), a shared table in the middle of the floor where the PM meets a reviewing worker, and a
// kopitiam (pantry and break corner) where the sandbox racks were. Idle workers take their break there. Every piece is drawn by SelariKru (draw/).
//
//   ┌ rooftop deck: ON THIS DEVICE · CLOUD ─────────────────────────────────┐
//   ├ back wall: plan board · sign · shelf · clock · louvres ─┬ kopitiam     ┐
//   │ stand-up corner │ PLAN desk (PM) │ reading nook        │ counter, urn │
//   │                 │ shared table   │                     │ fridge, fan  │
//   │ ─────────────── corridor ─────────────────────────── door  marble     │
//   │ Desk grid (up to 4 × N, pitch 8)    │ Review column    │ tables,      │
//   │ ════════════════ PR belt ═══════════╪═ gate ══════ post │ stools       │
//   └──────────────────────────────────────────────────────────╨────────────┘

import { deskCarpets } from '../engine/palette.ts';
import { WalkGrid, type Tile } from '../engine/path.ts';

/** One robot as the layout needs it: who sits at which desk, and the name on its plate. */
export interface DeskAgent {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  /** H11: false for a worker that is not started, disabled, or whose runner is not running: its desk is empty and dimmed, with its nameplate and no robot. */
  readonly active?: boolean;
  /** H11 fix round 1 (M10): a desk for a role no worker holds yet. */
  readonly notStarted?: boolean;
}

export interface LayoutInput {
  readonly agents: readonly DeskAgent[];
  readonly projectName: string;
  /** The plate on the plan desk. */
  readonly leadLabel: string;
}

export const TS = 16;
export const MARGIN = 3;
/** Tiles of open rooftop deck above the building (H7): where cloud calls go. */
export const ROOF = 6;
/** The building tile column of the stair up to the rooftop: robots climb it on a cloud errand (H7 fix). */
export const STAIR_X = 10;

const REVIEW_W = 10;
const TOP_Y = 4; // first floor row
const DESK_Y = 14; // first cubicle row
const CUB = 7;
const PITCH = 8;
/** H9: up to four desks across; more workers take more rows. */
export const MAX_DESK_COLUMNS = 4;
/** H9: the plan desk group moves this many tiles right of where H7 drew it, so the Project Manager sits at the top centre of the hall. */
export const LEAD_DX = 6;
/** H9: the reading nook's first column, right of the plan desk group: its louvre window and wall clock. */
export const NOOK_X0 = 27;
/** H9: the kopitiam's width in tiles. */
const KOPI_W = 12;

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeskSpot {
  agentId: string;
  index: number;
  x0: number; // cubicle origin, building tiles
  y0: number;
  seat: Tile;
  drop: Tile;
  rect: PxRect; // world px
  carpet: readonly [string, string];
}

export interface Rack extends PxRect {
  name: string;
  agentId: string | null;
}

export type HitKind = 'agent' | 'plan' | 'prs' | 'gate' | 'env' | 'lead' | 'roles' | 'kopitiam' | 'table';

export interface Hit {
  kind: HitKind;
  id: string;
  rect: PxRect;
}

export interface OfficeLayout {
  key: string;
  W: number; // building size in tiles
  H: number;
  ox: number; // building origin in world px
  oy: number;
  worldW: number;
  worldH: number;
  mainW: number;
  grid: WalkGrid; // building tile coords
  lead: { agentId: string | null; seat: Tile; rect: PxRect };
  plan: { board: PxRect; spot: Tile };
  /** H9: the kopitiam, right of the hall (tiles): where a worker with no claimed task sits or stands. */
  kopitiam: { x0: number; w: number; rect: PxRect; spots: { tile: Tile; sit: boolean; face: 'up' | 'down' | 'left' | 'right' }[] };
  /** H9: the shared table in the middle of the floor: the PM's place there, and the places for a reviewing worker. */
  table: { rect: PxRect; pmSpot: Tile; spots: Tile[] };
  /** H9: one small sign for the roles no worker holds yet; it opens Team settings. Null when every role is held. */
  rolesSign: { rect: PxRect; count: number } | null;
  desks: DeskSpot[];
  belt: { y: number; x0: number; x1: number; topY: number | null }; // px; topY = vertical run end
  gate: PxRect | null;
  prBoard: PxRect | null;
  /** Before H9 the sandbox racks' room. Always null now: sandbox state is shown on each desk's monitor. */
  serverRoom: null;
  /** The rooftop deck above the building, in world px. */
  roof: PxRect;
  /**
   * The way up (H7 fix): `foot` is the floor tile at the bottom of the stair, `top` the deck tile at its head, and `spots` where robots stand by
   * the uplink dish (one per worker, in tile coordinates; a negative row is on the roof). The roof is outside the walk grid, so a robot climbs in a straight line.
   */
  roofWalk: { foot: Tile; top: Tile; spots: Tile[]; deviceSpots: Tile[]; cloudSpots: Tile[] };
  /** The rooftop's two inference boxes (round 4), in building px: ON THIS DEVICE on the left, CLOUD on the right. */
  roofBoxes: { device: PxRect; cloud: PxRect };
  /** Before H9 one rack per worker's sandbox. Always empty now. */
  racks: Rack[];
  mailbox: PxRect | null;
  /** Before H9 the cables from desks to racks. Always empty now. */
  cables: { agentId: string; pts: [number, number][] }[];
  door: Tile;
  hits: Hit[];
}

export function layoutKey(input: LayoutInput): string {
  return JSON.stringify([input.agents.map((a) => [a.id, a.name, a.color, a.active !== false, a.notStarted === true]), input.projectName, input.leadLabel]);
}

export function deskColumns(n: number): number {
  return Math.max(1, Math.min(MAX_DESK_COLUMNS, n));
}

export function generateLayout(input: LayoutInput): OfficeLayout {
  // H9: a role no worker holds gets no desk: one small sign counts them instead.
  const workers = input.agents.filter((a) => !a.notStarted);
  const unheld = input.agents.length - workers.length;

  const cols = deskColumns(workers.length);
  const rows = Math.max(1, Math.ceil(workers.length / cols));
  const x0r = 2 + MAX_DESK_COLUMNS * PITCH; // review column start: the hall keeps its width, so the PM stays at its centre
  const gridLeft = 2 + Math.floor(((MAX_DESK_COLUMNS - cols) * PITCH) / 2);
  const mainW = x0r + REVIEW_W - 1;
  const glassX = mainW + 1; // the timber screen between the hall and the kopitiam
  const kx = glassX + 1;

  const yb = DESK_Y + rows * PITCH; // belt row
  const H = Math.max(yb + 3, 25);
  const W = 1 + mainW + 1 + KOPI_W + 1;

  const ox = MARGIN * TS;
  const oy = (MARGIN + ROOF) * TS;
  const px = (tx: number) => ox + tx * TS;
  const py = (ty: number) => oy + ty * TS;
  const D = LEAD_DX;

  // ---------------------------------------------------------- walkable grid
  const grid = new WalkGrid(W, H);
  grid.set(1, TOP_Y, W - 2, H - 2, true);
  grid.set(0, 13, 0, 13, true); // door
  // The plan desk group, at the top centre.
  grid.set(13 + D, 5, 17 + D, 6, false); // plan desk
  grid.set(18 + D, 4, 19 + D, 4, false); // bookshelf
  grid.set(11 + D, 4, 11 + D, 4, false); // plant
  // The stand-up corner, left.
  grid.set(1, 4, 1, 4, false);
  for (const [x, y] of [[3, 8], [8, 8], [5, 10], [1, 11]] as Tile[]) grid.set(x, y, x, y, false);
  // The shared table, in the middle of the floor below the plan desk.
  const tx0 = 19;
  grid.set(tx0, 9, tx0 + 5, 10, false);
  // The reading nook, right of the plan desk: a bench and a water cooler.
  grid.set(28, 8, 32, 8, false);
  grid.set(mainW, 4, mainW, 4, false);
  // The timber screen to the kopitiam, with a doorway on the corridor.
  grid.set(glassX, TOP_Y, glassX, H - 2, false);
  grid.set(glassX, 11, glassX, 12, true);
  // The kopitiam: the counter and its urn, a fridge, a standing fan, two marble-top tables, plants.
  grid.set(kx, 4, kx + 6, 5, false);
  grid.set(kx + 10, 4, kx + 11, 5, false);
  grid.set(kx + 10, 9, kx + 10, 9, false);
  const tables: Tile[] = [[kx + 4, 10], [kx + 4, 16]];
  for (const [tx, ty] of tables) grid.set(tx, ty, tx + 1, ty + 1, false);
  grid.set(kx, H - 3, kx, H - 3, false);
  grid.set(kx + KOPI_W - 1, H - 3, kx + KOPI_W - 1, H - 3, false);
  // belt + bottom
  grid.set(2, yb, mainW, yb, false);

  // ---------------------------------------------------------- desks
  const desks: DeskSpot[] = workers.map((a, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x0 = gridLeft + c * PITCH;
    const y0 = DESK_Y + r * PITCH;
    grid.set(x0, y0, x0 + CUB - 1, y0, false);
    grid.set(x0 + 1, y0, x0 + 1, y0, true); // door gap
    grid.set(x0, y0, x0, y0 + CUB - 1, false);
    grid.set(x0 + CUB - 1, y0, x0 + CUB - 1, y0 + CUB - 1, false);
    grid.set(x0 + 2, y0 + 1, x0 + 4, y0 + 2, false);
    return {
      agentId: a.id,
      index: i,
      x0,
      y0,
      seat: [x0 + 3, y0 + 3],
      drop: [x0 + 3, yb - 1],
      rect: { x: px(x0), y: py(y0) - 4, w: CUB * TS, h: CUB * TS + 4 },
      carpet: deskCarpets[i % deskCarpets.length]!,
    };
  });

  // ---------------------------------------------------------- review column
  const gate: PxRect = { x: px(x0r + 2), y: py(yb) - 25, w: 68, h: 46 };
  grid.set(x0r + 2, yb - 1, x0r + 6, yb + 1, false);
  const prBoard: PxRect = { x: px(x0r + 4), y: py(yb - 6) + 4, w: 64, h: 40 };
  grid.set(x0r + 4, yb - 6, x0r + 7, yb - 3, false);

  // ---------------------------------------------------------- the post box at the end of the belt
  const beltY = py(yb) + 8;
  const beltX1 = px(mainW) - 4;
  const mailbox: PxRect = { x: px(mainW) - 6, y: py(yb) - 14, w: 22, h: 30 };
  grid.set(mainW, yb - 1, mainW, yb, false);

  // ---------------------------------------------------------- the shared table and the kopitiam's places
  const table = { rect: { x: px(tx0), y: py(9), w: 6 * TS, h: 2 * TS }, pmSpot: [tx0 - 1, 9] as Tile, spots: [[tx0 + 1, 11], [tx0 + 4, 11], [tx0 + 6, 9], [tx0 + 6, 10]] as Tile[] };
  const kopitiamSpots: OfficeLayout['kopitiam']['spots'] = [
    // At the counter, standing.
    { tile: [kx + 1, 6], sit: false, face: 'up' }, { tile: [kx + 3, 6], sit: false, face: 'up' }, { tile: [kx + 5, 6], sit: false, face: 'up' },
    // On the stools round the two marble-top tables.
    ...tables.flatMap(([tx, ty]): OfficeLayout['kopitiam']['spots'] => [
      { tile: [tx - 1, ty], sit: true, face: 'right' }, { tile: [tx + 2, ty + 1], sit: true, face: 'left' }, { tile: [tx + 1, ty - 1], sit: true, face: 'down' }, { tile: [tx, ty + 2], sit: true, face: 'up' },
    ]),
  ];
  const kopitiam = { x0: kx, w: KOPI_W, rect: { x: px(kx), y: py(TOP_Y), w: KOPI_W * TS, h: (H - 1 - TOP_Y) * TS }, spots: kopitiamSpots.filter((s) => grid.ok(s.tile[0], s.tile[1])) };
  const rolesSign = unheld > 0 ? { rect: { x: px(x0r + 1), y: oy + 20, w: 92, h: 18 }, count: unheld } : null;

  // ---------------------------------------------------------- hits
  const hits: Hit[] = [];
  const planBoard = { x: px(2) + 3, y: oy + 19, w: 140, h: 40 };
  const leadRect = { x: px(12 + D), y: oy + 64, w: 6 * TS, h: 3 * TS };
  hits.push({ kind: 'plan', id: 'plan', rect: { x: planBoard.x - 3, y: planBoard.y - 8, w: planBoard.w + 6, h: planBoard.h + 14 } });
  hits.push({ kind: 'lead', id: 'lead', rect: leadRect });
  hits.push({ kind: 'table', id: 'table', rect: table.rect });
  for (const d of desks) hits.push({ kind: 'agent', id: d.agentId, rect: d.rect });
  hits.push({ kind: 'gate', id: 'gate', rect: { x: gate.x, y: gate.y - 16, w: gate.w, h: gate.h + 16 } });
  hits.push({ kind: 'prs', id: 'prs', rect: { x: prBoard.x, y: prBoard.y, w: prBoard.w, h: prBoard.h + 26 } });
  if (rolesSign) hits.push({ kind: 'roles', id: 'roles', rect: rolesSign.rect });
  hits.push({ kind: 'kopitiam', id: 'kopitiam', rect: kopitiam.rect });

  return {
    key: layoutKey(input),
    W,
    H,
    ox,
    oy,
    worldW: (W + MARGIN * 2) * TS,
    worldH: (H + MARGIN * 2 + ROOF) * TS,
    mainW,
    grid,
    lead: { agentId: null, seat: [15 + D, 7], rect: leadRect },
    plan: { board: planBoard, spot: [6, 5] },
    kopitiam,
    table,
    rolesSign,
    desks,
    belt: { y: beltY, x0: px(2), x1: beltX1, topY: null },
    gate,
    prBoard,
    serverRoom: null,
    roof: { x: ox, y: MARGIN * TS, w: W * TS, h: ROOF * TS },
    roofWalk: (() => {
      const devLeft = Math.ceil((STAIR_X * TS + 28) / TS);
      const mid = Math.floor(W / 2) + Math.floor(STAIR_X / 2);
      const spots = (from: number, to: number): Tile[] => workers.map((_, i): Tile => [Math.min(to, from + (i % Math.max(1, to - from + 1))), -2]);
      return { foot: [STAIR_X, TOP_Y] as Tile, top: [STAIR_X, -2] as Tile, spots: spots(devLeft + 1, mid - 2), deviceSpots: spots(devLeft + 1, mid - 2), cloudSpots: spots(mid + 1, W - 6) };
    })(),
    roofBoxes: (() => {
      const left = STAIR_X * TS + 28;
      const mid = (Math.floor(W / 2) + Math.floor(STAIR_X / 2)) * TS;
      return { device: { x: left, y: -ROOF * TS + 12, w: mid - 6 - left, h: ROOF * TS - 20 }, cloud: { x: mid + 6, y: -ROOF * TS + 12, w: W * TS - 12 - mid - 6, h: ROOF * TS - 20 } };
    })(),
    racks: [],
    mailbox,
    cables: [],
    door: [1, 13],
    hits,
  };
}

/** Tile centre in world px. */
export function tileCentre(l: OfficeLayout, t: Tile): { x: number; y: number } {
  return { x: l.ox + t[0] * TS + 8, y: l.oy + t[1] * TS + 8 };
}
