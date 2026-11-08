import { describe, expect, it } from 'vitest';
import { AttemptSchema, RunSchema, VerificationRecordSchema } from './index.ts';

describe('run, attempt and evidence schemas', () => {
  it('parse minimal valid records and reject unknown fields', () => {
    const run = { schemaVersion: 1, projectId: 'p', runId: 'r', status: 'ready_for_review', planRevision: 2 };
    expect(RunSchema.safeParse(run).success).toBe(true);
    expect(RunSchema.safeParse({ ...run, status: 'done' }).success).toBe(false);
    expect(RunSchema.safeParse({ ...run, extra: 1 }).success).toBe(false);

    const attempt = {
      schemaVersion: 1, attemptId: 'a1', taskId: 't', taskRevision: 1, number: 1, fence: 1,
      outcome: 'running', baseSha: 'abc', headSha: null, startedAt: '2026-11-08T06:00:00Z', endedAt: null,
    };
    expect(AttemptSchema.safeParse(attempt).success).toBe(true);
    expect(AttemptSchema.safeParse({ ...attempt, number: 0 }).success).toBe(false);

    const run1 = { attempt: 1, startedAt: '2026-11-08T06:00:00Z', finishedAt: '2026-11-08T06:01:00Z', exitCode: 0, infrastructureError: null, results: [], resultArtifactId: 'x', logArtifactId: null };
    const rec = {
      schemaVersion: 1, recordId: 'ver_1', taskId: 't', runId: 'r', partTaskIds: ['t'], candidateSha: 'abc', candidateTreeSha: 'tree', candidateContentSha256: 'a'.repeat(64),
      baseSha: 'def', contractRevisions: ['c1'], checkManifestSha256: 'b'.repeat(64), verifierSha256: 'd'.repeat(64), toolVersions: { node: '24' }, configVersions: { suiteId: 's' },
      environmentImageDigest: 'sha256:' + 'c'.repeat(64), host: 'local-docker', fixtures: [{ path: 'f.json', sha256: 'e'.repeat(64) }], startedAt: '2026-11-08T06:00:00Z',
      finishedAt: '2026-11-08T06:01:00Z', result: 'passed', exitCode: 0, results: [], runs: [run1], flaky: [], taskOutcomes: [], artifactIds: ['x'],
      verifier: { kind: 'verifier', id: 'ci' },
    };
    expect(VerificationRecordSchema.safeParse(rec).success).toBe(true);
    expect(VerificationRecordSchema.safeParse({ ...rec, result: 'skipped' }).success).toBe(true);
    expect(VerificationRecordSchema.safeParse({ ...rec, result: 'error' }).success).toBe(true);
    expect(VerificationRecordSchema.safeParse({ ...rec, result: 'maybe' }).success).toBe(false);
    expect(VerificationRecordSchema.safeParse({ ...rec, runs: [] }).success).toBe(false);
    expect(VerificationRecordSchema.safeParse({ ...rec, extra: 1 }).success).toBe(false);
    expect(VerificationRecordSchema.safeParse({ ...rec, checkManifestSha256: 'nope' }).success).toBe(false);
  });
});
