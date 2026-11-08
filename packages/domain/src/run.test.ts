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

    const rec = {
      schemaVersion: 1, taskId: 't', runId: 'r', candidateSha: 'abc', baseSha: 'def',
      contractRevisions: ['c1'], checkManifestSha256: 'b'.repeat(64), toolVersions: { node: '24' },
      environmentImageDigest: 'sha256:' + 'c'.repeat(64), startedAt: '2026-11-08T06:00:00Z',
      finishedAt: '2026-11-08T06:01:00Z', result: 'passed', exitCode: 0, artifactIds: ['x'],
      verifier: { kind: 'verifier', id: 'ci' },
    };
    expect(VerificationRecordSchema.safeParse(rec).success).toBe(true);
    expect(VerificationRecordSchema.safeParse({ ...rec, result: 'skipped' }).success).toBe(true);
    expect(VerificationRecordSchema.safeParse({ ...rec, result: 'maybe' }).success).toBe(false);
    expect(VerificationRecordSchema.safeParse({ ...rec, checkManifestSha256: 'nope' }).success).toBe(false);
  });
});
