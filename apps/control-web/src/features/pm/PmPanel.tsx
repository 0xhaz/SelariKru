import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { create } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { BrowserInputs } from '../hybrid/model.ts';
import { EMPTY_CHECKPOINT_STORE } from '../checkpoints/engine.ts';
import { planRouteProposals, routeTargets, type ShownRoute } from './routes.ts';
import { rememberedTurns } from './memory.ts';
import { modeLabel } from '../hybrid/model.ts';
import type { RoutePolicyMode } from '@selarikru/domain';
import { pmReplyTurn, type PmTurn } from '@selarikru/inference-firebase-web';
import { Chip, buttonPrimary, buttonQuiet } from '@selarikru/ui';
import { DataSourceException, type DelegationReceipt, type ProjectViewSnapshot } from '@selarikru/view-protocol';
import { sendCommand, useHybrid } from '../hybrid/context.tsx';
import { PERSON_ACCEPTS, observedChip, proposalAttribution, stepRoute } from '../hybrid/model.ts';
import { hrefFor } from '../../shell/route.ts';
import { settingsHref } from '../../shell/views.ts';
import { pmRefusal } from './copy.ts';
import { pmProposals } from './proposals.ts';
import { sanitizeSuggestions } from './suggestions.ts';
import { workerIdentity } from '../team/identity.ts';
import { currentRun } from '../settings/model.ts';
import { delegationAssignments, ownerTurnLabelAfter, planScopeFor, questionLabelFor, webResearchGranted, type PmKind, type PmOutcome } from './runner.ts';

/**
 * H11: Talk to the Project Manager. One single-turn Firebase AI Logic call per question, about one task of the run (its route, lock and context apply), with a
 * bounded and label-filtered part of this conversation. H12: each turn is also a checkpoint (the PM's memory), under the storage split: a restricted turn is kept only
 * in this browser, never on the server.
 * Every reply is a proposal until accepted; the PM's assignments apply on their own only inside the accepted plan, and only while auto-delegation is on.
 */
type Reply = {
  readonly kind: PmKind; readonly subjectTaskId: string; readonly outcome: PmOutcome & { readonly simulated: boolean }; readonly delegation?: DelegationReceipt | { readonly error: string };
  /** I4: where accepting this plan stands. */
  readonly accepted?: { readonly planRevision: number } | { readonly error: string } | 'sending' | undefined;
  /** H12: the routes set with the accepted plan: how many were set, and how many were refused. */
  readonly routes?: { readonly set: number; readonly refused: number };
  /** Fix round 1 (I5): the route proposals as shown, computed once when the reply arrived; Accept writes exactly these. */
  readonly routeProposals?: readonly ShownRoute[];
};
type NewTurn = { readonly who: 'owner'; readonly text: string; readonly restricted: boolean; readonly kind: PmKind } | { readonly who: 'pm'; readonly reply: Reply };
type Turn = NewTurn & { readonly id: number };

interface PmStore {
  readonly turns: readonly Turn[];
  add(turn: NewTurn): number;
  update(id: number, reply: Reply): void;
  /** Fix round 2 (M-b): marks an owner turn restricted after the fact (its call came back locked). */
  restrict(id: number): void;
}
let seq = 1;
/** Kept for this tab's session only, in memory. */
export const pmConversation = create<PmStore>((set) => ({
  turns: [],
  add: (turn) => { const id = seq++; set((s) => ({ turns: [...s.turns, { ...turn, id } as Turn] })); return id; },
  update: (id, reply) => set((s) => ({ turns: s.turns.map((t) => (t.id === id && t.who === 'pm' ? { ...t, reply } : t)) })),
  restrict: (id) => set((s) => ({ turns: s.turns.map((t) => (t.id === id && t.who === 'owner' ? { ...t, restricted: true } : t)) })),
}));

