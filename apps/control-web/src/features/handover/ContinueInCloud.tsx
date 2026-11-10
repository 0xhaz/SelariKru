import { useEffect, useId, useRef, useState } from 'react';
import type { HandoverRecordView, HandoverTaskView } from '@selarikru/view-protocol';
import { buttonPrimary, buttonQuiet, Chip, Panel, TONE_TEXT } from '@selarikru/ui';
import type { HandoverPort } from '../../shell/projection-store.ts';
import { costText, HANDOVER_STEPS, inHand, shortSha, stateTone, stepIndex, summarize, timeText } from './model.ts';
import { useHandovers, type HandoverState } from './useHandovers.ts';

/**
 * "Continue in cloud": a task's running local attempt continues as a new attempt on an enrolled cloud-location runner, from the approved base commit with the checked
 * checkpoint applied. The confirmation says what is carried and what never is, and what it is estimated to cost; the record then shows each step of the handover in words.
 * It never claims the running session moves: the combined result is verified again from the start.
 */

const EXCLUSION_WORDS: Readonly<Record<string, string>> = {
  secret_file_name: 'secret-bearing file', secret_content: 'secret-shaped content', outside_allowed_paths: 'outside the allowed paths',
  not_a_regular_file: 'link or special file', reserved_path: 'reserved path', too_large: 'too large to carry',
};

const newKey = (): string => `handover-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The confirmation. Native modal dialog; Escape keeps the task where it is. */
export function HandoverConfirm({ task, mode, title, onConfirm, onKeep }: { task: HandoverTaskView; mode: 'resume' | 'restart'; title: string | null; onConfirm: () => void; onKeep: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      opener?.focus();
    };
  }, []);
  const restart = mode === 'restart';
  const where = restart && task.restart.target === 'local' ? 'on a local runner' : 'on a cloud runner';
  return (
    <dialog ref={ref} data-testid="handover-confirm" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} onCancel={(e) => { e.preventDefault(); onKeep(); }}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-card border border-line-strong bg-panel p-5 text-fg backdrop:bg-backdrop">
      <h2 id={`${id}-title`} className="text-lg font-semibold text-fg">{restart ? 'Restart from persisted input?' : 'Continue in cloud?'}</h2>
      <p id={`${id}-body`} className="mt-2 text-fg wrap-anywhere">
        {restart
          ? `${title ?? 'This task'} stops locally and starts again ${where} from its approved base commit. The local attempt's changes are not carried.`
          : `${title ?? 'This task'} stops locally and continues as a new attempt on a cloud runner, from its approved base commit with its checked changes applied. This is not a migration of the running session, and the result is verified again from the start.`}
      </p>
      <dl className="mt-4 space-y-3 text-sm">
        <div><dt className="font-medium text-muted">Approved base commit</dt><dd className="m-0 break-all font-mono text-mono text-fg" data-testid="handover-base">{task.baseSha ?? 'Unknown'}</dd></div>
        {restart ? null : (
          <div>
            <dt className="font-medium text-muted">What is carried</dt>
            <dd className="m-0 text-fg wrap-anywhere" data-testid="handover-carried">
              The local attempt&apos;s changes against that commit, inside {task.allowedPaths.length > 0 ? task.allowedPaths.join(', ') : 'no allowed paths'}, every file hashed. The exact files and what was left out are shown once the attempt has stopped and its checkpoint is checked.
              {task.current?.patch ? <> Last checkpoint: {task.current.patch.fileCount} file(s), patch {shortSha(task.current.patch.sha256)}.</> : null}
            </dd>
          </div>
        )}
        {restart ? null : (
          <div>
            <dt className="font-medium text-muted">Never carried</dt>
            <dd className="m-0"><ul className="list-disc pl-5 text-fg" data-testid="handover-excludes">{task.excludes.map((x) => <li key={x} className="wrap-anywhere">{x}</li>)}</ul></dd>
          </div>
        )}
        <div><dt className="font-medium text-muted">Estimated cost</dt><dd className="m-0 text-fg" data-testid="handover-cost">{costText(task.estimate.costUsd)} <span className="text-muted">{task.estimate.costUsd.basis}</span></dd></div>
        {restart ? <div><dt className="font-medium text-muted">Work repeated</dt><dd className="m-0 text-fg" data-testid="handover-time">{timeText(task.estimate.timeSeconds)}</dd></div> : null}
      </dl>
      <p className="mt-3 text-sm text-muted"><kbd className="rounded-chip border border-line-strong px-1 font-mono text-mono text-fg">Esc</kbd> keeps it where it is.</p>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" autoFocus className={buttonQuiet} onClick={onKeep}>Keep it where it is</button>
        <button type="button" className={buttonPrimary} onClick={onConfirm}>{restart ? 'Restart from persisted input' : 'Continue in cloud'}</button>
      </div>
    </dialog>
  );
}

