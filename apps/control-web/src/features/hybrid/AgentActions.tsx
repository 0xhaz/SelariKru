import { useEffect, useId, useState } from 'react';
import { OPEN_HANDOVER_STATES, type RoutePolicyMode } from '@selarikru/domain';
import { Chip, buttonPrimary, buttonQuiet, type Tone } from '@selarikru/ui';
import { DataSourceException, type TaskRouteView, type TaskView } from '@selarikru/view-protocol';
import { hrefFor } from '../../shell/route.ts';
import type { AgentsOutcome } from './agents.ts';
import { hybridResults, resultKey, useHybrid, useHybridResults, type HybridValue } from './context.tsx';
import { AGENT_ACTIONS, PATCH_ACCEPT_CONSEQUENCE, STATUS_TEXT, acceptBlocker, actionAvailability, effectiveStep, patchAcceptBlocker, patchAcceptRefusal, reaskNote, refusalText, replanConfirm, revisionRefusal, stepRoute, suggestionFor, type AgentActionKind } from './model.ts';
import { loadFactsWithRetry, type TaskFacts } from './facts.ts';
import { ConfirmDialog } from '../decisions/ConfirmDialog.tsx';
import { approvalStateAt } from '@selarikru/view-protocol';

/** Only answers are cached, by the task's aggregate revision, so a change event reads again. A failure is never kept. */
const factsCache = new Map<string, TaskFacts>();
const pause = (ms: number): Promise<void> => new Promise((r) => { window.setTimeout(r, ms); });

export type FactsState = { readonly phase: 'loading' } | { readonly phase: 'ready'; readonly facts: TaskFacts } | { readonly phase: 'failed'; readonly retry: () => void };

/**
 * Whether the task has a change, and its input size: counts only, for the destination the task's fresh route allows (agents.facts reads the route first). Transport
 * failures are retried with a bounded backoff, a refusal is not; then the screen says the read failed and offers a retry. Read again when the task's aggregate
 * revision moves.
 */
export function useTaskFacts(h: HybridValue | null, task: TaskView | undefined): FactsState {
  const [state, setState] = useState<FactsState>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const key = h && task ? `${h.projectId}|${task.taskId}|${task.aggregateRevision}` : null;
  useEffect(() => {
    if (!h?.agents || !task || key === null) return;
    const hit = factsCache.get(key);
    if (hit) { setState({ phase: 'ready', facts: hit }); return; }
    let live = true;
    setState({ phase: 'loading' });
    const agents = h.agents;
    void loadFactsWithRetry(() => agents.facts(task.taskId), pause).then((f) => {
      if (!live) return;
      if (f) { factsCache.set(key, f); setState({ phase: 'ready', facts: f }); }
      else setState({ phase: 'failed', retry: () => setAttempt((n) => n + 1) });
    });
    return () => { live = false; };
  }, [h?.agents, key, attempt]);
  return state;
}

