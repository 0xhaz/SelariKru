import { describe, expect, it } from 'vitest';
import {
  criticalPath, readyTasks, supersedeAfterContractChange, validatePlanRevision,
  type PlanRevision, type TaskSpec, type TaskStatus, type StatusMap,
} from './index.ts';

type Dep = TaskSpec['dependencies'][number];
const dep = (taskId: string, condition: Dep['condition'] = 'artifact_verified', revision = 1): Dep => ({ taskId, revision, condition });

function t(taskId: string, deps: Dep[] = [], over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    schemaVersion: 1, tenantId: 't1', projectId: 'p1', runId: 'r1', taskId, boardId: 'b1', revision: 1,
    role: 'backend', title: taskId, baseSha: 'abc', requirementIds: [], dependencies: deps, contractRefs: [],
    allowedPaths: [], resourceClaims: [], acceptanceCheckIds: [], classification: 'internal', policyVersion: 'pol1',
    execution: 'eligible_any', inferencePolicyId: 'inf1', limits: { maxAttempts: 3, timeoutSeconds: 1800, maxCostUsd: 1 },
    ...over,
  };
}
const plan = (tasks: TaskSpec[]): PlanRevision => ({ projectId: 'p1', runId: 'r1', revision: 1, tasks });
const ctx = { projectId: 'p1', runId: 'r1' };
const st = (entries: Record<string, [TaskStatus, number?]>): StatusMap =>
  new Map(Object.entries(entries).map(([k, [s, r]]) => [k, { status: s, revision: r ?? 1 }]));
const kinds = (v: ReturnType<typeof validatePlanRevision>) => (v.ok ? [] : v.errors.map((e) => e.kind));

// docs/demo-project.md section 5
const feedbackBoard = plan([
  t('contract', [], { role: 'planner', contractRefs: [{ artifactId: 'api-contract', sha256: 'a'.repeat(64) }] }),
  t('backend', [dep('contract')], { contractRefs: [{ artifactId: 'api-contract', sha256: 'a'.repeat(64) }] }),
  t('frontend', [dep('contract')], { role: 'frontend', contractRefs: [{ artifactId: 'api-contract', sha256: 'a'.repeat(64) }] }),
  t('integration', [dep('backend', 'change_merged'), dep('frontend', 'change_merged')]),
  t('verification', [dep('integration', 'candidate_verified')]),
  t('evidence', [dep('verification', 'candidate_verified')]),
  t('review', [dep('evidence')]),
]);

describe('validatePlanRevision', () => {
  it('accepts a valid plan', () => {
    expect(validatePlanRevision(feedbackBoard, ctx)).toEqual({ ok: true });
  });
  it('rejects cycle and returns its path', () => {
    const v = validatePlanRevision(plan([t('a', [dep('c')]), t('b', [dep('a')]), t('c', [dep('b')]), t('d')]), ctx);
    expect(v.ok).toBe(false);
    const cyc = !v.ok ? v.errors.find((e) => e.kind === 'cycle') : undefined;
    expect(cyc && cyc.kind === 'cycle' ? cyc.path : []).toEqual(['a', 'c', 'b', 'a']);
  });
  it('rejects a self-dependency as a cycle', () => {
    const v = validatePlanRevision(plan([t('a', [dep('a')])]), ctx);
    expect(!v.ok && v.errors[0]).toEqual({ kind: 'cycle', path: ['a', 'a'] });
  });
  it('rejects missing dependency', () => {
    const v = validatePlanRevision(plan([t('a', [dep('ghost')])]), ctx);
    expect(!v.ok && v.errors).toEqual([{ kind: 'missing_dependency', taskId: 'a', dependsOn: 'ghost' }]);
  });
  it('rejects cross-project edge', () => {
    const v = validatePlanRevision(plan([t('a', [dep('x')]), t('x', [], { projectId: 'p2' })]), ctx);
    expect(kinds(v)).toContain('cross_project_edge');
  });
  it('rejects tasks outside the plan scope', () => {
    expect(kinds(validatePlanRevision({ ...plan([t('a')]), projectId: 'p2' }, ctx))).toContain('scope_mismatch');
    expect(kinds(validatePlanRevision(plan([t('a', [], { runId: 'r2' })]), ctx))).toContain('scope_mismatch');
  });
  it('rejects duplicate task ids', () => {
    expect(kinds(validatePlanRevision(plan([t('a'), t('a')]), ctx))).toEqual(['duplicate_task_id']);
  });
  it('rejects an edge whose revision differs from the predecessor revision in the plan', () => {
    const v = validatePlanRevision(plan([t('a', [dep('b', 'artifact_verified', 2)]), t('b')]), ctx);
    expect(!v.ok && v.errors).toEqual([{ kind: 'revision_mismatch', taskId: 'a', dependsOn: 'b', expected: 2, actual: 1 }]);
  });
  it('reports all errors without throwing', () => {
    const v = validatePlanRevision(plan([t('a', [dep('ghost'), dep('b')]), t('b', [dep('a')]), t('b')]), ctx);
    expect(new Set(kinds(v))).toEqual(new Set(['missing_dependency', 'duplicate_task_id', 'cycle']));
  });
});

