import type { ProjectViewSnapshot, TaskView } from '@selarikru/view-protocol';
import type { Tone } from '@selarikru/ui';

/**
 * The activity feed: the latest things the snapshot itself records, each with the time it carries. It is read from the current snapshot,
 * not a log, so it shows each task's and attempt's latest step, not every step it took.
 */
export interface ActivityItem {
  readonly id: string;
  readonly at: string;
  readonly glyph: string;
  readonly tone: Tone;
  readonly text: string;
}

const STATUS: Readonly<Record<TaskView['status'], { word: string; glyph: string; tone: Tone }>> = {
  planned: { word: 'planned', glyph: '+', tone: 'neutral' },
  ready: { word: 'queued', glyph: '▸', tone: 'neutral' },
  running: { word: 'running', glyph: '●', tone: 'active' },
  awaiting_approval: { word: 'needs you', glyph: '▲', tone: 'warning' },
  blocked: { word: 'blocked', glyph: '‖', tone: 'warning' },
  verifying: { word: 'verifying', glyph: '◎', tone: 'active' },
  verified: { word: 'verified, awaiting merge', glyph: '✓', tone: 'success' },
  merged: { word: 'merged', glyph: '⇢', tone: 'success' },
  failed: { word: 'failed', glyph: '✕', tone: 'danger' },
  cancelled: { word: 'cancelled', glyph: '–', tone: 'neutral' },
  superseded: { word: 'superseded', glyph: '–', tone: 'neutral' },
};

const OUTCOME: Readonly<Record<string, string>> = { succeeded: 'finished', failed: 'failed', cancelled: 'was cancelled', interrupted: 'was interrupted' };

export function recentActivity(snapshot: ProjectViewSnapshot, limit: number): readonly ActivityItem[] {
  const title = (taskId: string | null): string => (taskId ? snapshot.tasks[taskId]?.title ?? taskId : 'a task');
  const items: ActivityItem[] = [];
  for (const t of Object.values(snapshot.tasks)) {
    const s = STATUS[t.status];
    items.push({ id: `task:${t.taskId}`, at: t.enteredStatusAt, glyph: s.glyph, tone: s.tone, text: `${t.title ?? t.taskId}: ${s.word}` });
  }
  for (const a of Object.values(snapshot.attempts)) {
    if (a.endedAt) items.push({ id: `attempt:${a.attemptId}`, at: a.endedAt, glyph: a.outcome === 'succeeded' ? '✓' : '✕', tone: a.outcome === 'succeeded' ? 'success' : a.outcome === 'failed' ? 'danger' : 'neutral', text: `Attempt ${a.number} on ${title(a.taskId)} ${OUTCOME[a.outcome] ?? a.outcome}` });
    else items.push({ id: `attempt:${a.attemptId}`, at: a.startedAt, glyph: '●', tone: 'active', text: `Attempt ${a.number} started on ${title(a.taskId)}` });
  }
  for (const h of snapshot.approvalHistory) {
    if (!h.resolvedAt) continue;
    items.push({ id: `approval:${h.approvalId}`, at: h.resolvedAt, glyph: h.outcome === 'granted' ? '✓' : '✕', tone: h.outcome === 'granted' ? 'success' : 'neutral', text: `Approval ${h.outcome} for ${title(h.taskId)}` });
  }
  for (const c of snapshot.changeRequests) {
    if (!c.observedAt) continue;
    const merged = c.status === 'merged' || c.mergeCommitSha !== null;
    items.push({ id: `pr:${c.prNumber}`, at: c.observedAt, glyph: merged ? '⇢' : '⇡', tone: merged ? 'success' : 'active', text: merged ? `Pull request #${c.prNumber} was merged` : `Pull request #${c.prNumber} is ${c.status}` });
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}
