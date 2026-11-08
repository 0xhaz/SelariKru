import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS_CAP,
  TASK_STATUSES,
  newTaskStateFromSpec,
  TaskSpecSchema,
  newTaskState,
  transition,
  type TaskEvent,
  type TaskState,
} from './index.ts';

const sha = 'a'.repeat(64);
const spec = {
  schemaVersion: 1,
  tenantId: 't1',
  projectId: 'p1',
  runId: 'r1',
  taskId: 'task1',
  boardId: 'b1',
  revision: 1,
  role: 'backend',
  title: 'Add endpoint',
  baseSha: 'abc123',
  requirementIds: ['REQ-1'],
  dependencies: [{ taskId: 'task0', revision: 1, condition: 'artifact_verified' }],
  contractRefs: [{ artifactId: 'art1', sha256: sha }],
  allowedPaths: ['src/**'],
  resourceClaims: [{ key: 'lockfile', mode: 'exclusive' }],
  acceptanceCheckIds: ['chk1'],
  classification: 'internal',
  policyVersion: 'pol1',
  execution: 'eligible_any',
  inferencePolicyId: 'inf1',
  limits: { maxAttempts: 3, timeoutSeconds: 1800, maxCostUsd: 5 },
};

function run(state: TaskState, events: TaskEvent[]): TaskState {
  let s = state;
  for (const e of events) {
    const r = transition(s, e);
    if (!r.ok) throw new Error(`illegal: ${r.error.from} --${r.error.event}--> (${r.error.reason})`);
    s = r.value;
  }
  return s;
}
const start = (n: number): TaskEvent => ({ type: 'attempt_started', attemptId: `attempt_${n}` });

describe('TaskSpecSchema', () => {
  it('accepts a full spec and rejects unknown fields and bad values', () => {
    expect(TaskSpecSchema.safeParse(spec).success).toBe(true);
    expect(TaskSpecSchema.safeParse({ ...spec, apiKey: 'x' }).success).toBe(false);
    expect(TaskSpecSchema.safeParse({ ...spec, schemaVersion: 2 }).success).toBe(false);
    expect(TaskSpecSchema.safeParse({ ...spec, classification: 'top' }).success).toBe(false);
    expect(TaskSpecSchema.safeParse({ ...spec, limits: { maxAttempts: 3, timeoutSeconds: 1800 } }).success).toBe(false);
    expect(TaskSpecSchema.safeParse({ ...spec, contractRefs: [{ artifactId: 'a', sha256: 'zz' }] }).success).toBe(false);
    expect(TaskSpecSchema.safeParse({ ...spec, dependencies: [{ taskId: 't', revision: 1, condition: 'nope' }] }).success).toBe(false);
  });
  it('has exactly the eleven statuses', () => {
    expect([...TASK_STATUSES]).toEqual([
      'planned', 'ready', 'running', 'awaiting_approval', 'blocked', 'verifying',
      'verified', 'merged', 'failed', 'cancelled', 'superseded',
    ]);
  });
});