describe('readyTasks', () => {
  const p = plan([t('a'), t('b', [dep('a')])]);
  it('returns planned tasks with no dependencies', () => {
    expect(readyTasks(p, st({ a: ['planned'], b: ['planned'] }))).toEqual(['a']);
  });
  it('edge satisfied only at matching revision', () => {
    expect(readyTasks(p, st({ a: ['verified', 1], b: ['planned'] }))).toEqual(['b']);
    expect(readyTasks(p, st({ a: ['verified', 2], b: ['planned'] }))).toEqual([]);
    expect(readyTasks(p, st({ b: ['planned'] }))).toEqual([]);
  });
  it('only tasks in planned are returned', () => {
    expect(readyTasks(p, st({ a: ['verified'], b: ['running'] }))).toEqual([]);
    expect(readyTasks(p, st({ a: ['verified'] }))).toEqual([]);
  });
  it('conditions artifact_verified, candidate_verified, change_merged', () => {
    for (const c of ['artifact_verified', 'candidate_verified'] as const) {
      const q = plan([t('a'), t('b', [dep('a', c)])]);
      expect(readyTasks(q, st({ a: ['verified'], b: ['planned'] }))).toEqual(['b']);
      expect(readyTasks(q, st({ a: ['merged'], b: ['planned'] }))).toEqual(['b']);
      expect(readyTasks(q, st({ a: ['verifying'], b: ['planned'] }))).toEqual([]);
      expect(readyTasks(q, st({ a: ['superseded'], b: ['planned'] }))).toEqual([]);
    }
    const q = plan([t('a'), t('b', [dep('a', 'change_merged')])]);
    expect(readyTasks(q, st({ a: ['verified'], b: ['planned'] }))).toEqual([]);
    expect(readyTasks(q, st({ a: ['merged'], b: ['planned'] }))).toEqual(['b']);
  });
  it('requires every edge to be satisfied', () => {
    const q = plan([t('a'), t('b'), t('c', [dep('a'), dep('b')])]);
    expect(readyTasks(q, st({ a: ['verified'], b: ['running'], c: ['planned'] }))).toEqual([]);
  });
});

