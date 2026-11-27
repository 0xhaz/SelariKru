import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { PLAN_BRIEF_ITEM_KINDS, stopReasonFor } from '@selarikru/domain';
import type { PlanBriefForPlan } from '@selarikru/inference-firebase-web';
import { Chip, buttonPrimary, buttonQuiet } from '@selarikru/ui';
import type { TaskView } from '@selarikru/view-protocol';
import { EMPTY_CHECKPOINT_STORE } from '../checkpoints/engine.ts';
import { STOP_TEXT } from '../checkpoints/model.ts';
import type { useHybrid } from '../hybrid/context.tsx';
import { refusalText } from '../hybrid/model.ts';
import { settingsHref } from '../../shell/views.ts';
import {
  addItem, addQuestion, approveBrief, briefFromOutput, briefInLines, briefPayload, cloudRefusal, completeness, conversationNotes, editItem, editQuestion, emptyBrief, latestNotes, NOTES_LIMITS,
  notesCheckpoint, notesLabel, planBriefFor, removeItem, restrictBrief, briefCheckpoint, latestBrief, type CitedSource, removeQuestion, screenCheck, setGoal, setItemKind, toggleGoal, toggleItem, toggleQuestion, type BriefDraft, type ItemKind,
} from './brief.ts';
import { EMPTY_RUN_BRIEF, briefKey, checkFailureText, pmBrief, type RunBrief } from './brief-store.ts';
import { pmRefusal } from './copy.ts';
import type { BriefCheckKind } from './runner.ts';
import { SearchSuggestions } from './SearchSuggestions.tsx';

/**
 * H13: the PM panel's Plan brief. The owner's points and open questions, formatted on this device by Gemini Nano (never in the cloud), checked and corrected by the
 * owner, approved (frozen by hash), checked in the cloud, then made into the plan. Exactly what leaves the device is on screen, ticked, before it goes.
 */
type Hybrid = NonNullable<ReturnType<typeof useHybrid>>;

const SPLIT = 'Gemini Nano formats your points privately on this device; it can\'t search the web. Gemini in the cloud checks each point you approve, answers your questions, then drafts the architecture and plan.';
const ONLY_TICKED = 'Only the ticked goal, items and questions below are sent to Gemini in the cloud. Nothing else from this project is sent.';
const EDIT_ERROR: Readonly<Record<string, string>> = {
  too_long: 'At most 280 characters.', secret: 'That looks like a credential, so it is not kept. Take it out first.', empty: 'Write something first, or delete it.', full: 'The brief is full: at most 20 items and 10 questions.',
};
const VERDICT: Readonly<Record<string, { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }>> = {
  supported: { label: 'Supported', tone: 'success' }, contradicted: { label: 'Contradicted', tone: 'danger' }, unclear: { label: 'Unclear', tone: 'warning' }, not_checkable: { label: 'Not a fact to check', tone: 'neutral' },
  consistent: { label: 'Consistent', tone: 'success' }, inconsistent: { label: 'Inconsistent', tone: 'danger' },
};
const say = (code: string): string => pmRefusal(code);

