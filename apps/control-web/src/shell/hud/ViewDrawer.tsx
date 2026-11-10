// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import type { ReactNode } from 'react';
import { hrefFor } from '../route.ts';

/**
 * The drawer a screen opens in, over the office. It is the screen's route, so it can be linked to and the browser's back button leaves it;
 * "Office" or Escape (from anywhere that is not a control) go back to the office.
 */
export function ViewDrawer({ view, group, title, children, after }: { view: string; group: string | null; title: string; children: ReactNode; after?: ReactNode }) {
  return (
    <div data-testid="view-drawer" data-view={view} className="panel pointer-events-auto relative min-w-0 border-x-0 sm:my-3 sm:border-l-[3px] 2xl:mx-4 2xl:border-x-[3px]">
      <main id="main" tabIndex={-1} className="outline-none">
      <div className="flex items-center gap-2 border-b-[3px] border-edge px-3 py-1.5 sm:px-4">
        <a href={hrefFor('office')} className="btn" data-testid="view-drawer-close">
          <span aria-hidden="true">◀</span> Office
        </a>
        <span aria-hidden="true" className="min-w-0 truncate text-sm text-muted">{group && group !== title ? `${group} · ` : ''}{title}</span>
        <span className="ml-auto hidden text-sm text-muted md:inline" data-testid="view-drawer-keys"><kbd className="kbd">Esc</kbd> on the page goes back to the office</span>
      </div>
      <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-5">{children}</div>
      </main>
      {after}
    </div>
  );
}
