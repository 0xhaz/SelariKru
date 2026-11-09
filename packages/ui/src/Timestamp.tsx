import { useRef, useState } from 'react';
import { formatExact } from './format.ts';

const TOOLTIP_WIDTH_PX = 256;

/**
 * A relative or clock label that shows the exact local time in a tooltip on hover, positioned so the line does not move. By default it is also a
 * tab stop, showing the tooltip on focus and giving a screen reader the exact time in its label. With `tabStop={false}`, for row-heavy views, it is
 * plain text with the tooltip on hover only, so the view must make the exact time reachable some other way.
 */
export function Timestamp({ iso, children, tabStop = true }: { iso: string; children: string; tabStop?: boolean }) {
  const exact = formatExact(iso);
  const ref = useRef<HTMLSpanElement>(null);
  const [alignRight, setAlignRight] = useState(false);
  // Opens leftwards near the right edge, so it can never cause horizontal scrolling.
  const place = (): void => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setAlignRight(box.left + TOOLTIP_WIDTH_PX > window.innerWidth);
  };
  return (
    <span ref={ref} className="group relative inline-block" onMouseEnter={place} onFocus={place}>
      {tabStop ? <time dateTime={iso} tabIndex={0} aria-label={`${children} (${exact})`} className="rounded-chip">{children}</time> : <time dateTime={iso}>{children}</time>}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-full z-30 mb-1 hidden w-max max-w-64 rounded-chip border border-line-strong bg-panel-2 px-2 py-1 text-sm text-fg group-hover:block group-focus-within:block ${alignRight ? 'right-0' : 'left-0'}`}
      >
        {exact}
      </span>
    </span>
  );
}