describe('task state machine', () => {
  it('nominal path planned→…→merged', () => {
    const s0 = newTaskState({ taskId: 'task1', revision: 1, kind: 'repository', maxAttempts: 3 });
    expect(s0.status).toBe('planned');
    const seen: string[] = [s0.status];
    let s = s0;
    for (const e of [
      { type: 'dependencies_satisfied' },
      start(1),
      { type: 'attempt_completed' },
      { type: 'verification_passed' },
      { type: 'change_merged' },
    ] as TaskEvent[]) {
      s = run(s, [e]);
      seen.push(s.status);
    }
    expect(seen).toEqual(['planned', 'ready', 'running', 'verifying', 'verified', 'merged']);
    expect(s.attempts).toEqual([{ attemptId: 'attempt_1', number: 1, outcome: 'succeeded' }]);
  });

  it('artifact task ends at verified', () => {
    const s = run(newTaskState({ taskId: 't', revision: 1, kind: 'artifact', maxAttempts: 1 }), [
      { type: 'dependencies_satisfied' }, start(1), { type: 'attempt_completed' }, { type: 'verification_passed' },
    ]);
    expect(s.status).toBe('verified');
    const r = transition(s, { type: 'change_merged' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('illegal_transition');
  });

  it('failed attempt creates new attempt, keeps history', () => {
    let s = run(newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 2 }), [
      { type: 'dependencies_satisfied' }, start(1), { type: 'attempt_failed', reason: 'tests red' },
    ]);
    expect(s.status).toBe('failed');
    const first = s.attempts[0];
    s = run(s, [{ type: 'retry_requested' }, start(2)]);
    expect(s.status).toBe('running');
    expect(s.attempts).toHaveLength(2);
    expect(s.attempts[0]).toEqual(first);
    expect(s.attempts[0]).toMatchObject({ attemptId: 'attempt_1', number: 1, outcome: 'failed', reason: 'tests red' });
    expect(s.attempts[1]).toMatchObject({ attemptId: 'attempt_2', number: 2, outcome: 'running' });
    expect(s.history.map((h) => h.to)).toEqual(['ready', 'running', 'failed', 'ready', 'running']);
  });

  it('retry is refused when attempts are exhausted, and verification failure fails the attempt', () => {
    const s = run(newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 1 }), [
      { type: 'dependencies_satisfied' }, start(1), { type: 'attempt_completed' }, { type: 'verification_failed', reason: 'ci' },
    ]);
    expect(s.status).toBe('failed');
    expect(s.attempts[0]).toMatchObject({ outcome: 'failed', reason: 'ci' });
    const r = transition(s, { type: 'retry_requested' });
    expect(r.ok).toBe(false);
  });

  it('merged cannot be superseded', () => {
    const s = run(newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 1 }), [
      { type: 'dependencies_satisfied' }, start(1), { type: 'attempt_completed' }, { type: 'verification_passed' }, { type: 'change_merged' },
    ]);
    const r = transition(s, { type: 'superseded' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'illegal_transition', from: 'merged', event: 'superseded' });
    for (const e of [{ type: 'cancel' }, { type: 'retry_requested' }, { type: 'dependencies_satisfied' }] as TaskEvent[]) {
      expect(transition(s, e).ok).toBe(false);
    }
  });

  it('approval and blocked flows return the task to ready', () => {
    const running = run(newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 2 }), [
      { type: 'dependencies_satisfied' }, start(1),
    ]);
    const awaiting = run(running, [{ type: 'approval_requested' }]);
    expect(awaiting.status).toBe('awaiting_approval');
    expect(run(awaiting, [{ type: 'approval_granted' }]).status).toBe('ready');
    expect(run(awaiting, [{ type: 'approval_denied' }]).status).toBe('blocked');
    const blocked = run(running, [{ type: 'blocked', reason: 'missing limit' }]);
    expect(blocked.status).toBe('blocked');
    expect(run(blocked, [{ type: 'unblocked' }]).status).toBe('ready');
  });

  it('approval then grant then attempt_started keeps history; interrupted does not consume budget', () => {
    const base = newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 1 });
    let s = run(base, [{ type: 'dependencies_satisfied' }, start(1), { type: 'approval_requested' }]);
    expect(s.attempts).toEqual([{ attemptId: 'attempt_1', number: 1, outcome: 'interrupted' }]);
    s = run(s, [{ type: 'approval_granted' }, start(2)]);
    expect(s.status).toBe('running');
    expect(s.attempts.map((a) => [a.attemptId, a.outcome])).toEqual([['attempt_1', 'interrupted'], ['attempt_2', 'running']]);
  });

  it('blocked then unblocked then attempt_started; denied then unblocked also runs', () => {
    const base = newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 1 });
    let s = run(base, [{ type: 'dependencies_satisfied' }, start(1), { type: 'blocked', reason: 'limit' }, { type: 'unblocked' }, start(2)]);
    expect(s.status).toBe('running');
    expect(s.attempts[0]).toMatchObject({ outcome: 'interrupted', reason: 'limit' });
    s = run(base, [{ type: 'dependencies_satisfied' }, start(1), { type: 'approval_requested' }, { type: 'approval_denied' }, { type: 'unblocked' }, start(2)]);
    expect(s.status).toBe('running');
    expect(s.attempts).toHaveLength(2);
  });

  it('interrupted attempts leave the repair budget intact for real failures', () => {
    let s = run(newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 2 }), [
      { type: 'dependencies_satisfied' }, start(1), { type: 'approval_requested' }, { type: 'approval_granted' }, start(2),
      { type: 'attempt_failed', reason: 'x' }, { type: 'retry_requested' }, start(3), { type: 'attempt_failed', reason: 'y' },
    ]);
    expect(s.attempts.map((a) => a.outcome)).toEqual(['interrupted', 'failed', 'failed']);
    expect(transition(s, { type: 'retry_requested' }).ok).toBe(false);
  });

  it('maxAttempts is bounded and derived from the spec', () => {
    expect(MAX_ATTEMPTS_CAP).toBe(3);
    for (const bad of [0, -1, 1.5, 4, 1000, Number.NaN, Infinity]) {
      expect(() => newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: bad }), String(bad)).toThrow(RangeError);
    }
    for (const good of [1, 2, 3]) expect(newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: good }).maxAttempts).toBe(good);
    const okRes = newTaskStateFromSpec(spec as never, 'artifact');
    expect(okRes.ok && okRes.value).toMatchObject({ taskId: 'task1', revision: 1, kind: 'artifact', maxAttempts: 3, status: 'planned' });
    const over = newTaskStateFromSpec({ ...spec, limits: { ...spec.limits, maxAttempts: 4 } } as never, 'repository');
    expect(over.ok).toBe(false);
    expect(TaskSpecSchema.safeParse({ ...spec, limits: { ...spec.limits, maxAttempts: 0 } }).success).toBe(false);
    expect(TaskSpecSchema.safeParse({ ...spec, limits: { ...spec.limits, maxAttempts: 2.5 } }).success).toBe(false);
  });

  it('cancel and supersede legality for every non-merged status', () => {
    const base = newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 3 });
    const ready = run(base, [{ type: 'dependencies_satisfied' }]);
    const running = run(ready, [start(1)]);
    const verifying = run(running, [{ type: 'attempt_completed' }]);
    const verified = run(verifying, [{ type: 'verification_passed' }]);
    const failed = run(running, [{ type: 'attempt_failed', reason: 'x' }]);
    const awaiting = run(running, [{ type: 'approval_requested' }]);
    const blocked = run(running, [{ type: 'blocked', reason: 'x' }]);
    const cancelled = run(running, [{ type: 'cancel' }]);
    for (const s of [base, ready, running, verifying, verified, failed, awaiting, blocked, cancelled]) {
      const r = transition(s, { type: 'superseded' });
      expect(r.ok, s.status).toBe(true);
      if (r.ok) expect(r.value.status).toBe('superseded');
    }
    for (const s of [base, ready, running, verifying, awaiting, blocked]) {
      expect(run(s, [{ type: 'cancel' }]).status).toBe('cancelled');
    }
    for (const s of [verified, failed, cancelled]) expect(transition(s, { type: 'cancel' }).ok).toBe(false);
    const sup = run(base, [{ type: 'superseded' }]);
    expect(transition(sup, { type: 'superseded' }).ok).toBe(false);
  });

  it('rejects illegal moves without throwing and without mutating state', () => {
    const base = newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 3 });
    const frozen = JSON.stringify(base);
    const illegal: TaskEvent[] = [
      start(1), { type: 'attempt_completed' }, { type: 'verification_passed' }, { type: 'verification_failed', reason: 'x' },
      { type: 'change_merged' }, { type: 'approval_granted' }, { type: 'approval_requested' }, { type: 'retry_requested' },
      { type: 'unblocked' }, { type: 'attempt_failed', reason: 'x' },
    ];
    for (const e of illegal) {
      const r = transition(base, e);
      expect(r.ok, e.type).toBe(false);
    }
    expect(JSON.stringify(base)).toBe(frozen);
    const ready = run(base, [{ type: 'dependencies_satisfied' }]);
    for (const e of [{ type: 'verification_passed' }, { type: 'change_merged' }, { type: 'attempt_completed' }, { type: 'approval_granted' }] as TaskEvent[]) {
      expect(transition(ready, e).ok, e.type).toBe(false);
    }
    // verified requires verifying, not running
    const running = run(ready, [start(1)]);
    expect(transition(running, { type: 'verification_passed' }).ok).toBe(false);
    expect(transition(running, { type: 'change_merged' }).ok).toBe(false);
    // duplicate attempt id is refused
    const failed = run(running, [{ type: 'attempt_failed', reason: 'x' }, { type: 'retry_requested' }]);
    expect(transition(failed, start(1)).ok).toBe(false);
  });
});

