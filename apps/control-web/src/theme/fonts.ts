// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// The UI font style for panels, drawers, settings and terminals. The office canvas keeps its own pixel lettering. Saved per browser,
// because it is a personal reading choice, not a project setting.

import { useEffect, useState } from 'react';

export type FontStyle = 'pixel' | 'clean' | 'mono';

export const FONT_STYLES: readonly { id: FontStyle; label: string; hint: string }[] = [
  { id: 'pixel', label: 'Pixel', hint: 'Pixelify Sans, the game look' },
  { id: 'clean', label: 'Clean', hint: 'Inter, easiest to read' },
  { id: 'mono', label: 'Mono', hint: 'JetBrains Mono, like a terminal' },
];

export const FONT_KEY = 'selarikru.font';
export const FONT_EVENT = 'selarikru:font';

export const isFontStyle = (v: unknown): v is FontStyle => FONT_STYLES.some((f) => f.id === v);

export function savedFont(): FontStyle {
  try {
    const v = window.localStorage.getItem(FONT_KEY);
    return isFontStyle(v) ? v : 'pixel';
  } catch {
    return 'pixel'; // storage can be blocked; the default still works
  }
}

export function applyFont(font: FontStyle): void {
  if (font === 'pixel') delete document.documentElement.dataset['font'];
  else document.documentElement.dataset['font'] = font;
}

export function setFont(font: FontStyle): void {
  applyFont(font);
  window.dispatchEvent(new CustomEvent<FontStyle>(FONT_EVENT, { detail: font }));
  try {
    window.localStorage.setItem(FONT_KEY, font);
  } catch {
    /* a private window still applies it until reload */
  }
}

/** The current font style, following changes made anywhere on the page. */
export function useFont(): FontStyle {
  const [font, setState] = useState<FontStyle>(savedFont);
  useEffect(() => {
    const on = (e: Event): void => { const d = (e as CustomEvent<unknown>).detail; if (isFontStyle(d)) setState(d); };
    window.addEventListener(FONT_EVENT, on);
    return () => window.removeEventListener(FONT_EVENT, on);
  }, []);
  return font;
}
