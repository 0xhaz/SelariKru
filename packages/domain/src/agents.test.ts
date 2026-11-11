import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, AGENT_LIMITS, ROUTE_STEP_KINDS, agentOutputSchema, applyFileDiff, checkAgentOutput, checkPatch, diffSummary, parseUnifiedDiff, type AgentCheckContext, type AgentKind } from './index.ts';

const IDS = ['AC-1', 'AC-2'];
const BASE = 'line one\nline two\nline three\n';
const files = new Map([['src/app.ts', BASE], ['src/util.ts', 'export const a = 1;\n']]);
const ctx = (over: Partial<AgentCheckContext> = {}): AgentCheckContext => ({ criteriaIds: IDS, allowedPaths: ['src'], files, ...over });

const GOOD_DIFF = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,3 +1,3 @@', ' line one', '-line two', '+line 2', ' line three', ''].join('\n');

const GOOD: Record<AgentKind, unknown> = {
  brief: { summary: 'Let people post feedback.', acceptanceCriteria: [{ requirementId: 'AC-1', text: 'A post appears in the list.' }] },
  criteria: { acceptanceCriteria: [{ requirementId: 'AC-2', text: 'Empty posts are refused.' }] },
  plan: {
    tasks: [
      { key: 'T1', title: 'API', description: 'Add the post route.', role: 'backend', requirementIds: ['AC-1'], paths: ['src/api'], dependsOn: [] },
      { key: 'T2', title: 'Screen', description: 'Show posts.', role: 'frontend', requirementIds: ['AC-1', 'AC-2'], paths: ['src/web'], dependsOn: ['T1'] },
    ],
  },
  breakdown: { steps: [{ title: 'Write the route', detail: 'POST /posts stores one post.', paths: ['src/app.ts'], criteriaIds: ['AC-1'] }] },
  patch: { summary: 'Rename the second line.', diff: GOOD_DIFF },
  review: { outcome: 'changes_suggested', summary: 'One naming nit.', findings: [{ file: 'src/app.ts', line: 2, severity: 'nit', criterionId: 'AC-1', message: 'Spell the number out.' }] },
  triage: { summary: 'The post test failed.', category: 'test_failure', likelyCause: 'The route returns 200 instead of 201.', nextStep: 'Return 201 from the post route.', location: { file: 'src/app.ts', line: 2 } },
  prDescription: { title: 'Add posting', body: 'Adds the post route and screen.', criteriaCovered: ['AC-1'] },
};

const BAD: Record<AgentKind, unknown[]> = {
  brief: [{ summary: '', acceptanceCriteria: [] }, { summary: 'x', acceptanceCriteria: [{ requirementId: 'AC-9', text: 't' }] }, { summary: 'x', acceptanceCriteria: [{ requirementId: 'AC-1', text: 't' }], extra: 1 }],
  criteria: [{ acceptanceCriteria: [{ requirementId: 'AC-1' }] }, { acceptanceCriteria: Array.from({ length: 9 }, () => ({ requirementId: 'AC-1', text: 't' })) }],
  plan: [{ tasks: [] }, { tasks: [{ key: 'T1', title: 'x', description: 'y', role: 'admin', requirementIds: ['AC-1'], paths: ['src'], dependsOn: [] }] }, { tasks: [{ key: 'T1', title: 'x', description: 'y', role: 'backend', requirementIds: ['AC-1'], paths: ['src'], dependsOn: [], allowedPaths: ['/'] }] }],
  breakdown: [{ steps: [] }, { steps: [{ title: 'x', detail: 'y', paths: [], criteriaIds: ['NOPE'] }] }],
  patch: [{ summary: 'x' }, { summary: 'x', diff: 'd'.repeat(AGENT_LIMITS.patchDiffChars + 1) }, { summary: 'x', diff: GOOD_DIFF, command: 'rm -rf /' }],
  review: [{ outcome: 'approve', summary: 'x', findings: [] }, { outcome: 'no_issues', summary: 'x', findings: [{ file: 'src/app.ts', line: 0, severity: 'nit', message: 'm' }] }],
  triage: [{ summary: 'x', category: 'magic', likelyCause: 'y', nextStep: 'z' }, { summary: 'x', category: 'unknown', likelyCause: 'y' }],
  prDescription: [{ title: 't'.repeat(73), body: 'b', criteriaCovered: [] }, { title: 't', body: 'b', criteriaCovered: ['AC-7'] }],
};

