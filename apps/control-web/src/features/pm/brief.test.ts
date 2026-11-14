import { describe, expect, it } from 'vitest';
import type { AiCheckpoint } from '@selarikru/domain';
import { snapshotOf, task } from '../overview/testing.ts';
import {
  addItem, addQuestion, approveBrief, briefFromOutput, briefInCount, briefInLines, briefPayload, cloudRefusal, completeness, conversationNotes, decodeBriefTexts, decodeNotes, editItem, editQuestion, emptyBrief,
  encodeBriefTexts, encodeNotes, latestNotes, notesCheckpoint, notesLabel, planBriefFor, removeItem, restrictBrief, screenCheck, setGoal, toggleGoal, toggleItem,
} from './brief.ts';

/** A secret-shaped value built at run time, so no key-like literal sits in the source. */
const FAKE_TOKEN = ['gh', 'p_', 'X'.repeat(24)].join('');
const route = (lock: unknown = null) => ({ effective: 'PREFER_IN_CLOUD', source: 'run', runDefault: 'PREFER_IN_CLOUD', override: null, overrideRevision: 0, lock, suggestion: null, lastObserved: null }) as never;

const POINTS = ['Posts are public.', 'Newest first.', 'Votes are one per person.', 'Use Postgres.', 'No email.', 'Sign in with Google.', 'Admins can hide posts.'].join('\n');
const UNSURE = ['Do boards need moderation?', 'Is sort by votes usual?', 'How many posts a day?'].join('\n');
const fullOutput = {
  goal: 'A public feedback board.',
  items: POINTS.split('\n').slice(0, 6).map((t, i) => ({ id: `P${i + 1}`, text: t, kind: 'requirement', checkable: i === 0, source: 'points', from: [i + 1] })),
  uncertainties: UNSURE.split('\n').map((q, i) => ({ id: `U${i + 1}`, question: q, from: [8 + i] })),
  omitted: [{ reason: 'private', from: [7] }],
};

describe('the plan brief: completeness (H13 amendment B)', () => {
  it('given 7 points and 3 questions, the brief accounts for all 10 (items, questions and omitted)', () => {
    expect(briefInCount(POINTS, UNSURE)).toEqual({ points: 7, unsure: 3 });
    const d = briefFromOutput(fullOutput, 'internal', briefInLines(POINTS, UNSURE));
    const c = completeness(d);
    expect(c).toMatchObject({ ok: true, missing: 0 });
    expect(c.line).toBe('7 points and 3 questions in, 6 items + 3 questions + 1 omitted out');
  });

  it('a model that drops one shows the warning, and adding the missing one by hand settles it', () => {
    const dropped = { ...fullOutput, omitted: [] };
    const d = briefFromOutput(dropped, 'internal', briefInLines(POINTS, UNSURE));
    const c = completeness(d);
    expect(c.ok).toBe(false);
    expect(c.missing).toBe(1);
    expect(c.warning).toMatch(/Line 7 is not in this brief/);
    const fixed = addItem(d, 'Admins can hide posts.', 'requirement', [7]);
    expect('draft' in fixed && completeness(fixed.draft).ok).toBe(true);
  });

  it('an item with a secret-shaped string is dropped and counted as omitted (private), so the count still adds up', () => {
    const out = { ...fullOutput, items: [...fullOutput.items.slice(0, 5), { id: 'P6', text: `Token ${FAKE_TOKEN} works.`, kind: 'fact', checkable: true, source: 'points', from: [6] }] };
    const d = briefFromOutput(out, 'internal', briefInLines(POINTS, UNSURE));
    expect(d.items.map((x) => x.id)).not.toContain('P6');
    expect(JSON.stringify(d)).not.toContain(FAKE_TOKEN);
    expect(d.omitted.filter((o) => o.reason === 'private')).toHaveLength(2);
    expect(completeness(d).ok).toBe(true);
  });
});

describe('fix round 1 (I1): completeness per point, by line number', () => {
  it('a model that drops point 3 and invents an item: the warning names line 3, the invented item is flagged, and line 3 can be added by hand', () => {
    const items = fullOutput.items.filter((x) => x.id !== 'P3').concat([{ id: 'P7', text: 'Add dark mode.', kind: 'requirement', checkable: false, source: 'points', from: [] }]);
    const d = briefFromOutput({ ...fullOutput, items }, 'internal', briefInLines(POINTS, UNSURE));
    const c = completeness(d);
    expect(c.ok).toBe(false);
    expect(c.missingLines).toEqual([{ n: 3, text: 'Votes are one per person.', list: 'points' }]);
    expect(c.invented).toEqual(['P7']);
    expect(c.warning).toContain('Line 3 is not in this brief');
    expect(c.warning).toContain('P7');
    // Grouping is allowed: one item may cover several lines.
    const grouped = briefFromOutput({ ...fullOutput, items: [{ ...fullOutput.items[0]!, from: [1, 2, 3, 4, 5, 6] }] }, 'internal', briefInLines(POINTS, UNSURE));
    expect(completeness(grouped)).toMatchObject({ ok: true, missing: 0 });
    const fixed = addItem(removeItem(d, 'P7'), 'Votes are one per person.', 'requirement', [3]);
    expect('draft' in fixed && completeness(fixed.draft).ok).toBe(true);
  });

  it('points and questions are numbered as one list, questions after points', () => {
    expect(briefInLines('a\nb', 'q').map((l) => [l.n, l.list])).toEqual([[1, 'points'], [2, 'points'], [3, 'questions']]);
  });
});

