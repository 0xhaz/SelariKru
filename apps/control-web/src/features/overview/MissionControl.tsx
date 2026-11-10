import type { ReactNode } from 'react';
import { AxisBadges, Chip, EmptyState, Panel, Timestamp, formatAge, formatClock, formatCount, formatDuration, formatExact, formatUsd, toneGlyph, type Tone } from '@selarikru/ui';
import type { DataSourceError, ProjectViewSnapshot, UsageTotal } from '@selarikru/view-protocol';
import { ConnectionBanner, NextStep, STATE_COPY } from '../../shell/ConnectionStates.tsx';
import type { ConnectionState } from '../../shell/projection-store.ts';
import { decisionHref, hrefFor } from '../../shell/route.ts';
import type { AttentionItem, AttentionKind } from './attention.ts';
import type { CriterionCell, DeliveryModel, EvidenceRow, FleetModel, OverviewModel, UsageModel } from './model.ts';

const KIND: Readonly<Record<AttentionKind, { label: string; tone: Tone }>> = {
  policy_incident: { label: 'Policy block', tone: 'danger' },
  failed_gate: { label: 'Failed check', tone: 'danger' },
  stale_record: { label: 'Record no longer valid', tone: 'warning' },
  decision: { label: 'Decision', tone: 'warning' },
  worker_lost: { label: 'Connection lost', tone: 'danger' },
  budget_resource: { label: 'Budget or limit', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'neutral' },
  information: { label: 'Update', tone: 'neutral' },
};
const RAIL: Readonly<Record<Tone, string>> = { neutral: 'border-l-line-strong', active: 'border-l-active', success: 'border-l-success', warning: 'border-l-warning', danger: 'border-l-danger' };
const TINT: Readonly<Record<Tone, string>> = { neutral: '', active: 'bg-active-tint', success: 'bg-success-tint', warning: 'bg-warning-tint', danger: 'bg-danger-tint' };
/** Only a verified segment is filled, so zero verified can never look complete. */
const CELL: Readonly<Record<CriterionCell, string>> = { verified: 'border-success bg-success', failed: 'border-danger', held: 'border-warning', active: 'border-active', pending: 'border-line-strong' };

function AttentionRow({ item, top, titles, nowMs }: { item: AttentionItem; top: boolean; titles: Readonly<Record<string, string>>; nowMs: number }) {
  const k = KIND[item.kind];
  const n = item.affectedTaskIds.length;
  return (
    <li className={`wrap-anywhere rounded-chip border border-line border-l-4 p-3 ${RAIL[k.tone]} ${top ? TINT[k.tone] : ''}`} data-testid="attention-item" data-kind={item.kind}>
      <div className="grid gap-x-6 gap-y-2 md:grid-cols-[minmax(0,1fr)_minmax(12rem,20rem)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={k.tone}>{k.label}</Chip>
            {item.status === 'expired' ? <Chip tone="danger">Expired</Chip> : null}
            {item.asOfLastConfirmed ? <Chip tone="neutral">As of last confirmed state</Chip> : null}
            <span className="text-sm text-muted">
              {item.closedRecord ? 'Stopped' : item.needsOperator ? 'Waiting' : 'Noted'} <Timestamp iso={item.since}>{formatAge(nowMs - Date.parse(item.since))}</Timestamp>
            </span>
          </div>
          <p className={`mt-2 font-medium wrap-anywhere ${top ? 'text-lg' : ''} text-fg`}>{item.title}</p>
          <p className="mt-0.5 wrap-anywhere text-muted">{item.detail}</p>
          <p className="mt-1 text-sm text-muted">If nothing changes: {item.consequence}</p>
        </div>
        <div className="md:border-l md:border-line-strong md:pl-4">
          <p className="text-sm font-medium text-muted">Next action</p>
          <p className="mt-0.5 font-semibold text-fg">{item.nextAction}</p>
          {item.decisionId && item.needsOperator ? <a data-testid="decision-link" className="mt-1 inline-block text-sm font-medium text-active underline underline-offset-2" href={decisionHref(item.decisionId)}>Open in Decisions</a> : null}
        </div>
      </div>
      <details className="mt-2 text-sm text-muted">
        <summary className="cursor-pointer">Details</summary>
        <dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt>Reason code</dt>
          <dd className="break-all font-mono text-mono">{item.code ?? 'None reported'}</dd>
          <dt>Started</dt>
          <dd>{formatExact(item.since)}</dd>
          <dt>Affected tasks ({n})</dt>
          <dd>{item.affectedTaskIds.map((id) => titles[id] ?? id).join(', ')}</dd>
          <dt>Owner</dt>
          <dd>{item.owner}</dd>
        </dl>
      </details>
    </li>
  );
}

