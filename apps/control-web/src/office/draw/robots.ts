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
 * The Project Manager (H11): the same crew build in a gold songkok-style cap, holding a cream clipboard across its apron. Always at the PLAN desk.
 */
const PM_FRONT = [
  '....oooo....', '...oKKKKo...', '..oKgKKKKo..', '.oooooooooo.',
  '.ohBBBBBBBo.', '.oBFFFFFFBo.', '.oBFFFFFFBo.', '.oBBBBBBBbo.', '..oooooooo..',
  '.oBPPPPPPBo.', 'oBoPPPPPPoBo', 'oBoPMMMMPoBo', '.o.obbbbo.o.', '...oG..Go...', '...oo..oo...',
];
let pmCache: HTMLCanvasElement | null = null;
/** The Project Manager's sprite, front facing (it sits at the PLAN desk and turns to the board). */
export function pmCanvas(): HTMLCanvasElement {
  if (pmCache) return pmCache;
  const body = '#8a5a8c';
  pmCache = spriteCanvas(PM_FRONT, { o: toneShift(body, -0.62), B: body, b: toneShift(body, -0.22), h: toneShift(body, 0.5), K: C.goldDark, g: C.gold, F: C.screen, P: C.cream, M: C.inkSoft, G: C.deskDD });
  return pmCache;
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
