import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, AGENT_LIMITS, ROUTE_STEP_KINDS, agentOutputSchema, applyFileDiff, checkAgentOutput, checkPatch, diffSummary, parseUnifiedDiff, type AgentCheckContext, type AgentKind } from './index.ts';

const IDS = ['AC-1', 'AC-2'];
const BASE = 'line one\nline two\nline three\n';
const files = new Map([['src/app.ts', BASE], ['src/util.ts', 'export const a = 1;\n']]);
/** H11: what a Project Manager call may name. */
const PM = { sourceIds: ['brain:c1'], taskIds: ['t1', 't2'], workerIds: ['w1'], briefItemIds: ['P1', 'P2'], briefQuestionIds: ['U1'] };
const ctx = (over: Partial<AgentCheckContext> = {}): AgentCheckContext => ({ criteriaIds: IDS, allowedPaths: ['src'], files, pm: PM, ...over });

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
  pmAnswer: { answer: 'The list screen waits on the API task.', citations: [{ sourceId: 'brain:c1', note: 'The plan orders the API first.' }] },
  pmResearch: { answer: 'Most feedback boards sort by votes.', findings: [{ point: 'Sorting by recency is the simplest start.' }] },
  pmPlan: { tasks: [{ key: 'T1', title: 'API', description: 'Add the post route.', role: 'backend', requirementIds: ['AC-1'], paths: ['src/api'], dependsOn: [] }] },
  pmDelegate: { assignments: [{ taskId: 't1', workerId: 'w1', why: 'Backend work, and Aisyah is free.' }] },
  // H13: the plan brief Nano formats on the device, and the cloud's checks of it.
  pmBrief: {
    goal: 'Let people post and sort feedback.',
    items: [{ id: 'P1', text: 'Posts are sorted newest first.', kind: 'requirement', checkable: false, source: 'points', from: [1, 2] }, { id: 'P2', text: 'Most boards sort by votes.', kind: 'fact', checkable: true, source: 'conversation', from: [3] }],
    uncertainties: [{ id: 'U1', question: 'Do boards need moderation?', from: [5] }],
    omitted: [{ reason: 'private', from: [4] }],
  },
  pmVerify: {
    items: [{ id: 'P2', verdict: 'supported', explanation: 'Several public boards sort by votes.', sources: [{ title: 'A board', url: 'https://example.org/a' }] }, { id: 'P1', verdict: 'not_checkable', explanation: 'A decision, not a fact.', sources: [] }],
    uncertainties: [{ id: 'U1', answer: 'Most public boards moderate posts.', confidence: 'medium', sources: [] }],
  },
  pmVerifyNoWeb: {
    items: [{ id: 'P2', verdict: 'consistent', explanation: 'Fits what is generally known.' }],
    uncertainties: [{ id: 'U1', answer: 'Usually, yes.', confidence: 'low' }],
  },
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
  // A citation to a source the call was not given; an extra field.
  pmAnswer: [{ answer: 'x', citations: [{ sourceId: 'brain:zz', note: 'n' }] }, { answer: 'x', citations: [], urls: ['https://example.com'] }],
  // Web sources never come from the model's text: a findings URL field is refused.
  pmResearch: [{ answer: 'x', findings: [{ point: 'p', url: 'https://example.com' }] }, { answer: '', findings: [] }],
  pmPlan: [{ tasks: [] }],
  // A task outside the plan, a worker that does not exist, and any widening field (paths, budget, a new role) are refused.
  pmDelegate: [
    { assignments: [{ taskId: 'zz', workerId: 'w1', why: 'w' }] }, { assignments: [{ taskId: 't1', workerId: 'w9', why: 'w' }] },
    { assignments: [{ taskId: 't1', workerId: 'w1', why: 'w', allowedPaths: ['/'] }] }, { assignments: [{ taskId: 't1', workerId: 'w1', why: 'w', budgetUsd: 100 }] },
    { assignments: [{ taskId: 't1', workerId: 'w1', why: 'w', role: 'admin' }] }, { assignments: [] },
  ],
  pmBrief: [
    { goal: 'g', items: [{ id: 'P1', text: 't'.repeat(281), kind: 'fact', checkable: true, source: 'points', from: [1] }], uncertainties: [], omitted: [] },
    { goal: 'g', items: Array.from({ length: 21 }, (_, i) => ({ id: `P${i + 1}`, text: 't', kind: 'fact', checkable: true, source: 'points', from: [1] })), uncertainties: [], omitted: [] },
    { goal: 'g', items: [{ id: 'X1', text: 't', kind: 'fact', checkable: true, source: 'points', from: [1] }], uncertainties: [], omitted: [] },
    { goal: 'g', items: [], uncertainties: [{ id: 'U1', question: 'q', from: [1] }], omitted: [{ reason: 'boring', from: [2] }] },
    { goal: 'g', items: [{ id: 'P1', text: 't', kind: 'opinion', checkable: true, source: 'points', from: [1] }], uncertainties: [], omitted: [] },
    // Fix round 1 (I1): every entry says which input lines it covers; an omitted entry names at least one.
    { goal: 'g', items: [{ id: 'P1', text: 't', kind: 'fact', checkable: true, source: 'points' }], uncertainties: [], omitted: [] },
    { goal: 'g', items: [], uncertainties: [], omitted: [{ reason: 'private', from: [] }] },
    { goal: 'g', items: [{ id: 'P1', text: 't', kind: 'fact', checkable: true, source: 'points', from: [0] }], uncertainties: [], omitted: [] },
  ],
  // An id the brief did not have; a web verdict on the no-web variant; an explanation too long; a source with an extra field.
  pmVerify: [
    { items: [{ id: 'P9', verdict: 'supported', explanation: 'e', sources: [] }], uncertainties: [] },
    { items: [{ id: 'P1', verdict: 'consistent', explanation: 'e', sources: [] }], uncertainties: [] },
    { items: [{ id: 'P1', verdict: 'unclear', explanation: 'e'.repeat(401), sources: [] }], uncertainties: [] },
    { items: [], uncertainties: [{ id: 'U1', answer: 'a', confidence: 'certain', sources: [] }] },
  ],
  pmVerifyNoWeb: [
    { items: [{ id: 'P1', verdict: 'supported', explanation: 'e' }], uncertainties: [] },
    { items: [{ id: 'P1', verdict: 'unclear', explanation: 'e', sources: [{ title: 't', url: 'https://example.org' }] }], uncertainties: [] },
  ],
};

