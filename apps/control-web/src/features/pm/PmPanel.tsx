import { useEffect, useId, useRef, useState } from 'react';
import { create } from 'zustand';
import type { RoutePolicyMode } from '@selarikru/domain';
import type { PmTurn } from '@selarikru/inference-firebase-web';
import { Chip, buttonPrimary, buttonQuiet } from '@selarikru/ui';
import { DataSourceException, type DelegationReceipt, type ProjectViewSnapshot } from '@selarikru/view-protocol';
import { useHybrid } from '../hybrid/context.tsx';
import { PERSON_ACCEPTS, observedChip, proposalAttribution, refusalText, stepRoute } from '../hybrid/model.ts';
import { workerIdentity } from '../team/identity.ts';
import { currentRun } from '../settings/model.ts';
import { planScopeFor, type PmKind, type PmOutcome } from './runner.ts';

/**
 * H11: Talk to the Project Manager. One single-turn Firebase AI Logic call per question, about one task of the run (its route, lock and context apply), with a
 * bounded and label-filtered part of this conversation. The conversation lives in this tab only and is never stored: a restricted turn stays on this device.
 * Every reply is a proposal until accepted; the PM's assignments apply on their own only inside the accepted plan, and only while auto-delegation is on.
 */
type Reply = { readonly kind: PmKind; readonly outcome: PmOutcome & { readonly simulated: boolean }; readonly delegation?: DelegationReceipt | { readonly error: string } };
type NewTurn = { readonly who: 'owner'; readonly text: string; readonly restricted: boolean; readonly kind: PmKind } | { readonly who: 'pm'; readonly reply: Reply };
type Turn = NewTurn & { readonly id: number };

interface PmStore {
  readonly turns: readonly Turn[];
  add(turn: NewTurn): number;
  update(id: number, reply: Reply): void;
}
let seq = 1;
/** Kept for this tab's session only, in memory. */
export const pmConversation = create<PmStore>((set) => ({
  turns: [],
  add: (turn) => { const id = seq++; set((s) => ({ turns: [...s.turns, { ...turn, id } as Turn] })); return id; },
  update: (id, reply) => set((s) => ({ turns: s.turns.map((t) => (t.id === id && t.who === 'pm' ? { ...t, reply } : t)) })),
}));

const ASKS: readonly { kind: PmKind; label: string; what: string }[] = [
  { kind: 'pmAnswer', label: 'Ask', what: 'An answer from the project\'s own context, with its sources.' },
  { kind: 'pmResearch', label: 'Research the web', what: 'Cloud only, with Grounding with Google Search. Never for a locked (restricted) task.' },
  { kind: 'pmPlan', label: 'Draft a plan', what: 'A plan revision you can accept in the Assistant\'s replan step.' },
  { kind: 'pmDelegate', label: 'Propose assignments', what: 'Who takes each task of the accepted plan. Applied on their own only inside that plan.' },
];

const REFUSAL: Readonly<Record<string, string>> = {
  research_locked: 'This task reads restricted data, so the Project Manager does not search the web for it.',
  research_cloud_only: 'Web research runs only in the cloud, and this call could not go there.',
  question_empty: 'Write a question first.',
  auto_delegate_off: 'Auto-delegation is off in Settings › Workflow, so this waits for you.',
  plan_revision_not_accepted: 'It is not for the accepted plan revision in force.',
  task_not_in_plan: 'That task is not in the accepted plan.',
  worker_unknown: 'No such worker.',
  worker_disabled: 'That worker is disabled.',
  role_not_in_task: 'That worker\'s role is not the task\'s role.',
  task_not_delegable: 'That task is already running or done.',
  retry_limit_reached: 'That task has no repair left.',
  duplicate_task: 'The task was named twice.',
  outside_plan_field: 'It named something the accepted plan does not cover (a path, a budget or a role).',
};
const say = (code: string): string => REFUSAL[code] ?? refusalText(code);

/** Search Suggestions from Grounding with Google Search, rendered exactly as given, in a shadow root so its styles stay its own (the terms require showing it). */
function SearchSuggestions({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    root.innerHTML = html;
  }, [html]);
  return <div ref={host} data-testid="pm-search-suggestions" />;
}

function nameOf(snap: ProjectViewSnapshot | null, workerId: string): string {
  if (!snap) return workerId;
  const w = Object.values(snap.runs).length > 0 ? planScopeFor(snap, Object.values(snap.tasks).find((t) => t.delegation?.workerId === workerId)?.runId ?? Object.keys(snap.runs)[0]!).workers.find((x) => x.workerId === workerId) : undefined;
  return w ? workerIdentity(snap, workerId, w.role).label : workerId;
}

function ReplyView({ reply, snap }: { reply: Reply; snap: ProjectViewSnapshot | null }) {
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
              <ol className="list-decimal pl-5 text-fg">{(data['tasks'] as { key: string; title: string; role: string }[]).map((t) => <li key={t.key}>{t.title} <span className="text-sm text-muted">({t.role})</span></li>)}</ol>
              <p className="text-sm text-muted">To make this the plan, accept it through the replan step in the Assistant. Until then it changes nothing.</p>
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
          {d.refused.map((a) => <p key={`${a.taskId}:${a.workerId}`} className="text-sm text-warning" data-testid="pm-needs-you">{title(a.taskId)} → {nameOf(snap, a.workerId)}: not applied. {say(a.reason)} This needs you.</p>)}
          {d.simulated ? <p className="text-sm text-muted">Demo data: simulated, never evidence.</p> : null}
        </>
      )}
    </div>
  );
}

