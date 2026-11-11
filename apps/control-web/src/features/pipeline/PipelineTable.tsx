import type { ReactNode } from 'react';
import { Chip, RAIL_BORDER, RAIL_SHADOW, Timestamp } from '@selarikru/ui';
import { roleName } from '../team/TeamSignals.tsx';
import { Muted } from './ui.tsx';
import { decisionHref } from '../../shell/route.ts';
import { PIPELINE_COLUMNS, stageLabel, type Predecessor, type PipelineRow, type StageGroup } from './model.ts';
import { TaskHandover } from '../handover/ContinueInCloud.tsx';
import type { HandoverState } from '../handover/useHandovers.ts';
import { RunsOn } from '../hybrid/RunsOn.tsx';

/** The handovers, for each row's "Continue in cloud". Null: the source has none. */
type Handovers = { readonly handovers?: HandoverState | null; readonly live?: boolean };

const EDGE_TEXT: Readonly<Record<Predecessor['edge'], string>> = { met: 'text-muted', waiting: 'text-fg', stale: 'text-warning', unknown: 'text-warning', cycle: 'text-danger' };
const EDGE_WORD: Readonly<Record<Predecessor['edge'], string>> = { met: '', waiting: 'waiting', stale: 'stale', unknown: 'unknown', cycle: 'cycle' };

/** Dragging across a row to copy text ends in a click on the row. That is not a request to inspect the task. */
const hasTextSelection = (): boolean => {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
};

function PredecessorList({ row }: { row: PipelineRow }) {
  if (row.predecessors === null) return <span className="text-warning">Not known yet</span>;
  if (row.predecessors.length === 0) return <Muted>None</Muted>;
  return (
    <ul className="space-y-0.5">
      {row.predecessors.map((p) => (
        <li key={p.taskId} className="wrap-anywhere text-sm">
          <span className="text-fg">{p.title}</span>
          {' '}<span className={`whitespace-nowrap ${EDGE_TEXT[p.edge]}`}>{EDGE_WORD[p.edge] ? `· ${EDGE_WORD[p.edge]}` : '· met'}</span>
        </li>
      ))}
    </ul>
  );
}

function StateCell({ row, onOpen, handovers = null, live = false }: { row: PipelineRow; onOpen: (id: string) => void } & Handovers) {
  const handover = handovers?.view?.tasks.find((t) => t.taskId === row.taskId);
  return (
    <div className="min-w-0 space-y-1">
      <Chip tone={row.state.tone}>{row.state.label}</Chip>
      {row.reason ? <p className="wrap-anywhere text-sm text-fg">{row.reason}</p> : null}
      {row.why.held ? <button type="button" className="rounded-chip text-sm font-medium text-active underline underline-offset-2" data-why-task={row.taskId} onClick={(e) => { e.stopPropagation(); onOpen(row.taskId); }}>Why blocked?</button> : null}
      {handover && handovers ? <div onClick={(e) => e.stopPropagation()}><TaskHandover task={handover} title={row.title} state={handovers} live={live} compact /></div> : null}
      <RunsOn taskId={row.taskId} compact />
    </div>
  );
}

const checksCell = (row: PipelineRow): ReactNode => (row.checks ? (
  <div className="min-w-0 space-y-1">
    <Chip tone={row.checks.tone}>{row.checks.label}</Chip>
    {row.checks.detail ? <p className="wrap-anywhere text-sm text-muted">{row.checks.detail}</p> : null}
  </div>
) : <Muted>No checks yet</Muted>);

function TaskIdentity({ row, showStage, onOpen }: { row: PipelineRow; showStage: boolean; onOpen: (id: string) => void }) {
  return (
    <div className="min-w-0">
      <button type="button" data-open-task={row.taskId} className="max-w-full rounded-chip text-left font-semibold text-fg underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(row.taskId); }}>
        <span className="wrap-anywhere">{row.title}</span>
      </button>
      <p className="mt-0.5 text-sm text-muted">{showStage ? `${stageLabel(row.stage)} · ` : ''}Task rev {row.revision}{row.critical ? ' · ' : ''}{row.critical ? <span className="text-active">Longest chain</span> : null}</p>
    </div>
  );
}

function Row({ row, selected, showStage, onOpen, handovers, live }: { row: PipelineRow; selected: boolean; showStage: boolean; onOpen: (id: string) => void } & Handovers) {
  const selectedRail = selected ? 'shadow-[inset_3px_0_0_var(--color-active)]' : row.rail ? RAIL_SHADOW[row.rail] : '';
  return (
    <tr data-testid="pipeline-row" data-task-id={row.taskId} data-selected={selected} data-rail={row.rail ?? 'none'} onClick={() => { if (!hasTextSelection()) onOpen(row.taskId); }} className={`cursor-pointer wrap-anywhere border-b border-line align-top hover:bg-panel-2 ${selected ? 'bg-panel-2' : ''}`}>
      <td className={`px-3 py-3 ${selectedRail}`}><TaskIdentity row={row} showStage={showStage} onOpen={onOpen} /></td>
      <td className="px-3 py-3"><span className="block text-fg">{roleName(row.owner.role)}</span>{row.owner.workerId ? <span className="block break-all font-mono text-mono text-muted">{row.owner.workerId}</span> : <span className="block text-sm text-muted">No worker</span>}</td>
      <td className="px-3 py-3"><StateCell row={row} onOpen={onOpen} handovers={handovers ?? null} live={live ?? false} /></td>
      <td className="px-3 py-3"><PredecessorList row={row} /></td>
      <td className="px-3 py-3">{row.accepted.startsWith('None') ? <Muted>{row.accepted}</Muted> : row.accepted}</td>
      <td className="px-3 py-3">{row.branch ?? <Muted>Not reported</Muted>}</td>
      <td className="px-3 py-3">{checksCell(row)}</td>
      <td className="whitespace-nowrap px-3 py-3 text-sm text-muted"><Timestamp iso={row.since} tabStop={false}>{row.age}</Timestamp></td>
      <td className="px-3 py-3 text-sm text-fg">{row.nextAction}{row.decisionId ? <> <a data-testid="decision-link" onClick={(e) => e.stopPropagation()} className="font-medium text-active underline underline-offset-2" href={decisionHref(row.decisionId)}>Open in Action items</a></> : null}</td>
    </tr>
  );
}

