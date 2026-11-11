// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md: which overlay a robot shows for its state (the emote choice and the name tag on hover).
// The drawing itself (the cap lamp, the eyes on the face screen, the device or cloud badge, the signboard bubbles and the corner brackets) is
// SelariKru's own, redrawn for the kedai crew in H7.

import { stateStyle, type RobotState } from '../../theme/tokens.ts';
import type { Bot } from '../actors/bots.ts';
import type { OfficeAgent } from '../model.ts';
import { tag, text } from '../engine/font.ts';
import { C } from '../engine/palette.ts';
import { ellipse, type Pen } from '../engine/pen.ts';
import type { PxRect } from '../layout/layout.ts';

export function drawShadow(p: Pen, bot: Bot) {
  ellipse(p, Math.round(bot.x), Math.round(bot.y), 5, 1, C.shadow, 0.28);
}

/**
 * The state lamp on the cap and the eyes on the face screen. The lamp's colour is the state's; needs input blinks (when motion is allowed). The
 * state's word is always beside it in the team card, the tooltip and the office summary.
 */
export function drawFace(p: Pen, bot: Bot, state: RobotState, t: number) {
  const x = Math.round(bot.x) - 6;
  const y = bot.headY;
  const st = stateStyle[state];
  const lamp = state === 'needs_input' && Math.floor(t * 6) % 2 ? C.white : st.color;
  p.rect(x + 5, y + 1, 2, 2, lamp);
  if (state === 'working' || state === 'needs_input') p.rect(x + 5, y, 2, 1, lamp, 0.5);

  const eye = state === 'needs_input' ? '#ffb39a' : state === 'verified' ? '#b9f0a8' : '#a9f0e6';
  const shut = Math.floor(t * 10 + bot.index * 7) % 41 === 0;
  if (bot.face === 'down') {
    if (state === 'verified') {
      // Smiling eyes: two small arcs.
      for (const ex of [3, 7]) { p.rect(x + ex, y + 6, 1, 1, eye); p.rect(x + ex + 1, y + 5, 1, 1, eye); }
    } else if (state === 'idle' || state === 'offline' || state === 'unknown') {
      p.rect(x + 3, y + 6, 2, 1, C.lav);
      p.rect(x + 7, y + 6, 2, 1, C.lav);
    } else {
      p.rect(x + 3, y + (shut ? 6 : 5), 2, shut ? 1 : 2, eye);
      p.rect(x + 7, y + (shut ? 6 : 5), 2, shut ? 1 : 2, eye);
    }
  } else if (bot.face === 'right' || bot.face === 'left') {
    p.rect(x + (bot.face === 'right' ? 8 : 2), y + (shut ? 6 : 5), 2, shut ? 1 : 2, eye);
  }
}

/**
 * The worker's small AI badge, on its shoulder: a chip for this device or a cloud for Gemini in the cloud. Filled when observed; an expected one (a call
 * in flight) is an outline with a dot, so the two differ without motion. The desk mark and the office summary carry the same fact in words.
 */
export function drawBadge(p: Pen, bot: Bot, ai: NonNullable<OfficeAgent['ai']>) {
  const x = Math.round(bot.x) + 4;
  const y = bot.headY + 8;
  const fill = ai.place === 'device' ? C.device : C.cloudMark;
  const expected = ai.state === 'expected';
  p.rect(x - 1, y - 1, 8, 7, C.ink);
  p.rect(x, y, 6, 5, expected ? C.white : fill);
  if (ai.place === 'device') {
    p.rect(x + 2, y + 1, 2, 3, expected ? fill : C.deviceL);
    p.rect(x + 1, y + 2, 4, 1, expected ? fill : C.deviceL);
  } else {
    p.rect(x + 1, y + 2, 4, 2, expected ? fill : C.cloudMarkL);
    p.rect(x + 2, y + 1, 2, 1, expected ? fill : C.cloudMarkL);
  }
}

