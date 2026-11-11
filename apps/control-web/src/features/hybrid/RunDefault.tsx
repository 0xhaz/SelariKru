import { useEffect, useId, useState } from 'react';
import type { RoutePolicyMode } from '@selarikru/domain';
import { Panel, buttonQuiet } from '@selarikru/ui';
import { currentRun, settingStatus, SETTINGS_OFF } from '../settings/model.ts';
import { sendCommand, useHybrid } from './context.tsx';
import { RUNS_ON } from './model.ts';

const ORIGIN: Readonly<Record<'setting' | 'onboarding' | 'unset', string>> = {
  setting: 'Saved here.',
  onboarding: 'Seeded from the choice made at setup.',
  unset: 'Not set: AI steps without their own route are blocked until you choose. Missing is never a default.',
};

/** Settings › Workflow: "New tasks run on", the run's default route for its tasks' AI steps. The same four choices as each task's "Runs on". */
export function RunDefaultPanel() {
  const h = useHybrid();
  const id = useId();
  const snapshot = h?.snapshot ?? null;
  const run = snapshot ? currentRun(snapshot) : null;
  const policy = run?.routePolicy;
  const saved = policy?.value ?? '';
  const [choice, setChoice] = useState<string>(saved);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setChoice(saved), [saved]);
  if (!h || !snapshot || !run || !policy) {
    return (
      <Panel title="New tasks run on" labelId="settings-route-title">
        <p className="text-muted" data-testid="run-default-missing">The server reports no route policy for this run, so none is shown. Nothing is invented in its place.</p>
      </Panel>
    );
  }
  const setting = snapshot.settings.find((s) => s.scope === 'run' && s.key === run.runId && s.field === 'route_policy');
  const status = settingStatus(setting);
  const off = h.live ? null : SETTINGS_OFF;
  async function save(): Promise<void> {
    if (!h || !run || !policy || choice === '') return;
    setBusy(true);
    setFeedback(null);
    const r = await sendCommand(h, { command: 'setting.set', expectedRevision: policy.revision, args: { projectId: h.projectId, key: run.runId, change: { scope: 'run', field: 'route_policy', value: choice as RoutePolicyMode } } });
    setBusy(false);
    setFeedback(r.ok ? { ok: true, text: `Saved: new tasks run ${RUNS_ON.find((o) => o.mode === choice)?.label ?? ''}.` } : { ok: false, text: r.text });
    if (!r.ok) setChoice(saved);
  }
  return (
    <Panel title="New tasks run on" labelId="settings-route-title">
      <div data-testid="run-default" className="space-y-2.5">
        <p className="text-fg">Where a task&apos;s AI steps run when the task has no route of its own. This is assistant inference; where a worker&apos;s sandbox runs is set separately.</p>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-s`} className="text-sm text-muted">Run {run.runId}</label>
          <select id={`${id}-s`} value={choice} disabled={off !== null || busy} onChange={(e) => setChoice(e.target.value)} aria-describedby={`${id}-o`} className="rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-fg">
            {saved === '' ? <option value="" disabled>Choose one</option> : null}
            {RUNS_ON.map((o) => <option key={o.mode} value={o.mode}>{o.label}</option>)}
          </select>
          {choice !== saved && choice !== '' ? <button type="button" className={buttonQuiet} disabled={busy} onClick={() => void save()}>{busy ? 'Saving' : 'Save'}</button> : null}
        </div>
        <p className="text-sm text-muted" data-testid="run-default-origin">{ORIGIN[policy.origin]}</p>
        {off ? <p className="text-sm text-muted">{off}</p> : null}
        <dl id={`${id}-o`} className="grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(6rem,auto)_minmax(0,1fr)]">
          {RUNS_ON.map((o) => <div key={o.mode} className="contents"><dt className="font-medium text-fg">{o.label}</dt><dd className="m-0 text-muted">{o.description}</dd></div>)}
        </dl>
        <p className="text-sm text-muted">A task set on its own route keeps it, and restricted data always stays on this device.</p>
        {status ? <p className="text-sm"><span className="font-medium text-fg">{status.label}.</span> <span className="text-muted">{status.detail}</span></p> : null}
        <p role="status" className={`text-sm ${feedback?.ok === false ? 'text-danger' : 'text-fg'}`}>{feedback?.text ?? ''}</p>
      </div>
    </Panel>
  );
}
