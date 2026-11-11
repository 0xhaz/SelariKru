import { ROUTE_POLICY_LABELS, RUNNER_RECENT_SECONDS } from '@selarikru/domain';
import { LEASE_EXPIRY_MS, LIVENESS_STALE_MS, SUSPECT_AFTER_MS } from './common.ts';
import type { ApprovalView, ProjectViewSnapshot, RunView, RunnerView, TaskRouteView, TaskView, WorkerHealth, WorkerView } from './snapshot.ts';

/** Derived reads. Time is a parameter (`nowMs`); nothing here reads a clock. */

export interface WorkerHealthReading {
  /** `unknown` when liveness data is stale (a refresh outage): silence then says nothing about the worker. */
  readonly health: WorkerHealth | 'unknown';
  /** Milliseconds since the last heartbeat; null when none was recorded or no lease is held. */
  readonly heartbeatAgeMs: number | null;
  /** True when the reading is derived from silence rather than reported. */
  readonly derived: boolean;
}

/**
 * Health from the last confirmed value and heartbeat age. 30 s of silence is a suspected stall, 60 s is a lost connection. Silence only
 * ever worsens a healthy reading; it never turns a failed worker healthy, and it never invents idle or success.
 */
export function effectiveWorkerHealth(worker: WorkerView, nowMs: number, livenessAsOfMs: number | null): WorkerHealthReading {
  if (!worker.leaseHeld || worker.lastHeartbeatAt === null || worker.health !== 'healthy') {
    return { health: worker.health, heartbeatAgeMs: null, derived: false };
  }
  // Heartbeats reach the projection only through refreshes. If the last successful one is old (or there never was one), a stale
  // heartbeat time could be our outage rather than the worker, so the honest reading is unknown.
  if (livenessAsOfMs === null || nowMs - livenessAsOfMs >= LIVENESS_STALE_MS) {
    return { health: 'unknown', heartbeatAgeMs: null, derived: true };
  }
  const age = Math.max(0, nowMs - Date.parse(worker.lastHeartbeatAt));
  if (age >= LEASE_EXPIRY_MS) return { health: 'disconnected', heartbeatAgeMs: age, derived: true };
  if (age >= SUSPECT_AFTER_MS) return { health: 'suspected_stall', heartbeatAgeMs: age, derived: true };
  return { health: 'healthy', heartbeatAgeMs: age, derived: false };
}

/** Whether a runner reached the control plane recently. Uses the same window the scheduler uses, so what is shown and what is counted agree. */
export function runnerRecent(runner: Pick<RunnerView, 'lastSeenAt'>, nowMs: number): boolean {
  return runner.lastSeenAt !== null && nowMs - Date.parse(runner.lastSeenAt) < RUNNER_RECENT_SECONDS * 1000;
}

export type ApprovalDisplayState = 'pending' | 'granted' | 'denied' | 'expired' | 'superseded';

/** A pending approval past its expiry is `expired`: explicit, and never treated as granted. */
export function approvalStateAt(approval: ApprovalView, nowMs: number): ApprovalDisplayState {
  if (approval.state === 'pending' && approval.expiresAt !== null && Date.parse(approval.expiresAt) <= nowMs) return 'expired';
  return approval.state;
}

/**
 * True when a budget stop ended this task. A snapshot says so through the run's assessment or its recorded acceptance, because it carries no cancel reason on
 * the task; an event says so through `cancelReason`. A plain cancel is none of these.
 */
export function isBudgetStopped(task: Pick<TaskView, 'taskId' | 'revision' | 'status' | 'cancelReason'>, run: Pick<RunView, 'scopeAssessment' | 'reducedScope'> | undefined): boolean {
  if (task.status !== 'cancelled') return false;
  if (task.cancelReason === 'budget_exhausted') return true;
  const same = (t: { taskId: string; revision: number }): boolean => t.taskId === task.taskId && t.revision === task.revision;
  return (run?.scopeAssessment?.stopped.some(same) ?? false) || (run?.reducedScope?.notDelivered.tasks.some((t) => t.budgetStopped && same(t)) ?? false);
}

/** Blocks that a re-verification can send back without a worker. The same rule as `isReverifiableBlock` on the server. */
export const isReverifiableReason = (code: string | null): boolean => code === 'verification_error' || (code?.startsWith('assembly_infrastructure:') ?? false);

export function tasksByStatus(snapshot: ProjectViewSnapshot): Record<string, readonly TaskView[]> {
  const out: Record<string, TaskView[]> = {};
  for (const t of Object.values(snapshot.tasks)) (out[t.status] ??= []).push(t);
  return out;
}

/**
 * Counts of tasks with qualifying evidence at their current revision, optionally for one run. Work stopped for budget stays in the total: its
 * acceptance is still unmet, and leaving it out would make a run look closer to done. No percentage is derived from tokens or time.
 */
export function verifiedCounts(snapshot: ProjectViewSnapshot, runId?: string): { verified: number; total: number } {
  const live = Object.values(snapshot.tasks).filter((t) => (runId === undefined || t.runId === runId) && t.status !== 'superseded' && (t.status !== 'cancelled' || isBudgetStopped(t, snapshot.runs[t.runId])));
  return { verified: live.filter((t) => t.status === 'verified' || t.status === 'merged').length, total: live.length };
}

export const isEmptyProject = (s: ProjectViewSnapshot): boolean => Object.keys(s.runs).length === 0 && Object.keys(s.tasks).length === 0;

const ROUTE_SOURCE_WORDS = { call: 'this call', task: 'task override', run: 'run default', unset: 'not set' } as const;
const OBSERVED_WORDS = { ON_DEVICE: 'On device', IN_CLOUD: 'Cloud', UNKNOWN: 'Unknown' } as const;

/**
 * A task's route in words: the effective mode (`Local only`, `Local first`, `Cloud only`, `Cloud first`, or `Not set`), where it came from, and where the last call
 * actually ran as the browser reported it. An unknown source stays unknown; nothing is counted as on the device because of a setting.
 */
export function taskRouteLabel(route: TaskRouteView): { readonly mode: string; readonly source: string; readonly observed: string | null } {
  const mode = route.effective === null ? 'Not set' : ROUTE_POLICY_LABELS[route.effective];
  const source = route.source === 'lock' ? `locked: ${route.lock?.label ?? 'restricted'} data` : ROUTE_SOURCE_WORDS[route.source];
  const last = route.lastObserved;
  const observed = last === null ? null : `${OBSERVED_WORDS[last.observedSource]}${last.fellBack === true ? ', fell back' : ''} (reported by the browser)`;
  return { mode, source, observed };
}