describe('agent output schemas', () => {
  it('there is one agent per step kind the route suggestion knows', () => {
    expect([...AGENT_KINDS]).toEqual([...ROUTE_STEP_KINDS]);
  });

  for (const kind of AGENT_KINDS) {
    it(`${kind}: accepts a good fixture and rejects bad ones`, () => {
      expect(agentOutputSchema(kind, IDS).safeParse(GOOD[kind]).success).toBe(true);
      expect(checkAgentOutput(kind, GOOD[kind], ctx({ reviewedDiff: GOOD_DIFF }))).toMatchObject({ ok: true });
      for (const bad of BAD[kind]) {
        expect(agentOutputSchema(kind, IDS).safeParse(bad).success).toBe(false);
        const r = checkAgentOutput(kind, bad, ctx({ reviewedDiff: GOOD_DIFF }));
        expect(r.ok).toBe(false);
      }
    });
  }

  it('issues carry codes and JSON paths, never the model text', () => {
    const r = checkAgentOutput('brief', { summary: 'CANARY-TEXT', acceptanceCriteria: [{ requirementId: 'AC-9', text: 'CANARY-TEXT' }] }, ctx());
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('CANARY-TEXT');
  });
});

describe('plan checks', () => {
  const task = (key: string, dependsOn: string[], paths = ['src/x']) => ({ key, title: 't', description: 'd', role: 'backend', requirementIds: ['AC-1'], paths, dependsOn });
  const codes = (data: unknown, c = ctx()) => { const r = checkAgentOutput('plan', data, c); return r.ok ? [] : r.issues.map((i) => i.code); };

  it('refuses a cycle, a missing or self dependency and a duplicate key', () => {
    expect(codes({ tasks: [task('T1', ['T2']), task('T2', ['T1'])] })).toContain('cycle');
    expect(codes({ tasks: [task('T1', ['T3'])] })).toContain('missing_dependency');
    expect(codes({ tasks: [task('T1', ['T1'])] })).toContain('self_dependency');
    expect(codes({ tasks: [task('T1', []), task('T1', [])] })).toContain('duplicate_key');
  });

  it('refuses invalid paths, secret paths and paths outside the task', () => {
    expect(codes({ tasks: [task('T1', [], ['../etc'])] })).toContain('path_invalid');
    expect(codes({ tasks: [task('T1', [], ['src/.git/config'])] })).toContain('path_invalid');
    expect(codes({ tasks: [task('T1', [], ['src/.env'])] })).toContain('path_secret');
    expect(codes({ tasks: [task('T1', [], ['docs/readme.md'])] })).toContain('path_outside_allowed');
  });
});

describe('unified diff', () => {
  it('parses headers, hunks and counts', () => {
    const p = parseUnifiedDiff(GOOD_DIFF);
    if (!p.ok) throw new Error(p.code);
    expect(p.files).toHaveLength(1);
    expect(diffSummary(p.files)).toEqual([{ path: 'src/app.ts', change: 'modify', added: 1, removed: 1 }]);
  });

  it('applies cleanly to the given contents', () => {
    const p = parseUnifiedDiff(GOOD_DIFF);
    if (!p.ok) throw new Error(p.code);
    expect(applyFileDiff(BASE, p.files[0]!)).toEqual({ ok: true, content: 'line one\nline 2\nline three\n' });
  });

  it('creates and deletes whole files', () => {
    const create = parseUnifiedDiff(['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n'));
    if (!create.ok) throw new Error(create.code);
    expect(applyFileDiff(null, create.files[0]!)).toEqual({ ok: true, content: 'a\nb\n' });
    const del = parseUnifiedDiff(['--- a/src/util.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-export const a = 1;', ''].join('\n'));
    if (!del.ok) throw new Error(del.code);
    expect(applyFileDiff('export const a = 1;\n', del.files[0]!)).toEqual({ ok: true, content: null });
  });

  it('honours a missing newline at the end of a file', () => {
    const p = parseUnifiedDiff(['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-x', '\\ No newline at end of file', '+y', '\\ No newline at end of file', ''].join('\n'));
    if (!p.ok) throw new Error(p.code);
    expect(applyFileDiff('x', p.files[0]!)).toEqual({ ok: true, content: 'y' });
    expect(applyFileDiff('x\n', p.files[0]!).ok).toBe(false);
  });

  it('refuses context that does not match, wrong hunk counts and garbage', () => {
    const wrong = parseUnifiedDiff(GOOD_DIFF.replace(' line one', ' line ONE'));
    if (!wrong.ok) throw new Error(wrong.code);
    expect(applyFileDiff(BASE, wrong.files[0]!)).toMatchObject({ ok: false, code: 'diff_does_not_apply' });
    expect(parseUnifiedDiff(GOOD_DIFF.replace('@@ -1,3 +1,3 @@', '@@ -1,4 +1,3 @@'))).toMatchObject({ ok: false, code: 'diff_unparseable' });
    expect(parseUnifiedDiff('just some words')).toMatchObject({ ok: false });
    expect(parseUnifiedDiff('')).toMatchObject({ ok: false, code: 'diff_empty' });
  });

  it('refuses renames, mode changes and binary patches', () => {
    expect(parseUnifiedDiff(['--- a/src/a.ts', '+++ b/src/b.ts', '@@ -1 +1 @@', '-x', '+y', ''].join('\n'))).toMatchObject({ ok: false, code: 'diff_unsupported' });
    expect(parseUnifiedDiff(['diff --git a/x b/x', 'old mode 100644', 'new mode 100755', ''].join('\n'))).toMatchObject({ ok: false, code: 'diff_unsupported' });
    expect(parseUnifiedDiff(['diff --git a/x b/x', 'Binary files a/x and b/x differ', ''].join('\n'))).toMatchObject({ ok: false, code: 'diff_unsupported' });
  });
});