export function PlanBrief({ h, runId, subjectId, task, deviceOnly, researchGranted, conversation, busy, onMakePlan }: {
  h: Hybrid; runId: string; subjectId: string; task: TaskView | undefined; deviceOnly: boolean; researchGranted: boolean;
  conversation: () => readonly { readonly who: 'owner' | 'pm'; readonly text: string; readonly restricted: boolean }[];
  busy: boolean; onMakePlan: (brief: PlanBriefForPlan) => Promise<void>;
}) {
  const id = useId();
  // Fix round 1 (H3): the notes belong to this run and subject task; switching the subject shows that task's own notes.
  const key = briefKey(runId, subjectId);
  const r: RunBrief = pmBrief((s) => s.runs[key]) ?? EMPTY_RUN_BRIEF;
  const set = (fn: (x: RunBrief) => Partial<RunBrief>) => pmBrief.getState().set(key, fn);
  const kept = useStore(h.checkpoints?.store ?? EMPTY_CHECKPOINT_STORE, (s) => s.checkpoints);
  const saved = useMemo(() => latestNotes(kept, h.snapshot, runId, subjectId), [kept, h.snapshot, runId, subjectId]);
  const locked = task?.route?.lock !== null && task?.route?.lock !== undefined;
  const label = notesLabel(task, r.marked, r.restrictedTurns);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // The notes, once: as kept (re-judged by the subject's lock now), else the demo's sample notes.
  const started = pmBrief((s) => s.runs[key] !== undefined);
  useEffect(() => {
    if (started) return;
    // Fix round 1 (I3): the reviewed brief and its approval come back too.
    const draft = latestBrief(kept, h.snapshot, runId, subjectId, saved);
    if (saved) set(() => ({ points: saved.points, unsure: saved.unsure, marked: saved.label === 'restricted', ...(draft ? { draft } : {}) }));
    else if (h.agents?.simulated && h.agents.planBriefSample) { const demo = h.agents.planBriefSample; set(() => ({ points: demo.points, unsure: demo.unsure })); }
  }, [started, saved, key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Fix round 1 (H3): a restriction from the subject's lock is the notes' own from then on: it stays, whatever the subject's route says later.
  useEffect(() => { if (locked && !r.marked) set(() => ({ marked: true })); }, [locked, r.marked, key]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Kept as a checkpoint under the H12 split. Fix round 1 (H2): while typed (on blur) they stay on this device only; Save notes and Format store them with the
   * server too, once their label is settled. Restricted notes are only ever on this device, and a server copy made before is deleted.
   */
  const keepNotes = async (server: boolean, x: RunBrief = pmBrief.getState().runs[key] ?? EMPTY_RUN_BRIEF): Promise<void> => {
    const s = h.snapshot;
    if (!h.checkpoints || !s || !subjectId || (!x.points.trim() && !x.unsure.trim())) return;
    const at = new Date().toISOString();
    await h.checkpoints.keep(notesCheckpoint({ projectId: h.projectId, runId, taskId: subjectId, taskRevision: s.tasks[subjectId]?.revision ?? 1, planRevision: s.runs[runId]?.planRevision ?? null, points: x.points, unsure: x.unsure, label: notesLabel(task, x.marked, x.restrictedTurns), at }), { server });
  };
  // Fix round 1 (I3): the reviewed brief, with its approval, is kept under the same split as the notes, so a reload keeps it and a paused check can still be sent.
  useEffect(() => {
    const s = h.snapshot;
    if (!r.draft || !h.checkpoints || !s || !subjectId) return;
    void h.checkpoints.keep(briefCheckpoint({ projectId: h.projectId, runId, taskId: subjectId, taskRevision: s.tasks[subjectId]?.revision ?? 1, planRevision: s.runs[runId]?.planRevision ?? null, draft: r.draft, at: new Date().toISOString() }), { server: true });
  }, [r.draft]); // eslint-disable-line react-hooks/exhaustive-deps
  // Fix round 1 (H2): the moment the notes become restricted, they are kept as such, and a server copy is deleted.
  // The brief made from them is restricted too: nothing in it is ticked or approved, so it can never be checked in the cloud.
  useEffect(() => {
    if (label !== 'restricted') return;
    void keepNotes(true);
    // Fix round 2 (N1): and every check made from them, paused or done, stays on this device only; its server copy is deleted.
    void h.checkpoints?.restrictBriefChecks(runId, subjectId);
    const d = pmBrief.getState().runs[key]?.draft;
    if (d && d.label !== 'restricted') set(() => ({ draft: restrictBrief(d), check: null }));
  }, [label, key]); // eslint-disable-line react-hooks/exhaustive-deps

  async function format(): Promise<void> {
    if (!h.agents) return;
    await keepNotes(true);
    setError(null);
    const inCount = briefInLines(r.points, r.unsure);
    set(() => ({ format: { status: 'running' }, check: null }));
    const out = await h.agents.pm({ kind: 'pmBrief', subjectTaskId: subjectId, question: '', questionClassification: label, history: [], callOverride: null, notes: { points: r.points, unsure: r.unsure } });
    if (out.kind === 'refused') { set(() => ({ format: { status: 'failed', message: say(out.code) } })); return; }
    const p = out.result.proposal;
    if (p.status === 'ok') {
      set(() => ({ draft: briefFromOutput(p.data, out.result.locked ? 'restricted' : label, inCount), format: { status: 'done', simulated: out.simulated, locked: out.result.locked } }));
    } else if (p.status === 'blocked' && (p.blockedReason ?? '').startsWith('device_')) {
      // Nano is not available: never a cloud fallback. The owner writes the brief by hand.
      set((x) => ({ format: { status: 'unavailable', reason: refusalText(p.blockedReason) }, draft: x.draft ?? emptyBrief(label, inCount) }));
    } else {
      set(() => ({ format: { status: 'failed', message: p.status === 'invalid' ? 'The device model\'s brief did not pass its checks. Try again, or write the brief by hand.' : say(p.blockedReason ?? p.status) } }));
    }
  }

  async function check(kind: BriefCheckKind): Promise<void> {
    const d = r.draft;
    if (!h.agents || !d || d.approvedSha256 === null) return;
    const sha = d.approvedSha256;
    set(() => ({ check: { kind, status: 'running' } }));
    const out = await h.agents.pm({ kind, subjectTaskId: subjectId, question: '', questionClassification: d.label, history: [], callOverride: null, brief: briefPayload(d), briefSha256: sha });
    if (out.kind === 'refused') { set(() => ({ check: { kind, status: 'failed', message: say(out.code) } })); return; }
    const p = out.result.proposal;
    if (p.status === 'ok') { set(() => ({ check: { kind, status: 'done', result: screenCheck(kind, p.data, out.result.grounding ?? null), grounding: out.result.grounding ?? null, briefSha256: sha, simulated: out.simulated, resumed: false } })); return; }
    const stop = stopReasonFor(p.blockedReason);
    if (stop) { set(() => ({ check: { kind, status: 'paused', reason: STOP_TEXT[stop] } })); return; }
    set(() => ({ check: { kind, status: 'failed', message: checkFailureText(p) } }));
  }

  const d = r.draft;
  const count = d ? completeness(d) : null;
  const refusal = cloudRefusal(d);
  const checkBlock = !d ? null : d.label === 'restricted' ? say('brief_restricted') : locked ? say('verify_locked') : deviceOnly ? say('verify_device_only') : refusal ? say(refusal) : null;
  const usable = r.check?.status === 'done' && d?.approvedSha256 === r.check.briefSha256 && refusal === null ? r.check : null;
  const editDraft = (fn: (x: BriefDraft) => BriefDraft | { draft: BriefDraft } | { error: string }): void => {
    if (!d) return;
    const out = fn(d);
    if ('error' in out) { setError(EDIT_ERROR[out.error] ?? out.error); return; }
    setError(null);
    set(() => ({ draft: 'draft' in out ? out.draft : out }));
  };

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3 rounded-card border border-line bg-panel p-3" data-testid="pm-brief">
      <div>
        <h2 id={`${id}-h`} className="text-lg font-semibold">Plan brief</h2>
        <p className="mt-1 max-w-prose text-sm text-muted" data-testid="pm-brief-split">{SPLIT}</p>
        {h.agents?.simulated ? <p className="mt-1 text-sm font-medium text-warning">Demo data: the brief, its checks and the plan are simulated. They are never evidence.</p> : null}
      </div>
      <label className="flex items-start gap-2 text-sm text-fg"><input type="checkbox" className="mt-0.5" data-testid="pm-brief-restricted" checked={r.marked || locked} disabled={locked || r.marked}
        onChange={(e) => { set(() => ({ marked: e.target.checked })); }} /><span>These notes are restricted: keep them, and the brief made from them, on this device only. Tick this before you write anything restricted. Once restricted, notes stay restricted.</span></label>
      <label className="block text-sm">
        <span className="font-medium text-fg">Your points</span>
        <span className="block text-muted">Requirements, decisions, constraints and facts: one per line, or free text.</span>
        <textarea className="mt-1 block w-full rounded-chip border border-line-strong bg-bg p-2 text-fg" rows={5} maxLength={NOTES_LIMITS.pointsChars} value={r.points} data-testid="pm-brief-points"
          onChange={(e) => { set(() => ({ points: e.target.value })); setSavedNote(null); }} onBlur={() => void keepNotes(false)} />
      </label>
      <label className="block text-sm">
        <span className="font-medium text-fg">What you&apos;re unsure about</span>
        <span className="block text-muted">Open questions, one per line.</span>
        <textarea className="mt-1 block w-full rounded-chip border border-line-strong bg-bg p-2 text-fg" rows={3} maxLength={NOTES_LIMITS.unsureChars} value={r.unsure} data-testid="pm-brief-unsure"
          onChange={(e) => { set(() => ({ unsure: e.target.value })); setSavedNote(null); }} onBlur={() => void keepNotes(false)} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonQuiet} data-testid="pm-brief-add-conversation" disabled={conversation().length === 0}
          onClick={() => { const c = conversationNotes(conversation()); set((x) => ({ points: `${x.points.trimEnd()}${x.points.trim() ? '\n' : ''}${c.text}`.slice(0, NOTES_LIMITS.pointsChars), restrictedTurns: x.restrictedTurns || c.restricted })); void keepNotes(false); }}>
          Add this conversation
        </button>
        <button type="button" className={buttonQuiet} data-testid="pm-brief-save" disabled={!r.points.trim() && !r.unsure.trim()} onClick={() => { void keepNotes(true).then(() => setSavedNote(label === 'restricted' ? 'Saved on this device only.' : 'Saved on this device and by the server.')); }}>Save notes</button>
        {savedNote ? <span role="status" className="text-sm text-fg" data-testid="pm-brief-saved">{savedNote}</span> : null}
      </div>
      <p className="text-sm text-fg" data-testid="pm-brief-label">
        Label: <b>{label}</b>. {label === 'restricted'
          ? `Kept only on this device, and the brief made from them is never sent to the cloud${locked ? ': this task reads restricted data' : r.restrictedTurns ? ': they hold a restricted turn' : ''}.`
          : 'Kept on this device while you type; Save notes or Format also stores them with the server, like the Project Manager\'s turns.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonPrimary} data-testid="pm-brief-format" disabled={!h.agents || busy || r.format?.status === 'running' || (!r.points.trim() && !r.unsure.trim())} onClick={() => void format()}>Format on this device</button>
        {!d ? <button type="button" className={buttonQuiet} data-testid="pm-brief-manual" onClick={() => set(() => ({ draft: emptyBrief(label, briefInLines(r.points, r.unsure)) }))}>Write the brief by hand</button> : null}
      </div>
      {r.format?.status === 'running' ? <p role="status" className="text-sm text-fg">Gemini Nano is formatting your points on this device.</p> : null}
      {r.format?.status === 'unavailable' ? <p className="text-sm text-warning" data-testid="pm-brief-unavailable">Gemini Nano is not available on this device, so the brief was not formatted. {r.format.reason} Nothing was sent to the cloud: it never formats your notes there. Write the brief by hand below.</p> : null}
      {r.format?.status === 'failed' ? <p className="text-sm text-danger" data-testid="pm-brief-failed">{r.format.message}</p> : null}

      {d ? (
        <div className="space-y-3 border-t border-line pt-3" data-testid="pm-brief-review">
          <div className="flex flex-wrap items-center gap-2">
            {r.format?.status === 'done' ? <><Chip tone="success">Formatted on this device</Chip>{r.format.simulated ? <span className="rounded-chip bg-warning px-1.5 py-0.5 text-sm font-semibold text-bg">Demo data</span> : null}</> : <Chip tone="neutral">Written by hand</Chip>}
            {d.label === 'restricted' ? <Chip tone="warning">Restricted: stays on this device</Chip> : null}
          </div>
          {count ? <p className="text-sm text-fg" data-testid="pm-brief-count">{count.line}</p> : null}
          {count?.warning ? <p className="text-sm text-warning" data-testid="pm-brief-warning">{count.warning}</p> : null}
          {count && count.missingLines.length > 0 ? (
            <ul className="space-y-1 text-sm" data-testid="pm-brief-missing">{count.missingLines.map((l) => (
              <li key={l.n} className="flex flex-wrap items-center gap-2"><span className="text-fg">Line {l.n}: {l.text}</span>
                <button type="button" className={buttonQuiet} data-testid="pm-brief-add-missing" onClick={() => editDraft((y) => l.list === 'points' ? addItem(y, l.text.slice(0, 280), 'requirement', [l.n]) : addQuestion(y, l.text.slice(0, 280), [l.n]))}>Add line {l.n}</button></li>
            ))}</ul>
          ) : null}
          <p className="text-sm font-medium text-fg" data-testid="pm-brief-only-ticked">{ONLY_TICKED}</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-2" aria-label="Send the goal" checked={d.goalTicked} disabled={d.label === 'restricted'} onChange={() => editDraft(toggleGoal)} />
            <span className="flex-1"><span className="font-medium text-fg">Goal</span>
              <EditableText value={d.goal} testId="pm-brief-goal" onSave={(v) => editDraft((x) => setGoal(x, v))} /></span>
          </label>
          <div>
            <h3 className="text-sm font-medium text-fg">Items</h3>
            <ul className="mt-1 space-y-1" data-testid="pm-brief-items">
              {d.items.map((x) => (
                <li key={x.id} className="flex flex-wrap items-start gap-2 text-sm" data-testid="pm-brief-item" data-id={x.id} data-ticked={x.ticked ? 'true' : 'false'}>
                  <input type="checkbox" className="mt-2" aria-label={`Send ${x.id}`} data-testid="pm-brief-item-tick" checked={x.ticked} disabled={x.restricted} onChange={() => editDraft((y) => toggleItem(y, x.id))} />
                  <span className="mt-1.5 font-mono text-mono">{x.id}</span>
                  <select aria-label={`Kind of ${x.id}`} className="rounded-chip border border-line-strong bg-bg px-1 py-1 text-fg" value={x.kind} onChange={(e) => editDraft((y) => setItemKind(y, x.id, e.target.value as ItemKind))}>
                    {PLAN_BRIEF_ITEM_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                  <span className="min-w-0 flex-1"><EditableText value={x.text} testId="pm-brief-item-text" onSave={(v) => editDraft((y) => editItem(y, x.id, v))} />
                    {x.source === 'conversation' ? <span className="block text-muted">From this conversation.</span> : x.source === 'manual' ? <span className="block text-muted">Added by you.</span> : null}
                    {x.restricted ? <span className="block text-warning">From restricted notes: it stays on this device and cannot be ticked.</span> : null}</span>
                  <button type="button" className={buttonQuiet} aria-label={`Delete ${x.id}`} data-testid="pm-brief-item-delete" onClick={() => editDraft((y) => removeItem(y, x.id))}>Delete</button>
                </li>
              ))}
            </ul>
            <AddRow label="Add an item" testId="pm-brief-add-item" kinds onAdd={(text, kind) => editDraft((y) => addItem(y, text, kind ?? 'requirement'))} />
          </div>
          <div>
            <h3 className="text-sm font-medium text-fg">Questions</h3>
            <ul className="mt-1 space-y-1" data-testid="pm-brief-questions">
              {d.uncertainties.map((x) => (
                <li key={x.id} className="flex flex-wrap items-start gap-2 text-sm" data-testid="pm-brief-question" data-id={x.id}>
                  <input type="checkbox" className="mt-2" aria-label={`Send ${x.id}`} checked={x.ticked} disabled={x.restricted} onChange={() => editDraft((y) => toggleQuestion(y, x.id))} />
                  <span className="mt-1.5 font-mono text-mono">{x.id}</span>
                  <span className="min-w-0 flex-1"><EditableText value={x.question} testId="pm-brief-question-text" onSave={(v) => editDraft((y) => editQuestion(y, x.id, v))} />
                    {x.restricted ? <span className="block text-warning">From restricted notes: it stays on this device and cannot be ticked.</span> : null}</span>
                  <button type="button" className={buttonQuiet} aria-label={`Delete ${x.id}`} onClick={() => editDraft((y) => removeQuestion(y, x.id))}>Delete</button>
                </li>
              ))}
            </ul>
            <AddRow label="Add a question" testId="pm-brief-add-question" onAdd={(text) => editDraft((y) => addQuestion(y, text))} />
          </div>
          {error ? <p role="alert" className="text-sm text-danger" data-testid="pm-brief-edit-error">{error}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={buttonPrimary} data-testid="pm-brief-approve" disabled={d.label === 'restricted' || refusal === null} onClick={() => set((x) => ({ draft: x.draft ? approveBrief(x.draft) : null }))}>Approve brief</button>
            {refusal === null ? <p className="text-sm text-fg" data-testid="pm-brief-approved">Approved. Any edit un-approves it.</p> : d.approvedSha256 === null && d.label !== 'restricted' ? <p className="text-sm text-muted">Not approved yet.</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={buttonPrimary} data-testid="pm-brief-check" disabled={checkBlock !== null || !researchGranted || busy || r.check?.status === 'running'} title={checkBlock ?? (!researchGranted ? say('research_not_granted') : 'Gemini in the cloud, with Grounding with Google Search')} onClick={() => void check('pmVerify')}>Check in the cloud</button>
            {!researchGranted ? <button type="button" className={buttonQuiet} data-testid="pm-brief-check-noweb" disabled={checkBlock !== null || busy || r.check?.status === 'running'} onClick={() => void check('pmVerifyNoWeb')}>Check without web search</button> : null}
          </div>
          {checkBlock ? <p className="text-sm text-muted" data-testid="pm-brief-check-blocked">{checkBlock}</p> : null}
          {!researchGranted ? <p className="text-sm text-muted" data-testid="pm-brief-research-off">Web research is off for this run, so the check with Google Search is not offered. To allow it, turn on &quot;Google Search (web research)&quot; in <a className="text-active underline underline-offset-2" href={settingsHref('workflow')}>Settings › Workflow</a>. Check without web search is still a cloud call: its result is not checked against the web.</p> : null}
          {r.check?.status === 'running' ? <p role="status" className="text-sm text-fg">Gemini in the cloud is checking the brief.</p> : null}
          {r.check?.status === 'paused' ? <p role="status" className="text-sm text-warning" data-testid="pm-brief-paused">{r.check.reason}. The check is kept as paused work and is sent once it can be, if the approved brief is unchanged.</p> : null}
          {r.check?.status === 'failed' ? <p className="text-sm text-danger" data-testid="pm-brief-check-failed">{r.check.message}</p> : null}
          {r.check?.status === 'done' ? <CheckResults check={r.check} draft={d} /> : null}
          {usable ? (
            <div className="space-y-1">
              <button type="button" className={buttonPrimary} data-testid="pm-brief-make-plan" disabled={busy} onClick={() => void onMakePlan(planBriefFor(d, usable.result))}>Make the plan from this brief</button>
              <p className="text-sm text-muted">Draft a plan reads the approved brief with each verdict and answer. Contradicted items are flagged so it does not build on them; unclear ones are listed as risks.</p>
            </div>
          ) : r.check?.status === 'done' ? <p className="text-sm text-muted">The brief changed after this check. Approve it and check it again to make the plan from it.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function CheckResults({ check, draft }: { check: Extract<RunBrief['check'], { status: 'done' }>; draft: BriefDraft }) {
  const r = check.result;
  const textOf = (id: string) => draft.items.find((x) => x.id === id)?.text ?? id;
  const questionOf = (id: string) => draft.uncertainties.find((x) => x.id === id)?.question ?? id;
  // Fix round 1 (I2): a cited source is a live link only when the search itself returned its site; otherwise it is text, marked as the model's own citation.
  const Sources = ({ list }: { list: readonly CitedSource[] }) => list.length === 0 ? null : (
    <ul className="mt-0.5 text-sm">{list.map((s) => s.matched
      ? <li key={s.url} data-testid="pm-brief-source" data-matched="true"><a className="text-active underline underline-offset-2" href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a> <span className="text-muted">({new URL(s.url).host})</span></li>
      : <li key={s.url} data-testid="pm-brief-source" data-matched="false"><span className="text-fg">{s.title}</span> <span className="text-muted">({new URL(s.url).host}). Cited by the model, not from the search results.</span></li>)}</ul>
  );
  return (
    <div className="space-y-2 rounded-card border border-line-strong p-3" data-testid="pm-brief-results">
      <div className="flex flex-wrap items-center gap-2">
        {check.simulated ? <span className="rounded-chip bg-warning px-1.5 py-0.5 text-sm font-semibold text-bg">Demo data</span> : null}
        <Chip tone="active">Checked in the cloud</Chip>
        <span className="text-sm font-medium text-fg" data-testid="pm-brief-results-source">{r.checked === 'web' ? 'From web research' : 'Not checked against the web'}</span>
        {check.resumed ? <Chip tone="neutral">Sent after reconnecting</Chip> : null}
      </div>
      <ul className="space-y-1.5">{r.items.map((x) => {
        const v = VERDICT[x.verdict] ?? { label: x.verdict, tone: 'neutral' as const };
        return <li key={x.id} className="text-sm" data-testid="pm-brief-verdict" data-verdict={x.verdict}><span className="font-mono text-mono">{x.id}</span> {textOf(x.id)} <Chip tone={v.tone}>{v.label}</Chip><span className="block text-muted">{x.explanation}</span><Sources list={x.sources} /></li>;
      })}</ul>
      {r.uncertainties.length > 0 ? (
        <ul className="space-y-1.5 border-t border-line pt-2">{r.uncertainties.map((x) => (
          <li key={x.id} className="text-sm" data-testid="pm-brief-answer"><span className="font-mono text-mono">{x.id}</span> <span className="font-medium">{questionOf(x.id)}</span><span className="block text-fg">{x.answer} <span className="text-muted">({x.confidence} confidence)</span></span><Sources list={x.sources} /></li>
        ))}</ul>
      ) : null}
      {r.checked === 'web' ? (
        <div className="text-sm" data-testid="pm-brief-web-sources">
          <h3 className="font-medium text-fg">Web sources from the search</h3>
          {check.grounding && check.grounding.sources.length > 0 ? <ul>{check.grounding.sources.filter((s) => { try { return new URL(s.uri).protocol === 'https:'; } catch { return false; } }).map((s) => <li key={s.uri}><a className="text-active underline underline-offset-2" href={s.uri} target="_blank" rel="noopener noreferrer">{s.title ?? s.uri}</a></li>)}</ul>
            : <p className="text-muted">No web sources came back from the search itself.</p>}
          {check.grounding?.entryPointHtml ? <SearchSuggestions html={check.grounding.entryPointHtml} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Text shown as is, with Edit: a field with Save and Cancel. A refused save keeps the field open with the reason shown above. */
function EditableText({ value, testId, onSave }: { value: string; testId: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing !== null) field.current?.focus(); }, [editing !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  if (editing === null) {
    return <span className="flex items-start gap-2"><span className="mt-1.5 flex-1 text-fg" data-testid={testId}>{value || <span className="text-muted">(none)</span>}</span><button type="button" className={buttonQuiet} data-testid={`${testId}-edit`} onClick={() => setEditing(value)}>Edit</button></span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input ref={field} className="min-w-0 flex-1 rounded-chip border border-line-strong bg-bg px-2 py-1 text-fg" maxLength={281} value={editing} data-testid={`${testId}-input`} onChange={(e) => setEditing(e.target.value)} />
      <button type="button" className={buttonPrimary} data-testid={`${testId}-save`} onClick={() => { onSave(editing); setEditing(null); }}>Save</button>
      <button type="button" className={buttonQuiet} onClick={() => setEditing(null)}>Cancel</button>
    </span>
  );
}

function AddRow({ label, testId, kinds, onAdd }: { label: string; testId: string; kinds?: boolean; onAdd: (text: string, kind?: ItemKind) => void }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ItemKind>('requirement');
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
      <input className="min-w-0 flex-1 rounded-chip border border-line-strong bg-bg px-2 py-1 text-fg" aria-label={label} placeholder={label} maxLength={281} value={text} data-testid={`${testId}-text`} onChange={(e) => setText(e.target.value)} />
      {kinds ? <select aria-label="Kind" className="rounded-chip border border-line-strong bg-bg px-1 py-1 text-fg" value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>{PLAN_BRIEF_ITEM_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select> : null}
      <button type="button" className={buttonQuiet} data-testid={testId} disabled={!text.trim()} onClick={() => { onAdd(text, kind); setText(''); }}>Add</button>
    </div>
  );
}
