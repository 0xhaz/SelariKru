import { emptySnapshot, type CriterionEvidenceView, type ProjectViewSnapshot, type RunEvidenceView, type RunView } from '@selarikru/view-protocol';
import { describe, expect, it } from 'vitest';
import { buildEvidence, cleanFailureText, checkAnchor } from './model.ts';

const SHA = 'a'.repeat(40);
const criterion = (id: string, over: Partial<CriterionEvidenceView> = {}): CriterionEvidenceView => ({
  criterionId: id, description: null, state: 'passed', verified: true, taskIds: ['t1'], candidateSha: SHA,
  check: { checkRunId: `chk_${id}`, checkId: id, checkVersion: '1', taskId: 't1', revision: 1, attemptId: 'att', recordId: 'ver_1', verificationAttempt: 1, at: '2026-11-09T01:00:00.000Z' }, ...over,
});
const evidence = (criteria: CriterionEvidenceView[], live = true, recordValid = true): RunEvidenceView => ({
  candidate: { sha: SHA, status: live ? 'assembled' : 'rejected', live, baseSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), target: 'main', recordedAt: '2026-11-09T01:00:00.000Z', recordId: 'ver_1', recordValid, verifierHost: 'h', checkManifestSha256: 'e'.repeat(64), verifierSha256: '1'.repeat(64), flaky: ['FB-02'] }, criteria,
});
function snap(run: Partial<RunView>, over: Partial<ProjectViewSnapshot> = {}): ProjectViewSnapshot {
  const base: RunView = { runId: 'r1', lifecycle: 'ready_for_review', planRevision: 1, latestEvidence: null, criteria: null, evidence: null, reducedScope: null, scopeAssessment: null, pinnedModel: null, ...run };
  return { ...emptySnapshot({ projectId: 'p', observedAt: '2026-11-09T01:00:00.000Z', provenance: 'observed' }), runs: { r1: base }, ...over };
}
const states = (m: NonNullable<ReturnType<typeof buildEvidence>>) => Object.fromEntries(m.states.map((s) => [s.key, s]));
const cr = (status: string, over = {}) => ({ runId: 'r1', prNumber: 12, url: 'https://github.com/acme/app/pull/12', status, candidateSha: SHA, baseRef: 'main', observedHeadSha: SHA, mergeCommitSha: null, observedAt: '2026-11-09T01:00:00.000Z', outOfDate: null, ...over });

describe('a pull request main has left behind', () => {
  const outOfDate = { reason: 'main_moved' as const, at: '2026-11-09T02:00:00.000Z', rebuiltSha: 'c'.repeat(40), rebuild: 'verified' as const };
  it('says so in the delivery state and on the candidate, and never reads as awaiting a merge', () => {
    const m = buildEvidence(snap({ evidence: evidence([]) }, { changeRequests: [cr('open', { outOfDate })] }), null)!;
    expect(states(m)['merged']).toMatchObject({ value: 'Pull request out of date', tone: 'warning', established: false });
    expect(states(m)['merged']!.detail).toContain('no longer holds the verified code');
    expect(m.candidate?.outOfDateNote).toContain('Close it, and open the new one.');
  });
  it('stays quiet for a pull request that still holds the code', () => {
    const m = buildEvidence(snap({ evidence: evidence([]) }, { changeRequests: [cr('open')] }), null)!;
    expect(states(m)['merged']!.value).toBe('Awaiting a human merge');
    expect(m.candidate?.outOfDateNote).toBeNull();
  });
  it('does not say awaiting a merge while the run is out of review', () => {
    const m = buildEvidence(snap({ evidence: evidence([]), lifecycle: 'running' }, { changeRequests: [cr('open')] }), null)!;
    expect(states(m)['merged']).toMatchObject({ value: 'Not ready to merge', tone: 'warning' });
  });
});

