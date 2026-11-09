import { formatExact } from './format.ts';

/** A relative or clock label with the exact local time on hover. The exact time is also what a screen reader gets. */
export function Timestamp({ iso, children }: { iso: string; children: string }) {
  const exact = formatExact(iso);
  return <time dateTime={iso} title={exact} aria-label={`${children} (${exact})`}>{children}</time>;
}
