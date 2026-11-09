import { formatExact } from './format.ts';

/** A relative or clock label that reveals the exact local time on hover and on keyboard focus. A screen reader gets the exact time as well. */
export function Timestamp({ iso, children }: { iso: string; children: string }) {
  const exact = formatExact(iso);
  return (
    <span className="group">
      <time dateTime={iso} tabIndex={0} aria-label={`${children} (${exact})`} className="rounded-chip">{children}</time>
      <span aria-hidden="true" className="hidden wrap-anywhere group-hover:inline group-focus-within:inline"> ({exact})</span>
    </span>
  );
}