const ASKS: readonly { kind: PmKind; label: string; what: string }[] = [
  { kind: 'pmAnswer', label: 'Ask', what: 'An answer from the project\'s own context, with its sources.' },
  { kind: 'pmResearch', label: 'Research the web', what: 'Cloud only, with Grounding with Google Search. Never for a locked (restricted) task.' },
  { kind: 'pmPlan', label: 'Draft a plan', what: 'A plan revision you can accept in the Assistant\'s replan step.' },
  { kind: 'pmDelegate', label: 'Propose assignments', what: 'Who takes each task of the accepted plan. Applied on their own only inside that plan.' },
];

const say = (code: string, name?: string): string => pmRefusal(code, name);

/** Search Suggestions from Grounding with Google Search, rendered as given (less anything that runs), in a shadow root so its styles stay its own (the terms require showing it). */
function SearchSuggestions({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    root.innerHTML = sanitizeSuggestions(html);
  }, [html]);
  return <div ref={host} data-testid="pm-search-suggestions" />;
}

function nameOf(snap: ProjectViewSnapshot | null, workerId: string): string {
  if (!snap) return workerId;
  const w = Object.values(snap.runs).length > 0 ? planScopeFor(snap, Object.values(snap.tasks).find((t) => t.delegation?.workerId === workerId)?.runId ?? Object.keys(snap.runs)[0]!).workers.find((x) => x.workerId === workerId) : undefined;
  return w ? workerIdentity(snap, workerId, w.role).label : workerId;
}

