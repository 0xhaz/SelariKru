import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Chip, buttonQuiet, formatExact } from '@selarikru/ui';
import { DemoBadge } from '../../data-source/DemoBadge.tsx';
import { roleName } from '../team/TeamSignals.tsx';
import { Note } from './ui.tsx';
import { stageLabel, type BlockCause, type PipelineRow, type TaskLink } from './model.ts';

const Exact = ({ iso }: { iso: string }) => <time dateTime={iso}>{formatExact(iso)}</time>;

const CAUSE_TEXT: Readonly<Record<BlockCause, string>> = {
  policy: 'text-danger', budget: 'text-danger', approval: 'text-warning', claim: 'text-warning', placement: 'text-danger', gate: 'text-danger', worker: 'text-danger', cycle: 'text-danger', dependency: 'text-fg', capacity: 'text-fg', other: 'text-warning', unstated: 'text-warning',
};

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section aria-label={title} data-testid={testId}>
      <h3 className="mb-1.5 font-medium text-fg">{title}</h3>
      {children}
    </section>
  );
}

function TaskLinks({ items, onOpen }: { items: readonly TaskLink[]; onOpen: (id: string) => void }) {
  return (
    <ul className="space-y-1">
      {items.map((t) => (
        <li key={t.taskId} className="flex flex-wrap justify-between gap-2 wrap-anywhere">
          <button type="button" className="rounded-chip text-left text-active underline underline-offset-2" onClick={() => onOpen(t.taskId)}>{t.title}</button>
          <span className="text-sm text-muted">{t.status}</span>
        </li>
      ))}
    </ul>
  );
}

export interface InspectorProps {
  readonly row: PipelineRow;
  readonly mode: 'mock' | 'live';
  readonly simulated: boolean;
  readonly canShowGraph: boolean;
  readonly onClose: () => void;
  readonly onOpen: (id: string) => void;
  readonly onShowApproval: (id: string) => void;
}

