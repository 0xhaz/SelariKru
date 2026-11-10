import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { EmptyState, Panel, buttonQuiet } from '@selarikru/ui';
import type { DataSourceError } from '@selarikru/view-protocol';
import { ConnectionBanner, NextStep, STATE_COPY } from '../../shell/ConnectionStates.tsx';
import type { ConnectionState } from '../../shell/projection-store.ts';
import { GraphLegend, PipelineGraph } from './PipelineGraph.tsx';
import { PipelineCards, PipelineTable } from './PipelineTable.tsx';
import { useHandovers } from '../handover/useHandovers.ts';
import type { HandoverPort } from '../../shell/projection-store.ts';
import { TaskInspector } from './TaskInspector.tsx';
import { filterRows, type PipelineModel, type PipelineRow, type StageGroup } from './model.ts';
import { pipelinePresentation, type PipelineView as ViewMode } from './presentation.ts';

/** The table fits its nine columns from here; below it, cards carry the same fields. */
const TABLE_MIN = '(min-width: 1180px)';
const GRAPH_MIN = '(min-width: 768px)';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function readHashLink(): { view: string | null; task: string | null } {
  const query = window.location.hash.split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  return { view: params.get('view'), task: params.get('task') };
}

function Heading({ summary, children }: { summary?: string | null; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
        {summary ? <p className="mt-1 text-lg text-muted" data-testid="pipeline-summary">{summary}</p> : null}
      </div>
      {children}
    </div>
  );
}

function ViewToggle({ view, onView }: { view: ViewMode; onView: (v: ViewMode) => void }) {
  const button = (v: ViewMode, label: string) => (
    <button type="button" aria-pressed={view === v} onClick={() => onView(v)} className={`rounded-chip px-3 py-1.5 text-sm font-medium ${view === v ? 'bg-active text-bg' : 'text-fg hover:bg-panel-2'}`}>{label}</button>
  );
  return <div role="group" aria-label="Pipeline view" className="inline-flex gap-1 rounded-chip border border-line-strong p-0.5">{button('table', 'Table')}{button('graph', 'Graph')}</div>;
}

const CHAIN_NOTE: Readonly<Record<PipelineModel['critical']['state'], string>> = {
  known: 'Counted in tasks. No time estimate exists.',
  unknown: 'Filter off until every dependency is known.',
  none: '',
};

function Toolbar({ model, view, onView, graphOk, groupByStage, criticalOnly, shown, total }: { model: PipelineModel; view: ViewMode; onView: (v: ViewMode) => void; graphOk: boolean; groupByStage: boolean; criticalOnly: boolean; shown: number; total: number }) {
  const { setGroupByStage, setCriticalOnly } = pipelinePresentation.getState();
  const chain = model.critical;
  const canFilter = chain.state === 'known';
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line pb-3">
      {graphOk ? <ViewToggle view={view} onView={onView} /> : <p className="text-sm text-muted" data-testid="graph-unavailable">The graph needs a wider screen. This list has the same tasks and dependencies.</p>}
      {view === 'table' || !graphOk ? (
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={groupByStage} onChange={(e) => setGroupByStage(e.target.checked)} />
          Group by stage
        </label>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm" data-testid="critical-control">
        <label className={`flex items-center gap-2 ${canFilter ? 'text-fg' : 'text-muted'}`}>
          <input type="checkbox" disabled={!canFilter} checked={canFilter && criticalOnly} onChange={(e) => setCriticalOnly(e.target.checked)} />
          Longest chain only
        </label>
        <span className={chain.state === 'unknown' ? 'text-warning' : 'text-muted'} data-testid="critical-label">{chain.label}.{CHAIN_NOTE[chain.state] ? ` ${CHAIN_NOTE[chain.state]}` : ''}</span>
      </div>
      {shown !== total ? <p className="ml-auto text-sm text-muted" data-testid="filter-count">Showing {shown} of {total}</p> : null}
    </div>
  );
}

function ReplanNotice({ replan }: { replan: NonNullable<PipelineModel['replan']> }) {
  const list = (label: string, items: readonly string[]): ReactNode => (items.length > 0 ? <p className="wrap-anywhere text-sm"><span className="text-muted">{label}: </span><span className="text-fg">{items.join(', ')}</span></p> : null);
  return (
    <section aria-label="Plan revision" data-testid="replan-notice" className="mb-4 rounded-chip border border-l-4 border-line border-l-warning bg-panel p-3">
      <h2 className="font-medium text-fg">Plan moved to revision {replan.planRevision}</h2>
      <div className="mt-1 space-y-0.5">
        {list('Replanned', replan.replanned)}
        {list('Superseded', replan.superseded)}
        {list('Decisions required', replan.decisions)}
        <p className="text-sm text-muted">{replan.unreported} Earlier revisions cannot be opened yet.</p>
      </div>
    </section>
  );
}

function CycleNotice({ cycle }: { cycle: NonNullable<PipelineModel['cycle']> }) {
  return (
    <section aria-label="Plan error" data-testid="cycle-notice" className="mb-4 rounded-chip border border-danger bg-danger-tint p-3">
      <h2 className="font-medium text-danger">The plan has a cycle and cannot be scheduled</h2>
      <p className="mt-1 wrap-anywhere text-fg">{cycle.text}</p>
      <p className="mt-1 text-sm text-muted">This plan should have been refused by validation. Nothing is scheduled around the cycle; it is outlined below.</p>
    </section>
  );
}

function HighlightNotice({ title, onClear }: { title: string; onClear: () => void }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-chip border border-warning bg-warning-tint px-3 py-2 text-sm" data-testid="highlight-notice">
      <p className="text-fg">Showing what becomes eligible if <span className="font-semibold">{title}</span> is approved and then verified. It does not mean they will finish.</p>
      <button type="button" className={buttonQuiet} onClick={onClear}>Clear</button>
    </div>
  );
}

