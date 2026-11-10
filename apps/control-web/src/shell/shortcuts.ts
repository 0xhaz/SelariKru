// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// The shell's keyboard shortcuts: 1 to 9 open a worker, + and - zoom the office, Escape goes back to the office. A key is never taken from
// text entry, a terminal, a dialog or the worker drawer, which own their keys, and never with a browser or system modifier held.

export interface KeyTarget {
  closest(selector: string): unknown;
  matches(selector: string): boolean;
}

export interface KeyInput {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly defaultPrevented: boolean;
  readonly target: KeyTarget | null;
}

export type ShortcutAction = { readonly kind: 'escape' } | { readonly kind: 'open-worker'; readonly index: number } | { readonly kind: 'zoom'; readonly delta: 1 | -1 };

/** Places that own every key pressed inside them. */
const OWNS_KEYS = [
  'input', 'textarea', 'select', '[contenteditable]', '[role="textbox"]', '[role="combobox"]', '[role="spinbutton"]', '[role="slider"]',
  '[data-terminal]', '[role="log"]', 'dialog', '[role="dialog"]', '[role="alertdialog"]',
].join(', ');

/** Where focus rests when nothing in particular has it: Escape there means "back to the office". */
const RESTING = ['body', 'html', '#main', '[data-office-canvas]', '[data-focus-landing]'].join(', ');

export function shortcutFor(e: KeyInput): ShortcutAction | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = e.target;
  if (t && t.closest(OWNS_KEYS)) return null;
  if (e.key === 'Escape') return t === null || t.matches(RESTING) ? { kind: 'escape' } : null;
  if (e.key === '+' || e.key === '=') return { kind: 'zoom', delta: 1 };
  if (e.key === '-') return { kind: 'zoom', delta: -1 };
  if (/^[1-9]$/.test(e.key)) return { kind: 'open-worker', index: Number(e.key) - 1 };
  return null;
}
