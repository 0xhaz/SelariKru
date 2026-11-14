import { describe, expect, it } from 'vitest';
import type { AiCheckpoint } from '@selarikru/domain';
import { snapshotOf, task } from '../overview/testing.ts';
import {
  addItem, addQuestion, approveBrief, briefFromOutput, briefInCount, briefPayload, cloudRefusal, completeness, conversationNotes, decodeBriefTexts, decodeNotes, editItem, editQuestion, emptyBrief,
  encodeBriefTexts, encodeNotes, latestNotes, notesCheckpoint, notesLabel, planBriefFor, removeItem, screenCheck, setGoal, toggleItem,
} from './brief.ts';

/** A secret-shaped value built at run time, so no key-like literal sits in the source. */
const FAKE_TOKEN = ['gh', 'p_', 'X'.repeat(24)].join('');
const route = (lock: unknown = null) => ({ effective: 'PREFER_IN_CLOUD', source: 'run', runDefault: 'PREFER_IN_CLOUD', override: null, overrideRevision: 0, lock, suggestion: null, lastObserved: null }) as never;

const POINTS = ['Posts are public.', 'Newest first.', 'Votes are one per person.', 'Use Postgres.', 'No email.', 'Sign in with Google.', 'Admins can hide posts.'].join('\n');
const UNSURE = ['Do boards need moderation?', 'Is sort by votes usual?', 'How many posts a day?'].join('\n');
const fullOutput = {
  goal: 'A public feedback board.',
  items: POINTS.split('\n').slice(0, 6).map((t, i) => ({ id: `P${i + 1}`, text: t, kind: 'requirement', checkable: i === 0, source: 'points' })),
  uncertainties: UNSURE.split('\n').map((q, i) => ({ id: `U${i + 1}`, question: q })),
  omitted: [{ reason: 'private' }],
};

describe('the plan brief: completeness (H13 amendment B)', () => {
  it('given 7 points and 3 questions, the brief accounts for all 10 (items, questions and omitted)', () => {
    const inCount = briefInCount(POINTS, UNSURE);
    expect(inCount).toEqual({ points: 7, unsure: 3 });
    const d = briefFromOutput(fullOutput, 'internal', inCount);
    const c = completeness(d);
    expect(c).toMatchObject({ ok: true, missing: 0 });
    expect(c.line).toBe('7 points and 3 questions in, 6 items + 3 questions + 1 omitted out');
  });

  it('a model that drops one shows the warning, and adding the missing one by hand settles it', () => {
    const dropped = { ...fullOutput, omitted: [] };
    const d = briefFromOutput(dropped, 'internal', briefInCount(POINTS, UNSURE));
    const c = completeness(d);
    expect(c.ok).toBe(false);
    expect(c.missing).toBe(1);
    expect(c.warning).toMatch(/1 of what you gave is not in this brief/);
    const fixed = addItem(d, 'Admins can hide posts.', 'requirement');
    expect('draft' in fixed && completeness(fixed.draft).ok).toBe(true);
  });

  it('an item with a secret-shaped string is dropped and counted as omitted (private), so the count still adds up', () => {
    const out = { ...fullOutput, items: [...fullOutput.items.slice(0, 5), { id: 'P6', text: `Token ${FAKE_TOKEN} works.`, kind: 'fact', checkable: true, source: 'points' }] };
    const d = briefFromOutput(out, 'internal', briefInCount(POINTS, UNSURE));
    expect(d.items.map((x) => x.id)).not.toContain('P6');
    expect(JSON.stringify(d)).not.toContain(FAKE_TOKEN);
    expect(d.omitted.filter((o) => o.reason === 'private')).toHaveLength(2);
    expect(completeness(d).ok).toBe(true);
  });
});

describe('the plan brief: review and approval (H13 amendment C)', () => {
  const d0 = briefFromOutput(fullOutput, 'internal', briefInCount(POINTS, UNSURE));

  it('everything is ticked by default; restricted input can never be ticked', () => {
    expect(d0.items.every((x) => x.ticked)).toBe(true);
    const r = briefFromOutput(fullOutput, 'restricted', briefInCount(POINTS, UNSURE));
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
  });
});

describe('the cloud check\'s results and the plan (H13 amendment D, E)', () => {
  const a = approveBrief(briefFromOutput(fullOutput, 'internal', briefInCount(POINTS, UNSURE)));

  it('only https sources are kept, as text links', () => {
    const r = screenCheck('pmVerify', { items: [{ id: 'P1', verdict: 'supported', explanation: 'e', sources: [{ title: 'ok', url: 'https://example.org/a' }, { title: 'js', url: 'javascript:alert(1)' }, { title: 'http', url: 'http://example.org' }] }], uncertainties: [] });
    expect(r.items[0]!.sources).toEqual([{ title: 'ok', url: 'https://example.org/a' }]);
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
    const d = emptyBrief('internal', briefInCount(POINTS, UNSURE));
    expect(completeness(d)).toMatchObject({ ok: false, missing: 10 });
  });
});