export function TaskInspector({ row, mode, simulated, canShowGraph, onClose, onOpen, onShowApproval }: InspectorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // Jumping to another task through the inspector keeps the drawer open; focus and reading start again at its title.
  useEffect(() => {
    titleRef.current?.focus();
  }, [row.taskId]);

  // In StrictMode the effect above closes and reopens, queueing a close event for a dialog that is open again. Only a real close counts.
  const onDialogClose = (): void => {
    if (dialogRef.current?.open) return;
    onClose();
  };

  const why = row.why;
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      data-testid="task-inspector"
      onClose={onDialogClose}
      onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}
      className="wrap-anywhere fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-full border-0 border-l border-line-strong bg-panel p-0 text-fg backdrop:bg-backdrop sm:w-[34rem]"
    >
      <div className="flex h-full flex-col overflow-y-auto overscroll-contain">
        <header className="border-b border-line p-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={titleId} ref={titleRef} tabIndex={-1} className="text-lg font-semibold text-fg outline-none">{row.title}</h2>
              <p className="mt-0.5 text-sm text-muted">{roleName(row.role)} · {stageLabel(row.stage)} · Task rev {row.revision}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <DemoBadge mode={mode} testId="inspector-demo-badge" />
              <button type="button" className={buttonQuiet} onClick={() => dialogRef.current?.close()}>Close</button>
            </div>
          </div>
          <div className="mt-2"><Chip tone={row.state.tone}>{row.state.label}</Chip></div>
        </header>

        <div className="flex-1 space-y-5 p-4 sm:px-6">
          {simulated ? <Note>Simulated data. It is not evidence.</Note> : null}

          {why.held ? (
            <section aria-label="Why blocked?" data-testid="why-blocked" className="rounded-chip border border-line-strong bg-panel-2 p-3">
              <h3 className="font-medium text-fg">Why blocked?</h3>
              <ul className="mt-1.5 space-y-2.5">
                {why.reasons.map((r, i) => (
                  <li key={i} data-cause={r.cause} className="wrap-anywhere">
                    <span className={`text-sm font-medium ${CAUSE_TEXT[r.cause]}`}>{r.label}{r.unknown ? ' (unknown)' : ''}: </span>
                    <span className="text-fg">{r.text}</span>
                    {r.code ? <span className="mt-0.5 block break-all font-mono text-mono text-muted">{r.code}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-muted">Next: <span className="text-fg">{row.nextAction}</span></p>
            </section>
          ) : (
            <Section title="Status"><p className="text-fg">{row.reason ?? 'Nothing is holding this task.'} <span className="text-muted">{row.nextAction}</span></p></Section>
          )}

          {row.ifApproved ? (
            <Section title="What changes if I approve?" testId="if-approved">
              <p className="text-fg">{row.ifApproved.text}</p>
              {row.ifApproved.eligible.length > 0 ? (
                <div className="mt-2">
                  <Note>Becomes eligible once this task is verified:</Note>
                  <TaskLinks items={row.ifApproved.eligible} onOpen={onOpen} />
                </div>
              ) : <Note>No other task becomes eligible from this alone.</Note>}
              {row.ifApproved.stillWaiting.length > 0 ? (
                <div className="mt-2">
                  <Note>Still waits on other work:</Note>
                  <TaskLinks items={row.ifApproved.stillWaiting} onOpen={onOpen} />
                </div>
              ) : null}
              {canShowGraph && row.ifApproved.eligible.length > 0 ? <button type="button" className={`${buttonQuiet} mt-2`} onClick={() => onShowApproval(row.taskId)}>Show on the graph</button> : null}
            </Section>
          ) : null}

          <Section title="Inputs">
            {row.predecessors === null ? <Note>Not known yet. A dependency may exist that this snapshot does not list.</Note> : row.predecessors.length === 0 ? <Note>None.</Note> : (
              <ul className="space-y-1">
                {row.predecessors.map((p) => (
                  <li key={p.taskId} className="flex flex-wrap justify-between gap-2 wrap-anywhere">
                    <button type="button" className="rounded-chip text-left text-active underline underline-offset-2 disabled:text-muted disabled:no-underline" disabled={p.edge === 'unknown'} onClick={() => onOpen(p.taskId)}>{p.title}</button>
                    <span className="text-sm text-muted">{p.note ?? p.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Outputs">{row.dependents.length === 0 ? <Note>No task depends on this one.</Note> : <TaskLinks items={row.dependents} onOpen={onOpen} />}</Section>

          <Section title="Lease and attempts">
            <p className="mb-1 text-sm text-muted">{row.owner.workerId ? <>Held by <span className="font-mono text-mono text-fg">{row.owner.workerId}</span></> : 'No worker holds this task now.'}</p>
            {row.attempts.length === 0 ? <Note>No attempts yet.</Note> : (
              <ul className="space-y-1">
                {row.attempts.map((a, i) => <li key={i} className="flex flex-wrap justify-between gap-2 text-sm"><span className="text-fg">{a.label}</span><span className="text-muted"><Exact iso={a.at} /></span></li>)}
              </ul>
            )}
          </Section>

          <Section title="Checks">
            {row.checkLines.length === 0 ? <Note>No checks have reported for this task yet.</Note> : (
              <ul className="space-y-2">
                {row.checkLines.map((c) => (
                  <li key={c.checkId}>
                    <div className="flex flex-wrap items-center justify-between gap-2"><Chip tone={c.tone}>{c.label}</Chip><span className="break-all font-mono text-mono text-muted">{c.checkId}</span></div>
                    {c.summary ? <p className="mt-1 text-fg">{c.summary}</p> : null}
                    <p className="text-sm text-muted"><Exact iso={c.at} /></p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Timing">
            <p className="text-sm text-muted">In this state since <span className="text-fg"><Exact iso={row.since} /></span> ({row.age}).</p>
          </Section>

          <Section title="Accepted revision"><p className="text-fg">{row.accepted}</p></Section>

          <Note>Scope, per-task criteria, artifact contents and the branch are not reported in this snapshot.</Note>
        </div>

        <footer className="border-t border-line px-4 py-2 text-sm text-muted sm:px-6">Read-only. Closing this does not affect the task.</footer>
      </div>
    </dialog>
  );
}
