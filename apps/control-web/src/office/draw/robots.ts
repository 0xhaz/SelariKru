// SelariKru's crew (H7): pixel workers drawn for this app. Each wears a flat worker's cap with a state lamp on it, has a wide face screen, a gold
// apron band and two legs it walks on. Outlines are a dark shade of the worker's own accent colour rather than one black ink line, so each robot reads
// as one shape in its colour. Nothing here is taken from another product's sprites.

import { toneShift } from '../../theme/tokens.ts';
import { C } from '../engine/palette.ts';
import { flipCanvas, spriteCanvas } from '../engine/pen.ts';

/*
 * Legend: o outline (accent, much darker), B body (accent), b body shade, h highlight, C cap (deep green), c cap shine, F face screen, A apron band
 * (gold), G boots. 12 wide, 15 tall. The face screen sits on rows 5 and 6; the cap lamp on row 1, columns 5 and 6 (both drawn live).
 */
const CAP = ['....oooo....', '...oCCCCo...', '..oCcCCCCo..', '.oooooooooo.'];
const CAP_SIDE = ['...oooo.....', '..oCCCCo....', '.oCcCCCCo...', '.ooooooooooo'];
const FRONT = [
  ...CAP,
  '.ohBBBBBBBo.', '.oBFFFFFFBo.', '.oBFFFFFFBo.', '.oBBBBBBBbo.', '..oooooooo..',
  '.oBBAAAABBo.', 'oBoBBBBBBoBo', 'oBoBBBBBBoBo', '.o.obbbbo.o.', '...oG..Go...', '...oo..oo...',
];
const BACK = [
  ...CAP,
  '.ohBBBBBBBo.', '.oBBBBBBBBo.', '.oBBbbbbBBo.', '.oBBBBBBBbo.', '..oooooooo..',
  '.oBBAAAABBo.', 'oBoBBBBBBoBo', 'oBoBBbbBBoBo', '.o.obbbbo.o.', '...oG..Go...', '...oo..oo...',
];
/** Seated at the desk, seen from behind, both hands up on the keyboard. */
const TYPE = [
  ...CAP,
  '.ohBBBBBBBo.', '.oBBBBBBBBo.', '.oBBbbbbBBo.', '.oBBBBBBBbo.', '..oooooooo..',
  'ooBBAAAABBoo', 'oBBBBBBBBBBo', '.oBBBbbBBBo.', '..obbbbbbo..', '...o....o...', '............',
];
const SIDE = [
  ...CAP_SIDE,
  '.ohBBBBBBBo.', '.oBBBBFFFFo.', '.oBBBBFFFFo.', '.oBBBBBBBbo.', '..oooooooo..',
  '..oBAAAABo..', '..oBBBoBBo..', '..oBBBoBBo..', '..obbbbbbo..', '...oGo.oGo..', '...oo..oo...',
];

export type Facing = 'front' | 'back' | 'type' | 'side' | 'sideL';

/** Width and height of a worker sprite, in pixels. */
export const ROBOT_W = 12;
export const ROBOT_H = 15;

const cache = new Map<string, Record<Facing, HTMLCanvasElement>>();

/** Canvases for each facing, also used by the HUD portraits. */
export function robotCanvases(color: string): Record<Facing, HTMLCanvasElement> {
  const hit = cache.get(color);
  if (hit) return hit;
  const pal = { o: toneShift(color, -0.62), B: color, b: toneShift(color, -0.22), h: toneShift(color, 0.5), C: C.deep, c: '#2f6b66', F: C.screen, A: C.gold, G: C.deskDD };
  const side = spriteCanvas(SIDE, pal);
  const canvases: Record<Facing, HTMLCanvasElement> = {
    front: spriteCanvas(FRONT, pal),
    back: spriteCanvas(BACK, pal),
    type: spriteCanvas(TYPE, pal),
    side,
    sideL: flipCanvas(side),
  };
  cache.set(color, canvases);
  return canvases;
}

/**
 * The Project Manager (H11): the same crew build in a gold songkok-style cap, holding a cream clipboard across its apron. P1: it walks like the crew, so it
 * has a frame for each facing; the clipboard shows from the front and at its side, and is hidden from behind.
 */
