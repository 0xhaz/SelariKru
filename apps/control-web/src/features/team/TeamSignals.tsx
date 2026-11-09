import { Chip, Timestamp, formatAge, formatClock, type Tone } from '@selarikru/ui';
import type { TeamRow } from './model.ts';

export const roleName = (role: string | null): string => (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Unassigned');

export const PROVENANCE_CHIP: Readonly<Record<string, { tone: Tone; text: string }>> = {
  observed: { tone: 'success', text: 'Observed' }, estimated: { tone: 'warning', text: 'Estimated' }, unavailable: { tone: 'neutral', text: 'Unavailable' },
};

export function ActivitySignalView({ row }: { row: TeamRow }) {
  const a = row.activity;
  return (
    <div data-testid="signal-activity" className="min-w-0 space-y-1">
      {a.reported ? <Chip tone={a.tone}>{a.label}</Chip> : <span className="text-sm text-muted">{a.label}</span>}
      {a.stale ? <p className="text-sm text-muted">Last confirmed value</p> : null}
      {a.tool ? <p className="wrap-anywhere font-mono text-mono text-muted">{a.tool}</p> : null}
      {a.since && !a.stale ? <p className="text-sm text-muted">for {a.since}</p> : null}
      {row.blockers > 0 ? <p className="text-sm text-warning">{row.blockers} {row.blockers === 1 ? 'blocker' : 'blockers'}</p> : null}
    </div>
  );
}

export function HealthSignalView({ row, nowMs }: { row: TeamRow; nowMs: number }) {
  return (
    <div data-testid="signal-health" className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={row.health.tone}>{row.health.label}</Chip>
        {row.stale ? <Chip tone="neutral" testId="stale-label">Stale</Chip> : null}
      </div>
      {row.stale ? (
        <p className="text-sm text-muted">State last confirmed <Timestamp tabStop={false} iso={row.lastConfirmedAt}>{formatClock(row.lastConfirmedAt)}</Timestamp>, <span className="whitespace-nowrap">{formatAge(nowMs - Date.parse(row.lastConfirmedAt))} ago</span></p>
      ) : row.healthNote ? <p className="text-sm text-muted">{row.healthNote}</p> : null}
    </div>
  );
}

export function ResultSignalView({ row, nowMs }: { row: TeamRow; nowMs: number }) {
  const r = row.results;
  if (!r.known) return <div data-testid="signal-results"><span className="text-sm text-muted">{r.label}</span></div>;
  return (
    <div data-testid="signal-results" className="min-w-0 space-y-1">
      <Chip tone={r.tone}>{r.label}</Chip>
      {r.detail ? <p className="wrap-anywhere text-sm text-muted">{r.detail}</p> : null}
      {r.at ? <p className="text-sm text-muted"><Timestamp tabStop={false} iso={r.at}>{`${formatAge(nowMs - Date.parse(r.at))} ago`}</Timestamp></p> : null}
    </div>
  );
}
