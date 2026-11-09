import { useEffect, useState } from 'react';

export const ROUTES = ['overview', 'team', 'pipeline', 'assistant'] as const;
export type Route = (typeof ROUTES)[number];

/** A route may carry its own query, such as `#/pipeline?view=graph&task=x`, for deep links. */
const pathOf = (hash: string): string => hash.replace(/^#\/?/, '').split('?')[0]!;
const parse = (hash: string): Route => ((ROUTES as readonly string[]).includes(pathOf(hash)) ? (pathOf(hash) as Route) : 'overview');

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