describe('repair_refused', () => {
  const failedThrice = (): TaskState => run(newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 3 }), [
    { type: 'dependencies_satisfied' }, start(1), { type: 'attempt_failed', reason: 'x' }, { type: 'retry_requested' },
    start(2), { type: 'attempt_failed', reason: 'y' }, { type: 'retry_requested' }, start(3), { type: 'attempt_failed', reason: 'z' },
  ]);

  it('moves a failed task to blocked and keeps its failures as failures', () => {
    const r = transition(failedThrice(), { type: 'repair_refused', reason: 'repair_budget_exhausted' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('blocked');
      expect(r.value.attempts.map((a) => a.outcome)).toEqual(['failed', 'failed', 'failed']);
    }
  });

  it('a refused task that is unblocked still cannot start another attempt', () => {
    const s = run(failedThrice(), [{ type: 'repair_refused', reason: 'x' }, { type: 'unblocked' }]);
    expect(s.status).toBe('ready');
    expect(transition(s, { type: 'attempt_started', attemptId: 'a4' }).ok).toBe(false);
    expect(transition(s, { type: 'repair_refused', reason: 'x' }).ok).toBe(true);
  });

  it('is not allowed from running', () => {
    const s = run(newTaskState({ taskId: 't', revision: 1, kind: 'repository', maxAttempts: 3 }), [{ type: 'dependencies_satisfied' }, start(1)]);
    expect(transition(s, { type: 'repair_refused', reason: 'x' }).ok).toBe(false);
  });
});
