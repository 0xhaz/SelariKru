// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { formatAge } from '@selarikru/ui';
import type { ActivityItem } from './activity.ts';

const ICON: Readonly<Record<ActivityItem['tone'], string>> = { neutral: '#9aa6d1', active: '#29adff', success: '#6cf08a', warning: '#ffc14d', danger: '#ff5c86' };

/**
 * The reference's activity feed: the latest recorded steps, from the snapshot. Not a live region, so a busy project does not talk over the page.
 * Fixed at the bottom left over the office on wide screens; in the page flow below that.
 */
export function ActivityFeed({ items, nowMs, stale }: { items: readonly ActivityItem[]; nowMs: number; stale: boolean }) {
  return (
    <section aria-labelledby="activity-title" data-testid="activity-feed" className="panel-dark pointer-events-auto z-10 w-full overflow-hidden px-2.5 pt-2 pb-1.5 xl:fixed xl:bottom-4 xl:left-4 xl:h-[220px] xl:w-[280px]">
      <h2 id="activity-title" className="mb-1 flex items-center gap-2 text-[13px] uppercase tracking-[0.14em] text-[#b9c3e6]">
        <i aria-hidden="true" className="led" data-off={stale ? '' : undefined} />
        Activity
      </h2>
      {stale ? <p className="text-[13px] text-[#b9c3e6]">Last confirmed state; the connection is not live.</p> : null}
      {items.length === 0 ? <p className="text-[13px] text-[#b9c3e6]">Nothing recorded yet.</p> : (
        <ul className="m-0 list-none p-0 font-mono text-[17px] leading-none">
          {items.map((e) => (
            <li key={e.id} data-testid="activity-item" className="flex gap-1.5 border-t border-dashed border-[rgba(185,195,230,0.15)] py-[3px] first:border-t-0">
              <span aria-hidden="true" className="w-3 shrink-0 text-center" style={{ color: ICON[e.tone] }}>{e.glyph}</span>
              <span className="min-w-0 flex-1 truncate text-cream" title={e.text}>{e.text}</span>
              <time dateTime={e.at} className="shrink-0 text-[#8f9bc4]"><span className="sr-only">, </span>{formatAge(nowMs - Date.parse(e.at))}<span className="sr-only"> ago</span></time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
