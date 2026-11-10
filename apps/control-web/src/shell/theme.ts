import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'selarikru.theme';

function read(): Theme {
  try {
    return window.localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light'; // storage can be blocked; the default still works
  }
}

/** A browser-local presentation preference, applied at once. Light, the pixel theme's cream and ink, is the default (owner decision, T5.12). */
export function useTheme(): readonly [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    try {
      window.localStorage.setItem(KEY, theme);
    } catch {
      /* unsaved preference is harmless */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}
