import { useEffect, useState } from 'react';

/** Follows a media query, so a layout that needs a different DOM tree at a width can pick one. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Where the team panel has room beside the page. Below this it folds into the header. */
export const PANEL_WIDE = '(min-width: 1280px)';
