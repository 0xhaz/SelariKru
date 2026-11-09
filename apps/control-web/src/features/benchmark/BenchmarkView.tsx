import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Chip, buttonQuiet, formatDayTime, type Tone } from '@selarikru/ui';
import { buildBenchmark, type AssistantCohortView, type AssistantRow, type AttemptRow, type BenchmarkModel, type Comparison, type Counts, type EvidenceRow, type Fact, type Figure, type Totals, type Verdict, type WorkerCohortView, type WorkerRow } from './model.ts';
import { loadBenchmark, type BenchmarkLoad } from './schema.ts';

type Tab = 'assistant' | 'workers';
const TABS: readonly { id: Tab; label: string }[] = [{ id: 'assistant', label: 'Assistant' }, { id: 'workers', label: 'Workers' }];

const WORKER_GRID = 'xl:grid-cols-[minmax(11.5rem,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1.4fr)]';
const ASSISTANT_GRID = 'xl:grid-cols-[minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]';
const ATTEMPT_GRID = 'xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.5fr)_minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.1fr)]';
const CARD_GRID = 'grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:gap-x-4';
/** Attempts are many and short, so below the table they pack tighter than mode rows. */
const ATTEMPT_CARD_GRID = 'grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 xl:gap-x-4';

const PROVENANCE: Readonly<Record<Figure['provenance'], { label: string; className: string }>> = {
  observed: { label: 'Observed', className: 'text-success' },
  estimated: { label: 'Estimated', className: 'text-warning' },
  unavailable: { label: 'Unavailable', className: 'text-muted' },
  simulated: { label: 'Simulated', className: 'font-semibold text-warning' },
};

/** The value itself already says there is nothing, so the provenance word is not repeated under it. */
const ABSENT: ReadonlySet<string> = new Set(['Not measured', 'Unavailable', 'None recorded', 'Withheld', 'No comparable attempts']);

function FigureView({ figure, compact = false }: { figure: Figure; compact?: boolean }) {
  const p = PROVENANCE[figure.provenance];
  const absent = ABSENT.has(figure.text);
  return (
    <div data-testid="figure" data-provenance={figure.provenance} className="min-w-0">
      <p className={`text-sm font-semibold ${absent ? 'text-muted' : 'text-fg'}`}>{figure.text}</p>
      {figure.detail ? <p className="text-xs text-muted">{figure.detail}</p> : null}
      <p className="text-xs text-muted">
        {/* The value already says Not measured or Unavailable; the word is not repeated beneath it. */}
        {absent ? null : <span className={p.className}>{p.label}</span>}
        {compact ? null : <>{absent ? '' : ' · '}{figure.basis}</>}
      </p>
    </div>
  );
}

function CellLabel({ children }: { children: ReactNode }) {
  return <p className="mb-0.5 text-xs font-medium text-muted xl:hidden">{children}</p>;
}

function Cell({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="cell" className={`min-w-0 ${className}`}>
      <CellLabel>{label}</CellLabel>
      {children}
    </div>
  );
}

