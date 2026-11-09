import { emptySnapshot, type CriterionEvidenceView, type ProjectViewSnapshot, type RunEvidenceView, type RunView } from '@selarikru/view-protocol';
import { describe, expect, it } from 'vitest';
import { buildEvidence, checkAnchor } from './model.ts';

const SHA = 'a'.repeat(40);
const criterion = (id: string, over: Partial<CriterionEvidenceView> = {}): CriterionEvidenceView => ({
  criterionId: id, state: 'passed', verified: true, taskIds: ['t1'], candidateSha: SHA,
  check: { checkRunId: `chk_${id}`, checkId: id, checkVersion: '1', taskId: 't1', revision: 1, attemptId: 'att', recordId: 'ver_1', verificationAttempt: 1, at: '2026-11-09T01:00:00.000Z' }, ...over,
});
const evidence = (criteria: CriterionEvidenceView[], live = true): RunEvidenceView => ({
  candidate: { sha: SHA, status: live ? 'assembled' : 'rejected', live, baseSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), target: 'main', recordedAt: '2026-11-09T01:00:00.000Z', recordId: 'ver_1', verifierHost: 'h', checkManifestSha256: 'e'.repeat(64), verifierSha256: '1'.repeat(64), flaky: ['FB-02'] }, criteria,
});
function snap(run: Partial<RunView>, over: Partial<ProjectViewSnapshot> = {}): ProjectViewSnapshot {
  const base: RunView = { runId: 'r1', lifecycle: 'ready_for_review', planRevision: 1, latestEvidence: null, criteria: null, evidence: null, reducedScope: null, scopeAssessment: null, pinnedModel: null, ...run };
  return { ...emptySnapshot({ projectId: 'p', observedAt: '2026-11-09T01:00:00.000Z', provenance: 'observed' }), runs: { r1: base }, ...over };
}
const states = (m: NonNullable<ReturnType<typeof buildEvidence>>) => Object.fromEntries(m.states.map((s) => [s.key, s]));
const cr = (status: string, over = {}) => ({ runId: 'r1', prNumber: 12, url: 'https://github.com/acme/app/pull/12', status, candidateSha: SHA, baseRef: 'main', observedHeadSha: SHA, mergeCommitSha: null, observedAt: '2026-11-09T01:00:00.000Z', ...over });

describe('buildEvidence', () => {
  it('each criterion links to check and candidate SHA', () => {
    const m = buildEvidence(snap({ criteria: { verified: 2, total: 2 }, evidence: evidence([criterion('FB-01'), criterion('FB-02')]) }), null)!;
    expect(m.criteria).toHaveLength(2);
    for (const row of m.criteria) {
      expect(row.evidence?.checkHref).toContain(encodeURIComponent(`chk_${row.criterionId}`));
      expect(row.evidence?.candidateHref).toContain(SHA);
      expect(row.evidence?.candidateSha).toBe(SHA);
      expect(m.checks.some((c) => c.anchor === checkAnchor(`chk_${row.criterionId}`))).toBe(true);
    }
    expect(m.candidate).toMatchObject({ sha: SHA, flaky: ['FB-02'] });
  });

  it('a criterion no check has reported on has no link, and is not called verified', () => {
    const m = buildEvidence(snap({ criteria: { verified: 0, total: 1 }, evidence: evidence([criterion('FB-01', { state: 'not_run', verified: false, check: null, candidateSha: null })]) }), null)!;
    expect(m.criteria[0]).toMatchObject({ evidence: null, stateLabel: 'No check yet', verified: false });
    expect(m.checks).toEqual([]);
  });

  it('verified, merged, deployed render as distinct states', () => {
    const verifiedOnly = states(buildEvidence(snap({ criteria: { verified: 1, total: 1 }, evidence: evidence([criterion('FB-01')]) }), null)!);
    expect(verifiedOnly['verified']).toMatchObject({ value: 'Verified', established: true });
    expect(verifiedOnly['merged']).toMatchObject({ value: 'Not merged', established: false });
    expect(verifiedOnly['deployed']).toMatchObject({ value: 'Not established', established: false });
    const merged = states(buildEvidence(snap({ lifecycle: 'merged', criteria: { verified: 1, total: 1 }, evidence: evidence([criterion('FB-01')]) }, { changeRequests: [cr('merged', { mergeCommitSha: 'd'.repeat(40) })] }), null)!);
    expect(merged['merged']).toMatchObject({ value: 'Merged', established: true });
    // A merge says nothing about a deployment.
    expect(merged['deployed']).toMatchObject({ value: 'Not established', established: false });
  });

  it('a merged SHA mismatch is not called merged', () => {
    const s = states(buildEvidence(snap({ criteria: { verified: 1, total: 1 }, evidence: evidence([criterion('FB-01')]) }, { changeRequests: [cr('merged_sha_mismatch')] }), null)!);
    expect(s['merged']).toMatchObject({ value: 'Merge not recorded', established: false });
  });

  it('partial evidence, a rejected candidate and missing evidence each read as what they are', () => {
    expect(states(buildEvidence(snap({ criteria: { verified: 1, total: 2 }, evidence: evidence([criterion('FB-01'), criterion('FB-02', { state: 'failed', verified: false })]) }), null)!)['verified']).toMatchObject({ value: 'Partly verified', established: false });
    expect(states(buildEvidence(snap({ criteria: { verified: 0, total: 1 }, evidence: evidence([criterion('FB-01', { verified: false })], false) }), null)!)['verified']).toMatchObject({ value: 'Not verified' });
    const none = buildEvidence(snap({}), null)!;
    expect(states(none)['verified']).toMatchObject({ value: 'Not connected' });
    expect(none.connected).toBe(false);
    expect(none.coverage).toBe('Per-criterion evidence is not connected');
  });

  it('a commit link exists only when a real pull request put the commit on GitHub', () => {
    const run = { criteria: { verified: 1, total: 1 }, evidence: evidence([criterion('FB-01')]) };
    expect(buildEvidence(snap(run), null)!.candidate!.commitHref).toBeNull();
    expect(buildEvidence(snap(run, { changeRequests: [cr('open')] }), null)!.candidate!.commitHref).toBe(`https://github.com/acme/app/commit/${SHA}`);
  });

  it('a project with no run has no report', () => {
    expect(buildEvidence(emptySnapshot({ projectId: 'p', observedAt: '2026-11-09T01:00:00.000Z', provenance: 'observed' }), null)).toBeNull();
  });
});
