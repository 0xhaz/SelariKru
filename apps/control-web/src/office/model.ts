import type { ChangeRequestView, ProjectViewSnapshot, TaskView } from '@selarikru/view-protocol';
import { currentRun } from '../features/settings/model.ts';
import type { TeamModel, TeamRow } from '../features/team/model.ts';
import { agentPalette, stateStyle, type RobotState } from '../theme/tokens.ts';

/**
 * What the office canvas shows, read from SelariKru's own snapshot and team model. It is a picture of the same facts the team panel
 * lists; nothing here is invented for the animation, and a state the source did not confirm stays unknown.
 */

export interface OfficeAgent {
  readonly id: string;
  /** The name on its desk plate and tag: its role, numbered when two share one. */
  readonly name: string;
  readonly color: string;
  readonly state: RobotState;
  readonly label: string;
  readonly taskTitle: string | null;
}

/** A sticky note on the plan wall. Columns: 0 to do, 1 doing, 2 verifying, 3 done. */
export interface OfficeNote {
  readonly taskId: string;
  readonly column: 0 | 1 | 2 | 3;
  readonly status: TaskView['status'];
  readonly ownerId: string | null;
}

/** A pull request on the belt. A run's change has no single author, so none is named. */
export interface OfficeParcel {
  readonly num: number;
  readonly authorId: string | null;
  /**
   * From the run's own verification record, never from the pull request being open. `verified`: its candidate is the run's live candidate,
   * the record stands and every approved criterion passed. `out_of_date`: it no longer holds the run's live candidate. Otherwise `unverified`.
   */
  readonly verification: 'verified' | 'unverified' | 'out_of_date';
  readonly merged: boolean;
  readonly closed: boolean;
}

export interface OfficeWorld {
  readonly projectName: string;
  readonly agents: readonly OfficeAgent[];
  readonly notes: readonly OfficeNote[];
  readonly parcels: readonly OfficeParcel[];
  /** True while any task is verifying: the gate scans. */
  readonly verifying: boolean;
  /** The canvas's text equivalent. */
  readonly summary: string;
}

function prVerification(snapshot: ProjectViewSnapshot, c: ChangeRequestView): OfficeParcel['verification'] {
  if (c.outOfDate || c.status === 'stale_candidate') return 'out_of_date';
  const run = snapshot.runs[c.runId];
  const candidate = run?.evidence?.candidate ?? null;
  const criteria = run?.criteria ?? null;
  const verified = candidate !== null && criteria !== null && candidate.sha === c.candidateSha && candidate.live && candidate.recordValid && criteria.total > 0 && criteria.verified === criteria.total;
  return verified ? 'verified' : 'unverified';
}

const DONE = new Set<TaskView['status']>(['verified', 'merged']);

/** A worker's robot state: its presence first, then what its current task says. A stale or lost reading is never shown as a current one. */
export function robotState(row: TeamRow, snapshot: ProjectViewSnapshot): RobotState {
  const p = row.presence.state;
  if (p === 'unknown') return 'unknown';
  if (p === 'lost') return 'offline';
  const status = row.task ? snapshot.tasks[row.task.taskId]?.status ?? null : null;
  if (p === 'needs_you' || status === 'awaiting_approval') return 'needs_input';
  if (p === 'blocked') return 'blocked';
  if (status !== null && DONE.has(status)) return 'verified';
  if (status === 'verifying') return 'in_review';
  if (p === 'working') return 'working';
  return 'idle';
}

const COLUMN: Readonly<Partial<Record<TaskView['status'], OfficeNote['column']>>> = {
  planned: 0, ready: 0, blocked: 0, running: 1, awaiting_approval: 1, verifying: 2, verified: 3, merged: 3,
};

const ORDER: readonly RobotState[] = ['needs_input', 'working', 'in_review', 'verified', 'blocked', 'idle', 'offline', 'unknown'];

const roleName = (role: string | null): string => (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Worker');

export function buildOfficeWorld(snapshot: ProjectViewSnapshot, team: TeamModel, projectName: string): OfficeWorld {
  // Colours follow the worker's id, not its place in the attention order, so a robot keeps its colour as the order changes.
  const ids = Object.keys(snapshot.workers).sort();
  const colorOf = (id: string): string => agentPalette[Math.max(0, ids.indexOf(id)) % agentPalette.length]!;
  const seen = new Map<string, number>();
  const roles = new Map<string, number>();
  for (const r of team.rows) roles.set(roleName(r.role), (roles.get(roleName(r.role)) ?? 0) + 1);
  const agents = team.rows.map((r): OfficeAgent => {
    const base = roleName(r.role);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const state = robotState(r, snapshot);
    return { id: r.workerId, name: (roles.get(base) ?? 0) > 1 ? `${base} ${n}` : base, color: colorOf(r.workerId), state, label: stateStyle[state].label, taskTitle: r.task?.title ?? null };
  });

  const run = currentRun(snapshot);
  const holder = new Map(Object.values(snapshot.workers).filter((w) => w.taskId !== null).map((w) => [w.taskId!, w.workerId]));
  const notes = Object.values(snapshot.tasks)
    .filter((t) => run === null || t.runId === run.runId)
    .flatMap((t): OfficeNote[] => {
      const column = COLUMN[t.status];
      return column === undefined ? [] : [{ taskId: t.taskId, column, status: t.status, ownerId: holder.get(t.taskId) ?? null }];
    });

  const parcels = snapshot.changeRequests.map((c): OfficeParcel => {
    const merged = c.status === 'merged' || c.mergeCommitSha !== null;
    return { num: c.prNumber, authorId: null, verification: prVerification(snapshot, c), merged, closed: !merged && c.status === 'closed' };
  });
  const verifying = Object.values(snapshot.tasks).some((t) => t.status === 'verifying');

  let summary: string;
  if (agents.length === 0) summary = `Office for ${projectName}: no workers yet.`;
  else {
    const counts = ORDER.map((s) => [s, agents.filter((a) => a.state === s).length] as const).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${stateStyle[s].label.toLowerCase()}`);
    const open = parcels.filter((p) => !p.closed && !p.merged).length;
    const prs = open > 0 ? ` ${open} pull request${open === 1 ? '' : 's'}.` : '';
    summary = `Office for ${projectName}: ${agents.length} worker${agents.length === 1 ? '' : 's'}. ${counts.join(', ')}.${prs} The team panel lists each worker.`;
  }
  return { projectName, agents, notes, parcels, verifying, summary };
}
