import type { HandoverEstimateView, HandoverRecordView, HandoverTaskView } from '@selarikru/view-protocol';
import type { Tone } from '@selarikru/ui';

/** The handover's path, in order, as the owner reads it. A restart offer and a decline are off this path and say so in words. */
export const HANDOVER_STEPS = [
  { state: 'stopping', label: 'Stopping local attempt' },
  { state: 'awaiting_review', label: 'Checkpoint ready for review' },
  { state: 'fenced', label: 'Fenced' },
  { state: 'starting', label: 'Cloud attempt starting' },
  { state: 'running', label: 'Running' },
] as const;

export const stepIndex = (state: HandoverRecordView['state']): number => HANDOVER_STEPS.findIndex((s) => s.state === state);

/** States in which the record will move without the owner. */
export const TRANSITIONAL: readonly HandoverRecordView['state'][] = ['stopping', 'fenced', 'starting'];

export function stateTone(state: HandoverRecordView['state']): Tone {
  if (state === 'restart_offered' || state === 'awaiting_review') return 'warning';
  if (state === 'running') return 'success';
  if (state === 'declined' || state === 'closed') return 'neutral';
  return 'active';
}

/** A figure with its label, or Unknown. Never a number without its provenance. */
export function costText(e: HandoverEstimateView['costUsd']): string {
  return e.value === null || e.provenance === 'unavailable' ? 'Unknown' : `$${e.value.toFixed(2)} (estimated, at most)`;
}

export function timeText(e: HandoverEstimateView['timeSeconds']): string {
  if (e.value === null || e.provenance === 'unavailable') return 'Unknown';
  const m = Math.floor(e.value / 60);
  const s = e.value % 60;
  return `${m > 0 ? `${m} min ` : ''}${s} s (estimated)`;
}

export const shortSha = (sha: string | null): string => (sha === null ? 'Unknown' : sha.slice(0, 12));

/** What the row and the drawer say about one task: in progress, offered, or why not. */
export interface HandoverSummary {
  readonly label: string;
  readonly tone: Tone;
  readonly canResume: boolean;
  readonly canRestart: boolean;
  readonly why: string | null;
}

/** A handover still in hand: not declined or closed, and not one whose successor has since finished. */
export const inHand = (t: HandoverTaskView): boolean => {
  const c = t.current;
  return c !== null && c.state !== 'declined' && c.state !== 'closed' && !(c.state === 'running' && t.status !== 'running');
};

export function summarize(t: HandoverTaskView): HandoverSummary {
  const c = t.current;
  if (c && inHand(t)) return { label: c.state === 'restart_offered' ? 'Restart offered' : c.stateLabel, tone: stateTone(c.state), canResume: false, canRestart: false, why: c.refusal?.text ?? null };
  return {
    label: t.resume.eligible ? 'Can continue in cloud' : 'Cannot continue in cloud', tone: t.resume.eligible ? 'neutral' : 'warning',
    canResume: t.resume.eligible, canRestart: !t.resume.eligible && t.restart.eligible, why: t.resume.eligible ? null : (t.resume.reasonText[0] ?? null),
  };
}
