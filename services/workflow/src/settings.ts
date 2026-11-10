import { schema, type Tx } from '@selarikru/persistence';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { TaskSpec } from '@selarikru/domain';
import { hasCancelRequest } from './cancel.ts';
import type { TaskKey } from './taskstate.ts';

/**
 * What the owner's saved settings say about claims, read from the desired value: a pause or a revoke blocks new claims from the moment its save commits,
 * whatever any runner has acknowledged. Saves take the scheduler lock, so a claim either committed before the save or reads it.
 */
export interface RunGate {
  readonly paused: boolean;
  /** The plan paths still allowed. Null: not narrowed, so the plan's own paths stand. */
  readonly allowedPaths: readonly string[] | null;
  /** False: the owner took cloud away. Null: not set, so the run's placement decides. */
  readonly cloudEligible: boolean | null;
}

const OPEN: RunGate = { paused: false, allowedPaths: null, cloudEligible: null };

export async function loadRunGates(tx: Tx, tenantId: string, runIds: readonly string[]): Promise<ReadonlyMap<string, RunGate>> {
  const ids = [...new Set(runIds)];
  const out = new Map<string, RunGate>();
  if (ids.length === 0) return out;
  const rows = await tx.select({ runId: schema.runSettings.runId, projectId: schema.runSettings.projectId, field: schema.runSettings.field, desired: schema.runSettings.desired })
    .from(schema.runSettings).where(and(eq(schema.runSettings.tenantId, tenantId), inArray(schema.runSettings.runId, ids)));
  for (const r of rows) {
    const key = `${r.projectId}:${r.runId}`;
    const g = out.get(key) ?? OPEN;
    if (r.field === 'paused') out.set(key, { ...g, paused: r.desired === true });
    // Anything but a list of strings is unreadable, and an unreadable narrowing allows nothing rather than everything.
    else if (r.field === 'allowed_paths') out.set(key, { ...g, allowedPaths: Array.isArray(r.desired) ? r.desired.filter((p): p is string => typeof p === 'string') : [] });
    else if (r.field === 'cloud_eligible') out.set(key, { ...g, cloudEligible: r.desired === true });
  }
  return out;
}

export const gateFor = (gates: ReadonlyMap<string, RunGate>, projectId: string, runId: string): RunGate => gates.get(`${projectId}:${runId}`) ?? OPEN;

/** The task's paths the owner has since taken away. Empty: it may still run. */
export const pathsRevoked = (spec: Pick<TaskSpec, 'allowedPaths'>, gate: RunGate): readonly string[] =>
  gate.allowedPaths === null ? [] : spec.allowedPaths.filter((p) => !gate.allowedPaths!.includes(p));

export interface RunnerGate {
  readonly enabled: boolean;
  /** Null: not limited by the owner. */
  readonly slots: number | null;
}

export async function loadRunnerGate(tx: Tx, tenantId: string, runnerId: string): Promise<RunnerGate> {
  const rows = await tx.select({ field: schema.runnerSettings.field, desired: schema.runnerSettings.desired }).from(schema.runnerSettings)
    .where(and(eq(schema.runnerSettings.tenantId, tenantId), eq(schema.runnerSettings.runnerId, runnerId)));
  const enabled = rows.find((r) => r.field === 'enabled');
  const slots = rows.find((r) => r.field === 'slots');
  return {
    // Only an explicit true keeps a saved row enabled; an unreadable one is off.
    enabled: enabled === undefined ? true : enabled.desired === true,
    slots: slots === undefined ? null : typeof slots.desired === 'number' && Number.isInteger(slots.desired) && slots.desired >= 1 ? slots.desired : 0,
  };
}

/**
 * Asks the running attempt of a task to stop because the owner narrowed what it was granted, through the existing cancel request: the runner sees it on
 * its next heartbeat. When the attempt ends the task is not cancelled: it goes back to ready, blocked by the revoke, with its repair budget kept
 * (`confirmCancel`). Call with the task's status row locked. Returns false when the task is not running or a stop is already open.
 */
export async function requestPolicyStop(tx: Tx, key: TaskKey, reason: string, requestedBy: string, now: Date): Promise<boolean> {
  const [row] = await tx.select({ status: schema.taskStatus.status, revision: schema.taskStatus.currentRevision }).from(schema.taskStatus)
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId))).for('update');
  if (row?.status !== 'running') return false;
  if (await hasCancelRequest(tx, key, row.revision)) return false;
  const open = await tx.select({ attemptId: schema.attempts.attemptId }).from(schema.attempts)
    .where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.taskId, key.taskId), isNull(schema.attempts.endedAt)));
  await tx.insert(schema.taskCommands).values({
    tenantId: key.tenantId, projectId: key.projectId, operationId: `op_${randomUUID()}`, taskId: key.taskId, revision: row.revision,
    command: 'cancel', state: 'cancel_requested', requestedBy, requestedAt: now, detail: { reason, attemptIds: open.map((a) => a.attemptId) },
  });
  return true;
}
