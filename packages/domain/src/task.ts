import { z } from 'zod';
import { Id, Sha256, SchemaVersion } from './common.ts';
import { err, ok, type Result } from './result.ts';

export const TASK_STATUSES = [
  'planned', 'ready', 'running', 'awaiting_approval', 'blocked', 'verifying',
  'verified', 'merged', 'failed', 'cancelled', 'superseded',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const DEPENDENCY_CONDITIONS = ['artifact_verified', 'candidate_verified', 'change_merged'] as const;

export const TaskSpecSchema = z
  .object({
    schemaVersion: SchemaVersion,
    tenantId: Id,
    projectId: Id,
    runId: Id,
    taskId: Id,
    boardId: Id,
    revision: z.number().int().min(1),
    role: Id,
    title: Id,
    baseSha: Id,
    requirementIds: z.array(Id),
    dependencies: z.array(
      z.object({ taskId: Id, revision: z.number().int().min(1), condition: z.enum(DEPENDENCY_CONDITIONS) }).strict(),
    ),
    contractRefs: z.array(z.object({ artifactId: Id, sha256: Sha256 }).strict()),
    allowedPaths: z.array(Id),
    resourceClaims: z.array(z.object({ key: Id, mode: z.enum(['shared', 'exclusive']) }).strict()),
    acceptanceCheckIds: z.array(Id),
    classification: z.enum(['public', 'internal', 'restricted', 'secret']),
    policyVersion: Id,
    execution: z.enum(['local', 'cloud', 'eligible_any']),
    inferencePolicyId: Id,
    limits: z
      .object({
        maxAttempts: z.number().int().min(1),
        timeoutSeconds: z.number().int().min(1),
        maxCostUsd: z.number().min(0),
      })
      .strict(),
  })
  .strict();
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/** `repository` tasks may reach `merged`; `artifact` tasks end at `verified`. */
export type TaskKind = 'repository' | 'artifact';

export interface AttemptRecord {
  readonly attemptId: string;
  readonly number: number;
  readonly outcome: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly reason?: string;
}

export interface TransitionRecord {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly event: TaskEvent['type'];
}

/** Immutable task state. Attempts and history are append-only; failures are never rewritten. */
export interface TaskState {
  readonly taskId: string;
  readonly revision: number;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly maxAttempts: number;
  readonly attempts: readonly AttemptRecord[];
  readonly history: readonly TransitionRecord[];
}

export type TaskEvent =
  | { type: 'dependencies_satisfied' }
  | { type: 'attempt_started'; attemptId: string }
  | { type: 'attempt_completed' }
  | { type: 'attempt_failed'; reason: string }
  | { type: 'approval_requested' }
  | { type: 'approval_granted' }
  | { type: 'approval_denied' }
  | { type: 'blocked'; reason: string }
  | { type: 'unblocked' }
  | { type: 'verification_passed' }
  | { type: 'verification_failed'; reason: string }
  | { type: 'retry_requested' }
  | { type: 'change_merged' }
  | { type: 'cancel' }
  | { type: 'superseded' };

export interface IllegalTransition {
  readonly kind: 'illegal_transition';
  readonly from: TaskStatus;
  readonly event: TaskEvent['type'];
  readonly reason: string;
}

export function newTaskState(init: { taskId: string; revision: number; kind: TaskKind; maxAttempts: number }): TaskState {
  return { ...init, status: 'planned', attempts: [], history: [] };
}

const ACTIVE: readonly TaskStatus[] = ['planned', 'ready', 'running', 'awaiting_approval', 'blocked', 'verifying'];

/** Source status(es) and target for events whose only effect is a status change. */
const SIMPLE: Partial<Record<TaskEvent['type'], { from: readonly TaskStatus[]; to: TaskStatus }>> = {
  dependencies_satisfied: { from: ['planned'], to: 'ready' },
  attempt_completed: { from: ['running'], to: 'verifying' },
  approval_requested: { from: ['running'], to: 'awaiting_approval' },
  approval_granted: { from: ['awaiting_approval'], to: 'ready' },
  approval_denied: { from: ['awaiting_approval'], to: 'blocked' },
  blocked: { from: ['running'], to: 'blocked' },
  unblocked: { from: ['blocked'], to: 'ready' },
  verification_passed: { from: ['verifying'], to: 'verified' },
  cancel: { from: ACTIVE, to: 'cancelled' },
  // Any non-merged revision can be superseded (not already superseded).
  superseded: { from: [...ACTIVE, 'verified', 'failed', 'cancelled'], to: 'superseded' },
};

function lastIsRunning(attempts: readonly AttemptRecord[]): boolean {
  return attempts[attempts.length - 1]?.outcome === 'running';
}

function closeLast(attempts: readonly AttemptRecord[], outcome: AttemptRecord['outcome'], reason?: string): AttemptRecord[] {
  const copy = attempts.slice();
  const last = copy[copy.length - 1];
  if (last && last.outcome === 'running') {
    copy[copy.length - 1] = reason === undefined ? { ...last, outcome } : { ...last, outcome, reason };
  }
  return copy;
}

/** Pure transition function. Never throws on an illegal move; returns an `IllegalTransition` instead. */
export function transition(state: TaskState, event: TaskEvent): Result<TaskState, IllegalTransition> {
  const bad = (reason: string) => err<IllegalTransition>({ kind: 'illegal_transition', from: state.status, event: event.type, reason });
  const move = (to: TaskStatus, attempts: readonly AttemptRecord[] = state.attempts) =>
    ok<TaskState>({
      ...state,
      status: to,
      attempts,
      history: [...state.history, { from: state.status, to, event: event.type }],
    });

  switch (event.type) {
    case 'attempt_started': {
      if (state.status !== 'ready') return bad('attempt can start only from ready');
      if (state.attempts.length >= state.maxAttempts) return bad('attempt budget exhausted');
      if (state.attempts.some((a) => a.attemptId === event.attemptId)) return bad('attempt id already used');
      if (lastIsRunning(state.attempts)) return bad('previous attempt still running');
      const rec: AttemptRecord = { attemptId: event.attemptId, number: state.attempts.length + 1, outcome: 'running' };
      return move('running', [...state.attempts, rec]);
    }
    case 'attempt_failed':
      if (state.status !== 'running') return bad('only a running task can fail an attempt');
      return move('failed', closeLast(state.attempts, 'failed', event.reason));
    case 'verification_failed':
      if (state.status !== 'verifying') return bad('only a verifying task can fail verification');
      return move('failed', closeLast(state.attempts, 'failed', event.reason));
    case 'retry_requested':
      if (state.status !== 'failed') return bad('retry applies only to a failed task');
      if (state.attempts.length >= state.maxAttempts) return bad('attempt budget exhausted');
      return move('ready');
    case 'change_merged':
      if (state.status !== 'verified') return bad('merge requires verified');
      if (state.kind !== 'repository') return bad('artifact-only tasks end at verified');
      return move('merged');
    case 'verification_passed':
      if (state.status !== 'verifying') return bad('verification can pass only from verifying');
      return move('verified', closeLast(state.attempts, 'succeeded'));
    case 'cancel':
    case 'superseded': {
      const rule = SIMPLE[event.type]!;
      if (!rule.from.includes(state.status)) return bad(state.status === 'merged' ? 'merged tasks are immutable; create a new task' : `not allowed from ${state.status}`);
      return move(rule.to, closeLast(state.attempts, 'cancelled'));
    }
    default: {
      const rule = SIMPLE[event.type];
      if (!rule || !rule.from.includes(state.status)) return bad(`not allowed from ${state.status}`);
      return move(rule.to);
    }
  }
}
