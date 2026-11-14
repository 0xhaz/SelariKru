import { useEffect, useRef } from 'react';
import { sanitizeSuggestions } from './suggestions.ts';

/** Search Suggestions from Grounding with Google Search, rendered as given (less anything that runs), in a shadow root so its styles stay its own (the terms require showing it). */
export function SearchSuggestions({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    root.innerHTML = sanitizeSuggestions(html);
  }, [html]);
  return <div ref={host} data-testid="pm-search-suggestions" />;
}
