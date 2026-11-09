import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'selarikru.theme';

function read(): Theme {
  try {
    return window.localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark'; // storage can be blocked; the default still works
  }
}

/** A browser-local presentation preference, applied at once. Dark is the default so the assistant's validated appearance does not change. */
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
