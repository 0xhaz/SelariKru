import { useEffect, useState } from 'react';

export const ROUTES = ['overview', 'team', 'pipeline', 'decisions', 'evidence', 'assistant'] as const;
export type Route = (typeof ROUTES)[number];

/** A route may carry its own query, such as `#/pipeline?view=graph&task=x`, for deep links. */
const pathOf = (hash: string): string => hash.replace(/^#\/?/, '').split('?')[0]!;
const parse = (hash: string): Route => ((ROUTES as readonly string[]).includes(pathOf(hash)) ? (pathOf(hash) as Route) : 'overview');

export const hrefFor = (route: Route): string => `#/${route}`;
/** A deep link to one card on the Decisions screen. */
export const decisionHref = (cardId: string): string => `#/decisions?card=${encodeURIComponent(cardId)}`;

/** The query of the current route, read fresh from the hash. */
export const hashQuery = (hash: string = window.location.hash): URLSearchParams => new URLSearchParams(hash.split('?')[1] ?? '');

/** Tracks the hash's query so a deep link inside a route re-renders it. */
export function useHashQuery(): URLSearchParams {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = (): void => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return hashQuery(hash);
}

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