function ReplyView({ reply, snap, browser, onAcceptPlan }: { reply: Reply; snap: ProjectViewSnapshot | null; browser: BrowserInputs; onAcceptPlan?: (() => void) | null }) {
  const o = reply.outcome;
  if (o.kind === 'refused') return <p className="text-fg" data-testid="pm-refused">{say(o.code)}</p>;
  const p = o.result.proposal;
  const ok = p.status === 'ok';
  const chip = p.route ? observedChip({ ...p.route, observedSource: p.observedSource, status: p.status, blockedReason: p.blockedReason } as never) : { label: 'Where it ran was not recorded', tone: 'warning' as const, detail: null };
  const data = (p.data ?? {}) as Record<string, unknown>;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {o.simulated ? <span className="rounded-chip bg-warning px-1.5 py-0.5 text-sm font-semibold text-bg">Demo data</span> : null}
        <Chip tone={chip.tone}>{chip.label}</Chip>
        <Chip tone={ok ? 'success' : 'warning'}>{ok ? 'Passed its checks' : p.status === 'blocked' ? 'Did not run' : 'Not usable'}</Chip>
      </div>
      {!ok ? <p className="text-fg" data-testid="pm-refused">{say(p.blockedReason ?? p.status)}</p> : (
        <>
          <p className="text-sm text-fg" data-testid="pm-attribution"><span className="font-medium">{proposalAttribution(p.observedSource, p.route?.fellBack === true && p.route.conformance === 'conforms', o.simulated)}.</span> <span className="text-muted">{PERSON_ACCEPTS}</span></p>
          {typeof data['answer'] === 'string' ? <p className="whitespace-pre-wrap text-fg" data-testid="pm-answer">{data['answer']}</p> : null}
          {Array.isArray(data['citations']) && data['citations'].length > 0 ? (
            <ul className="text-sm text-muted" data-testid="pm-citations">{(data['citations'] as { sourceId: string; note: string }[]).map((c) => <li key={c.sourceId}>Source <span className="font-mono text-mono">{c.sourceId}</span>: {c.note}</li>)}</ul>
          ) : null}
          {Array.isArray(data['findings']) ? <ul className="list-disc pl-5 text-fg">{(data['findings'] as { point: string }[]).map((f, i) => <li key={i}>{f.point}</li>)}</ul> : null}
          {reply.kind === 'pmResearch' ? (
            <div data-testid="pm-web-sources" className="text-sm">
              {o.result.grounding && o.result.grounding.sources.length > 0 ? (
                <ul className="space-y-0.5">{o.result.grounding.sources.map((s) => <li key={s.uri}><a className="text-active underline underline-offset-2" href={s.uri} target="_blank" rel="noopener noreferrer">{s.title ?? s.uri}</a></li>)}</ul>
              ) : <p className="text-muted">No web sources came back with this answer.</p>}
              {o.result.grounding?.entryPointHtml ? <SearchSuggestions html={o.result.grounding.entryPointHtml} /> : null}
            </div>
          ) : null}
          {Array.isArray(data['tasks']) ? (
            <div>
              {(() => {
                const tasks = data['tasks'] as { key: string; title: string; role: string; revises?: string }[];
                // H12: where each task runs, proposed with its reason; accepted with the plan. The proposals were fixed when the reply arrived (fix round 1, I5).
                const routes = reply.routeProposals ?? [];
                return (
                  <ol className="list-decimal pl-5 text-fg">{tasks.map((t) => {
                    const r = routes.find((x) => x.key === t.key);
                    return (
                      <li key={t.key}>{t.title} <span className="text-sm text-muted">({t.role}{t.revises ? `; revises ${snap?.tasks[t.revises]?.title ?? t.revises}` : '; new task'})</span>
                        {r ? <span className="block text-sm text-fg" data-testid="pm-plan-route" data-mode={r.mode} data-locked={r.locked ? "true" : "false"}>Runs on: {modeLabel(r.mode)}{r.locked ? ' (fixed)' : ''} ({r.change}). <span className="text-muted">{r.reason}</span></span> : null}
                      </li>
                    );
                  })}</ol>
                );
              })()}
              <p className="text-sm text-muted">Until you accept it, it changes nothing. Accepting records it as the next plan revision, and sets each task&apos;s route as proposed; the server checks the call it came from first.</p>
              {reply.accepted === undefined ? (
                o.result.locked ? <p className="text-sm text-muted" data-testid="pm-plan-locked">This plan came from restricted data. It stays on this device, so it cannot become the run\'s plan.</p>
                  : onAcceptPlan ? <button type="button" className={buttonPrimary} data-testid="pm-accept-plan" onClick={onAcceptPlan}>Accept plan</button>
                    : <p className="text-sm text-muted">Accept it through the replan step in the Assistant.</p>
              ) : reply.accepted === 'sending' ? <p role="status" className="text-sm text-fg">Accepting…</p>
                : 'error' in reply.accepted ? <p className="text-sm text-danger" data-testid="pm-plan-refused">{reply.accepted.error}</p>
                  : <p className="text-sm text-fg" data-testid="pm-plan-accepted">Accepted as plan rev {reply.accepted.planRevision}. The Project Manager assigns its tasks next, inside it.{reply.routes ? ` Routes set: ${reply.routes.set}${reply.routes.refused > 0 ? `, ${reply.routes.refused} not set` : ''}.` : ''}</p>}
            </div>
          ) : null}
          {Array.isArray(data['assignments']) ? <DelegationView reply={reply} snap={snap} /> : null}
        </>
      )}
    </div>
  );
}

function DelegationView({ reply, snap }: { reply: Reply; snap: ProjectViewSnapshot | null }) {
  const o = reply.outcome as Extract<PmOutcome, { kind: 'result' }>;
  const items = (o.result.proposal.data as { assignments: { taskId: string; workerId: string; why: string }[] }).assignments;
  const d = reply.delegation;
  const title = (taskId: string) => snap?.tasks[taskId]?.title ?? taskId;
  return (
    <div className="space-y-1" data-testid="pm-delegation">
      <ul className="space-y-0.5 text-fg">{items.map((a) => <li key={`${a.taskId}:${a.workerId}`}>{title(a.taskId)} → <b>{nameOf(snap, a.workerId)}</b> <span className="text-sm text-muted">{a.why}</span></li>)}</ul>
      {d === undefined ? <p className="text-sm text-muted">Applying inside the accepted plan…</p> : 'error' in d ? <p className="text-sm text-danger">{d.error}</p> : (
        <>
          {d.applied.map((a) => <p key={a.taskId} className="text-sm text-fg" data-testid="pm-applied">{title(a.taskId)}: assigned by the Project Manager under your accepted plan rev {o.planRevision}.</p>)}
          {d.refused.map((a) => <p key={`${a.taskId}:${a.workerId}`} className="text-sm text-warning" data-testid="pm-needs-you">{title(a.taskId)} → {nameOf(snap, a.workerId)}: not applied. {say(a.reason, nameOf(snap, a.workerId))} It waits for you in <a className="underline" href={hrefFor('actions')}>Action items</a>.</p>)}
          {d.simulated ? <p className="text-sm text-muted">Demo data: simulated, never evidence.</p> : null}
        </>
      )}
    </div>
  );
}

