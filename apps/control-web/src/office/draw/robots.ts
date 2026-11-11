// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Hover-robot sprites, recoloured per worker.

import { shade } from '../../theme/tokens.ts';
import { C } from '../engine/palette.ts';
import { flipCanvas, spriteCanvas } from '../engine/pen.ts';

const HEAD_ANTENNA = ['.....kk.....', '....k..k....', '.....kk.....'];
const BODY_FRONT = ['..kkkkkkkk..', '.khhBBBBBBk.', '.khVVVVVVBk.', '.kBVVVVVVBk.', '.kBVVVVVVBk.', '.kbBBBBBBbk.', '..kkkkkkkk..', '...kBBBBk...', '.kbkBBBBkbk.', '.kk.kbbk.kk.', '.....kk.....'];
const BODY_BACK = ['..kkkkkkkk..', '.khhBBBBBBk.', '.kBBBBBBBBk.', '.kBBkbbkBBk.', '.kBBBBBBBBk.', '.kbBBBBBBbk.', '..kkkkkkkk..', '...kBBBBk...', '.kbkBBBBkbk.', '.kk.kbbk.kk.', '.....kk.....'];
const BODY_TYPE = ['..kkkkkkkk..', '.khhBBBBBBk.', '.kBBBBBBBBk.', '.kBBkbbkBBk.', '.kBBBBBBBBk.', '.kbBBBBBBbk.', '..kkkkkkkk..', '.kbkBBBBkbk.', '.kkkBBBBkkk.', '....kbbk....', '.....kk.....'];
const BODY_SIDE = ['..kkkkkkkk..', '.khhBBBBBBk.', '.kBBBBBVVVk.', '.kBBBBBVVVk.', '.kBBBBBVVVk.', '.kbBBBBBBbk.', '..kkkkkkkk..', '...kBBBBk...', '...kbBBBbk..', '....kbbkk...', '.....kk.....'];

export type Facing = 'front' | 'back' | 'type' | 'side' | 'sideL';

const cache = new Map<string, Record<Facing, HTMLCanvasElement>>();

/** Canvases for each facing, also used by the HUD portraits. */
export function robotCanvases(color: string): Record<Facing, HTMLCanvasElement> {
  const hit = cache.get(color);
  if (hit) return hit;
  const pal = { k: C.ink, B: color, b: shade(color, -0.3), h: shade(color, 0.6), V: '#16213f', G: C.gold };
  const side = spriteCanvas([...HEAD_ANTENNA, ...BODY_SIDE], pal);
  const canvases: Record<Facing, HTMLCanvasElement> = {
    front: spriteCanvas([...HEAD_ANTENNA, ...BODY_FRONT], pal),
    back: spriteCanvas([...HEAD_ANTENNA, ...BODY_BACK], pal),
    type: spriteCanvas([...HEAD_ANTENNA, ...BODY_TYPE], pal),
    side,
    sideL: flipCanvas(side),
  };
  cache.set(color, canvases);
  return canvases;
}

/**
 * The verifier on the gate: SelariKru's own figure (an inspector with a green status bulb and a visor), drawn for this app. It is not any review
 * product's mascot.
 */
const VERIFIER_ROWS = ['....kkk....', '...kGGGk...', '....kkk....', '.kkkkkkkkk.', '.kMMMMMMMk.', '.kMWWkWWMk.', '.kMMMMMMMk.', '.kMMkkkMMk.', '.kkkkkkkkk.', '..kMk.kMk..', '..kk...kk..'];
export const VERIFIER = VERIFIER_ROWS;
export const VERIFIER_BLINK = VERIFIER_ROWS.map((r, i) => (i === 5 ? '.kMkkkkkMk.' : r));
export const VERIFIER_PAL = { k: C.ink, M: '#8fd3ff', W: C.white, G: C.green };