const WIDTHS = ['w-[15%]', 'w-[11%]', 'w-[18%]', 'w-[13%]', 'w-[8%]', 'w-[8%]', 'w-[10%]', 'w-[6%]', 'w-[11%]'];

export function PipelineTable({ groups, flat, selectedId, onOpen, handovers = null, live = false }: { groups: readonly StageGroup[]; flat: boolean; selectedId: string | null; onOpen: (id: string) => void } & Handovers) {
  return (
    <table className="w-full table-fixed border-collapse" data-testid="pipeline-table">
      <caption className="sr-only">Tasks in this run, {flat ? 'in attention order' : 'grouped by stage'}. Choose a task to inspect it. Inspecting is read-only.</caption>
      <thead>
        <tr className="border-b border-line-strong">
          {PIPELINE_COLUMNS.map((c, i) => <th key={c.key} scope="col" className={`px-3 py-2 text-left text-sm font-medium text-muted ${WIDTHS[i]}`}>{c.label}</th>)}
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.id} data-testid="pipeline-stage" data-stage={g.id}>
          {!flat ? (
            <tr className="border-b border-line bg-panel-2">
              <th scope="rowgroup" colSpan={PIPELINE_COLUMNS.length} className="px-3 py-1.5 text-left text-sm font-semibold text-fg">{g.label} <span className="font-normal text-muted">{g.rows.length} {g.rows.length === 1 ? 'task' : 'tasks'}</span></th>
            </tr>
          ) : null}
          {g.rows.map((r) => <Row key={r.taskId} row={r} selected={selectedId === r.taskId} showStage={flat} onOpen={onOpen} handovers={handovers} live={live} />)}
        </tbody>
      ))}
    </table>
  );
}

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <div className={`min-w-0 ${className}`}><dt className="mb-0.5 text-sm font-medium text-muted">{label}</dt><dd className="m-0">{children}</dd></div>;
}

function Card({ row, selected, showStage, onOpen, handovers, live }: { row: PipelineRow; selected: boolean; showStage: boolean; onOpen: (id: string) => void } & Handovers) {
  const rail = selected ? 'border-l-active' : row.rail ? RAIL_BORDER[row.rail] : '';
  return (
    <li data-testid="pipeline-row" data-task-id={row.taskId} data-selected={selected} data-rail={row.rail ?? 'none'} className={`wrap-anywhere rounded-chip border border-line border-l-4 p-3 ${selected ? 'bg-panel-2' : ''} ${rail}`}>
      <TaskIdentity row={row} showStage={showStage} onOpen={onOpen} />
      <div className="mt-2"><StateCell row={row} onOpen={onOpen} handovers={handovers ?? null} live={live ?? false} /></div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 @3xl:grid-cols-4">
        <Field label="Owner"><span className="block text-fg">{roleName(row.owner.role)}</span>{row.owner.workerId ? <span className="block break-all font-mono text-mono text-muted">{row.owner.workerId}</span> : <span className="block text-sm text-muted">No worker</span>}</Field>
        <Field label="Age"><span className="text-sm text-muted"><Timestamp iso={row.since} tabStop={false}>{row.age}</Timestamp></span></Field>
        {!row.accepted.startsWith('None') ? <Field label="Accepted revision">{row.accepted}</Field> : null}
        {row.branch ? <Field label="Branch or candidate">{row.branch}</Field> : null}
        {row.predecessors === null || row.predecessors.length > 0 ? <Field label="Predecessors" className="col-span-2 @3xl:col-span-1"><PredecessorList row={row} /></Field> : null}
        {row.checks ? <Field label="Checks" className="col-span-2 @3xl:col-span-1"><div>{checksCell(row)}</div></Field> : null}
        <Field label="Next action" className="col-span-2"><span className="text-sm text-fg">{row.nextAction}</span>{row.decisionId ? <a onClick={(e) => e.stopPropagation()} data-testid="decision-link" className="mt-1 block text-sm font-medium text-active underline underline-offset-2" href={decisionHref(row.decisionId)}>Open in Action items</a> : null}</Field>
      </dl>
    </li>
  );
}

export function PipelineCards({ groups, flat, selectedId, onOpen, handovers = null, live = false }: { groups: readonly StageGroup[]; flat: boolean; selectedId: string | null; onOpen: (id: string) => void } & Handovers) {
  return (
    <div className="space-y-4" data-testid="pipeline-cards">
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label} data-testid="pipeline-stage" data-stage={g.id}>
          {!flat ? <h3 className="mb-2 text-sm font-semibold text-fg">{g.label} <span className="font-normal text-muted">{g.rows.length} {g.rows.length === 1 ? 'task' : 'tasks'}</span></h3> : null}
          <ul className="space-y-3">{g.rows.map((r) => <Card key={r.taskId} row={r} selected={selectedId === r.taskId} showStage={flat} onOpen={onOpen} handovers={handovers} live={live} />)}</ul>
        </section>
      ))}
      <p className="text-sm text-muted">Empty fields are left out of a card: no accepted revision, branch, predecessors or checks reported.</p>
    </div>
  );
}
