import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { AxisBadges, Chip, buttonQuiet, formatExact, type Tone } from '@selarikru/ui';
import { DemoBadge } from '../../data-source/DemoBadge.tsx';
import { decisionHref } from '../../shell/route.ts';
import { ActivitySignalView, HealthSignalView, PROVENANCE_CHIP, ResultSignalView, roleName } from './TeamSignals.tsx';
import type { Fact, TeamRow, WorkerDetail } from './model.ts';
import { TaskModelOverride } from './ModelAssignments.tsx';

const TABS = [
  { id: 'task', label: 'Task' }, { id: 'timeline', label: 'Timeline' }, { id: 'checks', label: 'Checks' }, { id: 'artifacts', label: 'Artifacts' },
  { id: 'permissions', label: 'Permissions' }, { id: 'sandbox', label: 'Sandbox' }, { id: 'usage', label: 'Usage' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const Exact = ({ iso }: { iso: string }) => <time dateTime={iso}>{formatExact(iso)}</time>;

function Facts({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)]">
      {facts.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-sm text-muted">{f.label}</dt>
          <dd className={`m-0 wrap-anywhere text-fg ${f.mono ? 'font-mono text-mono' : ''}`}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted">{children}</p>;
const Empty = ({ children }: { children: ReactNode }) => <p className="py-2 text-muted">{children}</p>;
const SIMULATED_NOTE = <p className="mb-3 text-sm text-warning">Simulated data. It is not evidence.</p>;

type AssignProps = Omit<Parameters<typeof TaskModelOverride>[0], 'target'>;

function TaskPanel({ detail, row, assign }: { detail: WorkerDetail; row: TeamRow; assign: AssignProps }) {
  const t = detail.task;
  return (
    <div className="space-y-4">
      {detail.blockers.length > 0 ? (
        <section aria-label="Blockers" className="rounded-chip border border-warning bg-warning-tint p-3">
          <h3 className="font-medium text-warning">Blocked by</h3>
          <ul className="mt-1 space-y-2">
            {detail.blockers.map((b, i) => (
              <li key={i} className="wrap-anywhere">
                <span className="text-sm text-muted">{b.kind}: </span><span className="text-fg">{b.text}</span>
                {b.code ? <span className="mt-0.5 block break-all font-mono text-mono text-muted">{b.code}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {t ? (
        <>
          <section aria-label="Task summary">
            {!t.current ? <p className="mb-1 text-sm text-muted">No task is assigned now. This is the last work it did.</p> : null}
            <p className="text-lg font-semibold wrap-anywhere text-fg">{t.title}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Chip tone={t.statusTone}>{t.statusLabel}</Chip>
              <span className="text-sm text-muted">Revision {t.revision}</span>
              {t.role ? <span className="text-sm text-muted">{roleName(t.role)}</span> : null}
            </div>
            {t.reason && !detail.blockers.some((b) => b.code === t.reasonCode) ? <p className="mt-2 wrap-anywhere text-fg">{t.reason} {t.reasonCode ? <span className="block break-all font-mono text-mono text-muted">{t.reasonCode}</span> : null}</p> : null}
          </section>
          <section aria-label="Dependencies">
            <h3 className="mb-1 font-medium text-fg">Dependencies</h3>
            {t.dependencies === null ? <Note>Not known yet.</Note> : t.dependencies.length === 0 ? <Note>None.</Note> : (
              <ul className="space-y-1">
                {t.dependencies.map((d) => <li key={d.taskId} className="flex flex-wrap justify-between gap-2 wrap-anywhere"><span className="text-fg">{d.title}</span><span className="text-sm text-muted">{d.status}</span></li>)}
              </ul>
            )}
          </section>
          <Facts facts={[
            { label: 'Run', value: t.runId, mono: true },
            ...(t.attempt ? [{ label: 'Attempt', value: t.attempt }] : []),
            ...(t.runCriteria ? [{ label: 'Run progress', value: t.runCriteria }] : []),
          ]} />
          {t.current ? <Note>Accepted contract versions, per-task criteria and the branch or pull request are not reported in this snapshot.</Note> : null}
        </>
      ) : <Empty>No task has been assigned to this worker.</Empty>}
      {row.overrideTarget ? <TaskModelOverride {...assign} target={row.overrideTarget} /> : null}
    </div>
  );
}

function TimelinePanel({ detail }: { detail: WorkerDetail }) {
  return (
    <div>
      {detail.timeline.length > 0 ? <p className="mb-3 text-sm text-muted">Built from what this snapshot records. The full event history is not connected.</p> : null}
      {detail.timeline.length === 0 ? <Empty>Nothing recorded for this worker yet.</Empty> : (
        <ol className="space-y-3">
          {detail.timeline.map((e, i) => (
            <li key={`${e.at}-${i}`} className="border-l-2 border-line-strong pl-3">
              <p className="wrap-anywhere text-fg">{e.label} <span className="text-sm text-muted">{e.source}</span></p>
              {e.detail ? <p className="wrap-anywhere text-sm text-muted">{e.detail}</p> : null}
              <p className="text-sm text-muted"><Exact iso={e.at} /></p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ChecksPanel({ detail, simulated }: { detail: WorkerDetail; simulated: boolean }) {
  return (
    <div>
      {simulated ? SIMULATED_NOTE : null}
      <p className="mb-3 text-sm text-muted">A check that has started is not a passing check.</p>
      {detail.checks.length === 0 ? <Empty>No checks have reported for this task yet.</Empty> : (
        <ul className="space-y-3">
          {detail.checks.map((c) => (
            <li key={c.checkId} className="rounded-chip border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><Chip tone={c.tone}>{c.label}</Chip><span className="break-all font-mono text-mono text-muted">{c.checkId}</span></div>
              {c.summary ? <p className="mt-2 wrap-anywhere text-fg">{c.summary}</p> : null}
              <p className="mt-1 text-sm text-muted"><Exact iso={c.at} /></p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArtifactsPanel({ detail, simulated }: { detail: WorkerDetail; simulated: boolean }) {
  return (
    <div>
      {simulated ? SIMULATED_NOTE : null}
      {detail.artifacts.length === 0 ? <Empty>No artifacts recorded yet.</Empty> : (
        <ul className="space-y-3">
          {detail.artifacts.map((a) => (
            <li key={a.ref}>
              <p className="wrap-anywhere text-fg">{a.label}</p>
              <p className="break-all font-mono text-mono text-muted">{a.ref}</p>
              <p className="text-sm text-muted"><Exact iso={a.at} /></p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PermissionsPanel({ detail }: { detail: WorkerDetail }) {
  return (
    <div>
      <p className="mb-3 text-sm text-muted">Requests for this task. Inspecting here grants nothing.</p>
      {detail.permissions.length === 0 ? <Empty>No permission requests for this task.</Empty> : (
        <ul className="space-y-3">
          {detail.permissions.map((p) => (
            <li key={p.approvalId} className="rounded-chip border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="wrap-anywhere text-fg">{p.reason}</span><Chip tone={p.tone}>{p.state}</Chip></div>
              <dl className="mt-2 grid gap-x-3 gap-y-1 text-sm text-muted sm:grid-cols-[auto_1fr]">
                <dt>Reason code</dt><dd className="m-0 break-all font-mono text-mono">{p.reasonCode ?? 'None recorded'}</dd>
                <dt>Scope</dt><dd className="m-0 break-all font-mono text-mono">{p.scopeHash ?? 'Not recorded'}</dd>
                <dt>Requested</dt><dd className="m-0"><Exact iso={p.requestedAt} /></dd>
                {p.expiresAt ? <><dt>Expires</dt><dd className="m-0"><Exact iso={p.expiresAt} /></dd></> : null}
                {p.resolvedAt ? <><dt>Resolved</dt><dd className="m-0"><Exact iso={p.resolvedAt} /></dd></> : null}
              </dl>
              {p.state === 'Pending' || p.state === 'Expired' ? <a className="mt-2 inline-block text-sm font-medium text-active underline underline-offset-2" href={decisionHref(`decision:${p.approvalId}`)}>Open in Decisions</a> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UsagePanel({ detail }: { detail: WorkerDetail }) {
  if (detail.usage.length === 0) return <Empty>No usage figures reported for this task.</Empty>;
  return (
    <div>
      <p className="mb-3 text-sm text-muted">Figures cover the whole task, across its attempts. Each keeps its source. Unavailable means unknown, not zero.</p>
      <ul className="divide-y divide-line">
        {detail.usage.map((u) => (
          <li key={u.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 py-2">
            <span className="text-fg">{u.metric}</span>
            <span className="flex items-center justify-end gap-2">
              <span className="font-semibold text-fg">{u.value}</span>
              <Chip tone={PROVENANCE_CHIP[u.provenance]!.tone}>{PROVENANCE_CHIP[u.provenance]!.text}</Chip>
            </span>
            <span className="col-span-2 break-all font-mono text-mono text-muted">{u.source}{u.attempt ? ` · ${u.attempt}` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MIN_WIDTH = 440;
const maxWidth = (): number => Math.max(MIN_WIDTH, Math.min(window.innerWidth - 120, 1100));
const clampWidth = (w: number): number => Math.min(maxWidth(), Math.max(MIN_WIDTH, w));

export function WorkerDrawer({ row, mode, simulated, wide, nowMs, onClose, assign }: { row: TeamRow; mode: 'mock' | 'live'; simulated: boolean; wide: boolean; nowMs: number; onClose: () => void; assign: AssignProps }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const titleId = useId();
  const tabsId = useId();
  const [tab, setTab] = useState<TabId>('task');
  const [width, setWidth] = useState(() => clampWidth(640));
  const [maximized, setMaximized] = useState(false);
  const dragging = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    tabRefs.current.task?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // In StrictMode the effect above closes and reopens, queueing a close event for a dialog that is open again. Only a real close counts.
  const onDialogClose = (): void => {
    if (dialogRef.current?.open) return;
    onClose();
  };

  const onDialogClick = (e: MouseEvent<HTMLDialogElement>): void => {
    if (e.target !== dialogRef.current) return;
    const box = dialogRef.current!.getBoundingClientRect();
    const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    if (!inside) dialogRef.current!.close();
  };

  const selectTab = (id: TabId, focus: boolean): void => {
    setTab(id);
    if (focus) tabRefs.current[id]?.focus();
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    selectTab(TABS[next]!.id, true);
  };

  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowLeft' ? 40 : e.key === 'ArrowRight' ? -40 : 0;
    if (step !== 0) {
      e.preventDefault();
      setWidth((w) => clampWidth(w + step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setWidth(MIN_WIDTH);
    } else if (e.key === 'End') {
      e.preventDefault();
      setWidth(maxWidth());
    }
  };
  const onResizeDown = (e: PointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragging.current) setWidth(clampWidth(window.innerWidth - e.clientX));
  };

  const stopResize = (): void => {
    dragging.current = false;
  };

  const { detail } = row;
  const widthStyle = wide ? { width: maximized ? '100vw' : `${width}px` } : undefined;
  const canResize = wide && !maximized;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      data-testid="worker-drawer"
      onClose={onDialogClose}
      onClick={onDialogClick}
      style={widthStyle}
      className="wrap-anywhere fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-full border-0 border-l border-line-strong bg-panel p-0 text-fg backdrop:bg-backdrop sm:w-[36rem]"
    >
        {canResize ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Drawer width"
            aria-valuenow={width}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={maxWidth()}
            tabIndex={0}
            onKeyDown={onResizeKey}
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={stopResize}
            onPointerCancel={stopResize}
            onLostPointerCapture={stopResize}
            className="group absolute inset-y-0 left-0 z-10 flex w-6 cursor-col-resize touch-none justify-center"
          >
            <span aria-hidden="true" className="h-full w-0.5 bg-transparent group-hover:bg-active group-focus-visible:bg-active" />
          </div>
        ) : null}

      <div className="flex h-full flex-col overflow-y-auto overscroll-contain">
        <header className="border-b border-line p-4 sm:pl-6">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold text-fg">{roleName(row.role)} worker</h2>
              <p className="break-all font-mono text-mono text-muted">{row.workerId}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <DemoBadge mode={mode} testId="drawer-demo-badge" />
              {wide ? <button type="button" className={buttonQuiet} onClick={() => setMaximized((m) => !m)}>{maximized ? 'Restore' : 'Maximize'}</button> : null}
              <button type="button" className={buttonQuiet} onClick={() => dialogRef.current?.close()}>Close</button>
            </div>
          </div>
          {detail.summary !== row.activity.label ? <p className="mt-2 wrap-anywhere text-fg" data-testid="drawer-summary">{detail.summary}</p> : null}
          <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div><dt className="mb-1 text-sm font-medium text-muted">Activity</dt><dd className="m-0"><ActivitySignalView row={row} /></dd></div>
            <div><dt className="mb-1 text-sm font-medium text-muted">Health</dt><dd className="m-0"><HealthSignalView row={row} nowMs={nowMs} /></dd></div>
            <div><dt className="mb-1 text-sm font-medium text-muted">Results</dt><dd className="m-0"><ResultSignalView row={row} nowMs={nowMs} /></dd></div>
          </dl>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line pt-2">
            <AxisBadges execution={row.execution} modelRoute={row.modelRoute} model={row.modelDetail} />
            <p className="text-sm text-muted" data-testid="drawer-confirmed">Last confirmed <Exact iso={row.lastConfirmedAt} /></p>
          </div>
        </header>

        <div role="tablist" aria-label="Worker detail" className="sticky top-0 z-10 flex flex-wrap gap-1 border-b border-line bg-panel px-2 sm:px-4">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${tabsId}-${t.id}`}
              ref={(el) => { tabRefs.current[t.id] = el; }}
              aria-selected={tab === t.id}
              aria-controls={`${tabsId}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => selectTab(t.id, false)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={`border-b-2 px-2.5 py-2 text-sm font-medium ${tab === t.id ? 'border-active text-fg' : 'border-transparent text-muted hover:text-fg'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`} tabIndex={0} className="flex-1 p-4 sm:px-6" data-testid="drawer-panel">
          {tab === 'task' ? <TaskPanel detail={detail} row={row} assign={assign} /> : null}
          {tab === 'timeline' ? <TimelinePanel detail={detail} /> : null}
          {tab === 'checks' ? <ChecksPanel detail={detail} simulated={simulated} /> : null}
          {tab === 'artifacts' ? <ArtifactsPanel detail={detail} simulated={simulated} /> : null}
          {tab === 'permissions' ? <PermissionsPanel detail={detail} /> : null}
          {tab === 'sandbox' ? <Facts facts={[...detail.sandbox]} /> : null}
          {tab === 'usage' ? <UsagePanel detail={detail} /> : null}
        </div>

        <footer className="border-t border-line px-4 py-2 text-sm text-muted sm:px-6">
          Inspecting is read-only. Closing this does not affect the worker; a model saved here applies only to its next attempt.
        </footer>
      </div>
    </dialog>
  );
}
