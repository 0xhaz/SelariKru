import { describe, expect, it } from 'vitest';
import {
  APPLY_LIMITS, AcceptedProposalSchema, PR_DESCRIPTION_MAX_CHARS, acceptedProposalDigest, checkAcceptedProposal, codingAgentLabel, ownerPrDescription, reproduceProposal, sha256Hex,
  type AcceptedProposal,
} from './index.ts';

const BASE_SHA = 'a'.repeat(40);
const TASK = { taskId: 't1', revision: 2, baseSha: BASE_SHA, allowedPaths: ['src'] };
const BEFORE = 'line one\nline two\nline three\n';
const AFTER = 'line one\nline 2\nline three\n';
const NEW_FILE = 'export const x = 1;\n';
const DIFF = [
  '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,3 +1,3 @@', ' line one', '-line two', '+line 2', ' line three',
  '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+export const x = 1;', '',
].join('\n');

const proposal = (over: Partial<AcceptedProposal> = {}): AcceptedProposal => ({
  proposalId: 'req_1', taskId: 't1', taskRevision: 2, baseSha: BASE_SHA, routeRecordId: 'rr_1', diff: DIFF,
  results: [{ path: 'src/app.ts', sha256: sha256Hex(AFTER), content: AFTER }, { path: 'src/new.ts', sha256: sha256Hex(NEW_FILE), content: NEW_FILE }],
  ...over,
});