describe('buildEvidence', () => {
  it('each criterion links to check and candidate SHA', () => {
    const m = buildEvidence(snap({ criteria: { verified: 2, total: 2 }, evidence: evidence([criterion('FB-01'), criterion('FB-02')]) }), null)!;
    expect(m.criteria).toHaveLength(2);
    for (const row of m.criteria) {
      expect(row.evidence?.checkHref).toContain(encodeURIComponent(`chk_${row.criterionId}`));
      expect(row.evidence?.candidateHref).toContain(SHA);
      expect(row.evidence?.candidateSha).toBe(SHA);
      expect(row.evidence?.anchor).toBe(checkAnchor(`chk_${row.criterionId}`));
    }
    expect(m.candidate).toMatchObject({ sha: SHA, flaky: ['FB-02'] });
  });

  it('a criterion no check has reported on has no link, and is not called verified', () => {
    const m = buildEvidence(snap({ criteria: { verified: 0, total: 1 }, evidence: evidence([criterion('FB-01', { state: 'not_run', verified: false, check: null, candidateSha: null })]) }), null)!;
    expect(m.criteria[0]).toMatchObject({ evidence: null, stateLabel: 'No check yet', verified: false });
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

  it('a stopped criterion stays in the total, is listed, and a run missing one is not called Verified', () => {
    const notDelivered = criterion('FB-02', { state: 'not_delivered', verified: false, check: null, candidateSha: null });
    const m = buildEvidence(snap({ criteria: { verified: 1, total: 2 }, evidence: evidence([criterion('FB-01'), notDelivered]) }), null)!;
    expect(m.coverage).toBe('1 of 2 approved criteria verified');
    expect(states(m)['verified']).toMatchObject({ value: 'Partly verified', established: false });
    expect(states(m)['verified']!.detail).toMatch(/1 not delivered/);
    expect(m.notDelivered).toEqual(['FB-02']);
    expect(m.criteria[1]).toMatchObject({ stateLabel: 'Not delivered', evidence: null });
  });

  it('only an accepted reduced scope can say verified with a criterion missing, and it says so', () => {
    const notDelivered = criterion('FB-02', { state: 'not_delivered', verified: false, check: null, candidateSha: null });
    const accepted = { decisionId: 'd', runId: 'r1', planRevision: 1, notDelivered: { tasks: [], requirementIds: ['FB-02'], acceptanceCheckIds: [] }, deliveredRequirementIds: ['FB-01'], acceptedAt: '2026-11-09T01:00:00.000Z', acceptedBy: 'o', note: null };
    expect(states(buildEvidence(snap({ criteria: { verified: 1, total: 2 }, evidence: evidence([criterion('FB-01'), notDelivered]), reducedScope: accepted }), null)!)['verified']).toMatchObject({ value: 'Verified at reduced scope', established: true });
    const other = { ...accepted, notDelivered: { ...accepted.notDelivered, requirementIds: ['FB-09'] } };
    expect(states(buildEvidence(snap({ criteria: { verified: 1, total: 2 }, evidence: evidence([criterion('FB-01'), notDelivered]), reducedScope: other }), null)!)['verified']).toMatchObject({ value: 'Partly verified' });
  });

  it('a passing row whose record no longer stands says so and is not called verified', () => {
    const m = buildEvidence(snap({ criteria: { verified: 0, total: 1 }, evidence: evidence([criterion('FB-01', { verified: false })], true, false) }), null)!;
    expect(states(m)['verified']).toMatchObject({ value: 'Record no longer valid', established: false });
    expect(m.criteria[0]).toMatchObject({ stateLabel: 'Record no longer valid', tone: 'warning' });
    // It says why, and where to act: re-verifying runs no worker.
    expect(states(m)['verified']!.detail).toMatch(/verifier, its suite or the stored record changed/i);
    expect(states(m)['verified']!.detail).toMatch(/no worker/i);
    expect(states(m)['verified']!.link).toMatchObject({ href: '#/decisions?card=reverify%3Ar1', label: 'Re-verify in Decisions', external: false });
  });

  it('a passing row with a valid record but an unfinished carrier reads as waiting, not as invalid', () => {
    const m = buildEvidence(snap({ criteria: { verified: 0, total: 1 }, evidence: evidence([criterion('FB-01', { verified: false })], true, true) }), null)!;
    expect(m.criteria[0]).toMatchObject({ stateLabel: 'Waiting on another task', tone: 'neutral' });
    expect(states(m)['verified']!.value).not.toBe('Record no longer valid');
  });

  it('offers no re-verify on a closed run, and still says the record does not stand', () => {
    for (const lifecycle of ['merged', 'failed', 'cancelled'] as const) {
      const m = buildEvidence(snap({ lifecycle, criteria: { verified: 0, total: 1 }, evidence: evidence([criterion('FB-01', { verified: false })], true, false) }), null)!;
      expect(states(m)['verified']).toMatchObject({ value: 'Record no longer valid', link: null });
      expect(states(m)['verified']!.detail).not.toMatch(/re-verifying/i);
    }
  });

  it('a lone carriage return ends a line rather than joining two words', () => {
    expect(cleanFailureText('one\rtwo\r\nthree')).toBe('one\ntwo\nthree');
  });

  it('strips control and direction characters from failure text, and keeps line structure', () => {
    expect(cleanFailureText('safe\u202Egnp.exe\u2066\u0007\nline2\ttab\u009b')).toBe('safegnp.exe\nline2\ttab');
  });

  it('a pass on a rejected candidate is muted, and a flaky criterion is marked', () => {
    const m = buildEvidence(snap({ criteria: { verified: 0, total: 2 }, evidence: evidence([criterion('FB-01', { verified: false }), criterion('FB-02', { verified: false })], false) }), null)!;
    expect(m.criteria[0]).toMatchObject({ stateLabel: 'Passed', tone: 'neutral', flaky: false });
    expect(m.criteria[1]).toMatchObject({ flaky: true });
  });

  it('a project with no run has no report', () => {
    expect(buildEvidence(emptySnapshot({ projectId: 'p', observedAt: '2026-11-09T01:00:00.000Z', provenance: 'observed' }), null)).toBeNull();
  });
});

describe('human intervention', () => {
  it('lists this run\'s attempts a person typed into, and no other run\'s', () => {
    const empty = emptySnapshot({ projectId: 'p', observedAt: '2026-11-09T01:00:00.000Z', provenance: 'observed' });
    const run = (id: string): RunView => ({ runId: id, lifecycle: 'verifying' as RunView['lifecycle'], planRevision: 1, latestEvidence: null, criteria: null, evidence: null, reducedScope: null, scopeAssessment: null, pinnedModel: null });
    const task = (taskId: string, runId: string) => ({ taskId, runId, revision: 1, aggregateRevision: 1, title: null, role: null, dependsOn: [], status: 'running' as const, statusReason: null, placementBlock: null, cancelRequested: null, cancelReason: null, supersededByRevision: null, attemptIds: [], activeAttemptId: null, enteredStatusAt: '2026-11-09T01:00:00.000Z', latestEvidence: null });
    const attempt = (attemptId: string, taskId: string, humanIntervenedAt: string | null) => ({ attemptId, taskId, number: 1, fence: 1, outcome: 'running' as const, exitReason: null, runnerId: 'r', startedAt: '2026-11-09T01:00:00.000Z', endedAt: null, lastHeartbeatAt: null, assignment: null, humanIntervenedAt });
    const snapshot: ProjectViewSnapshot = { ...empty, runs: { r1: run('r1'), r2: run('r2') }, tasks: { t1: task('t1', 'r1'), t2: task('t2', 'r2') }, attempts: { a1: attempt('a1', 't1', '2026-11-09T01:05:00.000Z'), a2: attempt('a2', 't2', '2026-11-09T01:06:00.000Z'), a3: attempt('a3', 't1', null) } };
    const model = buildEvidence(snapshot, 'r1')!;
    expect(model.humanIntervened).toEqual([{ attemptId: 'a1', taskId: 't1', at: '2026-11-09T01:05:00.000Z' }]);
    // An attempt of an older revision is only on the server's list, and the same attempt is not counted twice.
    const withOlder: ProjectViewSnapshot = { ...snapshot, runs: { ...snapshot.runs, r1: { ...run('r1'), humanInterventions: [{ attemptId: 'old', taskId: 't1', at: '2026-11-09T00:50:00.000Z' }, { attemptId: 'a1', taskId: 't1', at: '2026-11-09T01:05:00.000Z' }] } } };
    expect(buildEvidence(withOlder, 'r1')!.humanIntervened.map((h) => h.attemptId)).toEqual(['old', 'a1']);
  });
});

describe('verified is never established on an inconsistent record', () => {
  const reduced = (ids: string[]) => ({ decisionId: 'd', runId: 'r1', planRevision: 1, notDelivered: { requirementIds: ids }, deliveredRequirementIds: [], acceptedAt: '2026-11-09T01:00:00.000Z', acceptedBy: 'owner', note: null }) as unknown as RunView['reducedScope'];

  it('zero criteria rows with an invalid record, though the count says all passed, is not verified', () => {
    const v = states(buildEvidence(snap({ criteria: { verified: 2, total: 2 }, evidence: evidence([], true, false) }), 'r1')!).verified!;
    expect(v.established).toBe(false);
    expect(v.value).not.toMatch(/^Verified/);
  });

  it('every criterion not delivered and all of them accepted is not verified at reduced scope: nothing passed', () => {
    const rows = ['FB-01', 'FB-02'].map((id) => criterion(id, { state: 'not_delivered', verified: false }));
    const v = states(buildEvidence(snap({ criteria: { verified: 0, total: 2 }, evidence: evidence(rows), reducedScope: reduced(['FB-01', 'FB-02']) }), 'r1')!).verified!;
    expect(v.established).toBe(false);
    expect(v.value).toBe('Not verified');
  });

  it('a count with no candidate, or with rows missing, is not verified either', () => {
    const noCandidate = states(buildEvidence(snap({ criteria: { verified: 2, total: 2 }, evidence: { candidate: null, criteria: [criterion('FB-01'), criterion('FB-02')] } }), 'r1')!).verified!;
    expect(noCandidate.established).toBe(false);
    const short = states(buildEvidence(snap({ criteria: { verified: 2, total: 2 }, evidence: evidence([criterion('FB-01')]) }), 'r1')!).verified!;
    expect(short).toMatchObject({ established: false, value: 'Not verified' });
    expect(short.detail).toContain('lists 1 of 2 approved criteria');
  });

  it('a sound record still verifies, in full and at reduced scope', () => {
    expect(states(buildEvidence(snap({ criteria: { verified: 2, total: 2 }, evidence: evidence([criterion('FB-01'), criterion('FB-02')]) }), 'r1')!).verified).toMatchObject({ value: 'Verified', established: true });
    const rows = [criterion('FB-01'), criterion('FB-02', { state: 'not_delivered', verified: false })];
    expect(states(buildEvidence(snap({ criteria: { verified: 1, total: 2 }, evidence: evidence(rows), reducedScope: reduced(['FB-02']) }), 'r1')!).verified).toMatchObject({ value: 'Verified at reduced scope', established: true });
  });
});
