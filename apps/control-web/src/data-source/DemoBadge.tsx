/** Persistent label for mock data. It cannot be dismissed, and it renders whenever the source is not live. */
export function DemoBadge({ mode, testId = 'demo-badge' }: { mode: 'mock' | 'live'; testId?: string }) {
  if (mode !== 'mock') return null;
  return (
    <span role="status" data-testid={testId} className="inline-flex items-center gap-1.5 rounded-chip bg-warning px-2 py-1 text-sm font-semibold text-bg">
      <span aria-hidden="true" className="text-glyph">▲</span>
      Demo data
    </span>
  );
}