describe('agent output schemas', () => {
  it('there is one agent per step kind the route suggestion knows', () => {
    expect([...AGENT_KINDS]).toEqual([...ROUTE_STEP_KINDS]);
  });

  for (const kind of AGENT_KINDS) {
    it(`${kind}: accepts a good fixture and rejects bad ones`, () => {
      expect(agentOutputSchema(kind, IDS, PM).safeParse(GOOD[kind]).success).toBe(true);
      expect(checkAgentOutput(kind, GOOD[kind], ctx({ reviewedDiff: GOOD_DIFF }))).toMatchObject({ ok: true });
      for (const bad of BAD[kind]) {
        expect(agentOutputSchema(kind, IDS, PM).safeParse(bad).success).toBe(false);
        const r = checkAgentOutput(kind, bad, ctx({ reviewedDiff: GOOD_DIFF }));
        expect(r.ok).toBe(false);
      }
    });
  }

  it('H13: a plan brief with two items of one id is refused as a duplicate key', () => {
    const dup = { goal: 'g', items: [{ id: 'P1', text: 'a', kind: 'fact', checkable: true, source: 'points', from: [1] }, { id: 'P1', text: 'b', kind: 'fact', checkable: true, source: 'points', from: [1] }], uncertainties: [], omitted: [] };
    expect(checkAgentOutput('pmBrief', dup, ctx())).toMatchObject({ ok: false, issues: [{ code: 'duplicate_key' }] });
    const dupQ = { goal: 'g', items: [], uncertainties: [{ id: 'U1', question: 'a', from: [1] }, { id: 'U1', question: 'b', from: [2] }], omitted: [] };
    expect(checkAgentOutput('pmBrief', dupQ, ctx())).toMatchObject({ ok: false, issues: [{ code: 'duplicate_key' }] });
  });

  it('H13: a Project Manager plan may carry an architecture section of at most 2,000 characters', () => {
    const plan = GOOD.pmPlan as Record<string, unknown>;
    expect(checkAgentOutput('pmPlan', { ...plan, architecture: 'An API and a list screen (P1, P2).' }, ctx())).toMatchObject({ ok: true });
    expect(checkAgentOutput('pmPlan', { ...plan, architecture: 'a'.repeat(2001) }, ctx()).ok).toBe(false);
    expect(checkAgentOutput('plan', { ...(GOOD.plan as object), architecture: 'x' }, ctx()).ok).toBe(false);
  });

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
    expect(codes({ tasks: [task('T1', [], ['src/.env'])] })).toContain('path_reserved');
    expect(codes({ tasks: [task('T1', [], ['src/id_rsa'])] })).toContain('path_secret');
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
    expect(codes(at('src/.env'), ctx({ files: new Map([['src/.env', BASE]]) }))).toContain('path_reserved');
    expect(codes(at('src/id_rsa'), ctx({ files: new Map([['src/id_rsa', BASE]]) }))).toContain('path_secret');
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
    expect(codes(find('./src/app.ts', 3))).toEqual([]);
    expect(codes(find('src/util.ts', 1))).toContain('finding_file_not_in_diff');
    expect(codes(find('src/app.ts', 40))).toContain('finding_line_out_of_range');
  });
});

