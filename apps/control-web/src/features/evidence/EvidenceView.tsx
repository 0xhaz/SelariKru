import { useEffect, useId, useRef, useState } from 'react';
import { Chip, EmptyState, Panel, Timestamp, formatClock, toneGlyph, TONE_TEXT } from '@selarikru/ui';
import type { DataSourceError } from '@selarikru/view-protocol';
import { ConnectionBanner, NextStep, STATE_COPY } from '../../shell/ConnectionStates.tsx';
import type { ConnectionState } from '../../shell/projection-store.ts';
import type { CandidateModel, CheckRow, CriterionRow, DeliveryState, EvidenceModel } from './model.ts';
import { CANDIDATE_ANCHOR, checkAnchor } from './model.ts';

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

function CriteriaTable({ rows }: { rows: readonly CriterionRow[] }) {
  return (
    <>
      <table className="hidden w-full border-collapse text-left text-sm md:table">
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
          {rows.map((r) => (
            <tr key={r.criterionId} data-testid="criterion" data-criterion={r.criterionId} data-state={r.state} className="border-b border-line align-top last:border-0">
              <th scope="row" className="py-2.5 pr-3 font-mono text-mono font-semibold text-fg">{r.criterionId}</th>
              <td className="py-2.5 pr-3 whitespace-nowrap"><Chip tone={r.tone}>{r.stateLabel}</Chip></td>
              <td className="py-2.5 pr-3 text-muted">{r.tasks.join(', ')}</td>
              <td className="py-2.5 pr-3"><CheckLink row={r} /></td>
              <td className="py-2.5 pr-3"><ShaLink row={r} /></td>
              <td className="py-2.5 whitespace-nowrap text-muted">{r.evidence ? <Timestamp iso={r.evidence.at}>{formatClock(r.evidence.at)}</Timestamp> : 'Not yet'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li key={r.criterionId} data-testid="criterion-card" data-criterion={r.criterionId} className="rounded-chip border border-line bg-panel-2 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-mono font-semibold text-fg">{r.criterionId}</span>
              <Chip tone={r.tone}>{r.stateLabel}</Chip>
            </div>
            <p className="mt-1 text-muted">{r.tasks.join(', ')}</p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1"><span className="text-muted">Check <CheckLink row={r} /></span><span className="text-muted">Candidate <ShaLink row={r} /></span></p>
          </li>
        ))}
      </ul>
    </>
  );
}

function CheckList({ checks, target }: { checks: readonly CheckRow[]; target: string | null }) {
  return (
    <Panel title="Checks" labelId="evidence-checks-title" aside={`${checks.length} recorded`}>
      <ul className="space-y-2">
        {checks.map((c) => (
          <li key={c.checkRunId} id={c.anchor} tabIndex={-1} className="scroll-mt-40 rounded-chip border border-line outline-none">
            <details open={target === c.checkRunId} className="group p-3">
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-mono font-semibold text-fg">{c.criterionId}</span>
                <Chip tone={c.tone}>{c.stateLabel}</Chip>
              </summary>
              <Facts facts={c.facts} />
            </details>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function CandidatePanel({ candidate }: { candidate: CandidateModel }) {
  return (
    <section aria-labelledby="evidence-candidate-title" id={CANDIDATE_ANCHOR} tabIndex={-1} className="scroll-mt-40 rounded-card border border-line bg-panel outline-none">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <h2 id="evidence-candidate-title" className="text-base font-semibold text-fg">Candidate</h2>
        <Chip tone={candidate.live ? 'success' : 'warning'}>{candidate.statusLabel}</Chip>
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

function RunPicker({ model, onChange }: { model: EvidenceModel; onChange: (id: string) => void }) {
  const id = useId();
  if (model.runOptions.length < 2) return null;
  return (
    <div className="mt-2 flex items-center gap-2">
      <label htmlFor={id} className="text-sm text-muted">Run</label>
      <select id={id} value={model.runId} onChange={(e) => onChange(e.target.value)} className="rounded-chip border border-line-strong bg-bg px-2 py-1 text-sm text-fg">
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
  readonly onRestart: () => void;
  readonly onChooseRun: (runId: string) => void;
}

/** What each acceptance criterion has been shown to do, the check that says so and the exact commit it judged. Read-only: nothing here can decide or change anything. */
export function EvidenceView({ connection, error, model, failure, hasSnapshot, confirmedAt, mode, leaveDemoHref, checkTarget, candidateTarget, onRestart, onChooseRun }: EvidenceViewProps) {
  if (failure !== undefined) throw failure;
  const [openCheck, setOpenCheck] = useState<string | null>(checkTarget);
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    setOpenCheck(checkTarget);
    const anchor = checkTarget !== null ? checkAnchor(checkTarget) : candidateTarget !== null ? CANDIDATE_ANCHOR : null;
    if (anchor === null || scrolled.current === `${anchor}:${checkTarget}:${candidateTarget}`) return;
    const el = document.getElementById(anchor);
    if (!el) return;
    scrolled.current = `${anchor}:${checkTarget}:${candidateTarget}`;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }, [checkTarget, candidateTarget, model?.runId, model?.checks.length]);

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
      <div className="grid gap-4">
        <DeliveryStrip states={model.states} />
        {model.connected ? (
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="grid gap-4">
              <Panel title="Acceptance criteria" labelId="evidence-criteria-title" aside={model.counts.map((c) => `${c.n} ${c.label}`).join(', ')}>
                <CriteriaTable rows={model.criteria} />
              </Panel>
              {model.checks.length > 0 ? <CheckList checks={model.checks} target={openCheck} /> : null}
            </div>
            <div className="grid gap-4">
              {model.candidate ? <CandidatePanel candidate={model.candidate} /> : (
                <Panel title="Candidate" labelId="evidence-candidate-none"><p className="text-muted">No candidate has been assembled for this run yet, so there is nothing to judge.</p></Panel>
              )}
              {model.notDelivered.length > 0 ? (
                <Panel title="Not delivered" labelId="evidence-not-delivered">
                  <p className="text-sm text-muted">These stay unmet. Accepting a reduced scope records it; it does not verify anything.</p>
                  <p className="mt-2 font-mono text-mono text-fg">{model.notDelivered.join(', ')}</p>
                </Panel>
              ) : null}
            </div>
          </div>
        ) : (
          <section aria-label="Criteria" className="rounded-card border border-line bg-panel">
            <EmptyState title="Per-criterion evidence is not connected for this run"><p>This run's tasks name no acceptance criteria, so there is nothing to report against. Tasks are not counted in their place.</p></EmptyState>
          </section>
        )}
      </div>
    </>
  );
}
