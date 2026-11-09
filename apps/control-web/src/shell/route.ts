import { useEffect, useState } from 'react';

export const ROUTES = ['overview', 'assistant'] as const;
export type Route = (typeof ROUTES)[number];

const parse = (hash: string): Route => ((ROUTES as readonly string[]).includes(hash.replace(/^#\/?/, '')) ? (hash.replace(/^#\/?/, '') as Route) : 'overview');

export const hrefFor = (route: Route): string => `#/${route}`;

/** Hash routes keep the page's query (`?demo`, `?fixture`) intact and need no server rewrite. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onHash = (): void => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
