// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { formatAge } from '@selarikru/ui';
import type { ActivityItem, FallbackNote } from './activity.ts';

const ICON: Readonly<Record<ActivityItem['tone'], string>> = { neutral: '#d0d8d3', active: '#9fd8cf', success: '#8fd89a', warning: '#f2c45a', danger: '#f2a48a' };

/**
 * The reference's activity feed: the latest recorded steps, from the snapshot. Not a live region, so a busy project does not talk over the page.
 * Fixed at the bottom left over the office on wide screens; in the page flow below that.
 */
export function ActivityFeed({ items, fallback = null, nowMs, stale }: { items: readonly ActivityItem[]; fallback?: FallbackNote | null; nowMs: number; stale: boolean }) {
  return (
    <section aria-labelledby="activity-title" data-testid="activity-feed" className="panel-dark pointer-events-auto z-10 w-full overflow-hidden px-2.5 pt-2 pb-1.5 xl:fixed xl:bottom-4 xl:left-4 xl:h-[220px] xl:w-[280px]">
      <h2 id="activity-title" className="mb-1 flex items-center gap-2 text-[13px] uppercase tracking-[0.14em] text-feed-soft">
        <i aria-hidden="true" className="led" data-off={stale ? '' : undefined} />
        Activity
      </h2>
      {stale ? <p className="text-[13px] text-feed-soft">Last confirmed state; the connection is not live.</p> : null}
      {/* H7: the latest fallback, from its route record, in one plain line with its reason. */}
      {fallback ? (
        <p data-testid="activity-fallback" className="mb-1 rounded-[4px] border-2 border-gold bg-deep-2 px-1.5 py-0.5 text-[12px] leading-snug text-paper" title={`${fallback.title}: ${fallback.task}. ${fallback.reason}`}>
          <b className="text-gold"><span aria-hidden="true">↷ </span>{fallback.title}</b> · {fallback.task} · <time dateTime={fallback.at}>{formatAge(nowMs - Date.parse(fallback.at))}<span className="sr-only"> ago</span></time>
          <span className="block">{fallback.reason}</span>
        </p>
      ) : null}
      {items.length === 0 ? <p className="text-[13px] text-feed-soft">Nothing recorded yet.</p> : (
        <ul className="m-0 list-none p-0 font-mono text-[17px] leading-none">
          {items.map((e) => (
            <li key={e.id} data-testid="activity-item" className="flex gap-1.5 border-t border-dashed border-[rgba(201,221,214,0.18)] py-[3px] first:border-t-0">
              <span aria-hidden="true" className="w-3 shrink-0 text-center" style={{ color: ICON[e.tone] }}>{e.glyph}</span>
              <span className="min-w-0 flex-1 truncate text-paper" title={e.text}>{e.text}</span>
              <time dateTime={e.at} className="shrink-0 text-feed-time"><span className="sr-only">, </span>{formatAge(nowMs - Date.parse(e.at))}<span className="sr-only"> ago</span></time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
