// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { TONE_TEXT, formatAge } from '@selarikru/ui';
import type { ActivityItem } from './activity.ts';

/** The latest recorded steps, from the snapshot. Not a live region, so a busy project does not talk over the page. */
export function ActivityFeed({ items, nowMs, stale }: { items: readonly ActivityItem[]; nowMs: number; stale: boolean }) {
  return (
    <section aria-labelledby="activity-title" data-testid="activity-feed" className="panel pointer-events-auto w-full max-w-[19rem] px-3 pt-2 pb-2">
      <h2 id="activity-title" className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.12em] text-muted">
        <i aria-hidden="true" className="led" data-off={stale ? '' : undefined} />
        Activity
      </h2>
      {stale ? <p className="text-sm text-muted">Last confirmed state; the connection is not live.</p> : null}
      {items.length === 0 ? <p className="text-sm text-muted">Nothing recorded yet.</p> : (
        <ul className="m-0 list-none p-0 font-mono text-mono leading-tight">
          {items.map((e) => (
            <li key={e.id} data-testid="activity-item" className="flex gap-1.5 border-t border-dashed border-line py-[3px] first:border-t-0">
              <span aria-hidden="true" className={`w-3 shrink-0 text-center ${TONE_TEXT[e.tone]}`}>{e.glyph}</span>
              <span className="min-w-0 flex-1 truncate text-fg" title={e.text}>{e.text}</span>
              <time dateTime={e.at} className="shrink-0 text-muted"><span className="sr-only">, </span>{formatAge(nowMs - Date.parse(e.at))}<span className="sr-only"> ago</span></time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
