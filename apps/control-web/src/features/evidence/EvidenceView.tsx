import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Chip, EmptyState, Panel, Timestamp, formatDayTime, formatExact, toneGlyph, TONE_TEXT } from '@selarikru/ui';
import type { CriterionFailureView, DataSourceError, RunFailuresView } from '@selarikru/view-protocol';
import { ConnectionBanner, NextStep, STATE_COPY } from '../../shell/ConnectionStates.tsx';
import type { ConnectionState } from '../../shell/projection-store.ts';
import type { CandidateModel, CriterionRow, DeliveryState, EvidenceModel } from './model.ts';
import { CANDIDATE_ANCHOR, cleanFailureText } from './model.ts';

function Facts({ facts }: { facts: readonly { label: string; value: string }[] }) {
  return (
    <dl className="mt-3 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
      {facts.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-muted">{f.label}</dt>
          <dd className="m-0 break-all font-mono text-mono text-fg">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The three facts sit in one strip, in the order they can happen, each with its own value. One being true never colours another. */
function DeliveryStrip({ states }: { states: readonly DeliveryState[] }) {
  return (
    <ol aria-label="Delivery state" className="grid gap-3 md:grid-cols-3">
      {states.map((s, i) => (
        <li key={s.key} data-testid="delivery-state" data-key={s.key} data-established={s.established} className={`relative rounded-card border border-line bg-panel p-4 ${s.established ? 'border-l-4 border-l-success' : ''}`}>
          <p className="text-sm font-medium text-muted">{i + 1}. {s.title}</p>
          <p className={`mt-1 inline-flex items-center gap-1.5 text-lg font-semibold ${TONE_TEXT[s.tone]}`}>
            <span aria-hidden="true" className="text-glyph">{toneGlyph(s.tone)}</span>
            {s.value}
          </p>
          <p className="mt-1 text-sm text-muted">{s.detail}</p>
          {s.link ? <p className="mt-2 text-sm"><a className="font-medium text-active underline underline-offset-2" href={s.link.href} {...(s.link.external ? { target: '_blank', rel: 'noreferrer' } : {})}>{s.link.label}</a></p> : null}
        </li>
      ))}
    </ol>
  );
}

function CheckLink({ row }: { row: CriterionRow }) {
  if (!row.evidence) return <span className="text-muted">Not run</span>;
  return <a data-testid="criterion-check" className="break-all font-mono text-mono text-active underline underline-offset-2" href={row.evidence.checkHref}>{row.criterionId}</a>;
}

function ShaLink({ row }: { row: CriterionRow }) {
  if (!row.evidence) return <span className="text-muted">None</span>;
  return <a data-testid="criterion-candidate" className="font-mono text-mono text-active underline underline-offset-2" href={row.evidence.candidateHref} title={row.evidence.candidateSha}>{row.evidence.candidateShort}</a>;
}

function StateChips({ row }: { row: CriterionRow }) {
  return (
    <span className="inline-flex shrink-0 flex-wrap items-center gap-1.5 whitespace-nowrap">
      <Chip tone={row.tone}>{row.stateLabel}</Chip>
      {row.flaky ? <Chip tone="warning">Flaky</Chip> : null}
    </span>
  );
}

interface FailureState { readonly loading: boolean; readonly available: boolean | null; readonly failures: readonly CriterionFailureView[] }

/** The verifier's words on why this failed. Candidate code can shape them, so they are text nodes only: never markup, and never a link. */
function FailureList({ state, criterionId, onRetry, live }: { state: FailureState; criterionId: string; onRetry: () => void; live: boolean }) {
  if (state.loading) return <p role="status" className="mt-2 text-sm text-muted">Loading why it failed</p>;
  if (state.available === false) return <p className="mt-2 text-sm text-muted">The failure details are not available: the verification record no longer stands.</p>;
  if (state.available === null) return <p className="mt-2 text-sm text-muted" data-testid="failure-load-error">The failure details could not be loaded. <button type="button" onClick={onRetry} disabled={!live} className={live ? 'font-medium text-active underline underline-offset-2' : 'font-medium text-muted'}>Try again</button>{live ? null : ' Available again once the connection is back.'}</p>;
  const mine = state.failures.filter((f) => f.criterionId === criterionId);
  if (mine.length === 0) return <p className="mt-2 text-sm text-muted">No failure text was recorded for this criterion.</p>;
  return (
    <ul className="mt-2 space-y-2" data-testid="failure-list">
      {mine.map((f, i) => (
        <li key={i} className="rounded-chip border border-l-4 border-line border-l-danger bg-panel p-2 text-sm">
          <p className="font-medium text-fg">{cleanFailureText(f.test)}</p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted" data-testid="failure-output-label">Test output</p>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-mono text-muted">{cleanFailureText(f.message)}</pre>
        </li>
      ))}
    </ul>
  );
}

function CriterionDetail({ row, failures, onRetry, live }: { row: CriterionRow; failures: FailureState; onRetry: () => void; live: boolean }) {
  if (!row.evidence) return null;
  return (
    <div className="rounded-chip bg-panel-2 p-3">
      {row.state === 'failed' || row.state === 'error' ? <FailureList state={failures} criterionId={row.criterionId} onRetry={onRetry} live={live} /> : null}
      <Facts facts={row.evidence.facts} />
    </div>
  );
}

function Disclosure({ row, open, onToggle }: { row: CriterionRow; open: boolean; onToggle: () => void }) {
  if (!row.evidence) return <span className="font-mono text-mono font-semibold text-fg">{row.criterionId}</span>;
  return (
    <button type="button" aria-expanded={open} aria-controls={row.evidence.anchor} onClick={onToggle} className="inline-flex items-center gap-1 font-mono text-mono font-semibold text-fg hover:text-active">
      <span aria-hidden="true" className="inline-block w-3 text-muted">{open ? '▾' : '▸'}</span>
      {row.criterionId}
    </button>
  );
}

function CriteriaTable({ rows, openIds, onToggle, failures, onRetry, live }: { rows: readonly CriterionRow[]; openIds: ReadonlySet<string>; onToggle: (id: string) => void; failures: FailureState; onRetry: () => void; live: boolean }) {
  return (
    <table className="w-full border-collapse text-left text-sm">
      <caption className="sr-only">Each acceptance criterion, its result, its check and the candidate commit it was judged on</caption>
      <thead>
        <tr className="border-b border-line text-muted">
          <th scope="col" className="py-2 pr-3 font-medium">Criterion</th>
          <th scope="col" className="py-2 pr-3 font-medium">Result</th>
          <th scope="col" className="py-2 pr-3 font-medium">Task</th>
          <th scope="col" className="py-2 pr-3 font-medium">Check</th>
          <th scope="col" className="py-2 pr-3 font-medium">Candidate</th>
          <th scope="col" className="py-2 font-medium">Judged</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const open = openIds.has(r.criterionId);
          return (
            <Fragment key={r.criterionId}>
              <tr data-testid="criterion" data-criterion={r.criterionId} data-state={r.state} className="border-b border-line align-top">
                <th scope="row" className="min-w-[9rem] py-2.5 pr-3 font-normal">
                  <Disclosure row={r} open={open} onToggle={() => onToggle(r.criterionId)} />
                  {r.description ? <span className="mt-0.5 block pl-4 text-muted">{r.description}</span> : null}
                </th>
                <td className="whitespace-nowrap py-2.5 pr-3"><StateChips row={r} /></td>
                <td className="py-2.5 pr-3 text-muted">{r.tasks.join(', ')}</td>
                <td className="py-2.5 pr-3"><CheckLink row={r} /></td>
                <td className="py-2.5 pr-3"><ShaLink row={r} /></td>
                <td data-testid="criterion-judged" className="whitespace-nowrap py-2.5 text-muted">{r.evidence ? <Timestamp iso={r.evidence.at}>{formatDayTime(r.evidence.at)}</Timestamp> : r.state === 'not_delivered' ? 'Not delivered' : 'Not yet'}</td>
              </tr>
              {r.evidence ? (
                <tr id={r.evidence.anchor} tabIndex={-1} hidden={!open} className="scroll-mt-40 border-b border-line outline-none">
                  <td colSpan={6} className="pb-3 pt-1"><CriterionDetail row={r} failures={failures} onRetry={onRetry} live={live} /></td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function CriteriaCards({ rows, openIds, onToggle, failures, onRetry, live }: { rows: readonly CriterionRow[]; openIds: ReadonlySet<string>; onToggle: (id: string) => void; failures: FailureState; onRetry: () => void; live: boolean }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const open = openIds.has(r.criterionId);
        return (
          <li key={r.criterionId} data-testid="criterion" data-criterion={r.criterionId} data-state={r.state} className="rounded-chip border border-line bg-panel-2 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Disclosure row={r} open={open} onToggle={() => onToggle(r.criterionId)} />
              <StateChips row={r} />
            </div>
            {r.description ? <p className="mt-1 text-fg">{r.description}</p> : null}
            <p className="mt-1 text-muted">{r.tasks.join(', ')}</p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1"><span className="text-muted">Check <CheckLink row={r} /></span><span className="text-muted">Candidate <ShaLink row={r} /></span>{r.evidence ? <span className="text-muted">Judged <Timestamp iso={r.evidence.at}>{formatDayTime(r.evidence.at)}</Timestamp></span> : null}</p>
            {r.evidence ? <div id={r.evidence.anchor} tabIndex={-1} hidden={!open} className="mt-2 scroll-mt-40 outline-none"><CriterionDetail row={r} failures={failures} onRetry={onRetry} live={live} /></div> : null}
          </li>
        );
      })}
    </ul>
  );
}

function CandidatePanel({ candidate, simulated }: { candidate: CandidateModel; simulated: boolean }) {
  return (
    <section aria-labelledby="evidence-candidate-title" id={CANDIDATE_ANCHOR} tabIndex={-1} className="scroll-mt-40 rounded-card border border-line bg-panel outline-none">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <h2 id="evidence-candidate-title" className="text-base font-semibold text-fg">Candidate</h2>
        <span className="inline-flex items-center gap-2">
          {simulated ? <span className="text-sm text-muted">Simulated, not evidence</span> : null}
          <Chip tone={candidate.live && candidate.recordValid ? 'success' : 'warning'}>{candidate.live && !candidate.recordValid ? 'Record no longer valid' : candidate.statusLabel}</Chip>
        </span>
      </header>
      <div className="p-4">
        <p className="break-all font-mono text-lg font-semibold text-fg" data-testid="candidate-sha">{candidate.sha}</p>
        {candidate.commitHref ? <p className="mt-1 text-sm"><a className="font-medium text-active underline underline-offset-2" href={candidate.commitHref} target="_blank" rel="noreferrer">Open this commit on GitHub</a></p> : null}
        <Facts facts={candidate.facts} />
        {candidate.flaky.length > 0 ? <p className="mt-3 text-sm text-warning">Flaky between retries: {candidate.flaky.join(', ')}</p> : null}
      </div>
    </section>
  );
}

const MEDIUM = '(min-width: 768px)';
function useIsWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(MEDIUM).matches);
  useEffect(() => {
    const query = window.matchMedia(MEDIUM);
    const onChange = (): void => setWide(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return wide;
}

function RunPicker({ model, onChange }: { model: EvidenceModel; onChange: (id: string) => void }) {
  const id = useId();
  if (model.runOptions.length < 2) return null;
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-sm text-muted">Run</label>
      <select id={id} value={model.runId} onChange={(e) => onChange(e.target.value)} className="min-w-0 max-w-full rounded-chip border border-line-strong bg-bg px-2 py-1 text-sm text-fg">
        {model.runOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </div>
  );
}

export interface EvidenceViewProps {
  readonly connection: ConnectionState;
  readonly error: DataSourceError | null;
  readonly model: EvidenceModel | null;
  readonly failure?: unknown;
  readonly hasSnapshot: boolean;
  readonly confirmedAt: string | null;
  readonly mode: 'mock' | 'live';
  readonly leaveDemoHref?: string | undefined;
  readonly checkTarget: string | null;
  readonly candidateTarget: string | null;
  readonly onLoadFailures: (runId: string) => Promise<RunFailuresView>;
  readonly onRestart: () => void;
  readonly onChooseRun: (runId: string) => void;
}

/** What each acceptance criterion has been shown to do, the check that says so and the exact commit it judged. Read-only: nothing here can decide or change anything. */
export function EvidenceView({ connection, error, model, failure, hasSnapshot, confirmedAt, mode, leaveDemoHref, checkTarget, candidateTarget, onLoadFailures, onRestart, onChooseRun }: EvidenceViewProps) {
  if (failure !== undefined) throw failure;
  const wide = useIsWide();
  const scrolled = useRef<string | null>(null);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((id: string) => setToggled((prior) => { const next = new Set(prior); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);
  const rows = model?.criteria ?? [];
  const failedKey = rows.filter((r) => r.state === 'failed' || r.state === 'error').map((r) => r.criterionId).join(',');
  // A failed criterion is open from the start, and the one a link names is open. A person's click turns either one the other way.
  const openIds = useMemo(() => {
    const base = new Set(failedKey === '' ? [] : failedKey.split(','));
    const target = checkTarget === null ? undefined : rows.find((r) => r.evidence?.checkId === checkTarget);
    if (target) base.add(target.criterionId);
    for (const id of toggled) { if (base.has(id)) base.delete(id); else base.add(id); }
    return base;
  }, [failedKey, checkTarget, rows, toggled]);
  useEffect(() => { setToggled(new Set()); }, [checkTarget]);

  const [failures, setFailures] = useState<FailureState>({ loading: false, available: null, failures: [] });
  const [retry, setRetry] = useState(0);
  const retryFailures = useCallback(() => setRetry((n) => n + 1), []);
  const live = connection === 'live';
  const failureKey = model && failedKey !== '' && live ? `${model.runId}:${model.candidate?.sha ?? ''}:${failedKey}` : null;
  useEffect(() => {
    if (failureKey === null || !model) return;
    let cancelled = false;
    setFailures({ loading: true, available: null, failures: [] });
    onLoadFailures(model.runId).then(
      (r) => { if (!cancelled) setFailures({ loading: false, available: r.available, failures: r.failures }); },
      () => { if (!cancelled) setFailures({ loading: false, available: null, failures: [] }); },
    );
    return () => { cancelled = true; };
  }, [failureKey, retry]);

  useEffect(() => {
    const anchor = checkTarget !== null ? rows.find((r) => r.evidence?.checkId === checkTarget)?.evidence?.anchor ?? null : candidateTarget !== null ? CANDIDATE_ANCHOR : null;
    if (anchor === null || scrolled.current === `${anchor}:${checkTarget}:${candidateTarget}`) return;
    const el = document.getElementById(anchor);
    if (!el) return;
    scrolled.current = `${anchor}:${checkTarget}:${candidateTarget}`;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }, [checkTarget, candidateTarget, model?.runId, rows.length]);

  const heading = <h1 className="text-2xl font-semibold tracking-tight">Evidence</h1>;
  if (!model) {
    if (!hasSnapshot && (connection === 'unavailable' || connection === 'dead')) {
      return (
        <>
          {heading}
          <section aria-label="Connection" className="mt-4 rounded-card border border-line bg-panel">
            <EmptyState title="Project data is unavailable" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} />}>
              <p>{STATE_COPY.unavailable[mode]}</p>
              {error ? <p className="mt-2 text-sm">Error category <span className="font-mono text-mono">{error.code}</span></p> : null}
            </EmptyState>
          </section>
        </>
      );
    }
    if (!hasSnapshot) return <>{heading}<p role="status" className="mt-4 text-muted">Loading project state</p></>;
    return (
      <>
        {heading}
        <ConnectionBanner connection={connection} error={error} onRestart={onRestart} observedAt={confirmedAt} />
        <section aria-label="No run" className="mt-4 rounded-card border border-line bg-panel">
          <EmptyState title="No run to report on yet" action={<NextStep mode={mode} leaveDemoHref={leaveDemoHref} />}><p>An evidence report appears once a run exists and the verifier has judged a candidate.</p></EmptyState>
        </section>
      </>
    );
  }
  return (
    <>
      <div className="mb-5">
        {heading}
        <p className="mt-1 text-lg text-muted" data-testid="evidence-coverage">{model.coverage}{model.simulated ? ' (simulated, not evidence)' : ''}</p>
        <RunPicker model={model} onChange={onChooseRun} />
      </div>
      <ConnectionBanner connection={connection} error={error} onRestart={onRestart} observedAt={confirmedAt} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <DeliveryStrip states={model.states} />
        {model.humanIntervened.length > 0 ? (
          <Panel title="Human intervention" labelId="evidence-human" aside={`${model.humanIntervened.length} ${model.humanIntervened.length === 1 ? 'attempt' : 'attempts'}`}>
            <p className="text-sm text-muted">A person opened a shell in these attempts' sandboxes. The recorded model cannot vouch for what was run, and any change it made was still judged by the diff gate and the verifier.</p>
            <ul className="mt-2 space-y-1" data-testid="evidence-human">
              {model.humanIntervened.map((h) => <li key={h.attemptId} className="wrap-anywhere font-mono text-mono text-fg">{h.attemptId} (task {h.taskId}) at {formatExact(h.at)}</li>)}
            </ul>
          </Panel>
        ) : null}
        {model.connected ? (
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
              <Panel title="Acceptance criteria" labelId="evidence-criteria-title" aside={`${model.simulated ? 'Simulated, not evidence. ' : ''}${model.counts.map((c) => `${c.n} ${c.label}`).join(', ')}`}>
                {wide ? <CriteriaTable rows={model.criteria} openIds={openIds} onToggle={toggle} failures={failures} onRetry={retryFailures} live={live} /> : <CriteriaCards rows={model.criteria} openIds={openIds} onToggle={toggle} failures={failures} onRetry={retryFailures} live={live} />}
              </Panel>
            </div>
            <div className="grid gap-4">
              {model.candidate ? <CandidatePanel candidate={model.candidate} simulated={model.simulated} /> : (
                <Panel title="Candidate" labelId="evidence-candidate-none"><p className="text-muted">No candidate has been assembled for this run yet, so there is nothing to judge.</p></Panel>
              )}
              {model.notDelivered.length > 0 ? (
                <Panel title="Not delivered" labelId="evidence-not-delivered">
                  <p className="text-sm text-muted">{model.reducedScopeAccepted ? 'You accepted the reduced scope. These stay unmet: accepting records it and verifies nothing.' : 'These approved criteria are unmet because their work was stopped. They stay in the total.'}</p>
                  <p className="mt-2 font-mono text-mono text-fg">{model.notDelivered.join(', ')}</p>
                </Panel>
              ) : null}
            </div>
          </div>
        ) : (
          <section aria-label="Criteria" className="rounded-card border border-line bg-panel">
            <EmptyState title="Per-criterion evidence is not available for this run"><p>Its tasks name no acceptance criteria, or the run is older than the report window, so there is nothing to report against. Tasks are not counted in their place.</p></EmptyState>
          </section>
        )}
      </div>
    </>
  );
}
