/** Elapsed time, largest two units. Age is never negative: a clock skew reads as 0s. */
export function formatAge(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Usage quantities arrive as decimal strings. Callers handle unknown before reaching here: null is never passed as zero. */
export function formatUsd(quantity: string): string {
  const value = Number(quantity);
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

export function formatCount(quantity: string): string {
  return Number(quantity).toLocaleString('en-US');
}

export function formatDuration(seconds: string): string {
  return formatAge(Number(seconds) * 1000);
}

/** Exact local time with the zone, for hover and focus. Stored times are UTC; display follows the viewer's zone. */
export function formatExact(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
