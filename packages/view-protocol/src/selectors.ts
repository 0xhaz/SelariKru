import { LEASE_EXPIRY_MS, SUSPECT_AFTER_MS } from './common.ts';
import type { ApprovalView, ProjectViewSnapshot, TaskView, WorkerHealth, WorkerView } from './snapshot.ts';

/** Derived reads. Time is a parameter (`nowMs`); nothing here reads a clock. */

export interface WorkerHealthReading {
  readonly health: WorkerHealth;
  /** Milliseconds since the last heartbeat; null when none was recorded or no lease is held. */
  readonly heartbeatAgeMs: number | null;
  /** True when the reading is derived from silence rather than reported. */
  readonly derived: boolean;
}

/**
 * Health from the last confirmed value and heartbeat age. 30 s of silence is a suspected stall, 60 s is a lost connection. Silence only
 * ever worsens a healthy reading; it never turns a failed worker healthy, and it never invents idle or success.
 */
export function effectiveWorkerHealth(worker: WorkerView, nowMs: number): WorkerHealthReading {
  if (!worker.leaseHeld || worker.lastHeartbeatAt === null || worker.health !== 'healthy') {
    return { health: worker.health, heartbeatAgeMs: null, derived: false };
  }
  const age = Math.max(0, nowMs - Date.parse(worker.lastHeartbeatAt));
  if (age >= LEASE_EXPIRY_MS) return { health: 'disconnected', heartbeatAgeMs: age, derived: true };
  if (age >= SUSPECT_AFTER_MS) return { health: 'suspected_stall', heartbeatAgeMs: age, derived: true };
  return { health: 'healthy', heartbeatAgeMs: age, derived: false };
}

export type ApprovalDisplayState = 'pending' | 'granted' | 'denied' | 'expired';

/** A pending approval past its expiry is `expired`: explicit, and never treated as granted. */
export function approvalStateAt(approval: ApprovalView, nowMs: number): ApprovalDisplayState {
  if (approval.state === 'pending' && approval.expiresAt !== null && Date.parse(approval.expiresAt) <= nowMs) return 'expired';
  return approval.state;
}

export function tasksByStatus(snapshot: ProjectViewSnapshot): Record<string, readonly TaskView[]> {
  const out: Record<string, TaskView[]> = {};
  for (const t of Object.values(snapshot.tasks)) (out[t.status] ??= []).push(t);
  return out;
}

/** Counts of tasks with qualifying evidence at their current revision. No percentage is derived from tokens or time. */
export function verifiedCounts(snapshot: ProjectViewSnapshot): { verified: number; total: number } {
  const live = Object.values(snapshot.tasks).filter((t) => t.status !== 'superseded' && t.status !== 'cancelled');
  return { verified: live.filter((t) => t.status === 'verified' || t.status === 'merged').length, total: live.length };
}

export const isEmptyProject = (s: ProjectViewSnapshot): boolean => Object.keys(s.runs).length === 0 && Object.keys(s.tasks).length === 0;
