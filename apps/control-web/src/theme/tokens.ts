// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// The pixel palette, shared by the office canvas and the HUD. HUD text never uses these raw colours: it uses the semantic tokens in index.css,
// which are measured for contrast in both themes. These are for pixels on the canvas and for swatches that sit beside a text label.

export const colors = {
  ink: '#241a2e',
  cream: '#fff6e9',
  cream2: '#f0dfc2',
  cream3: '#e2cba6',
  muted: '#7d6b73',
  navy: '#1d2b53',
  navy2: '#16213f',
  blue: '#29adff',
  red: '#ff004d',
  orange: '#ffa300',
  green: '#00e436',
  lav: '#83769c',
  yellow: '#ffec27',
  pink: '#ff77a8',
  grass: '#4a8f3d',
  white: '#fff1e8',
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
  working: { label: 'Working', glyph: '◆', color: colors.blue, dim: '#1d6fb8' },
  needs_input: { label: 'Needs input', glyph: '▲', color: colors.red, dim: '#7e0f33' },
  in_review: { label: 'In review', glyph: '◎', color: colors.orange, dim: '#a86a00' },
  verified: { label: 'Verified', glyph: '✓', color: colors.green, dim: '#00873a' },
  idle: { label: 'Idle', glyph: '○', color: colors.lav, dim: '#5a5170' },
  blocked: { label: 'Blocked', glyph: '‖', color: colors.yellow, dim: '#8a7f14' },
  offline: { label: 'Lost', glyph: '✕', color: '#5f5a66', dim: '#3b373e' },
  unknown: { label: 'Unknown', glyph: '?', color: '#8e8a96', dim: '#5f5a66' },
};

/**
 * The team cards' state chips: the reference's chip colours. Where its ink text failed WCAG AA on a colour, that chip uses a darker shade of the
 * same hue with white text instead: Needs input #ff004d -> #e0003f (4.95:1), Idle #83769c -> #6f6388 (5.50:1), Lost #5f5a66 (6.69:1).
 */
export const chipStyle: Readonly<Record<RobotState, { readonly bg: string; readonly fg: string }>> = {
  working: { bg: colors.blue, fg: colors.ink },
  needs_input: { bg: '#e0003f', fg: '#ffffff' },
  in_review: { bg: colors.orange, fg: colors.ink },
  verified: { bg: colors.green, fg: colors.ink },
  idle: { bg: '#6f6388', fg: '#ffffff' },
  blocked: { bg: colors.yellow, fg: colors.ink },
  offline: { bg: '#5f5a66', fg: '#ffffff' },
  unknown: { bg: '#8e8a96', fg: colors.ink },
};

/** Robot body colours, in order. */
export const agentPalette = [
  '#ff77a8', '#29adff', '#ffd23a', '#00e436', '#ff8a3d', '#a98bff', '#3ee0d0', '#ff5c5c', '#c2c3c7', '#b0e04a', '#f0a6ff', '#6fa8ff',
] as const;

/** Lighter (amount > 0) or darker (amount < 0) variants of a colour, for sprite shading. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number): number => {
    const out = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