function Stack({ children }: { children: ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

function HeaderRow({ grid, columns }: { grid: string; columns: readonly string[] }) {
  return (
    <div role="rowgroup" className="hidden xl:block">
      <div role="row" className={`grid gap-x-4 border-b border-line px-3 py-2 ${grid}`}>
        {columns.map((c) => <div key={c} role="columnheader" className="text-sm font-medium text-muted">{c}</div>)}
      </div>
    </div>
  );
}

/** A card below the table breakpoint, a plain row at it. */
const rowClass = 'rounded-chip border border-line bg-panel-2 p-3 xl:rounded-none xl:border-x-0 xl:border-t-0 xl:bg-transparent xl:px-3 xl:py-3';

function countText(c: Counts): string {
  if (c.total === 0 && c.notRun === 0) return 'Not measured';
  const parts = [`${c.passed} passed`, `${c.failed} failed`, `${c.abandoned} abandoned`];
  if (c.timedOut > 0) parts.push(`${c.timedOut} timed out`);
  if (c.cancelled > 0) parts.push(`${c.cancelled} cancelled`);
  if (c.deniedStart > 0) parts.push(`${c.deniedStart} denied`);
  if (c.notRun > 0) parts.push(`${c.notRun} not run`);
  return parts.join(' · ');
}

function Attempts({ counts, children }: { counts: Counts; children?: ReactNode }) {
  const empty = counts.total === 0 && counts.notRun === 0;
  return (
    <Stack>
      <p data-testid="attempt-counts" className={`text-sm ${empty ? 'font-semibold text-muted' : 'text-fg'}`}>{countText(counts)}</p>
      {counts.humanIntervened > 0 ? <p className="text-sm text-warning" data-testid="human-excluded">{counts.humanIntervened} human-intervened, not compared</p> : null}
      {counts.notRecorded > 0 ? <p className="text-sm text-warning">{counts.notRecorded} with intervention not recorded, not compared</p> : null}
      {counts.warmups > 0 ? <p className="text-sm text-muted">{counts.warmups} warm-up{counts.warmups === 1 ? '' : 's'} not timed</p> : null}
      {children}
    </Stack>
  );
}

function WorkerTable({ rows, caption }: { rows: readonly WorkerRow[]; caption: string }) {
  return (
    <div role="table" aria-label={caption} data-testid="worker-table">
      <HeaderRow grid={WORKER_GRID} columns={['Mode', 'Execution host', 'Inference destination', 'Attempts', 'Passed', 'Delivery time', 'Usage and worker-hours', 'Cost']} />
      <div role="rowgroup" className="space-y-3 xl:space-y-0">
        {rows.map((r) => (
          <div key={r.mode} role="row" data-testid="worker-row" data-mode={r.mode} className={`${CARD_GRID} ${WORKER_GRID} ${rowClass}`}>
            <div role="rowheader" className="sm:col-span-2 lg:col-span-3 xl:col-span-1">
              <p className="font-mono text-lg font-semibold text-fg">{r.mode}</p>
              <Chip tone={r.workerCount === 2 ? 'active' : 'neutral'} testId="worker-label">{r.workerLabel}</Chip>
              {r.cache !== 'Not measured' ? <p className="mt-1 text-xs text-muted">{r.cache}</p> : null}
            </div>
            <Cell label="Execution host"><p className="text-sm text-fg" data-testid="execution-host">{r.executionHost.text}</p>{r.executionHost.detail ? <p className="wrap-anywhere text-xs text-muted">{r.executionHost.detail}</p> : null}</Cell>
            <Cell label="Inference destination"><p className={`text-sm ${r.inference.text === 'Not measured' ? 'font-semibold text-muted' : 'text-fg'}`} data-testid="inference-destination">{r.inference.text}</p>{r.inference.detail ? <p className="wrap-anywhere text-xs text-muted">{r.inference.detail}</p> : null}</Cell>
            <Cell label="Attempts"><Attempts counts={r.counts}><FigureView figure={r.human} /></Attempts></Cell>
            <Cell label="Passed"><FigureView figure={r.completion} /></Cell>
            <Cell label="Delivery time"><FigureView figure={r.time} /></Cell>
            <Cell label="Usage and worker-hours"><Stack><FigureView figure={r.usage} />{r.hours.map((f, i) => <FigureView key={i} figure={f} />)}</Stack></Cell>
            <Cell label="Cost"><Stack>{r.cost.map((f, i) => <FigureView key={i} figure={f} />)}</Stack></Cell>
          </div>
        ))}
      </div>
    </div>
  );
}

function AssistantTable({ rows, caption }: { rows: readonly AssistantRow[]; caption: string }) {
  return (
    <div role="table" aria-label={caption} data-testid="assistant-table">
      <HeaderRow grid={ASSISTANT_GRID} columns={['Requested route', 'Observed source', 'Requests', 'Passed', 'Routing, schema, review', 'First output', 'Complete', 'Usage and cost']} />
      <div role="rowgroup" className="space-y-3 xl:space-y-0">
        {rows.map((r) => (
          <div key={r.mode} role="row" data-testid="assistant-row" data-mode={r.mode} className={`${CARD_GRID} ${ASSISTANT_GRID} ${rowClass}`}>
            <div role="rowheader" className="sm:col-span-2 lg:col-span-3 xl:col-span-1">
              <p className="text-lg font-semibold text-fg">{r.requested}</p>
              {r.cache !== 'Not measured' ? <p className="mt-1 text-xs text-muted">{r.cache}</p> : null}
            </div>
            <Cell label="Observed source"><p className={`text-sm ${r.observedSource === 'Not measured' ? 'font-semibold text-muted' : 'text-fg'}`} data-testid="observed-source">{r.observedSource}</p></Cell>
            <Cell label="Requests"><Attempts counts={r.counts} /></Cell>
            <Cell label="Passed"><FigureView figure={r.completion} /></Cell>
            <Cell label="Routing, schema, review"><Stack><FigureView figure={r.routing} /><FigureView figure={r.schema} /><FigureView figure={r.review} /></Stack></Cell>
            <Cell label="First output"><FigureView figure={r.firstOutput} /></Cell>
            <Cell label="Complete"><FigureView figure={r.complete} /></Cell>
            <Cell label="Usage and cost"><Stack><FigureView figure={r.usage} /><FigureView figure={r.cost} /><FigureView figure={r.warmups} /></Stack></Cell>
          </div>
        ))}
      </div>
    </div>
  );
}

function EvidenceLinks({ refs }: { refs: readonly { label: string; href: string | null }[] }) {
  if (refs.length === 0) return <span className="text-muted">None</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {refs.map((r, i) => r.href ? <a key={i} className="wrap-anywhere text-active underline underline-offset-2" href={r.href} {...(r.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}>{r.label}</a> : <span key={i} className="wrap-anywhere text-muted">{r.label}</span>)}
    </span>
  );
}

function AttemptRowView({ a }: { a: AttemptRow }) {
  return (
    <div role="row" data-testid="attempt" data-status={a.statusLabel} className={`${ATTEMPT_CARD_GRID} ${ATTEMPT_GRID} ${rowClass}`}>
      <div role="rowheader" className="col-span-2 sm:col-span-4 xl:col-span-1">
        <p className="break-all font-mono text-mono font-semibold text-fg">{a.attemptId}</p>
        {a.candidate ? <p className="font-mono text-xs text-muted" title={a.candidateFull ?? undefined}>{a.candidate}</p> : null}
        {a.failure ? <p className="mt-1 wrap-anywhere text-xs text-danger" data-testid="attempt-failure">{a.failure}</p> : null}
      </div>
      <Cell label="Mode"><p className="wrap-anywhere text-sm text-fg">{a.mode}</p></Cell>
      <Cell label="Result"><Chip tone={a.tone}>{a.statusLabel}</Chip></Cell>
      <Cell label="Criteria"><p className="text-sm text-fg">{a.criteria}</p></Cell>
      <Cell label="Time"><FigureView figure={a.time} compact /></Cell>
      <Cell label="Cost"><FigureView figure={a.cost} compact /></Cell>
      <Cell label="Human"><p className={`text-sm ${a.humanLabel === 'No' || a.humanLabel === 'Not applicable' ? 'text-muted' : 'font-medium text-warning'}`}>{a.humanLabel}</p></Cell>
      <Cell label="Evidence"><p className="text-sm"><EvidenceLinks refs={a.evidence} /></p></Cell>
    </div>
  );
}

function AttemptTable({ attempts, collapsePassing, caption }: { attempts: readonly AttemptRow[]; collapsePassing: boolean; caption: string }) {
  const attention = collapsePassing ? attempts.filter((a) => !a.passed) : attempts;
  const passing = collapsePassing ? attempts.filter((a) => a.passed) : [];
  return (
    <div>
      <p className="mb-2 text-sm text-muted">{attempts.length} {attempts.length === 1 ? 'attempt' : 'attempts'} listed. Nothing here is dropped: a failed, abandoned or excluded attempt stays on this list.</p>
      {attention.length > 0 ? (
        <div role="table" aria-label={caption} data-testid="attempt-table">
          <HeaderRow grid={ATTEMPT_GRID} columns={['Attempt', 'Mode', 'Result', 'Criteria', 'Time', 'Cost', 'Human', 'Evidence']} />
          <div role="rowgroup" className="space-y-3 xl:space-y-0">
            {attention.map((a) => <AttemptRowView key={a.attemptId} a={a} />)}
          </div>
        </div>
      ) : null}
      {passing.length > 0 ? (
        <details className="mt-3" data-testid="passing-attempts">
          <summary className="cursor-pointer text-sm font-medium text-fg">{passing.length} passing {passing.length === 1 ? 'attempt' : 'attempts'}</summary>
          <div role="table" aria-label={`Passing: ${caption}`} className="mt-2">
            <HeaderRow grid={ATTEMPT_GRID} columns={['Attempt', 'Mode', 'Result', 'Criteria', 'Time', 'Cost', 'Human', 'Evidence']} />
            <div role="rowgroup" className="space-y-3 xl:space-y-0">
              {passing.map((a) => <AttemptRowView key={a.attemptId} a={a} />)}
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function VerdictView({ verdict }: { verdict: Verdict }) {
  if (verdict.kind === 'descriptive') {
    return (
      <div>
        <Chip tone="neutral" testId="descriptive-verdict">Side by side, no winner</Chip>
        <p className="mt-2 text-sm text-muted">Different capacity, so no winner is named. A winner is only for pairs with equal capacity.</p>
      </div>
    );
  }
  if (verdict.kind === 'winner') {
    return (
      <div>
        <Chip tone="success" testId="winner-badge">{`Winner on this cohort: ${verdict.mode}${verdict.exploratory ? ' (exploratory)' : ''}`}</Chip>
        <p className="mt-2 text-sm text-fg">{verdict.statement}</p>
        <p className="mt-1 text-sm text-muted">{verdict.basis === 'completion' ? 'Decided by more attempts passing, so speed was not compared.' : 'Decided by non-overlapping delivery-time ranges with equal pass rates.'} One fixture, one configuration: not a general claim.</p>
      </div>
    );
  }
  return (
    <div>
      <Chip tone="neutral" testId="no-winner">No winner</Chip>
      <p className="mt-2 text-sm font-medium text-fg">Why there is no comparison</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted" data-testid="no-winner-reasons">
        {verdict.reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>
    </div>
  );
}

function ComparisonCard({ c }: { c: Comparison }) {
  return (
    <li data-testid="comparison" data-id={c.id} className="rounded-chip border border-line bg-panel-2 p-3">
      <p className="font-mono text-mono font-semibold text-fg">{c.title}</p>
      <p className="mt-0.5 text-sm text-muted">{c.scope}</p>
      {c.capacityNote ? <p className="mt-2 text-sm font-medium text-warning" data-testid="capacity-note">{c.capacityNote}</p> : null}
      <ul className="mt-2 space-y-0.5 text-sm text-fg" data-testid="comparison-sides">{c.sides.map((s) => <li key={s}>{s}</li>)}</ul>
      {c.pairs.valid > 0 || c.pairs.excluded.length > 0 ? (
        <p className="mt-2 text-sm text-muted" data-testid="pair-summary">{c.pairs.valid} valid {c.pairs.valid === 1 ? 'pair' : 'pairs'}{c.pairs.excluded.length > 0 ? `. Excluded: ${c.pairs.excluded.join('; ')}` : ''}.</p>
      ) : null}
      <div className="mt-3"><VerdictView verdict={c.verdict} /></div>
    </li>
  );
}

function FactList({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {facts.map((f) => (
        <div key={f.label} className="min-w-0">
          <dt className="text-muted">{f.label}</dt>
          <dd className="m-0 break-all font-mono text-mono text-fg" title={f.full}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CohortFrame({ cohort, title, children, testId }: { cohort: { cohortId: string; kind: string; planned: number; facts: readonly Fact[]; exclusions: readonly string[]; confounders: readonly string[]; costExclusions: readonly string[] }; title: string; children: ReactNode; testId: string }) {
  const headingId = useId();
  const simulated = cohort.kind === 'simulated';
  // A measured cohort sits directly under the page heading; a simulated one sits under the Simulated section's heading.
  const Heading = simulated ? 'h3' : 'h2';
  return (
    <section aria-labelledby={headingId} data-testid={testId} data-kind={cohort.kind} className="rounded-card border border-line bg-panel">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <Heading id={headingId} className="text-base font-semibold text-fg">{title}</Heading>
        <span className="break-all font-mono text-mono text-muted">{cohort.cohortId}</span>
        <Chip tone={simulated ? 'warning' : 'active'} testId="cohort-kind">{simulated ? 'Simulated' : 'Measured'}</Chip>
        <span className="text-sm text-muted">Planned {cohort.planned} per mode</span>
      </header>
      <div className="space-y-4 p-4">
        <FactList facts={cohort.facts} />
        {cohort.exclusions.length > 0 ? <p className="text-sm text-warning" data-testid="exclusions">{cohort.exclusions.join(' ')}</p> : null}
        <p className="text-sm text-muted" data-testid="cost-basis">Cost figures include failed attempts{cohort.costExclusions.length > 0 ? ` and exclude ${cohort.costExclusions.join(', ')}` : ''}. Observed and estimated figures are never added together.</p>
        {cohort.confounders.length > 0 ? <p className="text-sm text-muted">Confounders: {cohort.confounders.join('; ')}</p> : null}
        {children}
      </div>
    </section>
  );
}

function WorkerCohort({ cohort }: { cohort: WorkerCohortView }) {
  return (
    <CohortFrame cohort={cohort} title="Worker cohort" testId="worker-cohort">
      <div>
        <p className="mb-2 text-sm font-medium text-fg">Comparisons</p>
        <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">{cohort.comparisons.map((c) => <ComparisonCard key={c.id} c={c} />)}</ul>
      </div>
      <WorkerTable rows={cohort.rows} caption={`${cohort.cohortId}: results by mode`} />
      <AttemptTable attempts={cohort.attempts} collapsePassing={cohort.kind === 'simulated'} caption={`${cohort.cohortId}: attempts`} />
    </CohortFrame>
  );
}

function AssistantCohort({ cohort }: { cohort: AssistantCohortView }) {
  return (
    <CohortFrame cohort={cohort} title="Assistant cohort" testId="assistant-cohort">
      <ul className="space-y-0.5 text-sm text-fg" data-testid="comparison-sides">{cohort.comparison.sides.map((s) => <li key={s}>{s}</li>)}</ul>
      <VerdictView verdict={cohort.comparison.verdict} />
      <AssistantTable rows={cohort.rows} caption={`${cohort.cohortId}: results by route`} />
      <AttemptTable attempts={cohort.attempts} collapsePassing caption={`${cohort.cohortId}: requests`} />
    </CohortFrame>
  );
}

function Simulated({ children, count, what }: { children: ReactNode; count: number; what: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid="simulated-section" className="rounded-card border-2 border-dashed border-warning bg-warning-tint p-3 sm:p-4">
      <h2 id={id} className="text-lg font-semibold text-fg"><span className="mr-2 inline-block"><Chip tone="warning">Simulated</Chip></span>Simulated {what}, not evidence</h2>
      <p className="mt-1 text-sm text-fg">{count} simulated {count === 1 ? 'record' : 'records'} in this file. They show the layout only, and never count toward measured totals, comparisons or a winner.</p>
      <div className="mt-3 space-y-4">{children}</div>
    </section>
  );
}

function RuleList() {
  return (
    <section aria-labelledby="benchmark-rules" className="rounded-card border border-line bg-panel p-4">
      <h2 id="benchmark-rules" className="text-sm font-semibold text-fg">How a winner is decided</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
        <li>Only complete cohorts, matched on manifest, starter, verifier, harness and model, with at least three attempts per mode and no recorded confounder. Fewer than five attempts is Exploratory.</li>
        <li>Completion comes first: more attempts passing decides it, by more than one attempt. Speed is only compared at equal pass rates, and only when the two delivery-time ranges do not overlap.</li>
        <li>A winner is for pairs with equal capacity. H2 against a one-worker mode is described side by side.</li>
        <li>Failed, timed-out, cancelled and abandoned attempts stay listed and count against a mode.</li>
        <li>Spread and sample size are always shown with a median. Below three valid pairs there is no headline speed result.</li>
        <li>Device and cloud assistants run different models, so they are compared as routes, never as a contest.</li>
        <li>Attempts a person controlled and simulated data never enter a comparison.</li>
      </ul>
    </section>
  );
}

function Definitions() {
  return (
    <details className="rounded-card border border-line bg-panel p-4">
      <summary className="cursor-pointer text-sm font-semibold text-fg">How each figure is measured</summary>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm md:grid-cols-2">
        {[
          ['Delivery time', 'Coordinator acceptance to the trusted verification verdict on the exact candidate, on a server clock. Passing attempts only, shown as median, range and n.'],
          ['Provenance', 'Observed values come from the provider, harness or runner. Estimated values are labelled. Unavailable means not reported, and is never zero.'],
          ['Cost', 'Platform-paid model, worker, tool and artifact charges, actual and estimated kept apart. Failed attempts count. Local hardware and energy stay unavailable unless measured.'],
          ['Inference destination', 'Where the coding model ran. A local worker may call a cloud model, so this is separate from the execution host.'],
          ['Assistant timing', 'Browser monotonic clock, warm requests only. Setup, download and warm-up requests are kept out of medians and counted separately.'],
          ['Completion', 'n of N attempts that passed all eight criteria within declared limits. A timed-out run stays in the denominator.'],
        ].map(([term, def]) => <div key={term}><dt className="font-medium text-fg">{term}</dt><dd className="m-0 text-muted">{def}</dd></div>)}
      </dl>
    </details>
  );
}

function Evidence({ items, measured }: { items: readonly EvidenceRow[]; measured: boolean }) {
  const tone: Readonly<Record<EvidenceRow['status'], Tone>> = { not_measured: 'neutral', recorded: 'success', failed: 'danger', simulated: 'warning' };
  const label: Readonly<Record<EvidenceRow['status'], string>> = { not_measured: 'Not measured', recorded: 'Recorded', failed: 'Failed', simulated: 'Simulated, not counted' };
  return (
    <section aria-labelledby="assistant-evidence" className="rounded-card border border-line bg-panel">
      <h2 id="assistant-evidence" className="border-b border-line px-4 py-3 text-base font-semibold text-fg">Assistant evidence</h2>
      <ul className="grid gap-px bg-line sm:grid-cols-2">
        {items.map((e) => (
          <li key={e.id} data-testid="evidence-item" data-status={e.status} className="flex flex-col gap-1 bg-panel p-3 sm:last:odd:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-fg">{e.label}</p>
              <Chip tone={tone[e.status]}>{label[e.status]}</Chip>
            </div>
            <p className="text-sm text-muted">{e.detail}</p>
            {e.references.length > 0 ? <p className="text-sm"><EvidenceLinks refs={e.references} /></p> : null}
          </li>
        ))}
      </ul>
      {!measured ? <p className="border-t border-line px-4 py-3 text-sm text-muted">Each item is confirmed by a real recorded run. A fixture can never satisfy it.</p> : null}
    </section>
  );
}

function TrackIntro({ children }: { children: ReactNode }) {
  return <p className="max-w-prose text-sm text-muted">{children}</p>;
}

function AssistantTab({ track }: { track: BenchmarkModel['assistant'] }) {
  const hasMeasured = track.measured.length > 0;
  return (
    <div className="space-y-5">
      <TrackIntro>Firebase AI Logic in the browser, on the same synthetic briefs. Requested route is what was asked for. Observed source is what the SDK reported. This is separate from where any coding worker runs.</TrackIntro>
      {hasMeasured ? track.measured.map((c) => <AssistantCohort key={c.cohortId} cohort={c} />) : (
        <section aria-label="Assistant routes" className="rounded-card border border-line bg-panel p-4"><AssistantTable rows={track.placeholder} caption="Assistant routes" /></section>
      )}
      {track.simulated.length > 0 ? <Simulated count={track.simulated.reduce((n, c) => n + c.attempts.length, 0)} what="assistant results">{track.simulated.map((c) => <AssistantCohort key={c.cohortId} cohort={c} />)}</Simulated> : null}
      <Evidence items={track.evidence} measured={hasMeasured} />
    </div>
  );
}

function WorkersTab({ track }: { track: BenchmarkModel['workers'] }) {
  const hasMeasured = track.measured.length > 0;
  return (
    <div className="space-y-5">
      <TrackIntro>Each cohort is planned on one Feedback Board starter, contract and verifier, and shows what its attempts recorded. Execution host is where the worker ran. Inference destination is where its model ran. They are different questions.</TrackIntro>
      {hasMeasured ? track.measured.map((c) => <WorkerCohort key={c.cohortId} cohort={c} />) : (
        <section aria-label="Worker modes" className="rounded-card border border-line bg-panel p-4"><WorkerTable rows={track.placeholder} caption="Worker modes" /></section>
      )}
      {track.simulated.length > 0 ? <Simulated count={track.simulated.reduce((n, c) => n + c.attempts.length, 0)} what="worker results">{track.simulated.map((c) => <WorkerCohort key={c.cohortId} cohort={c} />)}</Simulated> : null}
    </div>
  );
}

function StatusBanner({ model, onRetry }: { model: BenchmarkModel; onRetry: () => void }) {
  const total = model.assistant.totals.attempts + model.workers.totals.attempts;
  if (model.source === 'unreachable') {
    return (
      <section role="status" data-testid="benchmark-status" data-state="unreachable" className="rounded-card border border-line bg-panel p-4">
        <p className="text-lg font-semibold text-fg">Not measured</p>
        <p className="mt-1 text-sm text-muted">The results file could not be read, so nothing is shown. {model.detail}</p>
        <button type="button" className={`${buttonQuiet} mt-3`} onClick={onRetry}>Try again</button>
      </section>
    );
  }
  if (model.source === 'invalid') {
    return (
      <section role="status" data-testid="benchmark-status" data-state="invalid" className="rounded-card border border-danger bg-danger-tint p-4">
        <p className="text-lg font-semibold text-fg">Not measured</p>
        <p className="mt-1 text-sm text-fg">The results file was refused, so none of it is shown.</p>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-fg" data-testid="file-issues">{model.issues.map((i) => <li key={i} className="wrap-anywhere">{i}</li>)}</ul>
      </section>
    );
  }
  const hasSimulated = model.assistant.simulated.length > 0 || model.workers.simulated.length > 0;
  if (total === 0) {
    return (
      <section role="status" data-testid="benchmark-status" data-state="not-measured" className="rounded-card border border-line bg-panel p-4 sm:p-5">
        <p className="text-2xl font-semibold tracking-tight text-fg">Not measured</p>
        <p className="mt-1 max-w-prose text-muted">{hasSimulated ? 'No measured results. Only simulated records exist, shown separately below: they are not evidence and count toward nothing.' : 'No benchmark has been run. These tables show what will be recorded, and every value reads Not measured until a real run produces it. Nothing here is estimated, modelled or interpolated.'}</p>
      </section>
    );
  }
  return (
    <section role="status" data-testid="benchmark-status" data-state="results" aria-label="Measured totals" className="rounded-card border border-line bg-panel p-4">
      <div className="grid gap-4 md:grid-cols-2">
        <TrackTotals label="Assistant requests" testId="assistant-totals" totals={model.assistant.totals} />
        <TrackTotals label="Worker attempts" testId="worker-totals" totals={model.workers.totals} />
      </div>
      {model.generatedAt ? <p className="mt-3 text-sm text-muted">Results file generated {formatDayTime(model.generatedAt)}. Totals count measured records only, and each track is counted on its own.</p> : null}
    </section>
  );
}

function TrackTotals({ label, testId, totals }: { label: string; testId: string; totals: Totals }) {
  const parts: readonly [string, number][] = [['Passed', totals.passed], ['Failed', totals.failed], ['Timed out', totals.timedOut], ['Cancelled', totals.cancelled], ['Denied', totals.deniedStart], ['Abandoned', totals.abandoned], ['Human-intervened', totals.humanIntervened], ['Not recorded', totals.notRecorded], ['Warm-ups', totals.warmups]];
  return (
    <div data-testid={testId}>
      <p className="text-sm font-medium text-fg">{label}: {totals.attempts === 0 ? 'Not measured' : totals.attempts}</p>
      {totals.attempts > 0 ? (
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {parts.map(([k, v]) => <div key={k} className="flex gap-1"><dt className="text-muted">{k}</dt><dd className="m-0 font-semibold text-fg">{v}</dd></div>)}
        </dl>
      ) : null}
      {totals.notRun > 0 ? <p className="mt-1 text-sm text-muted">{totals.notRun} planned but not run, not counted above.</p> : null}
    </div>
  );
}

/** Mission Control's Benchmark panel: reads one results file, and shows only what that file measured. */
export function BenchmarkView({ mode, loader = loadBenchmark }: { mode: 'mock' | 'live'; loader?: () => Promise<BenchmarkLoad> }) {
  const [load, setLoad] = useState<BenchmarkLoad | null>(null);
  const [tab, setTab] = useState<Tab>('assistant');
  const tabsId = useId();
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const fetchResults = useCallback(() => {
    let cancelled = false;
    setLoad(null);
    void loader().then((result) => { if (!cancelled) setLoad(result); });
    return () => { cancelled = true; };
  }, [loader]);
  useEffect(() => fetchResults(), [fetchResults]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next]!.id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };
  const model = load === null ? null : buildBenchmark(load);
  return (
    <div className="space-y-5" data-testid="benchmark-view">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Benchmark</h1>
        <p className="mt-1 max-w-prose text-muted">Local, cloud and mixed runs on one fixed project, reported honestly: how many attempts passed, how long passing runs took, what they cost, and what is still unknown.</p>
        {mode === 'mock' && model !== null && model.source === 'ok' ? <p className="mt-1 max-w-prose text-sm text-muted">These figures come from the published results file, not from the demo data used in the rest of the app.</p> : null}
      </header>
      {model === null ? <p role="status" className="text-muted">Loading results</p> : <StatusBanner model={model} onRetry={fetchResults} />}
      <div role="tablist" aria-label="Benchmark experiments" className="flex gap-1 border-b border-line">
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
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? 'border-active text-fg' : 'border-transparent text-muted hover:text-fg'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`} tabIndex={0} data-testid="benchmark-panel" className="outline-none">
        {model === null ? null : tab === 'assistant' ? <AssistantTab track={model.assistant} /> : <WorkersTab track={model.workers} />}
      </div>
      <RuleList />
      <Definitions />
    </div>
  );
}
