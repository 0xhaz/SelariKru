/** Persistent label for mock data. It cannot be dismissed, and it renders whenever the source is not live. */
export function DemoBadge({ mode }: { mode: 'mock' | 'live' }) {
  if (mode !== 'mock') return null;
  return (
    <span role="status" data-testid="demo-badge" className="inline-flex items-center gap-1.5 rounded-[4px] bg-warning px-2 py-1 text-sm font-semibold text-bg">
      <span aria-hidden="true" className="text-[10px]">▲</span>
      Demo data
    </span>
  );
}