describe('Feedback Board DAG', () => {
  it('is valid and walks through ready sets', () => {
    expect(validatePlanRevision(feedbackBoard, ctx)).toEqual({ ok: true });
    const s: Record<string, [TaskStatus, number?]> = Object.fromEntries(
      feedbackBoard.tasks.map((x) => [x.taskId, ['planned'] as [TaskStatus]]),
    );
    expect(readyTasks(feedbackBoard, st(s))).toEqual(['contract']);
    s.contract = ['verified'];
    expect(readyTasks(feedbackBoard, st(s))).toEqual(['backend', 'frontend']);
    s.backend = ['merged']; s.frontend = ['verified'];
    expect(readyTasks(feedbackBoard, st(s))).toEqual([]);
    s.frontend = ['merged'];
    expect(readyTasks(feedbackBoard, st(s))).toEqual(['integration']);
    s.integration = ['verified'];
    expect(readyTasks(feedbackBoard, st(s))).toEqual(['verification']);
    s.verification = ['verified'];
    expect(readyTasks(feedbackBoard, st(s))).toEqual(['evidence']);
    s.evidence = ['verified'];
    expect(readyTasks(feedbackBoard, st(s))).toEqual(['review']);
  });
  it('critical path', () => {
    expect(criticalPath(feedbackBoard)).toEqual(['contract', 'backend', 'integration', 'verification', 'evidence', 'review']);
  });
});

describe('criticalPath', () => {
  it('returns the longest chain, ties broken by task id', () => {
    expect(criticalPath(plan([t('z'), t('m', [dep('z')]), t('b', [dep('z')])]))).toEqual(['z', 'b']);
    expect(criticalPath(plan([t('x'), t('a')]))).toEqual(['a']);
  });
  it('prefers the strictly longer chain', () => {
    expect(criticalPath(plan([t('a'), t('b', [dep('a')]), t('c', [dep('b')]), t('d')]))).toEqual(['a', 'b', 'c']);
  });
  it('is empty for an empty or cyclic plan, and ignores missing deps and duplicates', () => {
    expect(criticalPath(plan([]))).toEqual([]);
    expect(criticalPath(plan([t('a', [dep('b')]), t('b', [dep('a')])]))).toEqual([]);
    expect(criticalPath(plan([t('a', [dep('ghost')]), t('a')]))).toEqual(['a']);
  });
});

describe('supersedeAfterContractChange', () => {
  it('contract change marks dependents superseded and yields a replan diff', () => {
    const s = st({
      contract: ['verified'], backend: ['running'], frontend: ['verified'], integration: ['planned'],
      verification: ['planned'], evidence: ['planned'], review: ['planned'],
    });
    const d = supersedeAfterContractChange(feedbackBoard, 'contract', s);
    expect(d.superseded).toEqual(['backend', 'evidence', 'frontend', 'integration', 'review', 'verification']);
    expect(d.stillValid).toEqual(['contract']);
    expect(d.requiredDecisions).toEqual([]);
  });
  it('accepts an artifact ref: consumers and their dependents are superseded', () => {
    const d = supersedeAfterContractChange(feedbackBoard, 'api-contract', st({}));
    expect(d.superseded).toEqual(['backend', 'contract', 'evidence', 'frontend', 'integration', 'review', 'verification']);
  });
  it('does not supersede merged tasks, and flags them for a decision', () => {
    const d = supersedeAfterContractChange(feedbackBoard, 'contract', st({ backend: ['merged'], frontend: ['planned'] }));
    expect(d.superseded).not.toContain('backend');
    expect(d.requiredDecisions).toEqual([{ kind: 'merged_dependent', taskId: 'backend' }]);
    expect(d.superseded).toContain('integration');
  });
  it('skips already-terminal dependents and leaves unrelated tasks valid', () => {
    const p = plan([t('c'), t('a', [dep('c')]), t('b', [dep('c')]), t('u')]);
    const d = supersedeAfterContractChange(p, 'c', st({ a: ['cancelled'], b: ['superseded'] }));
    expect(d.superseded).toEqual([]);
    expect(d.stillValid).toEqual(['a', 'b', 'c', 'u']);
  });
  it('is pure and tolerates unknown refs and cyclic plans', () => {
    const before = JSON.stringify(feedbackBoard);
    expect(supersedeAfterContractChange(feedbackBoard, 'nope', st({})).superseded).toEqual([]);
    expect(supersedeAfterContractChange(plan([t('a', [dep('b')]), t('b', [dep('a')])]), 'a', st({})).superseded).toEqual(['b']);
    expect(JSON.stringify(feedbackBoard)).toBe(before);
  });
});
