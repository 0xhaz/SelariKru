import { useEffect, useState } from 'react';

export const ROUTES = ['overview', 'team', 'pipeline', 'decisions', 'evidence', 'benchmark', 'assistant', 'onboarding'] as const;
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

/** The current hash with one query key set, or removed when `value` is null. The route and its other keys are kept. */
export function hashWith(key: string, value: string | null, hash: string = window.location.hash): string {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  if (value === null) params.delete(key);
  else params.set(key, value);
  const rest = params.toString();
  return `#${path || '/overview'}${rest ? `?${rest}` : ''}`;
}

/**
 * Changes the hash's query in place: no history entry and no page move, so a drawer opened over a view leaves that view where it was. Listeners hear it as a hash change.
 */
export function replaceHashQuery(changes: Readonly<Record<string, string | null>>): void {
  const next = Object.entries(changes).reduce((hash, [key, value]) => hashWith(key, value, hash), window.location.hash);
  if (next === window.location.hash) return;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${next}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** The worker whose drawer is open, from `?worker=` on any route, so a drawer can be linked to and survives a reload. */
export const workerHref = (route: Route, workerId: string): string => `${hrefFor(route)}?worker=${encodeURIComponent(workerId)}`;
