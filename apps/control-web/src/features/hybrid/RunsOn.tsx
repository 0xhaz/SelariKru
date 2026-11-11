import { useEffect, useId, useState } from 'react';
import type { RoutePolicyMode } from '@selarikru/domain';
import { Chip, buttonQuiet } from '@selarikru/ui';
import type { TaskRouteView, TaskView } from '@selarikru/view-protocol';
import { sendCommand, useHybrid, type HybridValue } from './context.tsx';
import { routeIntent, runsOnModel, type RunsOnModel } from './model.ts';
import { useTaskFacts } from './AgentActions.tsx';

/** A padlock drawn in the text colour. Always beside words: the icon alone says nothing. */
export function Padlock() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 14" width="12" height="14" className="inline-block shrink-0 align-[-2px]" fill="currentColor">
      <path d="M3 6V4a3 3 0 0 1 6 0v2h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h1zm1.5 0h3V4a1.5 1.5 0 0 0-3 0v2z" />
    </svg>
  );
}

export function LockNote({ lock, compact }: { lock: NonNullable<RunsOnModel['lock']>; compact: boolean }) {
  return (
    <div data-testid="route-lock" className={compact ? 'flex items-start gap-1.5 text-sm font-medium text-warning' : 'rounded-chip border border-warning bg-warning-tint p-2.5'}>
      {compact ? <><Padlock /><span>{lock.title}</span></> : (
        <>
          <p className="flex items-center gap-1.5 font-medium text-fg"><Padlock />{lock.title}</p>
          <p className="mt-1 text-sm text-fg">{lock.reason}</p>
        </>
      )}
    </div>
  );
}

/**
 * Where one task's AI runs, and the owner's switch (plan.md §4.2). `compact` is the Pipeline row; the full control is in the task drawers. A change is an owner write
 * of the task override, shown saved and then in force from the snapshot; under the data lock the cloud choices are disabled and say why.
 */
export function RunsOn({ taskId, compact = false }: { taskId: string; compact?: boolean }) {
  const h = useHybrid();
  const t = h?.snapshot?.tasks[taskId];
  if (!h || !t?.route) return null;
  return <RunsOnControl h={h} task={t} route={t.route} compact={compact} />;
}

function RunsOnControl({ h, task, route, compact }: { h: HybridValue; task: TaskView; route: TaskRouteView; compact: boolean }) {
  const id = useId();
  const setting = h.snapshot?.settings.find((s) => s.scope === 'task' && s.key === task.taskId && s.field === 'route_override');
  const facts = useTaskFacts(compact ? null : h, task.taskId, task.revision);
  const m = runsOnModel({ projectId: h.projectId, task, route, setting, live: h.live, browser: h.browser, inputChars: facts?.inputChars ?? null });
  const saved = route.override ?? '';
  const [choice, setChoice] = useState<string>(saved);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setChoice(saved), [saved]);
  const chosen = choice === '' ? null : (choice as RoutePolicyMode);
  const dirty = choice !== saved;
  const offReason = m.clear.disabledReason;

  async function save(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    const r = await sendCommand(h, routeIntent(h.projectId, task.taskId, route, chosen));
    setBusy(false);
    setFeedback(r.ok ? { ok: true, text: `Saved: ${chosen === null ? 'this task uses the run default' : m.options.find((o) => o.mode === chosen)?.label ?? ''}.` } : { ok: false, text: r.text });
    if (!r.ok) setChoice(saved);
  }

  const select = (
    <select
      id={`${id}-select`} value={choice} disabled={offReason !== null || busy} onChange={(e) => setChoice(e.target.value)} aria-describedby={`${id}-now`}
      className={`max-w-full rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-fg ${compact ? 'w-full text-sm' : ''}`}
    >
      <option value="">{m.clear.label}</option>
      {m.options.map((o) => <option key={o.mode} value={o.mode} disabled={o.disabledReason !== null}>{o.label}{o.disabledReason !== null && m.lock ? ' (locked)' : ''}</option>)}
    </select>
  );
  const saveButton = dirty ? <button type="button" className={buttonQuiet} disabled={busy} onClick={() => void save()}>{busy ? 'Saving' : 'Save'}</button> : null;
  const now = <span id={`${id}-now`} data-testid="runs-on-now">{m.current.label} · {m.source}</span>;
  const status = feedback ? <p role="status" className={`text-sm ${feedback.ok ? 'text-fg' : 'text-danger'}`} data-testid="runs-on-feedback">{feedback.text}</p> : <p role="status" className="sr-only" />;

  if (compact) {
    return (
      <div data-testid="runs-on" data-task-id={task.taskId} data-compact="" className="mt-1 min-w-0 space-y-1" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-1.5">
          <label htmlFor={`${id}-select`} className="text-sm text-muted">Runs on</label>
          {select}
          {saveButton}
        </div>
        <p className="text-sm text-muted">{now}</p>
        {m.lock ? <LockNote lock={m.lock} compact /> : null}
        <Chip tone={m.observed.tone}>{m.observed.label}</Chip>
        {status}
      </div>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} data-testid="runs-on" data-task-id={task.taskId} className="space-y-2.5 rounded-chip border border-line p-3">
      <h3 id={`${id}-title`} className="font-medium text-fg">Runs on <span className="text-sm font-normal text-muted">where this task&apos;s AI steps run</span></h3>
      <p className="text-fg">{now}</p>
      {m.lock ? <LockNote lock={m.lock} compact={false} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-select`} className="text-sm text-muted">Change to</label>
        {select}
        {saveButton}
      </div>
      {offReason ? <p className="text-sm text-muted">{offReason}</p> : null}
      <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(6rem,auto)_minmax(0,1fr)]">
        {m.options.map((o) => (
          <div key={o.mode} className="contents">
            <dt className={o.disabledReason !== null && m.lock ? 'text-muted' : 'font-medium text-fg'}>{o.label}</dt>
            <dd className="m-0 text-muted">{o.description}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm" data-testid="runs-on-suggestion"><span className="font-medium text-fg">Suggested: {m.suggestion.label}.</span> <span className="text-muted">{m.suggestion.reason}</span> <span className="text-muted">Our policy, not Firebase&apos;s: Firebase only says whether the device model is ready.</span></p>
      <div className="flex flex-wrap items-center gap-2" data-testid="runs-on-observed">
        <span className="text-sm text-muted">Last call</span><Chip tone={m.observed.tone}>{m.observed.label}</Chip>
        {m.observed.detail ? <span className="text-sm text-fg">{m.observed.detail}</span> : null}
      </div>
      {m.status ? <p className="text-sm" data-testid="runs-on-status"><span className="font-medium text-fg">{m.status.label}.</span> <span className="text-muted">{m.status.detail}</span></p> : null}
      {status}
    </section>
  );
}