/** A small signboard bubble over the head: a cream board on two posts. */
function board(p: Pen, cx: number, y: number, fill: string = C.cream) {
  const x = Math.round(cx) - 6;
  p.rect(x, y, 13, 9, C.ink);
  p.rect(x + 1, y + 1, 11, 7, fill);
  p.rect(x + 1, y + 1, 11, 1, fill === C.cream ? C.white : fill);
  p.rect(x + 3, y + 9, 1, 2, C.ink);
  p.rect(x + 9, y + 9, 1, 2, C.ink);
  return x;
}

export function drawEmote(p: Pen, bot: Bot, state: RobotState, t: number, simT: number) {
  if (bot.carry !== null) return;
  let type: string | null = null;
  if (bot.emote && simT < bot.emote.until) type = bot.emote.type;
  else if (bot.path.length) type = null;
  else if (state === 'needs_input') type = 'bang';
  else if (state === 'in_review') type = 'wait';
  else if (state === 'verified') type = 'check';
  else if (state === 'working') type = 'dots';
  else if (state === 'idle') type = 'zz';
  else if (state === 'blocked') type = 'hold';
  else if (state === 'unknown') type = 'ask';
  if (!type) return;
  const cx = Math.round(bot.x);
  const top = bot.headY - 14;
  if (type === 'zz') {
    const k = (t * 0.7 + bot.index * 0.3) % 1;
    text(p, 'Z', cx + 5 + Math.round(k * 3), top + 8 - Math.round(k * 7), C.lav);
    return;
  }
  const lift = type === 'bang' ? Math.floor(t * 4) % 2 : 0;
  const x = board(p, cx, top - lift, type === 'bang' ? C.terracotta : C.cream);
  const y = top - lift;
  if (type === 'bang') { p.rect(x + 6, y + 2, 1, 3, C.white); p.rect(x + 6, y + 6, 1, 1, C.white); }
  if (type === 'dots') for (let i = 0; i < 3; i++) p.rect(x + 3 + i * 3, y + 4 - (Math.floor(t * 4) % 3 === i ? 1 : 0), 2, 1, C.tealDark);
  if (type === 'wait') {
    // An hourglass in amber.
    p.rect(x + 4, y + 2, 5, 1, C.goldDark); p.rect(x + 5, y + 3, 3, 1, C.goldDark); p.rect(x + 6, y + 4, 1, 1, C.goldDark);
    p.rect(x + 5, y + 5, 3, 1, C.goldDark); p.rect(x + 4, y + 6, 5, 1, C.goldDark);
  }
  if (type === 'check') for (let i = 0; i < 6; i++) p.rect(x + 3 + i, y + (i < 2 ? 4 + i : 7 - i), 1, 1, C.leafD);
  if (type === 'talk') for (let i = 0; i < 3; i++) p.rect(x + 3 + i * 3, y + 4, 2, 1, Math.floor(t * 6) % 3 >= i ? C.ink : C.lav);
  if (type === 'hold') { p.rect(x + 4, y + 2, 2, 5, C.indigo); p.rect(x + 7, y + 2, 2, 5, C.indigo); }
  if (type === 'ask') text(p, '?', x + 5, y + 2, C.ink);
  if (type === 'coffee') {
    // A kopi cup with steam.
    p.rect(x + 4, y + 3, 4, 4, C.ink); p.rect(x + 5, y + 4, 2, 2, C.kopiL); p.rect(x + 8, y + 4, 1, 2, C.ink);
    p.rect(x + 5, y + 1 + (Math.floor(t * 4) % 2), 1, 1, C.lav);
  }
}

export function drawNameTag(p: Pen, bot: Bot) {
  tag(p, bot.config.name.toUpperCase().slice(0, 10), Math.round(bot.x), bot.headY - 9, C.ink, bot.color);
}

/** Corner brackets around what the pointer is over, in gold; they pulse when motion is allowed. */
export function drawSelection(p: Pen, r: PxRect, t: number) {
  if (Math.floor(t * 3) % 3 === 0) return;
  const { x, y, w, h } = r;
  const L = 5;
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]] as const) {
    p.rect(sx > 0 ? cx - 2 : cx - L + 2, sy > 0 ? cy - 2 : cy, L, 2, C.gold);
    p.rect(sx > 0 ? cx - 2 : cx, sy > 0 ? cy - 2 : cy - L + 2, 2, L, C.gold);
  }
}
