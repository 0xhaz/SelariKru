import type { ProjectViewSnapshot, TaskView } from '@selarikru/view-protocol';
import type { Tone } from '@selarikru/ui';
import { isRecordedMerge } from '../../office/model.ts';
import { fallbackReason } from '../../features/hybrid/model.ts';

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
  failed: { word: 'failed', glyph: '✗', tone: 'danger' },
  cancelled: { word: 'cancelled', glyph: '–', tone: 'neutral' },
  superseded: { word: 'superseded', glyph: '–', tone: 'neutral' },
};

/** Pull request states that are not what they look like: only `merged` is a recorded merge. Same words as Evidence. */
const PR_STATUS: Readonly<Record<string, string>> = {
  merged_sha_mismatch: 'merged a commit that is not the verified one; no merge is recorded',
  stale_candidate: "no longer holds the run's candidate",
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
  // Where each task's last AI call ran, as the browser reported it (untrusted). A blocked call did not run, so it is not listed here.
  for (const t of Object.values(snapshot.tasks)) {
    const r = t.route?.lastObserved;
    if (!r || r.status === 'blocked' || r.status === 'error') continue;
    const where = r.observedSource === 'UNKNOWN' ? { text: 'AI ran, source unknown', glyph: '?', tone: 'warning' as const }
      : r.fellBack === true ? { text: r.observedSource === 'IN_CLOUD' ? 'AI fell back to cloud' : 'AI fell back to device', glyph: '↷', tone: 'warning' as const }
        : r.observedSource === 'IN_CLOUD' ? { text: 'AI ran in cloud', glyph: '☁', tone: 'active' as const } : { text: 'AI ran on device', glyph: '▣', tone: 'success' as const };
    items.push({ id: `ai:${r.recordId}`, at: r.reportedAt, glyph: where.glyph, tone: where.tone, text: `${t.title ?? t.taskId}: ${where.text}` });
  }
  for (const h of snapshot.approvalHistory) {
    if (!h.resolvedAt) continue;
    items.push({ id: `approval:${h.approvalId}`, at: h.resolvedAt, glyph: h.outcome === 'granted' ? '✓' : '✕', tone: h.outcome === 'granted' ? 'success' : 'neutral', text: `Approval ${h.outcome} for ${title(h.taskId)}` });
  }
  for (const c of snapshot.changeRequests) {
    if (!c.observedAt) continue;
    const merged = isRecordedMerge(c);
    const said = PR_STATUS[c.status];
    const tone = merged ? 'success' : said ? 'warning' : 'active';
    items.push({ id: `pr:${c.prNumber}`, at: c.observedAt, glyph: merged ? '⇢' : said ? '!' : '⇡', tone, text: `Pull request #${c.prNumber} ${merged ? 'was merged' : said ?? `is ${c.status}`}` });
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

/** The run's AI calls by where they ran (H7): each task's last route record in that run, as the browser reported it. Nothing in flight is counted. */
export interface AiRunCounts {
  readonly device: number;
  readonly cloud: number;
  readonly fellBack: number;
  readonly unknown: number;
  readonly total: number;
}

/**
 * Counted from records only: a record that fell back counts once, as a fallback, never also as device or cloud; an unknown source is its own count, never
 * either side; a blocked or failed call did not run and is left out, as is a task with no call yet.
 */
export function aiRunCounts(snapshot: ProjectViewSnapshot, runId: string | null): AiRunCounts {
  const c = { device: 0, cloud: 0, fellBack: 0, unknown: 0 };
  if (runId !== null) {
    for (const t of Object.values(snapshot.tasks)) {
      const r = t.runId === runId ? t.route?.lastObserved : null;
      if (!r || r.status === 'blocked' || r.status === 'error') continue;
      if (r.observedSource === 'UNKNOWN') c.unknown += 1;
      else if (r.fellBack === true) c.fellBack += 1;
      else if (r.observedSource === 'ON_DEVICE') c.device += 1;
      else c.cloud += 1;
    }
  }
  return { ...c, total: c.device + c.cloud + c.fellBack + c.unknown };
}

export interface FallbackNote {
  readonly title: 'Fell back to cloud' | 'Fell back to this device';
  readonly task: string;
  readonly reason: string;
  readonly at: string;
}

/** The most recent route record that fell back, with its reason in one plain line (from what the record says, never guessed beyond it). */
export function latestFallback(snapshot: ProjectViewSnapshot): FallbackNote | null {
  let best: FallbackNote | null = null;
  for (const t of Object.values(snapshot.tasks)) {
    const r = t.route?.lastObserved;
    if (!r || r.fellBack !== true || r.status === 'blocked' || r.status === 'error') continue;
    if (best && Date.parse(best.at) >= Date.parse(r.reportedAt)) continue;
    best = { title: r.observedSource === 'IN_CLOUD' ? 'Fell back to cloud' : 'Fell back to this device', task: t.title ?? t.taskId, reason: fallbackReason(r), at: r.reportedAt };
  }
  return best;
}