function Steps({ record }: { record: HandoverRecordView }) {
  const at = stepIndex(record.state);
  return (
    <ol className="flex flex-wrap gap-2" aria-label="Handover progress" data-testid="handover-steps">
      {HANDOVER_STEPS.map((s, i) => {
        const done = at > i || record.state === 'running';
        const now = at === i;
        return (
          <li key={s.state} aria-current={now ? 'step' : undefined} data-step={s.state} data-now={now} className={`rounded-chip border px-2 py-0.5 text-sm ${now ? 'border-active text-active' : done ? 'border-success text-success' : 'border-line text-muted'}`}>
            <span aria-hidden="true">{now ? '◆ ' : done ? '● ' : '○ '}</span>{s.label}<span className="sr-only">{now ? ' (now)' : done ? ' (done)' : ' (next)'}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** One handover's record: where it is, what was carried and left out, and, for a restart offer, the owner's two choices. */
export function HandoverRecord({ record, live, busy, onDecide }: { record: HandoverRecordView; live: boolean; busy: boolean; onDecide: (choice: 'restart' | 'decline') => void }) {
  return (
    <div className="space-y-3" data-testid="handover-record" data-state={record.state}>
      <div className="flex flex-wrap items-center gap-2"><Chip tone={stateTone(record.state)} testId="handover-state">{record.stateLabel}</Chip><span className="text-sm text-muted">{record.mode === 'restart' ? 'Restart from persisted input' : 'Resume from checkpoint'}, to a {record.target} runner</span></div>
      {record.state !== 'restart_offered' && record.state !== 'declined' && record.state !== 'closed' ? <Steps record={record} /> : null}
      {record.refusal ? (
        <div className="rounded-card border border-warning p-3" data-testid="handover-refusal">
          <p className="text-fg wrap-anywhere"><span className={TONE_TEXT.warning}>Cannot resume safely.</span> {record.refusal.text}</p>
          {record.estimate ? <p className="mt-1 text-sm text-fg" data-testid="handover-restart-cost">A restart from the persisted input repeats the work: {costText(record.estimate.costUsd)}, {timeText(record.estimate.timeSeconds)}.</p> : null}
          {record.state === 'restart_offered' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={buttonPrimary} disabled={!live || busy} onClick={() => onDecide('restart')}>Restart from persisted input</button>
              <button type="button" className={buttonQuiet} disabled={!live || busy} onClick={() => onDecide('decline')}>Keep it where it is</button>
              {!live ? <p className="w-full text-sm text-muted">Not available while the connection is not live.</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="font-medium text-muted">Base commit</dt><dd className="m-0 break-all font-mono text-mono text-fg">{record.baseSha}</dd></div>
        <div><dt className="font-medium text-muted">Fence</dt><dd className="m-0 text-fg">Prior attempt fence {record.priorFence}{record.nextFence !== null ? `; the next attempt starts at fence ${record.nextFence} or later` : '; not fenced yet'}</dd></div>
        {record.patch ? (
          <div className="sm:col-span-2" data-testid="handover-patch">
            <dt className="font-medium text-muted">Checkpoint carried</dt>
            <dd className="m-0 text-fg">
              {record.patch.fileCount} file(s), {record.patch.totalBytes} bytes, patch <span className="break-all font-mono text-mono">{record.patch.sha256}</span>
              <ul className="mt-1 space-y-0.5">{record.patch.files.map((f) => <li key={f.path} className="break-all font-mono text-mono">{f.status} {f.path}</li>)}</ul>
            </dd>
          </div>
        ) : null}
        {record.exclusions.length > 0 ? (
          <div className="sm:col-span-2" data-testid="handover-exclusions">
            <dt className="font-medium text-muted">Not carried</dt>
            <dd className="m-0"><ul className="space-y-0.5">{record.exclusions.map((x) => <li key={x.path} className="text-fg"><span className="break-all font-mono text-mono">{x.path}</span> <span className="text-muted">({EXCLUSION_WORDS[x.reason] ?? x.reason})</span></li>)}</ul></dd>
          </div>
        ) : null}
        {record.latePublishes > 0 ? <div className="sm:col-span-2 text-fg" data-testid="handover-late">The stopped attempt tried to publish {record.latePublishes} time(s) after the handover. Each was refused.</div> : null}
      </dl>
    </div>
  );
}

/** The action for one task: the record when a handover is in hand, else the button with its eligibility in words. */
export function TaskHandover({ task, title, state, live, compact = false }: { task: HandoverTaskView; title: string | null; state: HandoverState; live: boolean; compact?: boolean }) {
  const [confirm, setConfirm] = useState<'resume' | 'restart' | null>(null);
  const describe = useId();
  const s = summarize(task);
  const send = async (mode: 'resume' | 'restart') => {
    setConfirm(null);
    await state.act({ kind: 'request', taskId: task.taskId, mode, idempotencyKey: newKey() });
  };
  const decide = (choice: 'restart' | 'decline') => {
    if (!task.current) return;
    void state.act({ kind: 'decide', taskId: task.taskId, checkpointId: task.current.checkpointId, choice, idempotencyKey: newKey() });
  };
  if (task.current && inHand(task)) {
    return compact
      ? <div data-testid="handover-row" data-task-id={task.taskId}><Chip tone={s.tone} testId="handover-state">{s.label}</Chip></div>
      : <HandoverRecord record={task.current} live={live} busy={state.busy} onDecide={decide} />;
  }
  if (task.status !== 'running') return null;
  const blocked = !live ? 'Not available while the connection is not live.' : s.why;
  return (
    <div className="space-y-1" data-testid={compact ? 'handover-row' : 'handover-action'} data-task-id={task.taskId}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonQuiet} disabled={!s.canResume || !live || state.busy} aria-describedby={blocked ? describe : undefined} aria-label={compact && title ? `Continue in cloud: ${title}` : undefined} onClick={(e) => { e.stopPropagation(); setConfirm('resume'); }}>Continue in cloud</button>
        {s.canRestart && !compact ? <button type="button" className={buttonQuiet} disabled={!live || state.busy} onClick={() => setConfirm('restart')}>Restart from persisted input</button> : null}
      </div>
      {blocked ? <p id={describe} className="text-sm text-muted wrap-anywhere" data-testid="handover-why">{blocked}</p> : null}
      {s.canRestart && !compact ? <p className="text-sm text-muted">A restart {task.restart.target === 'local' ? 'stays on a local runner' : 'runs on a cloud runner'} and repeats the work: {costText(task.estimate.costUsd)}, {timeText(task.estimate.timeSeconds)}.</p> : null}
      {state.error && !compact ? <p role="alert" className="text-sm text-danger wrap-anywhere">{state.error}</p> : null}
      {confirm ? <HandoverConfirm task={task} mode={confirm} title={title} onConfirm={() => void send(confirm)} onKeep={() => setConfirm(null)} /> : null}
    </div>
  );
}

/** In the worker drawer: this attempt's task. Reads the handovers itself, again whenever the projection moves. */
export function DrawerHandover({ port, taskId, title, refreshKey, live }: { port: HandoverPort | null; taskId: string | null; title: string | null; refreshKey: string; live: boolean }) {
  const state = useHandovers(port, refreshKey);
  const task = taskId ? state.view?.tasks.find((t) => t.taskId === taskId) : undefined;
  if (!port || !task || (task.status !== 'running' && !inHand(task))) return null;
  return (
    <section aria-labelledby="drawer-handover" className="mb-4 rounded-card border border-line p-3" data-testid="drawer-handover">
      <h3 id="drawer-handover" className="mb-2 text-sm font-semibold text-fg">Continue in cloud</h3>
      <TaskHandover task={task} title={title} state={state} live={live} />
      <p className="mt-2 text-sm text-muted">{state.view?.notice}</p>
    </section>
  );
}

/** On Decisions: restart offers waiting for the owner, and every continuation that could not resume, with its reason. */
export function HandoverDecisions({ port, refreshKey, live, titleOf }: { port: HandoverPort | null; refreshKey: string; live: boolean; titleOf: (taskId: string) => string | null }) {
  const state = useHandovers(port, refreshKey);
  const refused = (state.view?.records ?? []).filter((r) => r.refusal !== null || r.state === 'restart_offered');
  if (refused.length === 0) return null;
  const offers = refused.filter((r) => r.state === 'restart_offered').length;
  return (
    <Panel title="Continuations that could not resume" labelId="handover-refusals" aside={offers > 0 ? `${offers} waiting for you` : `${refused.length} recorded`}>
      <ul className="space-y-3">
        {refused.map((r) => (
          <li key={r.checkpointId} data-testid="handover-decision" className={`rounded-card border p-4 ${r.state === 'restart_offered' ? 'border-warning' : 'border-line'}`}>
            <h3 className="mb-2 font-medium text-fg wrap-anywhere">{titleOf(r.taskId) ?? r.taskId}</h3>
            <HandoverRecord record={r} live={live} busy={state.busy} onDecide={(choice) => void state.act({ kind: 'decide', taskId: r.taskId, checkpointId: r.checkpointId, choice, idempotencyKey: newKey() })} />
          </li>
        ))}
      </ul>
      {state.error ? <p role="alert" className="mt-2 text-sm text-danger wrap-anywhere">{state.error}</p> : null}
    </Panel>
  );
}