const PM_CAP = ['....oooo....', '...oKKKKo...', '..oKgKKKKo..', '.oooooooooo.'];
const PM_CAP_SIDE = ['...oooo.....', '..oKKKKo....', '.oKgKKKKo...', '.ooooooooooo'];
export const PM_ROWS = {
  front: [
    ...PM_CAP,
    '.ohBBBBBBBo.', '.oBFFFFFFBo.', '.oBFFFFFFBo.', '.oBBBBBBBbo.', '..oooooooo..',
    '.oBPPPPPPBo.', 'oBoPPPPPPoBo', 'oBoPMMMMPoBo', '.o.obbbbo.o.', '...oG..Go...', '...oo..oo...',
  ],
  back: [
    ...PM_CAP,
    '.ohBBBBBBBo.', '.oBBBBBBBBo.', '.oBBbbbbBBo.', '.oBBBBBBBbo.', '..oooooooo..',
    '.oBBBBBBBBo.', 'oBoBBBBBBoBo', 'oBoBbbbbBoBo', '.o.obbbbo.o.', '...oG..Go...', '...oo..oo...',
  ],
  /** Seated at the PLAN desk, seen from behind, the clipboard set down and both hands on the keys. */
  type: [
    ...PM_CAP,
    '.ohBBBBBBBo.', '.oBBBBBBBBo.', '.oBBbbbbBBo.', '.oBBBBBBBbo.', '..oooooooo..',
    'ooBBBBBBBBoo', 'oBBBbBBbBBBo', '.oBBBbbBBBo.', '..obbbbbbo..', '...o....o...', '............',
  ],
  side: [
    ...PM_CAP_SIDE,
    '.ohBBBBBBBo.', '.oBBBBFFFFo.', '.oBBBBFFFFo.', '.oBBBBBBBbo.', '..oooooooo..',
    '..oBBBBPPPo.', '..oBBBoPMPo.', '..oBBBoPPPo.', '..obbbbbbo..', '...oGo.oGo..', '...oo..oo...',
  ],
} as const satisfies Record<'front' | 'back' | 'type' | 'side', readonly string[]>;
const PM_BODY = '#8a5a8c';
let pmCache: Record<Facing, HTMLCanvasElement> | null = null;
/** P1: the Project Manager's frames for every facing, built once. */
export function pmCanvases(): Record<Facing, HTMLCanvasElement> {
  if (pmCache) return pmCache;
  const body = PM_BODY;
  const pal = { o: toneShift(body, -0.62), B: body, b: toneShift(body, -0.22), h: toneShift(body, 0.5), K: C.goldDark, g: C.gold, F: C.screen, P: C.cream, M: C.inkSoft, G: C.deskDD };
  const side = spriteCanvas(PM_ROWS.side, pal);
  pmCache = { front: spriteCanvas(PM_ROWS.front, pal), back: spriteCanvas(PM_ROWS.back, pal), type: spriteCanvas(PM_ROWS.type, pal), side, sideL: flipCanvas(side) };
  return pmCache;
}
/** The Project Manager's colour, for its foot shadow and tag. */
export const PM_COLOR = PM_BODY;
/** The Project Manager's front frame (its portrait). */
export function pmCanvas(): HTMLCanvasElement {
  return pmCanvases().front;
}

/**
 * The verifier at the gate: a kedai inspector in a songkok-style cap with a gold badge, holding a magnifier. Drawn
 * for SelariKru; not any review product's mascot.
 */
const VERIFIER_ROWS = [
  '...ooooo...', '..oKKKKKo..', '..oKgKKKo..', '.ooooooooo.', '.oSSSSSSSo.', '.oSWWSWWSo.', '.oSSSSSSSo.', '..ooooooo..',
  '.oTTTTTTToM', 'oToTTTTToMm', '.o.ooooo.o.',
];
export const VERIFIER = VERIFIER_ROWS;
/** Blinking: the eyes close for one frame. */
export const VERIFIER_BLINK = VERIFIER_ROWS.map((r, i) => (i === 5 ? '.oSSSSSSSo.' : r));
export const VERIFIER_PAL = { o: C.ink, K: C.deep, g: C.gold, S: '#e8c9a4', W: C.ink, T: C.teal, M: C.metalD, m: C.skyL };