describe('fix round 1: canonical paths in patches (reviewer repro patch.mts)', () => {
  const f = new Map([['src/a.ts', 'one\ntwo\n']]);
  const c = (allowedPaths: string[] = ['src']) => ({ allowedPaths, files: f });
  const codes = (d: string, x = c()) => { const r = checkPatch(d, x); return r.ok ? ['ok'] : r.issues.map((i) => i.code); };
  const create = (p: string) => `--- /dev/null\n+++ ${p}\n@@ -0,0 +1 @@\n+x\n`;

  it.each([
    ['a create over an existing file spelled with ./', create('b/./src/a.ts'), 'diff_file_exists'],
    ['a create over an existing file in another case', create('b/src/A.ts'), 'diff_file_exists'],
    ['a create under a path that is an existing file', create('b/src/a.ts/x'), 'diff_file_exists'],
    ['a duplicate spelled with ./', `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-one\n+uno\n${create('b/./src/a.ts')}`, 'diff_duplicate_file'],
    ['a duplicate in another case', `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-one\n+uno\n${create('b/src/A.TS')}`, 'diff_duplicate_file'],
    ['a parent segment', create('b/src/../x'), 'path_invalid'],
    ['an absolute path', create('/etc/x'), 'path_invalid'],
    ['a quoted path', create('"b/src/x y"'), 'path_invalid'],
    ['a trailing slash', create('b/src/newdir/'), 'path_invalid'],
    ['an empty segment', create('b/src//x.ts'), 'path_invalid'],
    ['a carriage return in the path', `--- /dev/null\r\n+++ b/src/z.ts\r\n@@ -0,0 +1 @@\r\n+x\r\n`, 'path_invalid'],
    ['a NUL in the path', create('b/src/z\0.ts'), 'path_invalid'],
    ['.git in any case', create('b/src/.GIT/hooks/pre-commit'), 'path_invalid'],
    ['an .env file in any case', create('b/src/.Env'), 'path_reserved'],
    ['a git header naming another file', `diff --git a/src/a.ts b/src/evil.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-one\n+uno\n`, 'diff_header_mismatch'],
    ['a rename', `diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts\n`, 'diff_unsupported'],
    ['a binary patch', `diff --git a/src/x.png b/src/x.png\nnew file mode 100644\nBinary files /dev/null and b/src/x.png differ\n`, 'diff_unsupported'],
    ['a symlink', `diff --git a/src/l b/src/l\nnew file mode 120000\n--- /dev/null\n+++ b/src/l\n@@ -0,0 +1 @@\n+/etc/passwd\n`, 'diff_unsupported'],
    ['an executable', `diff --git a/src/l b/src/l\nnew file mode 100755\n--- /dev/null\n+++ b/src/l\n@@ -0,0 +1 @@\n+x\n`, 'diff_unsupported'],
    ['a change that changes nothing', `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,0 @@\n`, 'diff_empty'],
    ['prose before the diff', `Here is the diff:\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-one\n+uno\n`, 'diff_unparseable'],
    ['a hunk at the wrong line', `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-one\n+uno\n`, 'diff_does_not_apply'],
    ['no newline claimed on a file that has one', `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-two\n\\ No newline at end of file\n+deux\n`, 'diff_does_not_apply'],
  ])('refuses %s', (_name, diff, code) => {
    expect(codes(diff)).toContain(code);
  });

  it('a trailing timestamp after a tab is not part of the path', () => {
    expect(codes(create('b/src/z.ts\t2020-01-01'))).toEqual(['ok']);
  });

  it('no allowed paths allows nothing', () => {
    expect(codes(create('b/src/q'), c([]))).toContain('path_outside_allowed');
  });

  it('results are keyed by the canonical path', () => {
    const r = checkPatch(`--- a/./src/a.ts\n+++ b/./src/a.ts\n@@ -1 +1 @@\n-one\n+uno\n`, c());
    expect(r.ok && [...r.results.keys()]).toEqual(['src/a.ts']);
  });
});

