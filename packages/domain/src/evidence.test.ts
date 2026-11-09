import { describe, expect, it } from 'vitest';
import { deriveRunEvidence, type CriterionObservation, type EvidenceTask } from './evidence.ts';

const SHA = 'a'.repeat(40);
const task = (taskId: string, requirementIds: string[], over: Partial<EvidenceTask> = {}): EvidenceTask => ({ taskId, revision: 1, status: 'verified', requirementIds, ...over });
const seen = (checkId: string, taskId: string, result: CriterionObservation['result'], over: Partial<CriterionObservation> = {}): CriterionObservation => ({
  checkRunId: `chk_${checkId}_${taskId}`, checkId, checkVersion: '1', taskId, revision: 1, attemptId: 'att', recordId: 'ver', verificationAttempt: 1, candidateSha: SHA, result, at: '2026-11-09T01:00:00.000Z', ...over,
});
const derive = (tasks: EvidenceTask[], observations: CriterionObservation[], candidateLive = true, recordValid = true) => deriveRunEvidence({ tasks, observations, candidateSha: SHA, candidateLive, recordValid });

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
    expect(derive([task('a', ['FB-01'], { status: 'running' })], [])?.criteria?.[0]).toEqual({ criterionId: 'FB-01', description: expect.any(String), state: 'not_run', verified: false, taskIds: ['a'], check: null, candidateSha: null });
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

  it('superseded work owes nothing, and only it', () => {
    expect(derive([task('a', ['FB-01'], { status: 'superseded' })], [])).toBeNull();
  });

  it('a cancelled task keeps its own requirement in the denominator as not delivered', () => {
    const r = derive([task('a', ['FB-01'], { status: 'verified' }), task('b', ['FB-02'], { status: 'cancelled' })], [seen('FB-01', 'a', 'passed')]);
    expect(r).toMatchObject({ verified: 1, total: 2 });
    expect(r!.criteria[1]).toMatchObject({ criterionId: 'FB-02', state: 'not_delivered', verified: false, check: null, candidateSha: null, taskIds: ['b'] });
  });

  it('a cancelled task carrying a shared requirement leaves it not delivered, even when another task passed it', () => {
    const r = derive([task('a', ['FB-01']), task('b', ['FB-01'], { status: 'cancelled' })], [seen('FB-01', 'a', 'passed')]);
    expect(r).toMatchObject({ verified: 0, total: 1 });
    expect(r!.criteria[0]).toMatchObject({ state: 'not_delivered', taskIds: ['a', 'b'] });
  });

  it('a superseded carrier of a shared requirement does not count against it', () => {
    expect(derive([task('a', ['FB-01']), task('b', ['FB-01'], { status: 'superseded' })], [seen('FB-01', 'a', 'passed')])).toMatchObject({ verified: 1, total: 1 });
  });

  it('a pass on a task that has not reached verified is shown but not counted', () => {
    const r = derive([task('a', ['FB-01'], { status: 'running' })], [seen('FB-01', 'a', 'passed')]);
    expect(r).toMatchObject({ verified: 0, total: 1 });
    expect(r!.criteria[0]).toMatchObject({ state: 'passed', verified: false });
  });

  it('a pass under a record that is no longer valid is shown but not counted', () => {
    expect(derive([task('a', ['FB-01'])], [seen('FB-01', 'a', 'passed')], true, false)).toMatchObject({ verified: 0, total: 1 });
  });

  it('every known criterion carries its description, and an unknown one none', () => {
    expect(derive([task('a', ['FB-01', 'X-9'])], [])!.criteria.map((c) => c.description)).toEqual([expect.stringMatching(/feedback/i), null]);
  });
});