/**
 * H9 fix round 2: the panel's own "Draft a plan" action, offered to the guided tour while the panel can run it (it has the agents and a task to ask about).
 * Null: not ready. The tour calls this, so its question takes exactly the button's path: the same route, lock, history and checkpoint. True: a plan came back.
 */
export const pmPanelAction = createStore<{ askPlan: ((question: string) => Promise<boolean>) | null }>()(() => ({ askPlan: null }));

/** When this tab started: PM checkpoints from before it are remembered turns (H12 PM memory); later ones are already in this tab's conversation. */
const TAB_STARTED = new Date().toISOString();

export function PmPanel() {
  const h = useHybrid();
  const id = useId();
  const turns = pmConversation((s) => s.turns);
  // H12: the PM's memory. Its earlier turns are checkpoints under the same split (restricted ones only in this browser), read back here with their labels.
  const kept = useStore(h?.checkpoints?.store ?? EMPTY_CHECKPOINT_STORE, (s) => s.checkpoints);
  const remembered = useMemo(() => rememberedTurns(kept, h?.snapshot ?? null, TAB_STARTED), [kept, h?.snapshot]);
  const snap = h?.snapshot ?? null;
  const run = snap ? currentRun(snap) : null;
  const runTasks = snap && run ? Object.values(snap.tasks).filter((t) => t.runId === run.runId) : [];
  const [subject, setSubject] = useState<string>('');
  const subjectId = subject || runTasks[0]?.taskId || '';
  const task = subjectId && snap ? snap.tasks[subjectId] : undefined;
  const [question, setQuestion] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [override, setOverride] = useState<RoutePolicyMode | null>(null);
  const [busy, setBusy] = useState(false);
  const sr = task?.route ? stepRoute(task.route, override) : null;
  const offer = task?.route ? stepRoute(task.route, null).override : null;
  const locked = task?.route?.lock !== null && task?.route?.lock !== undefined;
  const deviceOnly = task?.route?.override === 'ONLY_ON_DEVICE';
  const researchGranted = webResearchGranted(snap, task?.runId ?? null);
  const autoDelegate = !(snap && run && snap.settings.some((x) => x.scope === 'run' && x.key === run.runId && x.field === 'auto_delegate' && x.desired === false));

  async function ask(kind: PmKind, asked: string = question): Promise<boolean> {
    if (!h?.agents || !subjectId) return false;
    const add = pmConversation.getState().add;
    // The history this call may carry: earlier turns with their labels. The catalog drops restricted ones from any cloud-capable call. A reply from a call that read
    // restricted text is itself restricted (`pmReplyTurn`), so its paraphrase never reaches the cloud either (fix round 1, H2).
    const history: PmTurn[] = [...remembered].concat(pmConversation.getState().turns.flatMap((t): PmTurn[] => t.who === 'owner' ? [{ who: 'owner', text: t.text, classification: t.restricted ? 'restricted' : 'internal' }]
      : t.reply.outcome.kind === 'result' && t.reply.outcome.result.proposal.status === 'ok' ? [pmReplyTurn(t.reply.outcome.result, String((t.reply.outcome.result.proposal.data as { answer?: unknown } | null)?.answer ?? ''))] : []));
    // A question about a locked task is restricted, whatever the checkbox says.
    const label = questionLabelFor(task, restricted);
    const ownerId = add({ who: 'owner', text: asked, restricted: label === 'restricted', kind });
    setBusy(true);
    try {
      const outcome = await h.agents.pm({ kind, subjectTaskId: subjectId, question: asked, questionClassification: label, history, callOverride: override });
      // The call came back locked (its route said so, whatever this tab's snapshot showed): the question was restricted, and is kept as such.
      if (ownerTurnLabelAfter(label, outcome) === 'restricted' && label !== 'restricted') pmConversation.getState().restrict(ownerId);
      // A plan's route proposals are computed once, here, and are what Accept writes (fix round 1, I5).
      const planTasks = kind === 'pmPlan' && outcome.kind === 'result' && outcome.result.proposal.status === 'ok' ? (outcome.result.proposal.data as { tasks?: { key: string; revises?: string }[] }).tasks : undefined;
      const routeProposals = planTasks ? planRouteProposals(planTasks, h.snapshot, outcome.kind === 'result' ? outcome.context?.task.classification ?? 'restricted' : 'restricted', h.browser, outcome.kind === 'result' ? outcome.runId : null) : undefined;
      const rid = add({ who: 'pm', reply: { kind, subjectTaskId: subjectId, outcome, ...(routeProposals ? { routeProposals } : {}) } });
      // H11: the PM's assignments apply on their own, inside the accepted plan only; the server re-checks them and refuses anything else, for you.
      if (kind === 'pmDelegate' && outcome.kind === 'result' && outcome.result.proposal.status === 'ok' && !h.agents.delegate) {
        pmConversation.getState().update(rid, { kind, subjectTaskId: subjectId, outcome, delegation: { error: 'This source cannot apply assignments, so they wait for you.' } });
      } else if (kind === 'pmDelegate' && outcome.kind === 'result' && outcome.result.proposal.status === 'ok' && !outcome.result.report) {
        pmConversation.getState().update(rid, { kind, subjectTaskId: subjectId, outcome, delegation: { error: 'Where this call ran was not recorded, so its assignments cannot be applied.' } });
      } else if (kind === 'pmDelegate' && outcome.kind === 'result' && outcome.result.proposal.status === 'ok' && outcome.result.report && h.agents.delegate) {
        // Without the reasons (fix round 2, M-c): the hash the call reported leaves them out, and the prose stays in this tab.
        const assignments = delegationAssignments((outcome.result.proposal.data as { assignments: Record<string, unknown>[] }).assignments);
        try {
          const receipt = await h.agents.delegate(outcome.runId, { planRevision: outcome.planRevision ?? 0, subjectTaskId: subjectId, routeRecordId: outcome.result.report.requestId, assignments });
          pmConversation.getState().update(rid, { kind, subjectTaskId: subjectId, outcome, delegation: receipt });
          // What was not applied waits for the owner in Action items (fix round 1, I3).
          if (receipt.refused.length > 0) pmProposals.getState().addRefused(outcome.runId, outcome.planRevision ?? 0, receipt.refused);
          h.refresh();
        } catch (e) {
          pmConversation.getState().update(rid, { kind, subjectTaskId: subjectId, outcome, delegation: { error: say(/^([a-z_]+):/.exec(e instanceof DataSourceException ? e.detail.message : e instanceof Error ? e.message : '')?.[1] ?? 'delegation_failed') } });
        }
      }
      setQuestion('');
      setOverride(null);
      return outcome.kind === 'result' && outcome.result.proposal.status === 'ok';
    } finally {
      setBusy(false);
    }
  }
  // H9 fix round 2: offered to the tour while it can run; withdrawn when the panel goes away.
  const askRef = useRef(ask);
  askRef.current = ask;
  const ready = Boolean(h?.agents && subjectId);
  useEffect(() => {
    if (!ready) return;
    pmPanelAction.setState({ askPlan: (q) => askRef.current('pmPlan', q) });
    return () => pmPanelAction.setState({ askPlan: null });
  }, [ready]);

  /** I4: accepts a Project Manager plan through the plan-revision path (the server judges the call first); then, with auto-delegation on, the PM assigns inside it. */
  async function acceptPlan(turnId: number, reply: Reply): Promise<void> {
    const o = reply.outcome;
    if (!h?.agents?.acceptPlan || o.kind !== 'result' || !o.result.report) return;
    const update = (accepted: Reply['accepted']) => pmConversation.getState().update(turnId, { ...reply, accepted });
    update('sending');
    try {
      const r = await h.agents.acceptPlan(o.runId, { expectedPlanRevision: o.planRevision ?? 0, subjectTaskId: reply.subjectTaskId, routeRecordId: o.result.report.requestId, plan: o.result.proposal.data as never, idempotencyKey: `pm-plan-${o.result.proposal.requestId}` });
      update({ planRevision: r.planRevision });
      h.refresh();
      // H12: the routes the PM proposed, accepted with the plan: each task's own route override, through the same owner write as the "Runs on" control.
      const tasks = (o.result.proposal.data as { tasks?: { key: string; revises?: string }[] }).tasks ?? [];
      const targets = routeTargets(tasks, reply.routeProposals ?? [], r.taskIds, h.snapshot);
      let set = 0;
      for (const t of targets) {
        const sent = await sendCommand(h, { command: 'setting.set', expectedRevision: t.overrideRevision, args: { projectId: h.projectId, key: t.taskId, change: { scope: 'task', field: 'route_override', value: t.mode } } } as never);
        if (sent.ok) set += 1;
      }
      pmConversation.getState().update(turnId, { ...reply, accepted: { planRevision: r.planRevision }, routes: { set, refused: targets.length - set } });
      if (autoDelegate) {
        // Wait for the new revision to be in the snapshot the PM reads, then let it assign inside it.
        for (let i = 0; i < 40 && (h.snapshot?.runs[o.runId]?.planRevision ?? 0) < r.planRevision; i++) await new Promise((res) => setTimeout(res, 50));
        await ask('pmDelegate', `Assign the tasks of plan rev ${r.planRevision}.`);
      }
    } catch (e) {
      const code = /^([a-z_]+):/.exec(e instanceof DataSourceException ? e.detail.message : e instanceof Error ? e.message : '')?.[1];
      update({ error: `Not accepted. ${say(code ?? 'unknown')}` });
    }
  }

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-4" data-testid="pm-panel">
      <div>
        <h1 id={`${id}-h`} className="text-2xl font-semibold tracking-tight">Talk to the Project Manager</h1>
        <p className="mt-1 max-w-prose text-muted">The Project Manager is an AI agent on Firebase AI Logic. It answers from the project, researches the web on the cloud route, drafts plans and proposes who takes each task. Every reply is a proposal until you accept it.</p>
        {h?.agents?.simulated ? <p className="mt-1 text-sm font-medium text-warning">{h.agents.liveModel ? 'Demo data: replies come from a real model (Firebase AI Logic) reading demo data. They are never evidence.' : 'Demo data: replies are simulated, with no live model. They are never evidence.'}</p> : null}
      </div>
      {!h?.agents ? <p className="text-muted">This source cannot run the Project Manager.</p> : runTasks.length === 0 ? <p className="text-muted">There is no run yet. The Project Manager needs a run to talk about.</p> : (
        <div className="space-y-3 rounded-card border border-line bg-panel p-3">
          <label className="block text-sm">
            <span className="font-medium text-fg">About task</span>
            <select className="mt-1 block w-full rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-fg" value={subjectId} onChange={(e) => { setSubject(e.target.value); setOverride(null); }} data-testid="pm-subject">
              {runTasks.map((t) => <option key={t.taskId} value={t.taskId}>{t.title ?? t.taskId}</option>)}
            </select>
            <span className="mt-1 block text-muted">The call uses this task&apos;s route and context. A restricted task keeps every PM call on this device.</span>
          </label>
          {sr ? <p className="text-sm text-fg" data-testid="pm-route">Uses {sr.label} ({sr.source}){sr.locked ? <span className="text-warning"> · restricted data stays on this device</span> : null}</p> : null}
          {offer && sr && !sr.locked && !sr.needsDefault ? (
            <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" checked={override !== null} onChange={(e) => setOverride(e.target.checked ? offer.mode : null)} />{offer.label}</label>
          ) : null}
          <label className="block text-sm">
            <span className="font-medium text-fg">Your question</span>
            <textarea className="mt-1 block w-full rounded-chip border border-line-strong bg-bg p-2 text-fg" rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} data-testid="pm-question" />
          </label>
          <label className="flex items-start gap-2 text-sm text-fg"><input type="checkbox" className="mt-0.5" data-testid="pm-restricted" checked={restricted || locked} disabled={locked} onChange={(e) => setRestricted(e.target.checked)} /><span>This question is restricted: keep it, and the reply, on this device{locked ? '. This task reads restricted data, so every question about it is.' : ''}</span></label>
          <div className="flex flex-wrap gap-2">
            {ASKS.map((a) => {
              const off = busy ? 'Waiting for the last reply.' : !question.trim() ? 'Write a question first.'
                : a.kind === 'pmResearch' && (locked || restricted) ? 'Web research is never used for restricted work.'
                  : a.kind === 'pmResearch' && deviceOnly ? say('research_device_only')
                    : a.kind === 'pmResearch' && !researchGranted ? say('research_not_granted') : null;
              return <button key={a.kind} type="button" className={a.kind === 'pmAnswer' ? buttonPrimary : buttonQuiet} disabled={off !== null} title={off ?? a.what} onClick={() => void ask(a.kind)}>{a.label}</button>;
            })}
          </div>
          <p className="text-sm text-muted">{ASKS.map((a) => `${a.label}: ${a.what}`).join(' ')}</p>
          {!researchGranted ? <p className="text-sm text-muted" data-testid="pm-research-off">Web research is off for this run. To allow it, turn on &quot;Google Search (web research)&quot; in <a className="text-active underline underline-offset-2" href={settingsHref('workflow')}>Settings › Workflow</a>. Only your question is sent, never the task or its context.</p> : null}
          {busy ? <p role="status" className="text-sm text-fg">The Project Manager is answering.</p> : null}
        </div>
      )}
      {remembered.length > 0 ? (
        <section aria-label="Earlier with the Project Manager" data-testid="pm-memory" className="rounded-card border border-line p-3">
          <h2 className="text-sm font-medium text-muted">Earlier, kept as checkpoints</h2>
          <ol className="mt-1 space-y-1 text-sm">{remembered.map((t, i) => <li key={i}><span className="font-medium">{t.who === 'owner' ? 'You' : 'Project Manager'}{t.classification === 'restricted' ? ' (restricted, kept on this device)' : ''}:</span> {t.text}</li>)}</ol>
        </section>
      ) : null}
      <ol className="space-y-3" data-testid="pm-turns" aria-label="Conversation with the Project Manager">
        {turns.map((t) => (
          <li key={t.id} className={`rounded-card border p-3 ${t.who === 'owner' ? 'border-line bg-panel-2' : 'border-line-strong bg-panel'}`} data-testid={t.who === 'owner' ? 'pm-turn-owner' : 'pm-turn-reply'}>
            <p className="text-sm font-medium text-muted">{t.who === 'owner' ? `You${t.restricted ? ' (restricted, kept on this device)' : ''}` : 'Project Manager'}</p>
            {t.who === 'owner' ? <p className="whitespace-pre-wrap text-fg">{t.text}</p> : <ReplyView reply={t.reply} snap={snap} browser={h?.browser ?? { online: true, cloudBudgetAvailable: null, nanoBudgetChars: 6000 }} onAcceptPlan={t.reply.kind === 'pmPlan' && h?.agents?.acceptPlan ? () => void acceptPlan(t.id, t.reply) : null} />}
          </li>
        ))}
      </ol>
    </section>
  );
}
