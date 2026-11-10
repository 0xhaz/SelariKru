import { describe, expect, it } from 'vitest';
import { RunViewSchema } from './snapshot.ts';

const SHA = 'a'.repeat(40);
const base = { runId: 'r1', lifecycle: 'ready_for_review', planRevision: 1, latestEvidence: null };
const row = (id: string) => ({ criterionId: id, state: 'passed', verified: true, taskIds: ['t1'], check: null, candidateSha: SHA });
const candidate = { sha: SHA, status: 'assembled', live: true, baseSha: SHA, treeSha: null, target: 'main', recordedAt: '2026-11-09T01:00:00.000Z', recordId: 'v1', recordValid: true, verifierHost: null, checkManifestSha256: null, verifierSha256: null, flaky: [] };

describe('a run\'s verification count and its rows agree', () => {
  it('accepts neither, or both with one row per approved criterion', () => {
    expect(RunViewSchema.safeParse(base).success).toBe(true);
    expect(RunViewSchema.safeParse({ ...base, criteria: null, evidence: null }).success).toBe(true);
    expect(RunViewSchema.safeParse({ ...base, criteria: { verified: 2, total: 2 }, evidence: { candidate, criteria: [row('FB-1'), row('FB-2')] } }).success).toBe(true);
    expect(RunViewSchema.safeParse({ ...base, criteria: { verified: 0, total: 0 }, evidence: { candidate: null, criteria: [] } }).success).toBe(true);
  });

  it('refuses a count without rows, and rows without a count', () => {
    const a = RunViewSchema.safeParse({ ...base, criteria: { verified: 2, total: 2 }, evidence: null });
    expect(a.success).toBe(false);
    expect(a.error?.issues[0]?.path).toEqual(['evidence']);
    const b = RunViewSchema.safeParse({ ...base, criteria: null, evidence: { candidate, criteria: [row('FB-1')] } });
    expect(b.success).toBe(false);
    expect(b.error?.issues[0]?.path).toEqual(['criteria']);
  });

  it('refuses rows that do not match the total', () => {
    const r = RunViewSchema.safeParse({ ...base, criteria: { verified: 2, total: 2 }, evidence: { candidate, criteria: [] } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({ path: ['evidence', 'criteria'], message: 'evidence lists 0 criteria but the count says 2' });
    expect(RunViewSchema.safeParse({ ...base, criteria: { verified: 1, total: 1 }, evidence: { candidate, criteria: [row('FB-1'), row('FB-2')] } }).success).toBe(false);
  });
});
