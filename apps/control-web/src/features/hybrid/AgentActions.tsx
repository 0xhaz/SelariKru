import { useEffect, useId, useState } from 'react';
import type { RoutePolicyMode } from '@selarikru/domain';
import { Chip, buttonPrimary, buttonQuiet, type Tone } from '@selarikru/ui';
import { DataSourceException, type TaskAgentContext, type TaskRouteView, type TaskView } from '@selarikru/view-protocol';
import { hrefFor } from '../../shell/route.ts';
import type { AgentsOutcome } from './agents.ts';
import { hybridResults, resultKey, useHybrid, useHybridResults, type HybridValue } from './context.tsx';
import { AGENT_ACTIONS, STATUS_TEXT, actionAvailability, refusalText, stepRoute, suggestionFor, type AgentActionKind } from './model.ts';

/** What the agents may read for a task, read once per task and destination-free: whether there is a change, and how long the input is. */
export interface TaskFacts {
  readonly hasChange: boolean;
  readonly inputChars: number;
}
const factsCache = new Map<string, Promise<TaskFacts | null>>();

export const inputCharsOf = (c: TaskAgentContext): number =>
  c.task.title.length + (c.task.description?.length ?? 0) + c.task.criteria.reduce((n, x) => n + x.text.length, 0) + c.bundle.claims.reduce((n, x) => n + x.text.length + x.heading.length, 0);