export function PmPanel() {
  const h = useHybrid();
  const id = useId();
  const turns = pmConversation((s) => s.turns);
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

  async function ask(kind: PmKind): Promise<void> {
    if (!h?.agents || !subjectId) return;
    const add = pmConversation.getState().add;
    // The history this call may carry: earlier turns with their labels. The catalog drops restricted ones from any cloud-capable call.
    const history: PmTurn[] = pmConversation.getState().turns.flatMap((t): PmTurn[] => t.who === 'owner' ? [{ who: 'owner', text: t.text, classification: t.restricted ? 'restricted' : 'internal' }]
      : t.reply.outcome.kind === 'result' && t.reply.outcome.result.proposal.status === 'ok' ? [{ who: 'pm', text: String((t.reply.outcome.result.proposal.data as { answer?: unknown } | null)?.answer ?? ''), classification: t.reply.outcome.result.locked ? 'restricted' : 'internal' }] : []);
    add({ who: 'owner', text: question, restricted, kind });
    setBusy(true);
    try {
      const outcome = await h.agents.pm({ kind, subjectTaskId: subjectId, question, questionClassification: restricted ? 'restricted' : 'internal', history, callOverride: override });
      const rid = add({ who: 'pm', reply: { kind, outcome } });
      // H11: the PM's assignments apply on their own, inside the accepted plan only; the server re-checks them and refuses anything else, for you.
      if (kind === 'pmDelegate' && outcome.kind === 'result' && outcome.result.proposal.status === 'ok' && !h.agents.delegate) {
        pmConversation.getState().update(rid, { kind, outcome, delegation: { error: 'This source cannot apply assignments, so they wait for you.' } });
      } else if (kind === 'pmDelegate' && outcome.kind === 'result' && outcome.result.proposal.status === 'ok' && !outcome.result.report) {
        pmConversation.getState().update(rid, { kind, outcome, delegation: { error: 'Where this call ran was not recorded, so its assignments cannot be applied.' } });
      } else if (kind === 'pmDelegate' && outcome.kind === 'result' && outcome.result.proposal.status === 'ok' && outcome.result.report && h.agents.delegate) {
        const assignments = (outcome.result.proposal.data as { assignments: Record<string, unknown>[] }).assignments;
        try {
          const receipt = await h.agents.delegate(outcome.runId, { planRevision: outcome.planRevision ?? 0, subjectTaskId: subjectId, routeRecordId: outcome.result.report.requestId, assignments });
          pmConversation.getState().update(rid, { kind, outcome, delegation: receipt });
          h.refresh();
        } catch (e) {
          pmConversation.getState().update(rid, { kind, outcome, delegation: { error: say(/^([a-z_]+):/.exec(e instanceof DataSourceException ? e.detail.message : e instanceof Error ? e.message : '')?.[1] ?? 'delegation_failed') } });
        }
      }
      setQuestion('');
      setOverride(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-4" data-testid="pm-panel">
      <div>
        <h1 id={`${id}-h`} className="text-2xl font-semibold tracking-tight">Talk to the Project Manager</h1>
        <p className="mt-1 max-w-prose text-muted">The Project Manager is an AI agent on Firebase AI Logic. It answers from the project, researches the web on the cloud route, drafts plans and proposes who takes each task. Every reply is a proposal until you accept it.</p>
        {h?.agents?.simulated ? <p className="mt-1 text-sm font-medium text-warning">Demo data: replies are simulated, with no live model. They are never evidence.</p> : null}
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
          <label className="flex items-start gap-2 text-sm text-fg"><input type="checkbox" className="mt-0.5" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} /><span>This question is restricted: keep it, and the reply, on this device</span></label>
          <div className="flex flex-wrap gap-2">
            {ASKS.map((a) => {
              const off = busy ? 'Waiting for the last reply.' : !question.trim() ? 'Write a question first.' : a.kind === 'pmResearch' && (locked || restricted) ? 'Web research is never used for restricted work.' : null;
              return <button key={a.kind} type="button" className={a.kind === 'pmAnswer' ? buttonPrimary : buttonQuiet} disabled={off !== null} title={off ?? a.what} onClick={() => void ask(a.kind)}>{a.label}</button>;
            })}
          </div>
          <p className="text-sm text-muted">{ASKS.map((a) => `${a.label}: ${a.what}`).join(' ')}</p>
          {busy ? <p role="status" className="text-sm text-fg">The Project Manager is answering.</p> : null}
        </div>
      )}
      <ol className="space-y-3" data-testid="pm-turns" aria-label="Conversation with the Project Manager">
        {turns.map((t) => (
          <li key={t.id} className={`rounded-card border p-3 ${t.who === 'owner' ? 'border-line bg-panel-2' : 'border-line-strong bg-panel'}`} data-testid={t.who === 'owner' ? 'pm-turn-owner' : 'pm-turn-reply'}>
            <p className="text-sm font-medium text-muted">{t.who === 'owner' ? `You${t.restricted ? ' (restricted, kept on this device)' : ''}` : 'Project Manager'}</p>
            {t.who === 'owner' ? <p className="whitespace-pre-wrap text-fg">{t.text}</p> : <ReplyView reply={t.reply} snap={snap} />}
          </li>
        ))}
      </ol>
    </section>
  );
}
