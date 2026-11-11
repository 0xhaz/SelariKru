// The office's pixel colours (H7): a kedai (shophouse) studio in SelariKru's own palette. Shared HUD colours come from theme/tokens.

import { colors, stateStyle } from '../../theme/tokens.ts';

export const C = {
  ink: colors.ink,
  // The street and the five-foot way outside.
  street: '#5b5048', streetD: '#4a413a', streetL: '#6c6158', kerb: '#8c8174',
  way: '#d8c3a0', wayD: '#bda57e', wayL: '#e6d4b2',
  // Terracotta and teal floor tiles.
  tileT: '#c4673f', tileTD: '#a8532f', tileTL: '#d67f55', tileTeal: '#2f8a80', tileTealD: '#236f67', grout: '#8f4a2e',
  // Lime-washed walls, timber and the roof.
  wall: '#efe2c8', wallD: '#dcc9a6', wallL: '#f8efdc', wallTrim: '#2a9d8f', wallTrimD: '#176b66', wallTop: '#3a2a20', wallTopL: '#5a4334', base: '#6b4226',
  roof: '#c4532f', roofD: '#8f3519', roofL: '#d67f55',
  louvre: '#2a9d8f', louvreD: '#176b66', louvreL: '#5fbfb2',
  // Timber furniture.
  wood: '#a8714a', woodD: '#7d5032', woodL: '#c48d62', woodLine: '#5a3a24',
  desk: '#9a6236', deskD: '#6b4226', deskDD: '#45291a',
  shelf: '#7d5032', shelfD: '#5a3a24',
  // Batik rugs and banners.
  batikA: '#56609e', batikAD: '#434c85', batikB: '#e2a93a', batikC: '#c4532f', batikD: '#2a9d8f',
  rugG: '#3f7a5a', rugGD: '#2f6247',
  // The kopi corner.
  kopi: colors.kopi, kopiL: colors.kopiLight, cream: '#f6ead2', tileL: '#f1e2c6', tileD: '#e0c9a0',
  // Plants.
  leaf: '#4f9a4a', leafD: '#2f6a2e', leafL: '#7cc46a', pot: '#c4532f', potD: '#8f3519',
  // Metal, screens and the delivery path.
  metal: '#bfb4a4', metalL: '#e2d9cb', metalD: '#8c8174', metalDD: '#5e554c',
  screen: '#0f2b29', bezel: '#3a3330',
  belt: '#3a302a', beltL: '#55493f', rail: '#a3968a',
  cork: '#d2a26a', corkD: '#a8784a',
  // The rooftop cloud deck.
  sky: '#9fd3d0', skyL: '#c6e6e2', skyN: '#173d3a', cloud: '#fffdf8', deck: '#8c6b4f', deckD: '#6b5039', deckL: '#a8865f',
  // Accents, by state and by family.
  red: stateStyle.needs_input.color, orange: stateStyle.in_review.color, yellow: colors.gold, green: colors.leaf, blue: stateStyle.working.color, lav: stateStyle.idle.color,
  teal: colors.teal, tealDark: colors.tealDark, terracotta: colors.terracotta, indigo: colors.indigo,
  pink: colors.rose, peach: '#f2c9a0', white: '#fffdf8', deep: colors.deepGreen, deep2: colors.deepGreen2,
  gold: colors.gold, goldDark: colors.goldDark,
  shadow: colors.ink,
  // Where AI runs (H4): device green and cloud blue-teal, always with a word or shape beside them.
  device: '#2f7a3a', deviceL: '#c9efc0', cloudMark: '#1f5f8a', cloudMarkL: '#d6ecf7',
  // Older drawing names, until the room is redrawn.
  grass: '#5b5048', grassD: '#4a413a', grassL: '#6c6158', path: '#d8c3a0', pathD: '#bda57e', wallSrv: '#344a52', wallSrvD: '#2a3d44',
  carpetJ: '#8f3519', carpetJD: '#6f2810', rugP: '#56609e', rugPD: '#434c85', grate: '#4a423c', grateD: '#38312c', grateL: '#5c534b',
  part: '#b98a5a', partD: '#8f6640', partCap: '#dcb98a', couch: '#2a9d8f', couchD: '#176b66', navy: '#173d3a',
} as const;

/** Batik rug colours under each desk, cycled by desk index. */
export const deskCarpets: readonly (readonly [string, string])[] = [
  ['#56609e', '#434c85'],
  ['#b5841c', '#8f6714'],
  ['#3f7a5a', '#2f6247'],
  ['#9d5a8c', '#7d4570'],
  ['#a8532f', '#8f4a2e'],
  ['#2f8a80', '#236f67'],
];
