import { z } from 'zod';
import { Id, Sha256, SchemaVersion } from './common.ts';
import { err, ok, type Result } from './result.ts';

export const TASK_STATUSES = [
  'planned', 'ready', 'running', 'awaiting_approval', 'blocked', 'verifying',
  'verified', 'merged', 'failed', 'cancelled', 'superseded',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** 1 initial attempt plus 2 repairs per task revision. */
export const MAX_ATTEMPTS_CAP = 3;

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
        maxAttempts: z.number().int().min(1).max(MAX_ATTEMPTS_CAP),
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
  readonly outcome: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
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
  /** From `running` (a worker asked; its attempt is interrupted) or `ready` (a placement or repair gate needs a human before any attempt starts). */
  | { type: 'approval_requested' }
  | { type: 'approval_granted' }
  | { type: 'approval_denied' }
  /** Nobody decided before the request's expiry. Never a grant: the task stops at `blocked` with a readable reason. */
  | { type: 'approval_expired' }
  | { type: 'blocked'; reason: string }
  | { type: 'unblocked' }
  | { type: 'verification_passed' }
  | { type: 'verification_failed'; reason: string }
  /** The verifier produced no verdict (`error` or `skipped`). The task stops at `blocked`; nothing about the candidate is concluded, so no repair is spent. */
  | { type: 'verification_unavailable'; reason: string }
  /** The evidence behind a verified task was invalidated. It goes back to `verifying`, or to `blocked` when its claims cannot be re-acquired. */
  | { type: 'verification_invalidated'; blockedReason?: string }
  | { type: 'retry_requested' }
  /** The scheduler refused a further attempt (repair or infrastructure retry): the task stops at `blocked`, keeping the reason on the event. */
  | { type: 'repair_refused'; reason: string }
  | { type: 'change_merged' }
  | { type: 'cancel' }
  | { type: 'superseded' };

export interface IllegalTransition {
  readonly kind: 'illegal_transition';
  readonly from: TaskStatus;
  readonly event: TaskEvent['type'];
  readonly reason: string;
}

export function isValidMaxAttempts(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_ATTEMPTS_CAP;
}

/** Throws RangeError if maxAttempts is not an integer in 1..MAX_ATTEMPTS_CAP. Prefer `newTaskStateFromSpec`. */
export function newTaskState(init: { taskId: string; revision: number; kind: TaskKind; maxAttempts: number }): TaskState {
  if (!isValidMaxAttempts(init.maxAttempts)) {
    throw new RangeError(`maxAttempts must be an integer in 1..${MAX_ATTEMPTS_CAP}`);
  }
  return { ...init, status: 'planned', attempts: [], history: [] };
}

/** Creates the initial state from a validated spec; maxAttempts is derived from `limits.maxAttempts`. */
export function newTaskStateFromSpec(spec: TaskSpec, kind: TaskKind): Result<TaskState, { kind: 'invalid_spec'; issues: string[] }> {
  const parsed = TaskSpecSchema.safeParse(spec);
  if (!parsed.success) return err({ kind: 'invalid_spec', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const v = parsed.data;
  return ok(newTaskState({ taskId: v.taskId, revision: v.revision, kind, maxAttempts: v.limits.maxAttempts }));
}

/** Interrupted attempts (approval/blocked pauses) do not consume the repair budget. */
export function budgetUsed(attempts: readonly AttemptRecord[]): number {
  return attempts.filter((a) => a.outcome !== 'interrupted').length;
}

const ACTIVE: readonly TaskStatus[] = ['planned', 'ready', 'running', 'awaiting_approval', 'blocked', 'verifying'];

/** Source status(es) and target for events whose only effect is a status change. */
const SIMPLE: Partial<Record<TaskEvent['type'], { from: readonly TaskStatus[]; to: TaskStatus }>> = {
  dependencies_satisfied: { from: ['planned'], to: 'ready' },
  attempt_completed: { from: ['running'], to: 'verifying' },
  approval_requested: { from: ['running', 'ready'], to: 'awaiting_approval' },
  approval_granted: { from: ['awaiting_approval'], to: 'ready' },
  approval_denied: { from: ['awaiting_approval'], to: 'blocked' },
  approval_expired: { from: ['awaiting_approval'], to: 'blocked' },
  blocked: { from: ['running'], to: 'blocked' },
  unblocked: { from: ['blocked'], to: 'ready' },
  // Attempts stay as they are: a refused repair never rewrites a failure into an interruption.
  repair_refused: { from: ['failed', 'ready'], to: 'blocked' },
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
      if (budgetUsed(state.attempts) >= state.maxAttempts) return bad('attempt budget exhausted');
      if (state.attempts.some((a) => a.attemptId === event.attemptId)) return bad('attempt id already used');
      if (lastIsRunning(state.attempts)) return bad('previous attempt still running');
      const rec: AttemptRecord = { attemptId: event.attemptId, number: state.attempts.length + 1, outcome: 'running' };
      return move('running', [...state.attempts, rec]);
    }
    case 'approval_requested':
    case 'blocked': {
      // A gate at claim time: no attempt exists yet, so there is nothing to interrupt.
      if (event.type === 'approval_requested' && state.status === 'ready') return move('awaiting_approval');
      if (state.status !== 'running') return bad(`${event.type} applies only to a running task`);
      return move(event.type === 'blocked' ? 'blocked' : 'awaiting_approval', closeLast(state.attempts, 'interrupted', event.type === 'blocked' ? event.reason : undefined));
    }
    case 'attempt_failed':
      if (state.status !== 'running') return bad('only a running task can fail an attempt');
      return move('failed', closeLast(state.attempts, 'failed', event.reason));
    case 'verification_failed':
      if (state.status !== 'verifying') return bad('only a verifying task can fail verification');
      return move('failed', closeLast(state.attempts, 'failed', event.reason));
    case 'verification_invalidated': {
      if (state.status !== 'verified') return bad('only a verified task can have its verification invalidated');
      // The verified attempt waits for a verdict again (so a failed re-verification fails it); if the task blocks it is interrupted, which keeps the budget.
      const attempts = state.attempts.slice();
      const last = attempts[attempts.length - 1];
      if (last && last.outcome === 'succeeded') attempts[attempts.length - 1] = event.blockedReason !== undefined ? { ...last, outcome: 'interrupted', reason: event.blockedReason } : { ...last, outcome: 'running' };
      return move(event.blockedReason !== undefined ? 'blocked' : 'verifying', attempts);
    }
    case 'verification_unavailable':
      if (state.status !== 'verifying') return bad('only a verifying task can have an unavailable verification');
      return move('blocked', closeLast(state.attempts, 'interrupted', event.reason));
    case 'retry_requested':
      if (state.status !== 'failed') return bad('retry applies only to a failed task');
      if (budgetUsed(state.attempts) >= state.maxAttempts) return bad('attempt budget exhausted');
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
