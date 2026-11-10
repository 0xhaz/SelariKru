import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AxisBadges, Chip, EmptyState, Panel, RAIL_BORDER, RAIL_SHADOW, Timestamp, buttonQuiet, formatDayTime } from '@selarikru/ui';
import type { AuthorizedViewCommand, CommandReceipt, DataSourceError } from '@selarikru/view-protocol';
import { ConnectionBanner, NextStep, STATE_COPY } from '../../shell/ConnectionStates.tsx';
import type { ConnectionState } from '../../shell/projection-store.ts';
import { ASSIGNMENTS_OFF, ModelAssignmentsPanel } from './ModelAssignments.tsx';
import { ActivitySignalView, HealthSignalView, PROVENANCE_CHIP, ResultSignalView, roleName } from './TeamSignals.tsx';
import { NO_FILTER, SORT_KEYS, filterRows, sortRows, type FleetFilter, type RunnerRow, type SortKey, type TeamModel, type TeamRow } from './model.ts';

const WIDE = '(min-width: 1024px)';

/** One DOM tree per width: a semantic table when it fits, a list of cards when it does not. */
export function useIsWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const onChange = (): void => setWide(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return wide;
}

function Identity({ row, onOpen }: { row: TeamRow; onOpen: (id: string) => void }) {
  return (
    <div className="min-w-0">
      <button type="button" data-open-worker={row.workerId} onClick={() => onOpen(row.workerId)} className="max-w-full rounded-chip text-left">
        <span className="block font-semibold text-fg underline-offset-2 hover:underline">{roleName(row.role)}</span>
        <span className="block break-all font-mono text-mono text-muted">{row.workerId}</span>
      </button>
      {row.task ? <p className="mt-1 wrap-anywhere text-sm text-fg">{row.task.title} <span className="text-muted">rev {row.task.revision}</span></p> : null}
      {row.lastTask ? <p className="mt-1 wrap-anywhere text-sm text-muted">No task now. Last: {row.lastTask.title}</p> : null}
      {!row.task && !row.lastTask ? <p className="mt-1 text-sm text-muted">No task assigned</p> : null}
      {row.spend ? (
        <p className="mt-1 text-sm text-muted" data-testid="row-spend">
          Task spend <span className="text-fg">{row.spend.value}</span>{row.spend.provenance === 'unavailable' ? '' : ` ${PROVENANCE_CHIP[row.spend.provenance]!.text.toLowerCase()}`}
          {row.spend.note ? `, ${row.spend.note.toLowerCase()}` : ''}
        </p>
      ) : null}
    </div>
  );
}

/** Dragging across a row to copy text ends in a click on the row. That is not a request to inspect the worker. */
const hasTextSelection = (): boolean => {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
};

const SORTED_COLUMN: Readonly<Partial<Record<SortKey, 'worker' | 'activity' | 'location'>>> = { role: 'worker', task: 'worker', activity: 'activity', runtime: 'location' };

function FleetTable({ rows, sort, nowMs, onOpen }: { rows: readonly TeamRow[]; sort: SortKey; nowMs: number; onOpen: (id: string) => void }) {
  const sortedColumn = SORTED_COLUMN[sort];
  const th = (column: 'worker' | 'activity' | 'health' | 'results' | 'location', width: string, label: string): ReactNode => (
    <th scope="col" aria-sort={sortedColumn === column ? 'ascending' : undefined} className={`px-3 py-2 text-left text-sm font-medium text-muted ${width}`}>{label}</th>
  );
  return (
    <table className="w-full table-fixed border-collapse">
      <caption className="sr-only">Workers in this project. Choose a worker to inspect it. Inspecting is read-only.</caption>
      <thead>
        <tr className="border-b border-line-strong">
          {th('worker', 'w-[25%]', 'Worker and task')}
          {th('activity', 'w-[19%]', 'Activity')}
          {th('health', 'w-[21%]', 'Health')}
          {th('results', 'w-[17%]', 'Results')}
          {th('location', 'w-[18%]', 'Runtime and inference')}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.workerId} data-testid="fleet-row" data-worker-id={row.workerId} onClick={() => { if (!hasTextSelection()) onOpen(row.workerId); }} className="cursor-pointer wrap-anywhere border-b border-line align-top last:border-b-0 hover:bg-panel-2">
            <td className={`px-3 py-3 ${row.rail ? RAIL_SHADOW[row.rail] : ''}`}><Identity row={row} onOpen={onOpen} /></td>
            <td className="px-3 py-3"><ActivitySignalView row={row} /></td>
            <td className="px-3 py-3"><HealthSignalView row={row} nowMs={nowMs} /></td>
            <td className="px-3 py-3"><ResultSignalView row={row} nowMs={nowMs} /></td>
            <td className="px-3 py-3"><AxisBadges stacked execution={row.execution} modelRoute={row.modelRoute} model={row.modelDetail} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FleetCards({ rows, nowMs, onOpen }: { rows: readonly TeamRow[]; nowMs: number; onOpen: (id: string) => void }) {
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.workerId} data-testid="fleet-row" data-worker-id={row.workerId} className={`wrap-anywhere rounded-chip border border-line border-l-4 bg-panel-2 p-3 ${row.rail ? RAIL_BORDER[row.rail] : ''}`}>
          <Identity row={row} onOpen={onOpen} />
          <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div><dt className="mb-1 text-sm font-medium text-muted">Activity</dt><dd className="m-0"><ActivitySignalView row={row} /></dd></div>
            <div><dt className="mb-1 text-sm font-medium text-muted">Health</dt><dd className="m-0"><HealthSignalView row={row} nowMs={nowMs} /></dd></div>
            <div><dt className="mb-1 text-sm font-medium text-muted">Results</dt><dd className="m-0"><ResultSignalView row={row} nowMs={nowMs} /></dd></div>
          </dl>
          <div className="mt-3 border-t border-line pt-2"><AxisBadges execution={row.execution} modelRoute={row.modelRoute} model={row.modelDetail} /></div>
        </li>
      ))}
    </ul>
  );
}