describe('fix round 1: reserved roots, whatever the allowed paths say', () => {
  const create = (p: string) => `--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+x\n`;
  it.each([
    ['.claude/skills/x/SKILL.md', ['.claude']],
    ['.selarikru/approval.json', ['.selarikru']],
    ['.CLAUDE/Skills/x.md', ['.CLAUDE']],
    ['app/.env.local', ['app']],
  ])('a patch may not touch %s', (p, allowed) => {
    const r = checkPatch(create(p), { allowedPaths: allowed, files: new Map() });
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain('path_reserved');
  });

  it('a plan, even with no allowed paths to bound it, may not propose them', () => {
    const plan = (paths: string[]) => ({ tasks: [{ key: 'T1', title: 't', description: 'd', role: 'backend', requirementIds: ['AC-1'], paths, dependsOn: [] }] });
    for (const p of ['.claude/skills', '.claude/skills/x', '.selarikru', '.env', 'web/.env.production']) {
      const r = checkAgentOutput('plan', plan([p]), { criteriaIds: IDS, allowedPaths: [] });
      expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain('path_reserved');
    }
    expect(checkAgentOutput('plan', plan(['.claude/commands']), { criteriaIds: IDS, allowedPaths: [] }).ok).toBe(true);
  });

  it('a breakdown step may not name one inside an allowed root', () => {
    const r = checkAgentOutput('breakdown', { steps: [{ title: 't', detail: 'd', paths: ['.claude/skills/x'], criteriaIds: [] }] }, { criteriaIds: IDS, allowedPaths: ['.claude'] });
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toContain('path_reserved');
  });
});

describe('fix round 2: .env reservation is exact', () => {
  const plan = (paths: string[]) => ({ tasks: [{ key: 'T1', title: 't', description: 'd', role: 'backend', requirementIds: ['AC-1'], paths, dependsOn: [] }] });
  const codes = (p: string) => { const r = checkAgentOutput('plan', plan([p]), { criteriaIds: IDS, allowedPaths: [] }); return r.ok ? [] : r.issues.map((i) => i.code); };
  it.each(['.env', '.ENV', 'web/.env', '.env.local', 'web/.Env.production'])('%s is reserved', (p) => {
    expect(codes(p)).toContain('path_reserved');
  });
  it.each(['.envrc', '.environment/config.ts', '.envoy/proxy.yaml', 'web/.envrc'])('%s is not reserved by this rule', (p) => {
    expect(codes(p)).not.toContain('path_reserved');
  });
});