describe('the plan brief: review and approval (H13 amendment C)', () => {
  const d0 = briefFromOutput(fullOutput, 'internal', briefInLines(POINTS, UNSURE));

  it('everything is ticked by default; restricted input can never be ticked', () => {
    expect(d0.items.every((x) => x.ticked)).toBe(true);
    const r = briefFromOutput(fullOutput, 'restricted', briefInLines(POINTS, UNSURE));
    expect(r.items.every((x) => !x.ticked && x.restricted)).toBe(true);
    expect(toggleItem(r, 'P1').items[0]!.ticked).toBe(false);
    expect(cloudRefusal(approveBrief(r))).toBe('brief_restricted');
  });

  it('a manual edit is held to 280 characters and refused when it holds a secret-shaped string', () => {
    expect(editItem(d0, 'P1', 'x'.repeat(281))).toEqual({ error: 'too_long' });
    expect(editItem(d0, 'P1', `use ${FAKE_TOKEN}`)).toEqual({ error: 'secret' });
    expect(editQuestion(d0, 'U1', `use ${FAKE_TOKEN}`)).toEqual({ error: 'secret' });
    expect(setGoal(d0, `goal ${FAKE_TOKEN}`)).toEqual({ error: 'secret' });
    const ok = editItem(d0, 'P1', 'Posts are public to everyone.');
    expect('draft' in ok && ok.draft.items[0]!.text).toBe('Posts are public to everyone.');
  });

  it('approval freezes the brief by hash; any edit after it un-approves, and the cloud step is refused until approved again', () => {
    expect(cloudRefusal(d0)).toBe('brief_not_approved');
    const a = approveBrief(d0);
    expect(a.approvedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cloudRefusal(a)).toBeNull();
    const edited = editItem(a, 'P2', 'Oldest first.');
    expect('draft' in edited && edited.draft.approvedSha256).toBeNull();
    expect('draft' in edited && cloudRefusal(edited.draft)).toBe('brief_not_approved');
    expect(toggleItem(a, 'P2').approvedSha256).toBeNull();
    expect(removeItem(a, 'P2').approvedSha256).toBeNull();
    const q = addQuestion(a, 'Who moderates?');
    expect('draft' in q && q.draft.approvedSha256).toBeNull();
  });

  it('the cloud payload is only the ticked goal, items (with kind) and questions', () => {
    const a = approveBrief(toggleItem(d0, 'P2'));
    const p = briefPayload(a);
    expect(p.items.map((x) => x.id)).toEqual(['P1', 'P3', 'P4', 'P5', 'P6']);
    expect(p.items[0]).toEqual({ id: 'P1', kind: 'requirement', text: 'Posts are public.' });
    expect(Object.keys(p).sort()).toEqual(['goal', 'items', 'uncertainties']);
    expect(p.goal).toBe('A public feedback board.');
    expect(briefPayload(toggleGoal(a)).goal).toBe('');
    expect(toggleGoal(a).approvedSha256).toBeNull();
  });
});

describe('fix round 1: a draft made restricted', () => {
  it('when the notes become restricted, the draft does too: nothing ticked, no approval, an empty payload, and the check refused', () => {
    const a = approveBrief(briefFromOutput(fullOutput, 'internal', briefInLines(POINTS, UNSURE)));
    const r = restrictBrief(a);
    expect(r).toMatchObject({ label: 'restricted', approvedSha256: null, goalTicked: false });
    expect(r.items.every((x) => x.restricted && !x.ticked)).toBe(true);
    expect(briefPayload(approveBrief(r))).toEqual({ goal: '', items: [], uncertainties: [] });
    expect(cloudRefusal(approveBrief(r))).toBe('brief_restricted');
  });
});

