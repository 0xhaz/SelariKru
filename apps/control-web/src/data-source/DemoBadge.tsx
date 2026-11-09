import type { EngineeringDataSource } from '@selarikru/view-protocol';

/** Persistent label for mock data. It cannot be dismissed, and it renders whenever the source is not live. */
export function DemoBadge({ source }: { source: EngineeringDataSource }) {
  if (source.mode !== 'mock') return null;
  return (
    <div role="status" data-testid="demo-badge" className="fixed right-4 top-4 z-50 rounded border-2 border-amber-700 bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-950">
      Demo data
    </div>
  );
}
