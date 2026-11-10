import type { VerificationRecord } from '@selarikru/domain';
import { describe, expect, it } from 'vitest';
import { buildPrBody } from './body.ts';

const record = { recordId: 'r1', verifier: { id: 'v' }, host: 'h', results: [], flaky: [] } as unknown as VerificationRecord;
const pkg = { runId: 'run', candidateSha: 'c'.repeat(40), baseSha: 'b'.repeat(40), record, limitations: [], usage: [] };

describe('the PR body', () => {
  it('names human intervention, and says what it does not mean', () => {
    const body = buildPrBody({ ...pkg, humanIntervention: [{ attemptId: 'a1', taskId: 't1', at: '2026-11-09T01:00:00.000Z' }] });
    expect(body).toContain('## Human intervention');
    expect(body).toContain('Attempt `a1` (task `t1`) at 2026-11-09T01:00:00.000Z');
    expect(body).toContain('recorded model cannot vouch for what was run');
    expect(body).toContain('diff gate and the verifier');
  });
  it('is absent when no person typed anything', () => {
    expect(buildPrBody(pkg)).not.toContain('Human intervention');
  });
});

describe('the PR body: knowledge packs', () => {
  it('lists each attempt\'s delivered packs by version and digest, and says they granted nothing', () => {
    const body = buildPrBody({ ...pkg, skills: [{ attemptId: 'a1', taskId: 't1', confirmed: true, packs: [{ versionId: 'express-api-routes@1.0.0', digest: 'd'.repeat(64) }] }, { attemptId: 'a2', taskId: 't2', confirmed: false, packs: [{ versionId: 'express-api-routes@1.0.0', digest: 'd'.repeat(64) }] }] });
    expect(body).toContain('## Knowledge packs');
    expect(body).toContain('- Attempt `a1` (task `t1`), delivered and confirmed by the runner: `express-api-routes@1.0.0` sha256 `' + 'd'.repeat(64) + '`');
    expect(body).toContain('- Attempt `a2` (task `t2`), resolved at claim but delivery not confirmed by the runner: `express-api-routes@1.0.0`');
    expect(body).toContain('granted no tool, path or approval');
  });
  it('is absent when no attempt received a pack', () => {
    expect(buildPrBody({ ...pkg, skills: [{ attemptId: 'a1', taskId: 't1', confirmed: false, packs: [] }] })).not.toContain('Knowledge packs');
  });
});