function AttentionQueue({ items, titles, nowMs, stale }: { items: readonly AttentionItem[]; titles: Readonly<Record<string, string>>; nowMs: number; stale: boolean }) {
  return (
    <Panel title="Attention" labelId="attention-title">
      {items.length === 0 ? (
        <p className="text-muted">{stale ? 'Attention is unknown until the connection returns.' : 'No decisions waiting.'}</p>
      ) : (
        <ol className="space-y-3">
          {items.map((item, i) => <AttentionRow key={item.id} item={item} top={i === 0 && item.needsOperator} titles={titles} nowMs={nowMs} />)}
        </ol>
      )}
    </Panel>
  );
}

const STAGES = [
  { lifecycle: 'planning', label: 'Planning' },
  { lifecycle: 'running', label: 'Running' },
  { lifecycle: 'ready_for_review', label: 'Ready for review' },
  { lifecycle: 'merged', label: 'Merged' },
] as const;
const RUN_LABEL: Readonly<Record<string, { label: string; tone: Tone }>> = {
  blocked: { label: 'Blocked', tone: 'warning' }, failed: { label: 'Failed', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
/** The lifecycles the stage rail cannot show on its own. */
const OFF_RAIL: readonly string[] = Object.keys(RUN_LABEL);

function RunStages({ lifecycle }: { lifecycle: string }) {
  const effective = lifecycle === 'blocked' ? 'running' : lifecycle;
  const index = STAGES.findIndex((s) => s.lifecycle === effective);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {STAGES.map((s, i) => (
        <li key={s.lifecycle} className="flex items-center gap-2" aria-current={i === index ? 'step' : undefined}>
          {i > 0 ? <span aria-hidden="true" className="text-muted">›</span> : null}
          <span className={i === index ? 'font-semibold text-fg' : 'text-muted'}>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function DeliverySummary({ model, stale }: { model: DeliveryModel; stale: boolean }) {
  const run = model.run;
  return (
    <Panel title="Delivery" labelId="delivery-title">
      <p className="text-2xl font-semibold tracking-tight" data-testid="criteria">{model.criteriaLabel}</p>
      {model.criteriaNote ? <p className="mt-1 text-sm text-muted" data-testid="criteria-note">{model.criteriaNote}</p> : null}
      {model.segments.length > 0 ? (
        <div aria-hidden="true" className="mt-3 flex max-w-md gap-1">
          {model.segments.map((cell, i) => <span key={i} data-testid="segment" data-filled={cell === 'verified'} className={`h-2 flex-1 rounded-chip border ${CELL[cell]}`} />)}
        </div>
      ) : null}
      {run ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm text-muted">Run stage</span>
          {OFF_RAIL.includes(run.lifecycle) ? <Chip tone={RUN_LABEL[run.lifecycle]!.tone}>Run {RUN_LABEL[run.lifecycle]!.label.toLowerCase()}</Chip> : null}
          <RunStages lifecycle={run.lifecycle} />
        </div>
      ) : null}
      {run ? <p className="mt-2 text-sm"><a data-testid="open-evidence" className="font-medium text-active underline underline-offset-2" href={`${hrefFor('evidence')}?run=${encodeURIComponent(run.runId)}`}>Open evidence</a></p> : null}
      <p className="mt-3 text-sm" data-testid="top-blocker">
        <span className="text-muted">Top blocker: </span>
        <span className={model.blocker ? 'text-warning' : 'text-muted'}>{model.blocker ?? (stale ? 'unknown until the connection returns' : 'none right now')}</span>
      </p>
      {model.tasks.length > 0 ? (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {model.tasks.map((t) => (
            <li key={t.taskId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
              <span className="min-w-0">
                <span className="text-fg">{t.title}</span>
                {t.role ? <span className="ml-2 text-sm text-muted">{t.role}</span> : null}
              </span>
              <Chip tone={t.tone}>{t.statusLabel}</Chip>
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-muted">No criteria recorded for this run yet.</p>}
    </Panel>
  );
}

function FleetPanel({ model, stale, inPanel }: { model: FleetModel; stale: boolean; inPanel: boolean }) {
  const { working, waiting, idle, lost } = model.summary;
  const parts = [`${working} assigned`, `${waiting} waiting`, `${idle} idle`, ...(lost > 0 ? [`${lost} lost`] : [])];
  // With the team panel beside the page each worker is already listed there, so this card keeps to one line rather than a second roster.
  if (inPanel) {
    return (
      <Panel title="Fleet" labelId="fleet-title">
        <p className="text-fg" data-testid="fleet-summary">
          {model.rows.length === 0 ? <span className="text-muted">No workers have started.</span> : <>{stale ? 'Last confirmed: ' : ''}{model.rows.length} worker{model.rows.length === 1 ? '' : 's'}: {parts.join(' · ')}.</>}
          {model.rows.length > 0 ? <span className="text-muted"> Each is listed in the Team panel.</span> : null}
        </p>
      </Panel>
    );
  }
  return (
    <Panel title="Fleet" labelId="fleet-title" aside={model.rows.length > 0 ? `${stale ? 'Last confirmed: ' : ''}${parts.join(' · ')}` : null}>
      {model.rows.length === 0 ? (
        <p className="text-muted">No workers have started.</p>
      ) : (
        <ul className="space-y-3">
          {model.rows.map((w) => (
            <li key={w.workerId} className="wrap-anywhere rounded-chip border border-line bg-panel-2 p-3" data-testid="fleet-row">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="min-w-0">
                  <span className="font-medium capitalize text-fg">{w.role ?? 'Unassigned'}</span>
                  <span className="ml-2 break-all font-mono text-mono text-muted">{w.workerId}</span>
                </span>
              </div>
              {w.taskTitle ? (
                <p className="mt-0.5 wrap-anywhere text-sm text-muted">
                  {w.taskTitle}
                  {w.heartbeatAgeMs !== null && w.health.state === 'healthy' ? ` · Heartbeat ${formatAge(w.heartbeatAgeMs)} ago` : ''}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Chip tone={w.health.tone}>
                  {w.health.state === 'disconnected' ? (
                    <>Connection lost; state last confirmed <Timestamp iso={w.lastConfirmedAt}>{formatClock(w.lastConfirmedAt)}</Timestamp></>
                  ) : w.health.label}
                </Chip>
                {w.activity.reported ? <Chip tone={w.activity.tone}>{w.activity.label}</Chip> : <span className="text-sm text-muted">{w.activity.label}</span>}
              </div>
              <div className="mt-2">
                <AxisBadges execution={w.execution} modelRoute={w.modelRoute} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function EvidencePanel({ rows, simulated }: { rows: readonly EvidenceRow[]; simulated: boolean }) {
  return (
    <Panel title="Recent evidence" labelId="evidence-title" aside={simulated ? 'Simulated, not evidence' : null}>
      {rows.length === 0 ? (
        <p className="text-muted">No checks have reported yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Chip tone={r.tone}>{r.stateLabel}</Chip>
                {r.subject ? <span className="wrap-anywhere text-fg">{r.subject}</span> : null}
                <span className={`wrap-anywhere ${r.subject ? 'text-sm text-muted' : 'text-fg'}`}>{r.summary}</span>
              </span>
              <span className="text-sm text-muted"><Timestamp iso={r.at}>{formatClock(r.at)}</Timestamp></span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Stat({ label, value, note, chip }: { label: string; value: string; note?: string | undefined; chip?: { tone: Tone; text: string } | undefined }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 py-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="m-0 flex flex-wrap items-center justify-end gap-2">
        <span className="font-semibold text-fg">{value}</span>
        {chip ? <Chip tone={chip.tone}>{chip.text}</Chip> : null}
      </dd>
      {note ? <dd className="col-span-2 m-0 text-sm text-muted">{note}</dd> : null}
    </div>
  );
}

const PROVENANCE_CHIP: Readonly<Record<string, { tone: Tone; text: string }>> = { observed: { tone: 'success', text: 'Observed' }, estimated: { tone: 'warning', text: 'Estimated' } };

/** Unknown is never zero. A total only appears when every figure is known; otherwise it reads as unavailable, with any known part labelled as a lower bound. */
function usageStat(label: string, total: UsageTotal, format: (q: string) => string) {
  if (total.figureCount === 0) return <Stat label={label} value="Not reported" />;
  if (total.total === null) {
    return <Stat label={label} value="Unavailable" note={total.knownSubtotal !== null ? `At least ${format(total.knownSubtotal)} known; ${total.unavailableCount} of ${total.figureCount} figures missing` : undefined} />;
  }
  return <Stat label={label} value={format(total.total)} chip={PROVENANCE_CHIP[total.provenance]} />;
}

function ResourcesPanel({ model }: { model: UsageModel }) {
  const { running, local, cloud, unknown, slots } = model.capacity;
  const where = [`${local} in local sandbox`, `${cloud} in cloud sandbox`, ...(unknown > 0 ? [`${unknown} location unknown`] : [])].join(', ');
  return (
    <Panel title="Resources and usage" labelId="resources-title">
      <dl className="divide-y divide-line">
        <Stat label="Leases held" value={slots !== null ? `${running} of ${slots}` : String(running)} note={`${where}.${slots !== null ? '' : ' Slot limit not reported.'}`} />
        {usageStat('Model spend', model.spend, formatUsd)}
        {usageStat('Input tokens', model.inputTokens, formatCount)}
        {usageStat('Output tokens', model.outputTokens, formatCount)}
        {usageStat('Worker time', model.workerSeconds, formatDuration)}
        <Stat label="Assistant inference" value={model.assistant.requested} note={model.assistant.observed ?? undefined} />
      </dl>
    </Panel>
  );
}

function EmptyProject({ mode, leaveDemoHref }: { mode: 'mock' | 'live'; leaveDemoHref?: string | undefined }) {
  return (
    <section aria-label="Project setup" className="rounded-card border border-line bg-panel">
      <EmptyState title="No run in this project yet" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} primary />}>
        {mode === 'mock'
          ? <p>This demo project has no run. Choose another fixture in the demo controls below, or leave demo mode to start real work in the Assistant.</p>
          : <p>Start by drafting acceptance criteria and a task plan. Mission Control fills in once a plan is accepted and work begins.</p>}
      </EmptyState>
    </section>
  );
}

function titlesOf(snapshot: ProjectViewSnapshot): Record<string, string> {
  return Object.fromEntries(Object.values(snapshot.tasks).map((t) => [t.taskId, t.title ?? t.taskId]));
}

export interface MissionControlProps {
  readonly connection: ConnectionState;
  readonly error: DataSourceError | null;
  readonly overview: OverviewModel | null;
  readonly snapshot: ProjectViewSnapshot | null;
  readonly confirmedAt: string | null;
  readonly nowMs: number;
  readonly mode: 'mock' | 'live';
  readonly onRestart: () => void;
  readonly leaveDemoHref?: string | undefined;
  /** A failure while deriving the view. Thrown here so the route's error boundary, not the shell, takes it. */
  readonly failure?: unknown;
  /** True while the team panel lists every worker beside the page, so the Fleet card keeps to a summary. */
  readonly fleetInPanel?: boolean;
  /** The run's Bounded autonomy panel: its effective policy from the server and the run controls. Absent when the server reports no policy. */
  readonly autonomy?: ReactNode;
}

export function MissionControl({ connection, error, overview, snapshot, confirmedAt, nowMs, mode, onRestart, leaveDemoHref, failure, fleetInPanel = false, autonomy = null }: MissionControlProps) {
  if (failure !== undefined) throw failure;
  if (!overview || !snapshot) {
    if (connection === 'unavailable' || connection === 'dead') {
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Mission Control</h1>
          <section aria-label="Connection" className="mt-4 rounded-card border border-line bg-panel">
            <EmptyState title="Project data is unavailable" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} />}>
              <p>{STATE_COPY.unavailable[mode]}</p>
              {error ? <p className="mt-2 text-sm">Error category <span className="font-mono text-mono">{error.code}</span></p> : null}
            </EmptyState>
          </section>
        </>
      );
    }
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Mission Control</h1>
        <p role="status" className="mt-4 text-muted">Loading project state</p>
      </>
    );
  }
  if (overview.empty) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Mission Control</h1>
        <ConnectionBanner connection={connection} error={error} onRestart={onRestart} observedAt={confirmedAt} />
        <div className="mt-4"><EmptyProject mode={mode} leaveDemoHref={leaveDemoHref} /></div>
      </>
    );
  }
  // A frozen, reconnecting or liveness-stale screen must not reassure the operator about the present.
  const stale = overview.stale;
  return (
    <>
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Mission Control</h1>
        {overview.headline ? (
          <p className="mt-1 text-lg text-muted" data-testid="headline">
            {overview.needsYou > 0 ? <span aria-hidden="true" className="mr-1.5 text-glyph text-warning">{toneGlyph('warning')}</span> : null}
            {overview.headline}
          </p>
        ) : null}
      </div>
      <ConnectionBanner connection={connection} error={error} onRestart={onRestart} observedAt={confirmedAt} />
      <div className="grid gap-4">
        <AttentionQueue items={overview.attention} titles={titlesOf(snapshot)} nowMs={nowMs} stale={stale} />
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="grid gap-4">
            <DeliverySummary model={overview.delivery} stale={stale} />
            <EvidencePanel rows={overview.evidence} simulated={overview.simulated} />
          </div>
          <div className="grid gap-4">
            <FleetPanel model={overview.fleet} stale={stale} inPanel={fleetInPanel} />
            <ResourcesPanel model={overview.usage} />
            {autonomy}
          </div>
        </div>
      </div>
    </>
  );
}
