// SelariKru's own palette (H7): a kedai (shophouse) studio. Terracotta floor tiles, teal shutters, kopi-brown timber, cream paper, deep green
// signboards, a gold accent and a warm kopi ink. Shared by the office canvas and the HUD. HUD text never uses these raw colours: it uses the semantic
// tokens in index.css, which are measured for contrast. These are for pixels on the canvas and for swatches that sit beside a text label.

export const colors = {
  /** Kopi-black ink: outlines, text on light surfaces. */
  ink: '#2b1d14',
  /** Cream paper and its two deeper folds. */
  paper: '#fbf3e4',
  paper2: '#f1e2c6',
  paper3: '#e4cfa8',
  /** Terracotta: floor tiles, roof, the "needs you" accent. */
  terracotta: '#c4532f',
  terracottaDark: '#8f3519',
  /** Teal: shutters, louvres, the working accent. */
  teal: '#2a9d8f',
  tealDark: '#176b66',
  /** Kopi brown: timber, shelves, the coffee corner. */
  kopi: '#6b4226',
  kopiLight: '#a8714a',
  /** Deep green: signboards and the dark panels. */
  deepGreen: '#173d3a',
  deepGreen2: '#0f2b29',
  leaf: '#5aa457',
  /** Gold accent: lit signs, the pressed button, the Demo data chip. */
  gold: '#f0c14b',
  goldDark: '#b5841c',
  /** Batik indigo, for the blocked state and batik accents. */
  indigo: '#56609e',
  rose: '#c9677a',
  white: '#ffffff',
} as const;

/**
 * What a robot in the office shows. These are SelariKru's worker states, read from the team model and the task the worker holds, never invented:
 * a worker the server reports as unknown stays unknown, and one whose runner is lost is shown as offline.
 */
export const ROBOT_STATES = ['idle', 'working', 'needs_input', 'in_review', 'verified', 'blocked', 'offline', 'unknown'] as const;
export type RobotState = (typeof ROBOT_STATES)[number];

export interface StateStyle {
  /** The word shown beside the colour. Colour is never the only signal. */
  readonly label: string;
  readonly glyph: string;
  readonly color: string;
  readonly dim: string;
}

export const stateStyle: Readonly<Record<RobotState, StateStyle>> = {
  working: { label: 'Working', glyph: '◆', color: '#3fa596', dim: '#256e64' },
  needs_input: { label: 'Needs input', glyph: '▲', color: '#d2532e', dim: '#7d2a14' },
  in_review: { label: 'In review', glyph: '◎', color: '#e2a93a', dim: '#8a6118' },
  verified: { label: 'Verified', glyph: '✓', color: colors.leaf, dim: '#2f6a2e' },
  idle: { label: 'Idle', glyph: '○', color: '#9a8878', dim: '#5e5045' },
  blocked: { label: 'Blocked', glyph: '‖', color: '#6f7bbd', dim: '#3c4478' },
  offline: { label: 'Lost', glyph: '✕', color: '#4f463f', dim: '#332c27' },
  unknown: { label: 'Unknown', glyph: '?', color: '#a39686', dim: '#6a5f55' },
};

/**
 * The team cards' state chips. Each pairs a colour with its word, and each pair meets WCAG AA: Working 5.46:1, Needs input 5.83:1, In review 7.74:1,
 * Verified 5.34:1, Idle 5.50:1, Blocked 5.89:1, Lost 9.21:1, Unknown 5.64:1.
 */
export const chipStyle: Readonly<Record<RobotState, { readonly bg: string; readonly fg: string }>> = {
  working: { bg: '#3fa596', fg: colors.ink },
  needs_input: { bg: '#b13f22', fg: colors.white },
  in_review: { bg: '#e2a93a', fg: colors.ink },
  verified: { bg: colors.leaf, fg: colors.ink },
  idle: { bg: '#76665a', fg: colors.white },
  blocked: { bg: colors.indigo, fg: colors.white },
  offline: { bg: '#4f463f', fg: colors.white },
  unknown: { bg: '#a39686', fg: colors.ink },
};

/** Each worker's accent colour, in order: kedai tones (terracotta, teal, gold, pandan, kopi, batik indigo, rose, sage, peacock, sand, mangosteen, papaya). */
export const agentPalette = [
  '#d0643c', '#2fa39a', '#e8b33a', '#5f9a4e', '#a8714a', '#5867a8', '#c9677a', '#86b06c', '#3f86a6', '#d9a46b', '#9d5a8c', '#e07f52',
] as const;

/** Lighter (amount > 0) or darker (amount < 0) variants of a colour, for sprite shading. */
export function shade(hex: string, amount: number): string {
  const toward = amount >= 0 ? 255 : 0;
  const t = Math.min(1, Math.abs(amount));
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `#${channels.map((v) => Math.round(v + (toward - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