/** The cloud bundle is enough to know these facts, and it carries nothing restricted. */
export function useTaskFacts(h: HybridValue | null, taskId: string, revision: number): TaskFacts | null {
  const [facts, setFacts] = useState<TaskFacts | null>(null);
  useEffect(() => {
    if (!h?.agents) return;
    const key = `${h.projectId}|${taskId}|${revision}`;
    let p = factsCache.get(key);
    if (!p) {
      p = h.agents.context(taskId, 'cloud').then((c) => ({ hasChange: c.change !== null, inputChars: inputCharsOf(c) }), () => null);
      factsCache.set(key, p);
    }
    let live = true;
    void p.then((f) => { if (live) setFacts(f); });
    return () => { live = false; };
  }, [h?.agents, h?.projectId, taskId, revision]);
  return facts;
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
  const facts = useTaskFacts(h, task.taskId, task.revision);
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
      </div>
      <ul className="space-y-3">
        {AGENT_ACTIONS.map((a) => (
          <ActionRow key={a.kind} h={h} task={task} route={route} kind={a.kind} label={a.label} what={a.what}
            unavailable={facts === null && (a.kind === 'review' || a.kind === 'prDescription') ? 'Reading whether this task has a change.' : actionAvailability(a.kind, { hasChange: facts?.hasChange ?? false, failedCheck })}
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
  const off = !h.live ? 'AI actions are off until the connection is live.' : sr.mode === null ? 'No route is set for this task or its run. Choose one under Runs on.' : unavailable;
  useEffect(() => { if (sr.locked) setOverride(null); }, [sr.locked]);

  async function run(): Promise<void> {
    if (!h.agents) return;
    hybridResults.getState().set(key, { phase: 'running' });
    const outcome = await h.agents.run({ taskId: task.taskId, kind, callOverride: override });
    hybridResults.getState().set(key, { phase: 'done', outcome });
  }

  const where = sr.place === 'device' ? (sr.mode === 'ONLY_ON_DEVICE' ? 'on this device only' : 'on this device first') : sr.place === 'cloud' ? (sr.mode === 'ONLY_IN_CLOUD' ? 'in the cloud only' : 'in the cloud first') : 'nowhere yet';
  return (
    <li data-testid="agent-action" data-kind={kind} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button type="button" className={buttonQuiet} disabled={off !== null || running} aria-busy={running} aria-describedby={`${id}-route`} onClick={() => void run()}>{running ? `${label}: running` : label}</button>
        <span id={`${id}-route`} className="text-sm text-fg" data-testid="agent-route">Uses {sr.label}, {where} <span className="text-muted">({sr.source})</span>{sr.locked ? <span className="text-warning"> · restricted data stays on this device</span> : null}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{what} Suggested for this step: {suggestion.label}.</p>
      {offer && !sr.locked ? (
        <label className="mt-1.5 flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={override !== null} disabled={running} onChange={(e) => setOverride(e.target.checked ? offer.mode : null)} />
          {offer.label}
        </label>
      ) : null}
      {off ? <p className="mt-1 text-sm text-muted">{off}</p> : null}
      {running ? <p role="status" className="mt-2 text-sm text-fg">Running {where}.</p> : null}
      {result?.phase === 'done' ? <ProposalCard h={h} task={task} kind={kind} outcome={result.outcome} onDiscard={() => hybridResults.getState().set(key, null)} /> : null}
    </li>
  );
}

function ProposalCard({ h, task, kind, outcome, onDiscard }: { h: HybridValue; task: TaskView; kind: AgentActionKind; outcome: AgentsOutcome; onDiscard: () => void }) {
  if (outcome.kind === 'refused') {
    return (
      <div role="status" data-testid="agent-result" data-status="refused" className="mt-2 rounded-chip border border-warning bg-warning-tint p-2.5">
        <p className="text-fg">{refusalText(outcome.code)}</p>
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
    <div role="status" data-testid="agent-result" data-status={p.status} data-kind={kind} className={`mt-2 space-y-2 rounded-chip border p-2.5 ${ok ? 'border-line-strong bg-panel-2' : 'border-warning bg-warning-tint'}`}>
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
    case 'patch':
      return (
        <div className="space-y-1.5">
          <p className="text-fg">{String(data['summary'] ?? '')}</p>
          <pre className="max-h-48 overflow-auto rounded-chip border border-line bg-bg p-2 font-mono text-mono whitespace-pre text-fg" tabIndex={0} aria-label="Proposed diff">{String(data['diff'] ?? '')}</pre>
          <button type="button" className={buttonQuiet} disabled aria-describedby={`apply-${task.taskId}`}>Apply comes next</button>
          <p id={`apply-${task.taskId}`} className="text-sm text-muted">Applying a proposed change in the sandbox is the next step to be built. Nothing was applied.</p>
        </div>
      );
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
    case 'prDescription': return <PrProposal task={task} title={String(data['title'] ?? '')} body={String(data['body'] ?? '')} />;
  }
}

function CriteriaProposal({ h, task, data, outcome }: { h: HybridValue; task: TaskView; data: Criteria; outcome: Extract<AgentsOutcome, { kind: 'result' }> }) {
  const [state, setState] = useState<{ phase: 'idle' | 'working' } | { phase: 'done' | 'failed'; text: string }>({ phase: 'idle' });
  const revise = h.agents?.reviseCriteria ?? null;
  const reason = outcome.result.locked ? 'This proposal came from restricted data. It stays on this device, and a browser proposal does not revise a restricted task.'
    : !revise ? 'This source cannot take a plan revision.' : !h.live ? 'Accepting is off until the connection is live.' : null;
  async function accept(): Promise<void> {
    if (!revise) return;
    setState({ phase: 'working' });
    try {
      const r = await revise({ taskId: task.taskId, expectedPlanRevision: outcome.context.planRevision, idempotencyKey: `criteria-${outcome.result.proposal.requestId}`, criteria: data.acceptanceCriteria.map((c) => ({ id: c.requirementId, text: c.text })) });
      h.refresh();
      setState({ phase: 'done', text: r.simulated ? `Criteria revision recorded in the demo as plan revision ${r.planRevision}. Demo data, not evidence.` : `Plan revision ${r.planRevision} created with the reworded criteria. The task continues from its new revision.` });
    } catch (e) {
      setState({ phase: 'failed', text: e instanceof DataSourceException ? `Not recorded: ${e.detail.message}.` : 'The revision was not recorded. Trying again is safe.' });
    }
  }
  return (
    <div className="space-y-1.5">
      <ul className="space-y-1">{data.acceptanceCriteria.map((c) => <li key={c.requirementId} className="text-fg"><span className="font-mono text-mono text-muted">{c.requirementId}</span> {c.text}</li>)}</ul>
      {state.phase === 'done' ? <p className="text-sm font-medium text-fg" data-testid="criteria-accepted">{state.text}</p> : (
        <>
          <button type="button" className={buttonPrimary} disabled={reason !== null || state.phase === 'working'} onClick={() => void accept()}>{state.phase === 'working' ? 'Accepting' : 'Accept criteria'}</button>
          <p className="text-sm text-muted">{reason ?? 'Accepting makes a new revision of this task through the replan path, with these criteria and nothing else changed.'}</p>
          {state.phase === 'failed' ? <p className="text-sm text-danger">{state.text}</p> : null}
        </>
      )}
    </div>
  );
}

function PrProposal({ task, title, body }: { task: TaskView; title: string; body: string }) {
  const id = useId();
  const field = useHybridResults((s) => s.prBody[task.runId]);
  return (
    <div className="space-y-1.5">
      <p className="font-medium text-fg">{title}</p>
      <p className="whitespace-pre-wrap text-fg">{body}</p>
      <button type="button" className={buttonQuiet} onClick={() => hybridResults.getState().setPrBody(task.runId, `${title}\n\n${body}`)}>Use as PR description</button>
      {field !== undefined ? (
        <div>
          <label htmlFor={`${id}-pr`} className="block text-sm font-medium text-fg">Pull request description</label>
          <textarea id={`${id}-pr`} data-testid="pr-body" className="mt-1 w-full rounded-chip border border-line-strong bg-bg p-2 text-fg" rows={5} value={field} onChange={(e) => hybridResults.getState().setPrBody(task.runId, e.target.value)} />
          <p className="text-sm text-muted">Kept in this tab for run {task.runId}. Opening the draft pull request does not send it yet.</p>
        </div>
      ) : null}
    </div>
  );
}