describe('the cloud check\'s results and the plan (H13 amendment D, E)', () => {
  const a = approveBrief(briefFromOutput(fullOutput, 'internal', briefInLines(POINTS, UNSURE)));

  it('fix round 1 (I2): a source the model cites is matched by host against the search results; an invented one is marked as not from the search', () => {
    const grounding = { sources: [{ uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'boards.example.org' }, { uri: 'https://www.news.example.net/a', title: null }], entryPointHtml: null };
    const r = screenCheck('pmVerify', { items: [{ id: 'P1', verdict: 'supported', explanation: 'e', sources: [
      { title: 'Boards', url: 'https://www.boards.example.org/sorting' }, { title: 'News', url: 'https://news.example.net/b' }, { title: 'Made up', url: 'https://invented.example.com/x' },
    ] }], uncertainties: [] }, grounding);
    expect(r.items[0]!.sources.map((x) => [x.title, x.matched])).toEqual([['Boards', true], ['News', true], ['Made up', false]]);
    // Without the search's results nothing the model cites is matched.
    expect(screenCheck('pmVerify', { items: [{ id: 'P1', verdict: 'supported', explanation: 'e', sources: [{ title: 'B', url: 'https://boards.example.org/' }] }], uncertainties: [] }, null).items[0]!.sources[0]!.matched).toBe(false);
  });

  it('only https sources are kept, as text links', () => {
    const r = screenCheck('pmVerify', { items: [{ id: 'P1', verdict: 'supported', explanation: 'e', sources: [{ title: 'ok', url: 'https://example.org/a' }, { title: 'js', url: 'javascript:alert(1)' }, { title: 'http', url: 'http://example.org' }] }], uncertainties: [] });
    expect(r.items[0]!.sources).toEqual([{ title: 'ok', url: 'https://example.org/a', matched: false }]);
    expect(r.checked).toBe('web');
    expect(screenCheck('pmVerifyNoWeb', { items: [], uncertainties: [] }).checked).toBe('no_web');
  });

  it('the plan reads the approved brief with each verdict and answer', () => {
    const r = screenCheck('pmVerify', { items: [{ id: 'P2', verdict: 'contradicted', explanation: 'Most sort by votes.', sources: [] }], uncertainties: [{ id: 'U1', answer: 'Yes.', confidence: 'high', sources: [] }] });
    const plan = planBriefFor(a, r);
    expect(plan.checked).toBe('web');
    expect(plan.items.find((x) => x.id === 'P2')).toMatchObject({ verdict: 'contradicted', explanation: 'Most sort by votes.' });
    expect(plan.uncertainties.find((x) => x.id === 'U1')).toMatchObject({ answer: 'Yes.', confidence: 'high' });
  });

  it('a paused check carries its brief in labelled texts, read back exactly', () => {
    const p = briefPayload(a);
    const texts = encodeBriefTexts(p, 'internal');
    expect(texts.length).toBeLessThanOrEqual(8);
    expect(texts.every((t) => t.text.length <= 2000 && t.classification === 'internal')).toBe(true);
    expect(decodeBriefTexts(texts)).toEqual(p);
  });
});

describe('the plan brief notes (H13 amendment A, §1)', () => {
  const snap = snapshotOf({ tasks: [task('open', { route: route() }), task('locked', { route: route({ label: 'restricted', reason: 'r' }) })] });

  it('the notes\' label is the strongest of the subject\'s lock, the owner\'s mark and the turns they carry', () => {
    expect(notesLabel(snap.tasks['open'], false, false)).toBe('internal');
    expect(notesLabel(snap.tasks['open'], true, false)).toBe('restricted');
    expect(notesLabel(snap.tasks['open'], false, true)).toBe('restricted');
    expect(notesLabel(snap.tasks['locked'], false, false)).toBe('restricted');
  });

  it('Add this conversation appends the turns as text after a marker, and says whether any was restricted', () => {
    const c = conversationNotes([{ who: 'owner', text: 'Sort how?', restricted: false }, { who: 'pm', text: 'By votes.', restricted: true }]);
    expect(c.text).toBe('--- From this conversation ---\nOwner: Sort how?\nProject Manager: By votes.');
    expect(c.restricted).toBe(true);
  });

  it('notes are kept as a checkpoint and read back, re-judged by the subject\'s lock now', () => {
    const cp = notesCheckpoint({ projectId: 'p', runId: 'run', taskId: 'open', taskRevision: 1, planRevision: 1, points: POINTS, unsure: UNSURE, label: 'internal', at: '2026-11-14T00:00:00.000Z' });
    expect(cp.stepKind).toBe('researchNotes');
    expect(decodeNotes(cp.partial!.texts)).toEqual({ points: POINTS, unsure: UNSURE });
    expect(encodeNotes(POINTS, UNSURE, 'internal').every((t) => t.text.length <= 2000)).toBe(true);
    const back = latestNotes({ [cp.checkpointId]: cp }, snap, 'run');
    expect(back).toMatchObject({ points: POINTS, unsure: UNSURE, label: 'internal' });
    const moved: AiCheckpoint = { ...cp, checkpointId: 'ckp_notes_locked_000001', taskId: 'locked', updatedAt: '2026-11-14T01:00:00.000Z' };
    expect(latestNotes({ a: cp, b: moved }, snap, 'run')?.label).toBe('restricted');
    expect(latestNotes({ a: cp }, snap, 'another-run')).toBeNull();
  });

  it('an empty manual brief starts with the counts of what was given', () => {
    const d = emptyBrief('internal', briefInLines(POINTS, UNSURE));
    expect(completeness(d)).toMatchObject({ ok: false, missing: 10 });
  });
});