const selectClass = 'rounded-chip border border-line-strong bg-bg px-2 py-1.5 text-sm text-fg';

function Toolbar({ sort, onSort, filter, onFilter, roles, runs, providers, shown, total }: { sort: SortKey; onSort: (s: SortKey) => void; filter: FleetFilter; onFilter: (f: FleetFilter) => void; roles: readonly string[]; runs: readonly string[]; providers: TeamModel['providers']; shown: number; total: number }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-3 border-b border-line pb-3">
      <div>
        <label htmlFor="team-sort" className="mb-1 block text-sm text-muted">Sort by</label>
        <select id="team-sort" className={selectClass} value={sort} onChange={(e) => onSort(e.target.value as SortKey)}>
          {SORT_KEYS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="team-runtime" className="mb-1 block text-sm text-muted">Runtime</label>
        <select id="team-runtime" className={selectClass} value={filter.runtime} onChange={(e) => onFilter({ ...filter, runtime: e.target.value as FleetFilter['runtime'] })}>
          <option value="all">All runtimes</option>
          <option value="local">Local sandbox</option>
          <option value="cloud">Cloud sandbox</option>
          <option value="unknown">Unknown</option>
        </select>
      </div>
      <div>
        <label htmlFor="team-provider" className="mb-1 block text-sm text-muted">Provider</label>
        <select id="team-provider" className={selectClass} value={filter.provider} onChange={(e) => onFilter({ ...filter, provider: e.target.value })}>
          <option value="all">All providers</option>
          {providers.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="team-role" className="mb-1 block text-sm text-muted">Role</label>
        <select id="team-role" className={selectClass} value={filter.role} onChange={(e) => onFilter({ ...filter, role: e.target.value })}>
          <option value="all">All roles</option>
          {roles.map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
        </select>
      </div>
      <div className="min-w-0">
        <label htmlFor="team-run" className="mb-1 block text-sm text-muted">Run</label>
        <select id="team-run" className={`${selectClass} max-w-52`} value={filter.run} onChange={(e) => onFilter({ ...filter, run: e.target.value })}>
          <option value="all">All runs</option>
          {runs.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <label className="flex items-center gap-2 py-1.5 text-sm text-fg">
        <input type="checkbox" checked={filter.blockedOnly} onChange={(e) => onFilter({ ...filter, blockedOnly: e.target.checked })} />
        Blocked only
      </label>
      {shown !== total ? <p className="ml-auto py-1.5 text-sm text-muted" data-testid="filter-count">Showing {shown} of {total}</p> : null}
    </div>
  );
}

const REACHABILITY = { reachable: { label: 'Reachable', tone: 'success' }, not_reachable: { label: 'Not reachable', tone: 'neutral' }, unknown: { label: 'Unknown', tone: 'warning' } } as const;

/** Runner liveness apart from any task: an enrolled runner that has gone quiet reads as such, and our own outage is never read as theirs. */
function RunnersPanel({ runners, summary, simulated }: { runners: readonly RunnerRow[]; summary: string; simulated: boolean }) {
  return (
    <Panel title="Runners" labelId="team-runners-title" aside={<span data-testid="runners-summary">{`${summary}${simulated ? ', simulated' : ''}`}</span>}>
      <ul className="divide-y divide-line">
        {runners.map((r) => (
          <li key={r.runnerId} data-testid="runner-row" data-reachability={r.reachability} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
            <span className="min-w-0">
              <span className="break-all font-mono text-mono text-fg">{r.label ?? r.runnerId}</span>
              <span className="ml-2 text-sm text-muted">{r.location === 'cloud' ? 'Cloud sandbox' : 'Local sandbox'}</span>
            </span>
            <span className="flex items-center gap-2">
              <Chip tone={REACHABILITY[r.reachability].tone}>{REACHABILITY[r.reachability].label}</Chip>
              <span className="text-sm text-muted">{r.lastSeenAt ? <>Last seen <Timestamp iso={r.lastSeenAt}>{formatDayTime(r.lastSeenAt)}</Timestamp></> : 'Not seen since it enrolled'}</span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export interface TeamViewProps {
  readonly connection: ConnectionState;
  readonly error: DataSourceError | null;
  readonly team: TeamModel | null;
  readonly confirmedAt: string | null;
  readonly nowMs: number;
  readonly mode: 'mock' | 'live';
  readonly onRestart: () => void;
  readonly leaveDemoHref?: string | undefined;
  readonly onExecute: (command: AuthorizedViewCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
  readonly onResync: () => void;
  /** Opens the worker's drawer, which the shell owns so it opens the same way from every view. */
  readonly onOpenWorker: (workerId: string) => void;
  /** A failure while deriving the view. Thrown here so the route's error boundary, not the shell, takes it. */
  readonly failure?: unknown;
  /** The run's Bounded autonomy panel, beside the model assignments it is set up with. Absent when the server reports no policy. */
  readonly autonomy?: ReactNode;
}

function Heading({ summary }: { summary?: string | null | undefined }) {
  return (
    <div className="mb-5">
      <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
      {summary ? <p className="mt-1 text-lg text-muted" data-testid="team-summary">{summary}</p> : null}
    </div>
  );
}

export function TeamView({ connection, error, team, confirmedAt, nowMs, mode, onRestart, leaveDemoHref, onExecute, onRefresh, onResync, onOpenWorker, failure, autonomy = null }: TeamViewProps) {
  if (failure !== undefined) throw failure;
  const wide = useIsWide();
  const [sort, setSort] = useState<SortKey>('attention');
  const [filter, setFilter] = useState<FleetFilter>(NO_FILTER);
  const rows = useMemo(() => (team ? filterRows(sortRows(team.rows, sort), filter) : []), [team, sort, filter]);

  if (!team) {
    return (
      <>
        <Heading />
        {connection === 'unavailable' || connection === 'dead' ? (
          <section aria-label="Connection" className="rounded-card border border-line bg-panel">
            <EmptyState title="Project data is unavailable" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} />}>
              <p>{STATE_COPY.unavailable[mode]}</p>
              <p className="mt-2">No worker list is shown until a real source provides one.</p>
              {error ? <p className="mt-2 text-sm">Error category <span className="font-mono text-mono">{error.code}</span></p> : null}
            </EmptyState>
          </section>
        ) : <p role="status" className="text-muted">Loading project state</p>}
      </>
    );
  }

  const assignProps = { model: team.assignments, disabledReason: connection === 'live' ? null : ASSIGNMENTS_OFF, onExecute, onRefresh, onResync };
  return (
    <>
      <Heading summary={team.summary} />
      <ConnectionBanner connection={connection} error={error} onRestart={onRestart} observedAt={confirmedAt} />
      <ModelAssignmentsPanel {...assignProps} />
      {team.empty ? (
        <section aria-label="Workers" className="rounded-card border border-line bg-panel">
          <EmptyState title="No workers have started" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} />}>
            <p>{mode === 'mock' ? 'This demo project has no workers. Choose another fixture in the demo controls below.' : 'Workers appear here once a plan is accepted and the scheduler starts a task. No roster is shown before then.'}</p>
          </EmptyState>
        </section>
      ) : (
        <Panel title="Fleet" labelId="team-fleet-title" aside={team.simulated ? 'Simulated, not evidence' : null}>
          <Toolbar sort={sort} onSort={setSort} filter={filter} onFilter={setFilter} roles={team.roles} runs={team.runs} providers={team.providers} shown={rows.length} total={team.rows.length} />
          {rows.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-muted">No workers match these filters.</p>
              <button type="button" className={`${buttonQuiet} mt-3`} onClick={() => setFilter(NO_FILTER)}>Clear filters</button>
            </div>
          ) : wide ? <FleetTable rows={rows} sort={sort} nowMs={nowMs} onOpen={onOpenWorker} /> : <FleetCards rows={rows} nowMs={nowMs} onOpen={onOpenWorker} />}
        </Panel>
      )}
      {team.runners.length > 0 ? <div className="mt-4"><RunnersPanel runners={team.runners} summary={team.runnersSummary} simulated={team.simulated} /></div> : null}
      {autonomy ? <div className="mt-4">{autonomy}</div> : null}
    </>
  );
}
