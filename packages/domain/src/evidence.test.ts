import { describe, expect, it } from 'vitest';
import { deriveRunEvidence, type CriterionObservation, type EvidenceTask } from './evidence.ts';

const SHA = 'a'.repeat(40);
const task = (taskId: string, requirementIds: string[], over: Partial<EvidenceTask> = {}): EvidenceTask => ({ taskId, revision: 1, status: 'verified', requirementIds, budgetStopped: false, ...over });
const seen = (checkId: string, taskId: string, result: CriterionObservation['result'], over: Partial<CriterionObservation> = {}): CriterionObservation => ({
  checkRunId: `chk_${checkId}_${taskId}`, checkId, checkVersion: '1', taskId, revision: 1, attemptId: 'att', recordId: 'ver', verificationAttempt: 1, candidateSha: SHA, result, at: '2026-11-09T01:00:00.000Z', ...over,
});
const derive = (tasks: EvidenceTask[], observations: CriterionObservation[], candidateLive = true) => deriveRunEvidence({ tasks, observations, candidateSha: SHA, candidateLive });

describe('deriveRunEvidence', () => {
  it('counts criteria, never tasks', () => {
    const r = derive([task('a', ['FB-01', 'FB-02', 'FB-03'])], [seen('FB-01', 'a', 'passed'), seen('FB-02', 'a', 'passed'), seen('FB-03', 'a', 'failed')]);
    expect(r).toMatchObject({ verified: 2, total: 3 });
    expect(r!.criteria.map((c) => c.state)).toEqual(['passed', 'passed', 'failed']);
  });

  it('is null when no task names a requirement: nothing is known, and a task count must not stand in', () => {
    expect(derive([task('a', []), task('b', [])], [])).toBeNull();
  });

  it('a criterion with no check is not_run with no candidate named', () => {
    expect(derive([task('a', ['FB-01'], { status: 'running' })], [])?.criteria?.[0]).toEqual({ criterionId: 'FB-01', state: 'not_run', verified: false, taskIds: ['a'], check: null, candidateSha: null });
  });

  it('every criterion with a check carries that check and the candidate', () => {
    const r = derive([task('a', ['FB-01'])], [seen('FB-01', 'a', 'passed')]);
    expect(r!.criteria[0]).toMatchObject({ candidateSha: SHA, check: { checkRunId: 'chk_FB-01_a', recordId: 'ver', taskId: 'a' } });
  });

  it('a pass on a candidate that is no longer live, or on an earlier task revision, does not count', () => {
    expect(derive([task('a', ['FB-01'])], [seen('FB-01', 'a', 'passed')], false)).toMatchObject({ verified: 0, total: 1 });
    expect(derive([task('a', ['FB-01'], { revision: 2 })], [seen('FB-01', 'a', 'passed')])?.criteria?.[0]?.state).toBe('not_run');
  });

  it('a retry within one verification replaces the earlier result, and the newer verification wins', () => {
    const flaky = [seen('FB-01', 'a', 'failed', { verificationAttempt: 1, checkRunId: 'c1' }), seen('FB-01', 'a', 'passed', { verificationAttempt: 2, checkRunId: 'c2' })];
    expect(derive([task('a', ['FB-01'])], flaky)).toMatchObject({ verified: 1 });
    const later = [seen('FB-01', 'a', 'passed', { at: '2026-11-09T01:00:00.000Z' }), seen('FB-01', 'a', 'error', { at: '2026-11-09T02:00:00.000Z' })];
    expect(derive([task('a', ['FB-01'])], later)).toMatchObject({ verified: 0 });
  });

  it('every task sharing a criterion has to pass it', () => {
    const r = derive([task('a', ['FB-01']), task('b', ['FB-01'])], [seen('FB-01', 'a', 'passed'), seen('FB-01', 'b', 'failed')]);
    expect(r).toMatchObject({ verified: 0, total: 1 });
    expect(r!.criteria[0]!.state).toBe('failed');
    expect(derive([task('a', ['FB-01']), task('b', ['FB-01'])], [seen('FB-01', 'a', 'passed')])).toMatchObject({ verified: 0 });
  });

  it('skipped never counts as verified', () => {
    expect(derive([task('a', ['FB-01'])], [seen('FB-01', 'a', 'skipped')])).toMatchObject({ verified: 0, total: 1 });
  });

  it('superseded and cancelled work owes nothing; budget-stopped work stays owed', () => {
    expect(derive([task('a', ['FB-01'], { status: 'superseded' }), task('b', ['FB-02'], { status: 'cancelled' })], [])).toBeNull();
    expect(derive([task('a', ['FB-01'], { status: 'cancelled', budgetStopped: true })], [])).toMatchObject({ verified: 0, total: 1 });
  });
});
