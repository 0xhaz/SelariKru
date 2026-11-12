import { ROUTE_POLICY_LABELS, type RouteRecord } from '@selarikru/domain';
import type { Tone } from '@selarikru/ui';
import { hrefFor } from '../../shell/route.ts';
import { STEP_LABEL } from '../checkpoints/model.ts';
import { sourceLabel } from '../hybrid/model.ts';

/**
 * H9 item 2: every AI call, from the route records only (client reports of kind `route`, as the server keeps them, or the demo source's own). Nothing here is
 * inferred: where a call ran is the record's observed source, and an unknown source stays Unknown. A restricted call shows its labels only.
 */
export interface AiCallRow {
  readonly id: string;
  readonly taskId: string;
  readonly task: string;
  readonly taskHref: string;
  readonly step: string;
  readonly at: string;
  /** The route the server worked out for this call: its label and mode. */
  readonly requested: string;
  readonly requestedSource: string;
  readonly ran: 'On this device' | 'Cloud' | 'Unknown' | 'Did not run';
  readonly ranTone: Tone;
  /** Fell back, escalated, sent after reconnecting, moved to the device, or as routed. */
  readonly how: string;
  readonly timing: string;
  readonly check: string;
  readonly lock: string;
  readonly labels: string;
  readonly model: string | null;
  readonly restricted: boolean;
}

const HIDDEN = 'Not shown (restricted)';
const RESUMED: Readonly<Record<string, string>> = {
  after_reconnect: 'Sent after reconnecting',
  escalated: 'Escalated to the cloud: the local result failed its checks',
  device_only: 'Moved to this device only',
};
const CHECK: Readonly<Record<RouteRecord['validation'], string>> = { passed: 'Passed', failed: 'Failed', not_run: 'Not run' };

const seconds = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const ranAt = (r: RouteRecord): AiCallRow['ran'] => (r.status === 'blocked' || r.status === 'error' ? 'Did not run' : r.observedSource === 'ON_DEVICE' ? 'On this device' : r.observedSource === 'IN_CLOUD' ? 'Cloud' : 'Unknown');

function howOf(r: RouteRecord): string {
  if (r.status === 'blocked' || r.status === 'error') return `Stopped before running${r.blockedReason ? `: ${r.blockedReason.replace(/_/g, ' ')}` : ''}`;
  if (r.status === 'route_violation' || r.conformance === 'violation') return 'Route violation';
  if (r.resumed) return RESUMED[r.resumed] ?? 'As routed';
  if (r.observedSource === 'UNKNOWN' || r.fellBack === null) return 'Unknown';
  if (r.fellBack) return r.observedSource === 'IN_CLOUD' ? 'Fell back to the cloud' : 'Fell back to this device';
  return 'As routed';
}

export function aiCallRows(records: readonly RouteRecord[], titleOf: (taskId: string) => string | null): AiCallRow[] {
  return [...records].sort((a, b) => b.reportedAt.localeCompare(a.reportedAt)).map((r): AiCallRow => {
    const restricted = r.locked || r.inputLabel === 'restricted' || r.inputLabel === 'secret';
    const ran = ranAt(r);
    const how = howOf(r);
    return {
      id: r.recordId, taskId: r.taskId, task: titleOf(r.taskId) ?? r.taskId, taskHref: `${hrefFor('pipeline')}?task=${encodeURIComponent(r.taskId)}`,
      step: STEP_LABEL[r.stepKind] ?? r.stepKind, at: r.reportedAt,
      requested: r.effectiveMode ? `${ROUTE_POLICY_LABELS[r.effectiveMode]} (${r.effectiveMode})` : 'Not set', requestedSource: sourceLabel(r.policySource),
      ran, ranTone: how === 'Route violation' ? 'danger' : ran === 'On this device' ? 'success' : ran === 'Cloud' ? 'active' : ran === 'Unknown' ? 'warning' : 'neutral',
      how: restricted ? HIDDEN : how,
      timing: restricted ? HIDDEN : seconds(r.timing.totalMs),
      check: restricted ? HIDDEN : CHECK[r.validation],
      lock: r.locked ? 'Locked: restricted data stays on this device' : 'None',
      labels: r.inputLabel ?? (r.locked ? 'restricted' : 'Not reported'),
      model: restricted || ran !== 'Cloud' ? null : r.model.cloudModel,
      restricted,
    };
  });
}

export function aiCallsSummary(rows: readonly AiCallRow[]): string {
  if (rows.length === 0) return 'No AI call has been recorded yet.';
  const n = (ran: AiCallRow['ran']): number => rows.filter((r) => r.ran === ran).length;
  return `${rows.length} call${rows.length === 1 ? '' : 's'}: ${n('On this device')} on this device, ${n('Cloud')} in the cloud, ${n('Unknown')} unknown, ${n('Did not run')} stopped before running.`;
}
