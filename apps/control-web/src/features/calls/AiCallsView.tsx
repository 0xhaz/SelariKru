import { useEffect, useMemo, useState } from 'react';
import type { RouteRecord } from '@selarikru/domain';
import { Chip, EmptyState, Panel, formatClock } from '@selarikru/ui';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';
import type { AgentSource } from '../../shell/projection-store.ts';
import { aiCallRows, aiCallsSummary } from './model.ts';

/**
 * H9 item 2: "AI calls" (Boards). Every AI call in this project, read fresh from each task's route records: where it was meant to run, where it actually ran, and
 * how. Unknown stays unknown; a restricted call shows its labels only. Each row links to its task.
 */
export function AiCallsView({ source, snapshot, projectId, simulated }: { source: Pick<AgentSource, 'getTaskRoute'> | null; snapshot: ProjectViewSnapshot | null; projectId: string; simulated: boolean }) {
  const [state, setState] = useState<{ records: RouteRecord[]; failed: number } | null>(null);
  const taskIds = useMemo(() => Object.keys(snapshot?.tasks ?? {}).sort(), [snapshot]);
  // The records are read again whenever the projection moves (a new route record arrives as an event).
  const cursor = snapshot?.meta.cursor ?? '0';
  useEffect(() => {
    if (!source?.getTaskRoute || taskIds.length === 0) { setState({ records: [], failed: 0 }); return; }
    let live = true;
    void Promise.allSettled(taskIds.map((id) => source.getTaskRoute!(projectId, id))).then((all) => {
      if (!live) return;
      setState({ records: all.flatMap((r) => (r.status === 'fulfilled' ? r.value.records : [])), failed: all.filter((r) => r.status === 'rejected').length });
    });
    return () => { live = false; };
  }, [source, projectId, taskIds, cursor]);
  const titleOf = (id: string): string | null => snapshot?.tasks[id]?.title ?? null;
  const rows = useMemo(() => (state ? aiCallRows(state.records, titleOf) : []), [state, snapshot]);

  return (
    <section aria-labelledby="ai-calls-h" className="space-y-5" data-testid="ai-calls">
      <header>
        <h1 id="ai-calls-h" className="text-2xl font-bold text-fg">AI calls</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Every AI call in this project, from the route records the browser reported: where each one was meant to run, and where it actually ran. Nothing here is a
          prediction. A call whose source was not shown stays Unknown, and a restricted call shows its labels only.{simulated ? ' Demo data: never evidence.' : ''}
        </p>
      </header>
      {!source?.getTaskRoute ? (
        <EmptyState title="No route records here">This connection does not serve route records, so no AI call can be listed.</EmptyState>
      ) : state === null ? <p role="status" className="text-muted">Loading the route records</p> : (
        <Panel title="Calls" labelId="ai-calls-title" aside={<span data-testid="ai-calls-summary">{aiCallsSummary(rows)}</span>}>
          {state.failed > 0 ? <p className="mb-3 text-sm text-warning" role="status">The records of {state.failed} task{state.failed === 1 ? '' : 's'} could not be read, so they are not listed.</p> : null}
          {rows.length === 0 ? <p className="text-muted">No AI call has been recorded yet. Run an AI step from a task, or ask the Project Manager.</p> : (
            <ol className="space-y-3" aria-label="AI calls, newest first">
              {rows.map((r) => (
                <li key={r.id} data-testid="ai-call-row" data-ran={r.ran} data-restricted={r.restricted ? 'true' : undefined} className="rounded-card border border-line bg-panel-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-fg">{r.step}</span>
                    <span className="text-muted">·</span>
                    <a className="min-w-0 wrap-anywhere text-active underline underline-offset-2" href={r.taskHref}>{r.task}</a>
                    <span className="ml-auto text-sm text-muted"><time dateTime={r.at}>{formatClock(r.at)}</time></span>
                  </div>
                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(9rem,auto)_minmax(0,1fr)]">
                    <dt className="text-muted">Requested route</dt><dd className="m-0 text-fg">{r.requested} <span className="text-muted">· {r.requestedSource}</span></dd>
                    <dt className="text-muted">Where it ran</dt><dd className="m-0" data-testid="ai-call-ran"><Chip tone={r.ranTone}>{r.ran}</Chip>{r.model ? <span className="ml-2 font-mono text-mono text-muted">{r.model}</span> : null}</dd>
                    <dt className="text-muted">How</dt><dd className="m-0 text-fg" data-testid="ai-call-how">{r.how}</dd>
                    <dt className="text-muted">Time</dt><dd className="m-0 text-fg">{r.timing}</dd>
                    <dt className="text-muted">Schema check</dt><dd className="m-0 text-fg">{r.check}</dd>
                    <dt className="text-muted">Lock</dt><dd className="m-0 text-fg">{r.lock}</dd>
                    <dt className="text-muted">Labels</dt><dd className="m-0 text-fg">{r.labels}</dd>
                  </dl>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      )}
    </section>
  );
}