const SOURCE_CHIP: Readonly<Record<string, { label: string; tone: Tone }>> = {
  ON_DEVICE: { label: 'Ran on this device', tone: 'success' }, IN_CLOUD: { label: 'Ran in the cloud', tone: 'active' }, UNKNOWN: { label: 'Source unknown', tone: 'warning' },
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/**
 * The AI actions on one task (plan.md §4.3): one button per step, each showing the route it will use, with a one-call override that is never offered under the lock.
 * A result is an untrusted proposal with its checks, where it ran and how long it took. Accepting goes through the existing flows.
 */
export function AgentActions({ taskId }: { taskId: string }) {
  const h = useHybrid();
  const t = h?.snapshot?.tasks[taskId];
  if (!h || !t?.route) return null;
  return <Actions h={h} task={t} route={t.route} />;
}

function Actions({ h, task, route }: { h: HybridValue; task: TaskView; route: TaskRouteView }) {
  const id = useId();
  const factsState = useTaskFacts(h, task);
  const facts = factsState.phase === 'ready' ? factsState.facts : null;
  const failedCheck = Object.values(h.snapshot?.checks ?? {}).some((c) => c.taskId === task.taskId && c.state === 'failed');
  if (!h.agents) {
    return (
      <section aria-labelledby={`${id}-t`} className="rounded-chip border border-line p-3">
        <h3 id={`${id}-t`} className="font-medium text-fg">AI actions</h3>
        <p className="mt-1 text-sm text-muted">This source cannot run the task agents, so no AI action is offered here.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby={`${id}-t`} data-testid="agent-actions" className="space-y-3 rounded-chip border border-line p-3">
      <div>
        <h3 id={`${id}-t`} className="font-medium text-fg">AI actions</h3>
        <p className="text-sm text-muted">Each runs one Firebase AI Logic call in this browser and comes back as a proposal. Nothing runs commands or changes the task until you accept it.</p>
        {h.agents.simulated ? <p className="mt-1 text-sm font-medium text-warning" data-testid="agents-demo-note">Demo data: answers are simulated, with no live model. They are never evidence.</p> : null}
        {factsState.phase === 'failed' ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-warning" data-testid="facts-failed">
            Couldn&apos;t read whether this task has a change.
            <button type="button" className={buttonQuiet} onClick={factsState.retry}>Retry</button>
          </p>
        ) : null}
      </div>
      <ul className="space-y-3">
        {AGENT_ACTIONS.map((a) => (
          <ActionRow key={a.kind} h={h} task={task} route={route} kind={a.kind} label={a.label} what={a.what}
            unavailable={facts === null && (a.kind === 'review' || a.kind === 'prDescription') ? (factsState.phase === 'failed' ? 'Couldn\'t read whether this task has a change.' : 'Reading whether this task has a change.') : actionAvailability(a.kind, { hasChange: facts?.hasChange ?? false, failedCheck })}
            inputChars={facts?.inputChars ?? null} />
        ))}
      </ul>
    </section>
  );
}

function ActionRow({ h, task, route, kind, label, what, unavailable, inputChars }: { h: HybridValue; task: TaskView; route: TaskRouteView; kind: AgentActionKind; label: string; what: string; unavailable: string | null; inputChars: number | null }) {
  const id = useId();
  const [override, setOverride] = useState<RoutePolicyMode | null>(null);
  const key = resultKey(task.taskId, kind);
  const result = useHybridResults((s) => s.results[key]);
  const sr = stepRoute(route, override);
  const offer = stepRoute(route, null).override;
  const suggestion = suggestionFor(route, kind, inputChars, h.browser);
  const running = result?.phase === 'running';
  const off = !h.live ? 'AI actions are off until the connection is live.' : sr.mode === null ? 'No route is set for this task or its run.' : unavailable;
  useEffect(() => { if (sr.locked) setOverride(null); }, [sr.locked]);

  async function run(): Promise<void> {
    if (!h.agents) return;
    hybridResults.getState().set(key, { phase: 'running' });
    const outcome = await h.agents.run({ taskId: task.taskId, kind, callOverride: override });
    hybridResults.getState().set(key, { phase: 'done', outcome });
    // A one-call override is for that call only.
    setOverride(null);
  }

  const where = sr.place === 'device' ? (sr.mode === 'ONLY_ON_DEVICE' ? 'on this device only' : 'on this device first') : sr.place === 'cloud' ? (sr.mode === 'ONLY_IN_CLOUD' ? 'in the cloud only' : 'in the cloud first') : 'nowhere yet';
  return (
    <li data-testid="agent-action" data-kind={kind} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button type="button" className={buttonQuiet} disabled={off !== null || running} aria-busy={running} aria-describedby={`${id}-route`} onClick={() => void run()}>{running ? `${label}: running` : label}</button>
        <span id={`${id}-route`} className="text-sm text-fg" data-testid="agent-route">Uses {sr.label}, {where} <span className="text-muted">({sr.source})</span>{sr.locked ? <span className="text-warning"> · restricted data stays on this device</span> : null}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{what} Suggested for this step: {suggestion.label}.</p>
      {offer && !sr.locked && !sr.needsDefault ? (
        <label className="mt-1.5 flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={override !== null} disabled={running} onChange={(e) => setOverride(e.target.checked ? offer.mode : null)} />
          {offer.label}
        </label>
      ) : null}
      {sr.needsDefault ? <p className="mt-1 text-sm text-fg" data-testid="needs-default">Choose where new tasks run first, in <a className="font-medium text-active underline underline-offset-2" href="#/settings?section=workflow">Settings › Workflow</a>, or set this task&apos;s route above.</p> : null}
      {off && !sr.needsDefault ? <p className="mt-1 text-sm text-muted">{off}</p> : null}
      {kind === 'patch' ? <p className="mt-1 text-sm text-muted" data-testid="patch-files-note">The agent reads this task&apos;s files at its base commit, from the local runner. A restricted task&apos;s files stay on this device, so its proposals can only add files.</p> : null}
      {running ? <p role="status" className="mt-2 text-sm text-fg">Running {where}.</p> : null}
      {result?.phase === 'done' ? <ProposalCard h={h} task={task} kind={kind} outcome={result.outcome} onDiscard={() => hybridResults.getState().set(key, null)} /> : null}
    </li>
  );
}

function ProposalCard({ h, task, kind, outcome, onDiscard }: { h: HybridValue; task: TaskView; kind: AgentActionKind; outcome: AgentsOutcome; onDiscard: () => void }) {
  if (outcome.kind === 'refused') {
    return (
      <div data-testid="agent-result" data-status="refused" className="mt-2 rounded-chip border border-warning bg-warning-tint p-2.5">
        <p role="status" className="text-fg">{refusalText(outcome.code)}</p>
        <button type="button" className={`${buttonQuiet} mt-2`} onClick={onDiscard}>Dismiss</button>
      </div>
    );
  }
  const p = outcome.result.proposal;
  const ok = p.status === 'ok';
  const fell = p.route?.fellBack === true;
  const src = fell ? { label: p.observedSource === 'IN_CLOUD' ? 'Fell back to cloud' : 'Fell back to this device', tone: 'warning' as const } : SOURCE_CHIP[p.observedSource]!;
  const ran = p.status !== 'blocked' && p.status !== 'error';
  return (
    <div data-testid="agent-result" data-status={p.status} data-kind={kind} className={`mt-2 space-y-2 rounded-chip border p-2.5 ${ok ? 'border-line-strong bg-panel-2' : 'border-warning bg-warning-tint'}`}>
      <p role="status" className="sr-only" data-testid="result-announce">{`${AGENT_ACTIONS.find((a) => a.kind === kind)?.label ?? kind}: ${ok ? `proposal ready, ${src.label.toLowerCase()}` : p.status === 'blocked' ? `stopped. ${refusalText(p.blockedReason)}` : 'not usable'}.`}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">Proposal</span>
        {outcome.simulated ? <span className="rounded-chip bg-warning px-1.5 py-0.5 text-sm font-semibold text-bg" data-testid="result-demo">Demo data</span> : null}
        <Chip tone={ok ? 'success' : 'warning'}>{ok ? STATUS_TEXT['ok']! : p.status === 'blocked' ? STATUS_TEXT['blocked']! : 'Not usable'}</Chip>
        {ran ? <Chip tone={src.tone}>{src.label}</Chip> : null}
        {ran ? <span className="text-sm text-muted" data-testid="result-timing">{seconds(p.timing.totalMs)}</span> : null}
      </div>
      {!ok ? (
        <p className="text-fg" data-testid="result-refusal">{p.status === 'blocked' ? refusalText(p.blockedReason) : p.blockedReason ? refusalText(p.blockedReason) : STATUS_TEXT[p.status] ?? 'Not usable.'}</p>
      ) : null}
      {outcome.kind === 'result' && reaskNote(outcome.reasked) ? <p className="text-sm text-fg" data-testid="reask-note">{reaskNote(outcome.reasked)}</p> : null}
      {p.status === 'invalid' ? <p className="text-sm text-muted">The answer did not pass its checks ({p.validation.errors.length} problem{p.validation.errors.length === 1 ? '' : 's'}), so it is not shown.</p> : null}
      {ok ? <ProposalBody h={h} task={task} kind={kind} outcome={outcome} /> : null}
      <p className="text-sm text-muted">
        {outcome.result.locked ? 'Restricted data: this result stays in this tab and is not stored. ' : ''}
        {outcome.result.omissions.length > 0 ? `${outcome.result.omissions.length} item${outcome.result.omissions.length === 1 ? ' was' : 's were'} left out of the context. ` : ''}
        {outcome.result.reported === 'sent' ? 'Where it ran was recorded as an untrusted browser report, with no prompt or output.' : outcome.result.reported === 'failed' ? 'Where it ran could not be recorded. Nothing else changed.' : ''}
      </p>
      <button type="button" className={buttonQuiet} onClick={onDiscard}>Discard</button>
    </div>
  );
}

type Criteria = { acceptanceCriteria: { requirementId: string; text: string }[] };

function ProposalBody({ h, task, kind, outcome }: { h: HybridValue; task: TaskView; kind: AgentActionKind; outcome: Extract<AgentsOutcome, { kind: 'result' }> }) {
  const data = outcome.result.proposal.data as Record<string, unknown>;
  switch (kind) {
    case 'criteria': return <CriteriaProposal h={h} task={task} data={data as unknown as Criteria} outcome={outcome} />;
    case 'breakdown': {
      const steps = (data['steps'] as { title: string; detail: string }[]) ?? [];
      return (
        <div>
          <ol className="list-decimal space-y-1 pl-5">{steps.map((s, i) => <li key={i} className="text-fg"><span className="font-medium">{s.title}.</span> <span className="text-muted">{s.detail}</span></li>)}</ol>
          <p className="mt-1.5 text-sm text-muted">Steps are a guide. To change the plan, <a className="font-medium text-active underline underline-offset-2" href={`${hrefFor('assistant')}?run=${encodeURIComponent(task.runId)}&task=${encodeURIComponent(task.taskId)}`}>replan this task in the Assistant</a>.</p>
        </div>
      );
    }
    case 'patch': return <PatchProposal h={h} task={task} data={data} outcome={outcome} />;
    case 'review': {
      const findings = (data['findings'] as { file: string; line: number; severity: string; message: string }[]) ?? [];
      return (
        <div>
          <p className="text-fg"><span className="font-medium">{String(data['outcome']).replace(/_/g, ' ')}.</span> {String(data['summary'] ?? '')}</p>
          {findings.length > 0 ? <ul className="mt-1 space-y-1">{findings.map((f, i) => <li key={i} className="text-sm text-fg"><span className="font-mono text-mono">{f.file}:{f.line}</span> <span className="text-muted">{f.severity}</span> {f.message}</li>)}</ul> : null}
          <p className="mt-1 text-sm text-muted">A review note informs you. It approves nothing and verifies nothing.</p>
        </div>
      );
    }
    case 'triage':
      return (
        <dl className="grid grid-cols-1 gap-y-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-3">
          <dt className="text-muted">Summary</dt><dd className="m-0 text-fg">{String(data['summary'] ?? '')}</dd>
          <dt className="text-muted">Likely cause</dt><dd className="m-0 text-fg">{String(data['likelyCause'] ?? '')}</dd>
          <dt className="text-muted">Next step</dt><dd className="m-0 text-fg">{String(data['nextStep'] ?? '')}</dd>
        </dl>
      );
    case 'prDescription': return <PrProposal task={task} title={String(data['title'] ?? '')} body={String(data['body'] ?? '')} locked={outcome.result.locked} />;
  }
}

function CriteriaProposal({ h, task, data, outcome }: { h: HybridValue; task: TaskView; data: Criteria; outcome: Extract<AgentsOutcome, { kind: 'result' }> }) {
  const [state, setState] = useState<{ phase: 'idle' | 'working' | 'confirming' } | { phase: 'done' | 'failed'; text: string }>({ phase: 'idle' });
  const [confirm, setConfirm] = useState<ReturnType<typeof replanConfirm>['confirm']>(null);
  const revise = h.agents?.reviseCriteria ?? null;
  const reason = acceptBlocker({ status: task.status, locked: outcome.result.locked, canRevise: revise !== null, live: h.live });
  const pendingApproval = Object.values(h.snapshot?.approvals ?? {}).some((a) => a.taskId === task.taskId && approvalStateAt(a, Date.now()) === 'pending');
  async function send(): Promise<void> {
    if (!revise) return;
    setConfirm(null);
    setState({ phase: 'working' });
    try {
      const r = await revise({ taskId: task.taskId, expectedPlanRevision: outcome.context.planRevision, idempotencyKey: `criteria-${outcome.result.proposal.requestId}`, criteria: data.acceptanceCriteria.map((c) => ({ id: c.requirementId, text: c.text })) });
      h.refresh();
      setState({ phase: 'done', text: r.simulated ? `Criteria revision recorded in the demo as plan revision ${r.planRevision}. Demo data, not evidence.` : `Plan revision ${r.planRevision} created with the reworded criteria. The task is planned again from its new revision.` });
    } catch (e) {
      setState({ phase: 'failed', text: revisionRefusal(e instanceof DataSourceException ? e.detail.message : '') });
    }
  }
  async function accept(): Promise<void> {
    setState({ phase: 'confirming' });
    // An open handover is read now; one that cannot be read is treated as open, so the person is asked.
    let openHandover = false;
    if (h.handover) {
      try {
        const view = await h.handover.load();
        openHandover = view.tasks.some((t) => t.taskId === task.taskId && t.current !== null && (OPEN_HANDOVER_STATES as readonly string[]).includes(t.current.state));
      } catch {
        openHandover = true;
      }
    }
    const c = replanConfirm({ pendingApproval, openHandover }).confirm;
    if (c) { setConfirm(c); setState({ phase: 'idle' }); return; }
    await send();
  }
  const copy = replanConfirm({ pendingApproval: false, openHandover: false }).consequence;
  return (
    <div className="space-y-1.5">
      <ul className="space-y-1">{data.acceptanceCriteria.map((c) => <li key={c.requirementId} className="text-fg"><span className="font-mono text-mono text-muted">{c.requirementId}</span> {c.text}</li>)}</ul>
      {state.phase === 'done' ? <p className="text-sm font-medium text-fg" data-testid="criteria-accepted">{state.text}</p> : (
        <>
          <button type="button" className={buttonPrimary} disabled={reason !== null || state.phase === 'working' || state.phase === 'confirming'} onClick={() => void accept()}>{state.phase === 'working' ? 'Accepting' : 'Accept criteria'}</button>
          <p className="text-sm text-muted" data-testid="accept-note">{reason ?? copy}</p>
          {state.phase === 'failed' ? <p className="text-sm text-danger" data-testid="accept-refused">{state.text}</p> : null}
        </>
      )}
      {confirm ? <ConfirmDialog copy={confirm} confirmLabel="Replan with these criteria" onConfirm={() => void send()} onKeep={() => setConfirm(null)} /> : null}
    </div>
  );
}

function PatchProposal({ h, task, data, outcome }: { h: HybridValue; task: TaskView; data: Record<string, unknown>; outcome: Extract<AgentsOutcome, { kind: 'result' }> }) {
  const id = useId();
  const [state, setState] = useState<{ phase: 'idle' | 'working' } | { phase: 'done' | 'failed'; text: string }>({ phase: 'idle' });
  const accept = h.agents?.acceptPatch ?? null;
  const r = outcome.result;
  const reason = patchAcceptBlocker({ status: task.status, locked: r.locked, canAccept: accept !== null, live: h.live, recorded: r.reported === 'sent' && r.report !== null, checked: r.patch !== undefined && (outcome.base ?? null) !== null });
  async function send(): Promise<void> {
    if (!accept) return;
    setState({ phase: 'working' });
    try {
      const receipt = await accept(outcome);
      h.refresh();
      setState({ phase: 'done', text: receipt.simulated
        ? `Accepted in the demo: ${receipt.fileCount} file${receipt.fileCount === 1 ? '' : 's'}. The demo has no runner, so nothing is applied. Demo data, not evidence.`
        : `Accepted: ${receipt.fileCount} file${receipt.fileCount === 1 ? '' : 's'}. The task waits for the runner, which applies them with no model, then builds, tests and verifies the result.` });
    } catch (e) {
      setState({ phase: 'failed', text: patchAcceptRefusal(e instanceof DataSourceException ? e.detail.message : e instanceof Error ? e.message : '') });
    }
  }
  return (
    <div className="space-y-1.5">
      <p className="text-fg">{String(data['summary'] ?? '')}</p>
      <pre className="max-h-48 overflow-auto rounded-chip border border-line bg-bg p-2 font-mono text-mono whitespace-pre text-fg" tabIndex={0} aria-label="Proposed diff">{String(data['diff'] ?? '')}</pre>
      {state.phase === 'done' ? <p className="text-sm font-medium text-fg" data-testid="patch-accepted">{state.text}</p> : (
        <>
          <button type="button" className={buttonPrimary} disabled={reason !== null || state.phase === 'working'} aria-describedby={`${id}-apply`} onClick={() => void send()}>{state.phase === 'working' ? 'Accepting' : 'Accept and apply'}</button>
          <p id={`${id}-apply`} className="text-sm text-muted" data-testid="patch-accept-note">{reason ?? PATCH_ACCEPT_CONSEQUENCE}</p>
          {state.phase === 'failed' ? <p className="text-sm text-danger" data-testid="patch-accept-refused">{state.text}</p> : null}
        </>
      )}
    </div>
  );
}

function PrProposal({ task, title, body, locked }: { task: TaskView; title: string; body: string; locked: boolean }) {
  const id = useId();
  const field = useHybridResults((s) => s.prBody[task.runId]);
  return (
    <div className="space-y-1.5">
      <p className="font-medium text-fg">{title}</p>
      <p className="whitespace-pre-wrap text-fg">{body}</p>
      <button type="button" className={buttonQuiet} disabled={locked} onClick={() => hybridResults.getState().setPrBody(task.runId, `${title}\n\n${body}`)}>Use as PR description</button>
      {locked ? <p className="text-sm text-muted" data-testid="pr-locked">This text came from restricted data. It stays on this device, so it is not used as a pull request description.</p> : null}
      {field !== undefined ? (
        <div>
          <label htmlFor={`${id}-pr`} className="block text-sm font-medium text-fg">Pull request description</label>
          <textarea id={`${id}-pr`} data-testid="pr-body" className="mt-1 w-full rounded-chip border border-line-strong bg-bg p-2 text-fg" rows={5} value={field} onChange={(e) => hybridResults.getState().setPrBody(task.runId, e.target.value)} />
          <p className="text-sm text-muted" data-testid="pr-body-note">Kept in this tab for run {task.runId}. Opening the draft pull request from Action items sends it as the description, with secrets removed, ahead of the verified results.</p>
        </div>
      ) : null}
    </div>
  );
}