export interface PipelineViewProps {
  readonly connection: ConnectionState;
  readonly error: DataSourceError | null;
  readonly pipeline: PipelineModel | null;
  readonly confirmedAt: string | null;
  readonly mode: 'mock' | 'live';
  readonly onRestart: () => void;
  readonly leaveDemoHref?: string | undefined;
  readonly failure?: unknown;
  /** Checkpoint continuation: each running task row offers "Continue in cloud" with its eligibility. Absent: the source has none. */
  readonly handover?: HandoverPort | null;
  /** The projection's cursor: the handovers are read again when it moves. */
  readonly refreshKey?: string;
}

export function PipelineView({ connection, error, pipeline, confirmedAt, mode, onRestart, leaveDemoHref, failure, handover = null, refreshKey = '0' }: PipelineViewProps) {
  const handovers = useHandovers(handover, refreshKey);
  if (failure !== undefined) throw failure;
  const presentation = useStore(pipelinePresentation);
  const { view, selectedTaskId, inspecting, groupByStage, criticalOnly, highlightFor } = presentation;
  const tableFits = useMediaQuery(TABLE_MIN);
  const graphOk = useMediaQuery(GRAPH_MIN);
  const effectiveView: ViewMode = graphOk ? view : 'table';

  useEffect(() => {
    pipelinePresentation.getState().applyLink(readHashLink());
  }, []);

  useEffect(() => {
    if (pipeline) pipelinePresentation.getState().reconcile(pipeline.rows.map((r) => r.taskId));
  }, [pipeline]);

  useEffect(() => {
    // Keys this view does not own, such as an open worker drawer's, are kept.
    const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    if (view !== 'table') params.set('view', view);
    else params.delete('view');
    if (selectedTaskId) params.set('task', selectedTaskId);
    else params.delete('task');
    const query = params.toString();
    const url = new URL(window.location.href);
    url.hash = `#/pipeline${query ? `?${query}` : ''}`;
    window.history.replaceState(null, '', url);
  }, [view, selectedTaskId]);

  const selected = pipeline?.rows.find((r) => r.taskId === selectedTaskId) ?? null;
  // The element to return to on close. An opener inside the inspector does not count: it is about to be replaced.
  const opener = useRef<Element | null>(null);
  const open = (id: string): void => {
    if (!pipelinePresentation.getState().inspecting) opener.current = document.activeElement;
    pipelinePresentation.getState().open(id);
  };
  const select = (id: string): void => pipelinePresentation.getState().select(id);

  // Focus returns to whatever opened the inspector, found by task id so a re-sort or a view change cannot strand it.
  const wasInspecting = useRef(false);
  useEffect(() => {
    if (wasInspecting.current && !inspecting) {
      const id = pipelinePresentation.getState().selectedTaskId;
      const trigger = opener.current instanceof HTMLElement && opener.current.isConnected && opener.current.closest<HTMLElement>('[data-task-id]')?.dataset['taskId'] === id ? opener.current : null;
      const fallback = id ? document.querySelector<HTMLElement>(`[data-open-task="${CSS.escape(id)}"]`) : null;
      (trigger ?? fallback ?? document.getElementById('main'))?.focus();
    }
    wasInspecting.current = inspecting;
  }, [inspecting]);

  const shownRows: readonly PipelineRow[] = useMemo(() => (pipeline ? filterRows(pipeline.rows, pipeline.critical, { criticalOnly }) : []), [pipeline, criticalOnly]);
  const groups = useMemo((): readonly StageGroup[] => {
    if (!pipeline) return [];
    const shown = new Set(shownRows.map((r) => r.taskId));
    return pipeline.stages.map((g) => ({ ...g, rows: g.rows.filter((r) => shown.has(r.taskId)) })).filter((g) => g.rows.length > 0);
  }, [pipeline, shownRows]);
  const flatGroups: readonly StageGroup[] = useMemo(() => [{ id: 'build', label: 'All', rows: shownRows }], [shownRows]);

  if (!pipeline) {
    return (
      <>
        <Heading />
        {(connection === 'unavailable' || connection === 'dead') ? (
          <section aria-label="Connection" className="rounded-card border border-line bg-panel">
            <EmptyState title="Project data is unavailable" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} />}>
              <p>{STATE_COPY.unavailable[mode]}</p>
              <p className="mt-2">No task table or graph is shown until a real source provides one.</p>
              {error ? <p className="mt-2 text-sm">Error category <span className="font-mono text-mono">{error.code}</span></p> : null}
            </EmptyState>
          </section>
        ) : <p role="status" className="text-muted">Loading project state</p>}
      </>
    );
  }

  const highlightTitle = highlightFor ? (pipeline.rows.find((r) => r.taskId === highlightFor)?.title ?? null) : null;
  const highlight = highlightFor && highlightTitle !== null ? (pipeline.rows.find((r) => r.taskId === highlightFor)?.ifApproved?.eligible.map((t) => t.taskId) ?? []) : [];
  const flat = !groupByStage;

  return (
    <>
      <Heading summary={pipeline.summary}>
        {pipeline.runs.length > 1 ? (
          <div>
            <label htmlFor="pipeline-run" className="mb-1 block text-sm text-muted">Run</label>
            <select id="pipeline-run" className="max-w-52 rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-sm text-fg" value={pipeline.runId ?? ''} onChange={(e) => pipelinePresentation.getState().setRun(e.target.value)}>
              {pipeline.runs.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        ) : null}
      </Heading>
      <ConnectionBanner connection={connection} error={error} onRestart={onRestart} observedAt={confirmedAt} />
      {pipeline.empty ? (
        <section aria-label="Tasks" className="rounded-card border border-line bg-panel">
          <EmptyState title="No plan yet" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} />}>
            <p>{mode === 'mock' ? 'This demo project has no tasks. Choose another fixture in the demo controls below.' : 'Tasks appear here once a plan is accepted. Nothing is scheduled before then.'}</p>
          </EmptyState>
        </section>
      ) : (
        <>
          {pipeline.cycle ? <CycleNotice cycle={pipeline.cycle} /> : null}
          {pipeline.replan ? <ReplanNotice replan={pipeline.replan} /> : null}
          <Panel title="Tasks" labelId="pipeline-tasks-title" aside={pipeline.simulated ? 'Simulated, not evidence' : null}>
            <Toolbar model={pipeline} view={effectiveView} onView={(v) => pipelinePresentation.getState().setView(v)} graphOk={graphOk} groupByStage={groupByStage} criticalOnly={criticalOnly} shown={shownRows.length} total={pipeline.rows.length} />
            {highlightTitle && effectiveView === 'graph' ? <HighlightNotice title={highlightTitle} onClear={() => pipelinePresentation.getState().setHighlightFor(null)} /> : null}
            {shownRows.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-muted">No task is on the longest chain.</p>
                <button type="button" className={`${buttonQuiet} mt-3`} onClick={() => pipelinePresentation.getState().setCriticalOnly(false)}>Clear filter</button>
              </div>
            ) : effectiveView === 'graph' ? (
              <>
                <PipelineGraph rows={shownRows} edges={pipeline.edges} selectedId={selectedTaskId} highlight={highlight} onSelect={select} onOpen={open} />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-2">
                  <GraphLegend rows={shownRows} edges={pipeline.edges} />
                  <p className="text-sm text-muted">Arrow keys follow dependencies. Enter inspects.</p>
                </div>
              </>
            ) : tableFits ? (
              <PipelineTable groups={flat ? flatGroups : groups} flat={flat} selectedId={selectedTaskId} onOpen={open} handovers={handovers} live={connection === 'live'} />
            ) : (
              <PipelineCards groups={flat ? flatGroups : groups} flat={flat} selectedId={selectedTaskId} onOpen={open} handovers={handovers} live={connection === 'live'} />
            )}
            <p className="mt-3 border-t border-line pt-2 text-sm text-muted">{pipeline.stageNote}</p>
          </Panel>
        </>
      )}
      {selected && inspecting ? <TaskInspector key="inspector" row={selected} mode={mode} simulated={pipeline.simulated} canShowGraph={graphOk} onClose={() => pipelinePresentation.getState().closeInspector()} onOpen={open} onShowApproval={(id) => pipelinePresentation.getState().showApprovalEffect(id)} /> : null}
    </>
  );
}