describe('accepted proposal: the server re-validation', () => {
  it('accepts a proposal whose results match their hashes, paths and diff', () => {
    expect(AcceptedProposalSchema.safeParse(proposal()).success).toBe(true);
    expect(checkAcceptedProposal(proposal(), TASK)).toEqual({ ok: true, digest: acceptedProposalDigest(proposal()) });
  });

  it('refuses a tampered hash', () => {
    const p = proposal({ results: [{ path: 'src/app.ts', sha256: sha256Hex('something else'), content: AFTER }, proposal().results[1]!] });
    expect(checkAcceptedProposal(p, TASK)).toMatchObject({ ok: false, code: 'hash_mismatch' });
  });

  it('refuses a path outside the allowed paths, a reserved path and a credentials file', () => {
    const at = (path: string) => proposal({ diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`, results: [{ path, sha256: sha256Hex('x\n'), content: 'x\n' }] });
    expect(checkAcceptedProposal(at('docs/readme.md'), TASK)).toMatchObject({ ok: false, code: 'path_outside_allowed' });
    expect(checkAcceptedProposal(at('src/.env'), TASK)).toMatchObject({ ok: false, code: 'path_reserved' });
    expect(checkAcceptedProposal(at('.selarikru/x'), { ...TASK, allowedPaths: ['.selarikru'] })).toMatchObject({ ok: false, code: 'path_reserved' });
    expect(checkAcceptedProposal(at('src/id_rsa'), TASK)).toMatchObject({ ok: false, code: 'path_secret' });
    expect(checkAcceptedProposal(at('src/../etc/x'), TASK)).toMatchObject({ ok: false, code: 'path_invalid' });
  });

  it('refuses an oversize result, one file and the whole', () => {
    const big = 'x'.repeat(APPLY_LIMITS.fileChars + 1);
    const p = proposal({ results: [{ path: 'src/app.ts', sha256: sha256Hex(big), content: big }, proposal().results[1]!] });
    expect(checkAcceptedProposal(p, TASK)).toMatchObject({ ok: false, code: 'result_too_large' });
    expect(AcceptedProposalSchema.safeParse(proposal({ results: Array.from({ length: APPLY_LIMITS.files + 1 }, (_, i) => ({ path: `src/f${i}.ts`, sha256: sha256Hex('x'), content: 'x' })) })).success).toBe(false);
  });

  it('refuses a mismatched base, a stale revision and another task', () => {
    expect(checkAcceptedProposal(proposal({ baseSha: 'b'.repeat(40) }), TASK)).toMatchObject({ ok: false, code: 'base_mismatch' });
    expect(checkAcceptedProposal(proposal({ taskRevision: 1 }), TASK)).toMatchObject({ ok: false, code: 'stale_revision' });
    expect(checkAcceptedProposal(proposal({ taskId: 't2' }), TASK)).toMatchObject({ ok: false, code: 'task_mismatch' });
  });

  it('refuses results that the diff does not name, or a create the diff does not give', () => {
    expect(checkAcceptedProposal(proposal({ results: [proposal().results[0]!] }), TASK)).toMatchObject({ ok: false, code: 'diff_results_mismatch' });
    const other = 'export const x = 2;\n';
    expect(checkAcceptedProposal(proposal({ results: [proposal().results[0]!, { path: 'src/new.ts', sha256: sha256Hex(other), content: other }] }), TASK)).toMatchObject({ ok: false, code: 'diff_results_mismatch' });
    expect(checkAcceptedProposal(proposal({ results: [proposal().results[0]!, { path: 'src/new.ts', sha256: null, content: null }] }), TASK)).toMatchObject({ ok: false, code: 'diff_results_mismatch' });
  });

  it('refuses secret-shaped content and duplicates', () => {
    const secret = 'const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n';
    const p = proposal({ diff: `--- /dev/null\n+++ b/src/k.ts\n@@ -0,0 +1 @@\n+${secret}`, results: [{ path: 'src/k.ts', sha256: sha256Hex(secret), content: secret }] });
    expect(checkAcceptedProposal(p, TASK)).toMatchObject({ ok: false, code: 'secret_content' });
    const dup = proposal({ results: [proposal().results[0]!, { ...proposal().results[0]!, path: 'src/APP.ts' }] });
    expect(checkAcceptedProposal(dup, TASK)).toMatchObject({ ok: false, code: 'result_duplicate' });
  });
});

describe('accepted proposal: reproduced from the base files', () => {
  it('reproduces the results from the base and refuses a base the diff does not apply to', () => {
    expect(reproduceProposal(proposal(), new Map([['src/app.ts', BEFORE]]), TASK.allowedPaths)).toEqual({ ok: true });
    expect(reproduceProposal(proposal(), new Map([['src/app.ts', 'something else\n']]), TASK.allowedPaths)).toMatchObject({ ok: false, code: 'base_mismatch' });
    // A file the diff creates already exists at the base.
    expect(reproduceProposal(proposal(), new Map([['src/app.ts', BEFORE], ['src/new.ts', 'old\n']]), TASK.allowedPaths)).toMatchObject({ ok: false, code: 'base_mismatch' });
  });

  it('refuses results that differ from what the diff gives on the base', () => {
    const other = 'line one\nline 3\nline three\n';
    const p = proposal({ results: [{ path: 'src/app.ts', sha256: sha256Hex(other), content: other }, proposal().results[1]!] });
    expect(reproduceProposal(p, new Map([['src/app.ts', BEFORE]]), TASK.allowedPaths)).toMatchObject({ ok: false, code: 'base_mismatch' });
  });
});

describe('labels and the owner\'s PR description', () => {
  it('names the apply worker without a model', () => {
    expect(codingAgentLabel({ provider: 'selarikru', model: 'apply-proposal' }, null)).toBe('Applies accepted changes (no model)');
    expect(codingAgentLabel({ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { label: 'Claude', harnessVersion: '2.1.0' })).toBe('Claude 2.1.0 claude-sonnet-5-5');
  });

  it('redacts secrets and caps the owner description', () => {
    expect(ownerPrDescription('  Adds posting.\n\nkey ghp_abcdefghijklmnopqrstuvwxyz0123456789  ')).toBe('Adds posting.\n\nkey [REDACTED]');
    expect(ownerPrDescription('x'.repeat(PR_DESCRIPTION_MAX_CHARS + 10))!.length).toBe(PR_DESCRIPTION_MAX_CHARS);
    expect(ownerPrDescription('   ')).toBeNull();
    expect(ownerPrDescription(undefined)).toBeNull();
  });
});

describe('base files relayed for the patch agent', () => {
  it('re-checks a runner answer: reserved, secret and outside paths are dropped without being named, secret content and size are listed', async () => {
    const { screenBaseFiles, BASE_FILE_LIMITS } = await import('./index.ts');
    const big = 'x'.repeat(BASE_FILE_LIMITS.fileChars + 1);
    const out = screenBaseFiles({
      files: [
        { path: 'src/a.ts', content: 'a\n' }, { path: 'src/.env', content: 'X=1\n' }, { path: 'docs/x.md', content: 'x\n' }, { path: 'src/id_rsa', content: 'k\n' },
        { path: 'src/k.ts', content: 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n' }, { path: 'src/big.ts', content: big.slice(0, BASE_FILE_LIMITS.fileChars) },
      ],
      omitted: [{ path: 'src/huge.ts', reason: 'too_large' }],
    }, ['src']);
    expect(out.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/big.ts']);
    expect(out.omitted).toEqual([{ path: 'src/huge.ts', reason: 'too_large' }, { path: 'src/k.ts', reason: 'secret_content' }]);
    expect(JSON.stringify(out)).not.toMatch(/\.env|docs\/x|id_rsa/);
  });
});

describe('fix round 1: listing and choosing base files (I4)', () => {
  it('a listing keeps only servable paths, sorted and capped at 500 entries', async () => {
    const { screenBaseListing } = await import('./index.ts');
    const many = Array.from({ length: 600 }, (_, i) => ({ path: `src/f${String(i).padStart(3, '0')}.ts`, size: i }));
    const out = screenBaseListing([...many, { path: 'src/.env', size: 1 }, { path: 'docs/x.md', size: 1 }], ['src']);
    expect(out.entries).toHaveLength(500);
    expect(out.truncated).toBe(true);
    expect(out.entries.some((e) => e.path === 'src/.env' || e.path === 'docs/x.md')).toBe(false);
  });

  it('a choice over 30 files picks the relevant one by name, and finds nothing when no name matches', async () => {
    const { selectFilesByName } = await import('./index.ts');
    const entries = [
      ...Array.from({ length: 29 }, (_, i) => ({ path: `src/components/widget${i}.tsx`, size: 100 })),
      { path: 'src/feedback/postStore.ts', size: 300 },
    ];
    expect(selectFilesByName(entries, ['Store new feedback posts', 'A post appears in the list'])).toEqual(['src/feedback/postStore.ts']);
    expect(selectFilesByName(entries, ['Make it faster'])).toEqual([]);
    expect(selectFilesByName(entries, ['widget'], 3)).toHaveLength(3);
  });
});