describe('patch check', () => {
  const codes = (diff: string, c = ctx()) => { const r = checkPatch(diff, c); return r.ok ? [] : r.issues.map((i) => i.code); };

  it('accepts a diff that applies inside the allowed paths', () => {
    const r = checkPatch(GOOD_DIFF, ctx());
    expect(r).toMatchObject({ ok: true, files: [{ path: 'src/app.ts', change: 'modify', added: 1, removed: 1 }] });
    if (r.ok) expect(r.results.get('src/app.ts')).toBe('line one\nline 2\nline three\n');
  });

  it('refuses a diff outside the allowed paths, into .git, or onto a secret file', () => {
    const at = (path: string) => GOOD_DIFF.replaceAll('src/app.ts', path);
    expect(codes(at('docs/app.ts'), ctx({ files: new Map([['docs/app.ts', BASE]]) }))).toContain('path_outside_allowed');
    expect(codes(at('src/.git/config'), ctx({ files: new Map([['src/.git/config', BASE]]) }))).toContain('path_invalid');
    expect(codes(at('src/.env'), ctx({ files: new Map([['src/.env', BASE]]) }))).toContain('path_secret');
    expect(codes(at('../outside.ts'))).toContain('path_invalid');
  });

  it('refuses a change to a file whose contents were not provided, and a create over an existing file', () => {
    expect(codes(GOOD_DIFF.replaceAll('src/app.ts', 'src/other.ts'))).toContain('diff_file_not_provided');
    expect(codes(['--- /dev/null', '+++ b/src/app.ts', '@@ -0,0 +1 @@', '+a', ''].join('\n'))).toContain('diff_file_exists');
  });

  it('refuses a diff that does not apply, an invalid diff, a duplicate file and one over the size caps', () => {
    expect(codes(GOOD_DIFF.replace('-line two', '-line TWO'))).toContain('diff_does_not_apply');
    expect(codes('not a diff')).toContain('diff_unparseable');
    expect(codes(`${GOOD_DIFF}${GOOD_DIFF}`)).toContain('diff_duplicate_file');
    const big = ['--- /dev/null', '+++ b/src/big.ts', `@@ -0,0 +1,${AGENT_LIMITS.patchChangedLines + 1} @@`, ...Array.from({ length: AGENT_LIMITS.patchChangedLines + 1 }, (_, i) => `+l${i}`), ''].join('\n');
    expect(codes(big)).toContain('diff_too_large');
  });
});

describe('review checks', () => {
  const reviewed = GOOD_DIFF;
  const find = (file: string, line: number) => ({ outcome: 'changes_suggested', summary: 's', findings: [{ file, line, severity: 'minor', message: 'm' }] });
  const codes = (data: unknown) => { const r = checkAgentOutput('review', data, ctx({ reviewedDiff: reviewed })); return r.ok ? [] : r.issues.map((i) => i.code); };

  it('a finding names a file in the diff and a line that exists after the change', () => {
    expect(codes(find('src/app.ts', 3))).toEqual([]);
    expect(codes(find('src/util.ts', 1))).toContain('finding_file_not_in_diff');
    expect(codes(find('src/app.ts', 40))).toContain('finding_line_out_of_range');
  });
});
