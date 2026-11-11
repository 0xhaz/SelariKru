import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Chip, EmptyState, Panel, buttonPrimary, buttonQuiet, formatExact } from '@selarikru/ui';
import { PRODUCT_DECISIONS, type Measure, type ProblemBriefContent, type ProductDecision, type ProductRecord } from '@selarikru/domain';
import type { ProductAction, ProductView as ProductViewData } from '@selarikru/view-protocol';
import { DemoBadge } from '../../data-source/DemoBadge.tsx';
import type { ConnectionState, ProductPort } from '../../shell/projection-store.ts';
import { inputClass } from '../onboarding/ui.tsx';
import { lines, measureFrom, measureLabel, measureProblem, planFrom, traceTable, type PlanForm } from './model.ts';
import { useProduct } from './useProduct.ts';

export interface ProductViewProps {
  readonly port: ProductPort | null;
  readonly connection: ConnectionState;
  readonly mode: 'mock' | 'live';
}

type Act = (action: ProductAction, done: string) => Promise<boolean>;
const Exact = ({ iso }: { iso: string }) => <time dateTime={iso}>{formatExact(iso)}</time>;
const PROVENANCE: readonly { value: Measure['provenance']; label: string }[] = [{ value: 'unavailable', label: 'Unknown' }, { value: 'observed', label: 'Observed' }, { value: 'estimated', label: 'Estimated' }];
const CONFIDENCE = ['unknown', 'low', 'medium', 'high'] as const;

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="block text-sm text-fg">{label}{hint ? <span className="text-muted"> ({hint})</span> : null}{children}</label>;
}
const textArea = `${inputClass} mt-1 min-h-[4.5rem]`;
const field = `${inputClass} mt-1`;

function MeasureFields({ name, value, unit, provenance, onChange }: { name: string; value: string; unit: string; provenance: Measure['provenance']; onChange: (v: { value?: string; unit?: string; provenance?: Measure['provenance'] }) => void }) {
  const problem = measureProblem(value, provenance);
  return (
    <fieldset className="grid gap-2 sm:grid-cols-3">
      {problem ? <p role="alert" data-testid={`measure-problem-${name.toLowerCase()}`} className="text-sm text-warning sm:col-span-3">{name}: {problem}</p> : null}
      <legend className="text-sm font-medium text-fg">{name}</legend>
      <Field label={`${name} value`} hint="blank: unknown"><input className={field} inputMode="decimal" value={value} onChange={(e) => onChange({ value: e.target.value })} /></Field>
      <Field label={`${name} unit`}><input className={field} value={unit} maxLength={40} onChange={(e) => onChange({ unit: e.target.value })} /></Field>
      <Field label={`${name} provenance`}>
        <select className={field} value={provenance} onChange={(e) => onChange({ provenance: e.target.value as Measure['provenance'] })}>{PROVENANCE.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
      </Field>
    </fieldset>
  );
}

// ---- brief ------------------------------------------------------------------------------------------------------------------------------

function BriefSection({ view, live, act }: { view: ProductViewData; live: boolean; act: Act }) {
  // The form starts from the owner's own latest text or the onboarding draft, never from a worker's proposal.
  const seed = view.brief.seed;
  const formOf = (c: ProblemBriefContent | null) => ({
    owner: c?.owner ?? '', targetUser: c?.targetUser ?? '', desiredChange: c?.desiredChange ?? '', currentWorkaround: c?.currentWorkaround ?? '', assumptions: (c?.assumptions ?? []).join('\n'),
    nonGoals: (c?.nonGoals ?? []).join('\n'), unknowns: (c?.unknowns ?? []).join('\n'), permissionScope: c?.permissionScope ?? '', confidence: c?.confidence ?? 'unknown', confidenceRationale: c?.confidenceRationale ?? '',
    evidence: c?.evidence ?? [],
  });
  const [f, setF] = useState(() => formOf(seed));
  /** The proposal the owner chose to start from, if any. Saving records it. */
  const [from, setFrom] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const content: ProblemBriefContent = {
    schemaVersion: 1, owner: f.owner.trim(), targetUser: f.targetUser.trim(), evidence: f.evidence, permissionScope: f.permissionScope.trim(), currentWorkaround: f.currentWorkaround.trim() || null,
    assumptions: lines(f.assumptions), desiredChange: f.desiredChange.trim(), nonGoals: lines(f.nonGoals), unknowns: lines(f.unknowns), confidence: f.confidence as ProblemBriefContent['confidence'], confidenceRationale: f.confidenceRationale.trim() || null,
  };
  const ready = content.owner !== '' && content.targetUser !== '' && content.desiredChange !== '' && content.permissionScope !== '';
  const save = (confirm: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    void act({ kind: 'save_brief', expectedRevision: view.brief.revision, confirm, content, ...(from !== null ? { fromProposalId: from } : {}) }, confirm ? 'Confirmed the brief. It is now an accepted Project Brain source.' : 'Saved the brief as a draft. It is a proposal until you confirm it.');
  };
  const { confirmed, latest } = view.brief;
  const state = confirmed && latest?.revision === confirmed.revision ? { label: `Confirmed, revision ${confirmed.revision}`, tone: 'success' as const }
    : latest ? { label: `Proposed, revision ${latest.revision}${latest.proposedBy.kind === 'worker' ? ', by a worker' : ''}: not confirmed`, tone: 'warning' as const } : { label: 'Not saved yet: a draft from the onboarding brief', tone: 'neutral' as const };
  return (
    <Panel title="Problem brief" labelId="product-brief" aside={<span data-testid="product-brief-state"><Chip tone={state.tone}>{state.label}</Chip></span>}>
      <p className="text-sm text-muted">{view.notice}</p>
      {seed === null ? <p className="mt-2 text-muted">There is no onboarding brief to start from. Fill in the brief below.</p> : null}
      {view.brief.proposals.length > 0 ? (
        <div className="mt-3 space-y-2">
          <h3 className="font-medium text-fg">Proposed by workers</h3>
          <p className="text-sm text-muted">A proposal is a worker's suggestion. It is not your brief and is never confirmed unless you choose it, read it in the form and confirm. The newest {view.brief.proposalCap} are kept{view.brief.droppedProposals > 0 ? `; ${view.brief.droppedProposals} older ${view.brief.droppedProposals === 1 ? 'was' : 'were'} dropped` : ''}.</p>
          <ul className="space-y-2">
            {view.brief.proposals.map((p) => (
              <li key={p.proposalId} data-testid="product-proposal" className="rounded-chip border border-warning p-3 text-sm">
                <p className="text-fg"><Chip tone="warning">Proposal</Chip> by {p.proposedBy.id}, <Exact iso={p.proposedAt} /></p>
                <p className="mt-1 text-fg wrap-anywhere">Target user: {p.content.targetUser}</p>
                <p className="text-fg wrap-anywhere">Desired change: {p.content.desiredChange}</p>
                <button type="button" className={`${buttonQuiet} mt-2`} disabled={from === p.proposalId} onClick={() => { setF(formOf(p.content)); setFrom(p.proposalId); }}>Use this proposal<span className="sr-only"> from {p.proposedBy.id}</span></button>
              </li>
            ))}
          </ul>
          {from !== null ? <p role="status" className="text-sm text-warning">The form now holds the worker's proposal. Read it before you confirm.</p> : null}
        </div>
      ) : null}
      {f.evidence.length > 0 ? (
        <p className="mt-2 text-sm text-muted">Cites <span className="break-all font-mono text-mono">{content.evidence.map((c) => `${c.sourceId}@${c.revision}#${c.anchor}`).join(', ')}</span></p>
      ) : <p className="mt-2 text-sm text-muted">Cites no Project Brain evidence.</p>}
      <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={save(true)}>
        <Field label="Owner"><input className={field} value={f.owner} maxLength={120} onChange={set('owner')} /></Field>
        <Field label="Target user or workflow"><input className={field} value={f.targetUser} maxLength={300} onChange={set('targetUser')} /></Field>
        <Field label="Desired change"><textarea className={textArea} value={f.desiredChange} maxLength={400} onChange={set('desiredChange')} /></Field>
        <Field label="Current workaround" hint="blank: unknown"><textarea className={textArea} value={f.currentWorkaround} maxLength={400} onChange={set('currentWorkaround')} /></Field>
        <Field label="Assumptions, one per line"><textarea className={textArea} value={f.assumptions} onChange={set('assumptions')} /></Field>
        <Field label="Non-goals, one per line"><textarea className={textArea} value={f.nonGoals} onChange={set('nonGoals')} /></Field>
        <Field label="Unknowns, one per line"><textarea className={textArea} value={f.unknowns} onChange={set('unknowns')} /></Field>
        <Field label="Permission scope of the evidence"><textarea className={textArea} value={f.permissionScope} maxLength={300} onChange={set('permissionScope')} /></Field>
        <Field label="Confidence"><select className={field} value={f.confidence} onChange={set('confidence')}>{CONFIDENCE.map((c) => <option key={c} value={c}>{c === 'unknown' ? 'Unknown' : c[0]!.toUpperCase() + c.slice(1)}</option>)}</select></Field>
        <Field label="Confidence rationale" hint="optional"><input className={field} value={f.confidenceRationale} maxLength={400} onChange={set('confidenceRationale')} /></Field>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button type="submit" className={buttonPrimary} disabled={!live || !ready}>Confirm brief</button>
          <button type="button" className={buttonQuiet} disabled={!live || !ready} onClick={() => save(false)()}>Save as draft</button>
        </div>
      </form>
    </Panel>
  );
}

// ---- outcome plan ---------------------------------------------------------------------------------------------------------------------

const EMPTY_PLAN = (owner: string): PlanForm => ({
  requirementIds: [], milestone: '', metric: '', baselineValue: '', baselineUnit: '', baselineProvenance: 'unavailable', targetValue: '', targetUnit: '', targetProvenance: 'unavailable', learningQuestion: '',
  windowDays: '', dataSource: '', cohort: '', guardrails: '', reviewOwner: owner, reviewDate: '', decisionOptions: [...PRODUCT_DECISIONS], reportLabel: '', reportUrl: '', confidence: 'unknown',
});

function PlanCard({ r }: { r: Extract<ProductRecord, { kind: 'outcome_plan' }> }) {
  const c = r.content;
  return (
    <li data-testid="product-plan" data-record={r.recordId} className="rounded-chip border border-line p-3">
      <p className="font-medium text-fg wrap-anywhere">{c.metric}</p>
      <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(9rem,auto)_minmax(0,1fr)]">
        <dt className="text-muted">Requirements</dt><dd className="m-0 font-mono text-mono text-fg">{c.requirementIds.join(', ')}</dd>
        <dt className="text-muted">Baseline</dt><dd className="m-0 text-fg" data-testid="product-plan-baseline">{measureLabel(c.baseline)}</dd>
        <dt className="text-muted">Target</dt><dd className="m-0 text-fg">{measureLabel(c.target)}</dd>
        {c.learningQuestion ? <><dt className="text-muted">Learning question</dt><dd className="m-0 text-fg wrap-anywhere">{c.learningQuestion}</dd></> : null}
        <dt className="text-muted">Window</dt><dd className="m-0 text-fg">{c.windowDays === null ? 'Unknown' : `${c.windowDays} days`}</dd>
        <dt className="text-muted">Data source and cohort</dt><dd className="m-0 text-fg wrap-anywhere">{c.dataSource ?? 'Unknown'}; cohort {c.cohort ?? 'unknown'}</dd>
        <dt className="text-muted">Guardrails</dt><dd className="m-0 text-fg wrap-anywhere">{c.guardrails.length === 0 ? 'None recorded' : c.guardrails.join('; ')}</dd>
        <dt className="text-muted">Review</dt><dd className="m-0 text-fg wrap-anywhere">{c.reviewOwner}, {c.reviewDate ?? 'no date set'}; options {c.decisionOptions.join(', ')}</dd>
        {c.reportLinks.length > 0 ? <><dt className="text-muted">Reports</dt><dd className="m-0 text-fg">{c.reportLinks.map((l) => <a key={l.url} className="break-all text-active underline underline-offset-2" href={l.url} rel="noreferrer noopener" target="_blank">{l.label}</a>)}</dd></> : null}
        <dt className="text-muted">Record</dt><dd className="m-0 break-all font-mono text-mono text-muted">{r.recordId} · revision {r.revision} · {r.classification}</dd>
      </dl>
    </li>
  );
}

function PlanSection({ view, live, act }: { view: ProductViewData; live: boolean; act: Act }) {
  const [f, setF] = useState<PlanForm>(() => EMPTY_PLAN(view.brief.confirmed?.kind === 'problem_brief' ? view.brief.confirmed.content.owner : (view.brief.seed?.owner ?? '')));
  const set = (patch: Partial<PlanForm>) => setF((x) => ({ ...x, ...patch }));
  const plan = planFrom(f);
  const ready = measureProblem(f.baselineValue, f.baselineProvenance) === null && measureProblem(f.targetValue, f.targetProvenance) === null && plan.requirementIds.length > 0 && plan.metric !== '' && plan.reviewOwner !== '' && plan.decisionOptions.length > 0 && (plan.target.provenance !== 'unavailable' || plan.learningQuestion !== null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act({ kind: 'save_plan', recordId: null, expectedRevision: 0, content: plan }, `Added an outcome plan for ${plan.requirementIds.join(', ')}. Baseline: ${measureLabel(plan.baseline)}.`).then((ok) => { if (ok) setF(EMPTY_PLAN(f.reviewOwner)); });
  };
  const plans = view.plans.filter((r): r is Extract<ProductRecord, { kind: 'outcome_plan' }> => r.kind === 'outcome_plan');
  return (
    <Panel title="Outcome plan" labelId="product-plan" aside={`${plans.length} plan${plans.length === 1 ? '' : 's'}`}>
      {plans.length === 0 ? <p className="text-muted">No outcome plan yet.</p> : <ul className="space-y-2">{plans.map((r) => <PlanCard key={r.recordId} r={r} />)}</ul>}
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <h3 className="font-medium text-fg">Add an outcome plan</h3>
        <p className="text-sm text-muted">Leave any figure blank when it is not known: it is recorded as unknown, never as zero.</p>
        <fieldset>
          <legend className="text-sm font-medium text-fg">Requirements</legend>
          {view.requirements.length === 0 ? <p className="text-sm text-muted">This project has no accepted requirement yet.</p> : (
            <span className="mt-1 flex flex-wrap gap-x-4 gap-y-2">
              {view.requirements.map((r) => (
                <label key={r.id} className="flex items-center gap-1.5 text-sm text-fg"><input type="checkbox" checked={f.requirementIds.includes(r.id)} onChange={(e) => set({ requirementIds: e.target.checked ? [...f.requirementIds, r.id] : f.requirementIds.filter((x) => x !== r.id) })} /><span className="font-mono text-mono">{r.id}</span></label>
              ))}
            </span>
          )}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Metric definition"><input className={field} value={f.metric} maxLength={300} onChange={(e) => set({ metric: e.target.value })} /></Field>
          <Field label="Milestone" hint="optional"><input className={field} value={f.milestone} maxLength={120} onChange={(e) => set({ milestone: e.target.value })} /></Field>
        </div>
        <MeasureFields name="Baseline" value={f.baselineValue} unit={f.baselineUnit} provenance={f.baselineProvenance} onChange={(v) => set({ ...(v.value !== undefined ? { baselineValue: v.value } : {}), ...(v.unit !== undefined ? { baselineUnit: v.unit } : {}), ...(v.provenance ? { baselineProvenance: v.provenance } : {}) })} />
        <MeasureFields name="Target" value={f.targetValue} unit={f.targetUnit} provenance={f.targetProvenance} onChange={(v) => set({ ...(v.value !== undefined ? { targetValue: v.value } : {}), ...(v.unit !== undefined ? { targetUnit: v.unit } : {}), ...(v.provenance ? { targetProvenance: v.provenance } : {}) })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Learning question" hint="needed when the target is unknown"><input className={field} value={f.learningQuestion} maxLength={300} onChange={(e) => set({ learningQuestion: e.target.value })} /></Field>
          <Field label="Observation window in days" hint="blank: unknown"><input className={field} inputMode="numeric" value={f.windowDays} onChange={(e) => set({ windowDays: e.target.value })} /></Field>
          <Field label="Data source" hint="blank: unknown"><input className={field} value={f.dataSource} maxLength={200} onChange={(e) => set({ dataSource: e.target.value })} /></Field>
          <Field label="Cohort" hint="blank: unknown"><input className={field} value={f.cohort} maxLength={200} onChange={(e) => set({ cohort: e.target.value })} /></Field>
          <Field label="Guardrails, one per line"><textarea className={textArea} value={f.guardrails} onChange={(e) => set({ guardrails: e.target.value })} /></Field>
          <Field label="Review owner"><input className={field} value={f.reviewOwner} maxLength={120} onChange={(e) => set({ reviewOwner: e.target.value })} /></Field>
          <Field label="Review date" hint="optional"><input className={field} type="date" value={f.reviewDate} onChange={(e) => set({ reviewDate: e.target.value })} /></Field>
          <Field label="Confidence"><select className={field} value={f.confidence} onChange={(e) => set({ confidence: e.target.value as PlanForm['confidence'] })}>{CONFIDENCE.map((c) => <option key={c} value={c}>{c === 'unknown' ? 'Unknown' : c[0]!.toUpperCase() + c.slice(1)}</option>)}</select></Field>
          <Field label="Prototype or evaluation report title" hint="optional"><input className={field} value={f.reportLabel} maxLength={120} onChange={(e) => set({ reportLabel: e.target.value })} /></Field>
          <Field label="Report link" hint="https, optional"><input className={field} type="url" value={f.reportUrl} maxLength={500} onChange={(e) => set({ reportUrl: e.target.value })} /></Field>
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-fg">Decisions the review may take</legend>
          <span className="mt-1 flex flex-wrap gap-x-4 gap-y-2">
            {PRODUCT_DECISIONS.map((d) => <label key={d} className="flex items-center gap-1.5 text-sm text-fg"><input type="checkbox" checked={f.decisionOptions.includes(d)} onChange={(e) => set({ decisionOptions: e.target.checked ? [...f.decisionOptions, d] : f.decisionOptions.filter((x) => x !== d) })} />{d}</label>)}
          </span>
        </fieldset>
        <button type="submit" className={buttonPrimary} disabled={!live || !ready}>Add outcome plan</button>
      </form>
    </Panel>
  );
}

// ---- trace and milestone summary ------------------------------------------------------------------------------------------------------

function TraceSection({ view }: { view: ProductViewData }) {
  const rows = useMemo(() => traceTable(view.trace), [view.trace]);
  return (
    <Panel title="Trace" labelId="product-trace" aside={`${rows.length} requirement${rows.length === 1 ? '' : 's'}`}>
      <p className="text-sm text-muted">Each accepted requirement from its problem to its outcome. A missing link is shown as missing. A merge is not a release, and a release is not an outcome. Review due is not tracked automatically.</p>
      {rows.length === 0 ? <p className="mt-2 text-muted">No accepted requirement yet.</p> : (
        <ul className="mt-3 space-y-3">
          {rows.map((r) => (
            <li key={r.id} data-testid="trace-row" data-requirement={r.id} className="rounded-chip border border-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 font-medium text-fg wrap-anywhere"><span className="font-mono text-mono">{r.id}</span>{r.text ? <span className="text-muted"> · {r.text}</span> : null}</h3>
                <span className="flex flex-wrap gap-1.5"><Chip tone="neutral">{r.release}</Chip><span data-testid="trace-outcome" data-outcome={r.outcome.label}><Chip tone={r.outcome.tone}>{r.outcome.label}</Chip></span></span>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(9rem,auto)_minmax(7rem,auto)_minmax(0,1fr)]">
                {r.links.map((l) => (
                  <div key={l.kind} data-testid="trace-link" data-kind={l.kind} data-state={l.state} className="contents">
                    <dt className="text-muted">{l.name}</dt>
                    <dd className="m-0"><Chip tone={l.tone}>{l.state}</Chip></dd>
                    <dd className="m-0 text-fg wrap-anywhere">{l.label}{l.ref ? <span className="ml-1 break-all font-mono text-mono text-muted">{l.ref}</span> : null}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function MilestoneSection({ view }: { view: ProductViewData }) {
  return (
    <Panel title="Milestone summary" labelId="product-milestones" aside="Derived from the records, no model">
      {view.milestones.length === 0 ? <p className="text-muted">No run has a plan yet.</p> : (
        <ul className="space-y-2">
          {view.milestones.map((m) => (
            <li key={m.runId} data-testid="product-milestone" className="rounded-chip border border-line p-3 text-sm">
              <p className="font-medium text-fg"><span className="break-all font-mono text-mono">{m.runId}</span>: {m.covered} of {m.total} requirements carried by a task, {m.verified} of {m.total} verified · {m.release.label}</p>
              <p className="mt-1 text-fg">Outcomes: {m.outcomes.length === 0 ? 'none' : m.outcomes.map((o) => `${o.label} (${o.count})`).join(', ')}</p>
              <p className="mt-1 text-muted">Cites <span className="break-all font-mono text-mono">{m.citations.length === 0 ? 'nothing yet' : m.citations.map((c) => `${c.kind.replace(/_/g, ' ')} ${c.ref}`).join(', ')}</span></p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---- outcome notes -------------------------------------------------------------------------------------------------------------------

function ReleaseForm({ view, live, act }: { view: ProductViewData; live: boolean; act: Act }) {
  const runs = view.mergedRuns.filter((r) => !r.released);
  const [runId, setRunId] = useState(runs[0]?.runId ?? '');
  // Nothing is filled in for the person: where and when they released is theirs to say.
  const [environment, setEnvironment] = useState('');
  const [configuration, setConfiguration] = useState('');
  const [releasedOn, setReleasedOn] = useState('');
  const [note, setNote] = useState('');
  const chosen = runs.some((r) => r.runId === runId) ? runId : (runs[0]?.runId ?? '');
  if (runs.length === 0) return <p className="text-sm text-muted" data-testid="product-no-merged-run">No merged run waits for a release note. A person merges on GitHub, and a merge alone is not a release.</p>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act({ kind: 'add_release', content: { schemaVersion: 1, runId: chosen, environment: environment.trim(), configuration: configuration.trim() || null, releasedOn, note: note.trim() || null } }, `Recorded the release of ${chosen}. Its outcomes now wait for observations.`);
  };
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
      <h3 className="font-medium text-fg sm:col-span-2">Record a release</h3>
      <p className="text-sm text-muted sm:col-span-2">A manual note that you released a merged run. Nothing here deploys anything.</p>
      <Field label="Merged run"><select className={field} value={chosen} onChange={(e) => setRunId(e.target.value)}>{runs.map((r) => <option key={r.runId} value={r.runId}>{r.runId} (pull request #{r.prNumber})</option>)}</select></Field>
      <Field label="Environment"><input className={field} value={environment} maxLength={80} onChange={(e) => setEnvironment(e.target.value)} /></Field>
      <Field label="Configuration" hint="optional"><input className={field} value={configuration} maxLength={200} onChange={(e) => setConfiguration(e.target.value)} /></Field>
      <Field label="Released on"><input className={field} type="date" value={releasedOn} onChange={(e) => setReleasedOn(e.target.value)} /></Field>
      <Field label="Note" hint="optional"><input className={field} value={note} maxLength={600} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="sm:col-span-2"><button type="submit" className={buttonPrimary} disabled={!live || environment.trim() === '' || !/^\d{4}-\d{2}-\d{2}$/.test(releasedOn)}>Record release note</button></div>
    </form>
  );
}

function ReviewForm({ view, live, act }: { view: ProductViewData; live: boolean; act: Act }) {
  const plans = view.plans;
  const releases = view.releases;
  const [planId, setPlanId] = useState('');
  const [releaseId, setReleaseId] = useState('');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [provenance, setProvenance] = useState<Measure['provenance']>('unavailable');
  const [summary, setSummary] = useState('');
  const [unknowns, setUnknowns] = useState('');
  const [decision, setDecision] = useState<ProductDecision>('investigate');
  const [followTitle, setFollowTitle] = useState('');
  const [followReason, setFollowReason] = useState('');
  const [windowFrom, setWindowFrom] = useState('');
  const [windowTo, setWindowTo] = useState('');
  const [environment, setEnvironment] = useState('');
  const [cited, setCited] = useState<string[]>([]);
  const id = useId();
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const keyOf = (c: { sourceId: string; revision: number; anchor: string }) => `${c.sourceId}@${c.revision}#${c.anchor}`;
  if (plans.length === 0 || releases.length === 0) return <p className="text-sm text-muted">An outcome review needs an outcome plan and a release note first.</p>;
  const plan = plans.find((p) => p.recordId === planId) ?? plans[0]!;
  const release = releases.find((r) => r.recordId === releaseId) ?? releases[0]!;
  const follow = followTitle.trim() !== '' && followReason.trim() !== '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act({ kind: 'add_review', content: {
      schemaVersion: 1, planRecordId: plan.recordId, releaseRecordId: release.recordId, observedEnvironment: environment.trim(), observedConfiguration: null,
      windowFrom, windowTo, evidence: view.citable.filter((c) => cited.includes(keyOf(c))).map((c) => ({ sourceId: c.sourceId, revision: c.revision, anchor: c.anchor })), result: measureFrom(value, unit, provenance), summary: summary.trim(), unknowns: lines(unknowns), decision,
      followUp: follow ? { title: followTitle.trim(), requirementIds: plan.kind === 'outcome_plan' ? plan.content.requirementIds.slice(0, 8) : [], reason: followReason.trim() } : null,
    } }, follow ? `Recorded the review: ${decision}. The follow-up is a proposal on Decisions; it changes no plan until you add it through a plan revision.` : `Recorded the review: ${decision}.`);
  };
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit} aria-describedby={`${id}-help`}>
      <h3 className="font-medium text-fg sm:col-span-2">Record an outcome review</h3>
      <p id={`${id}-help`} className="text-sm text-muted sm:col-span-2">Your decision on what was observed. It changes no task, and an association it reports is not proof of cause. A follow-up you name here is a proposal only. Review due is not tracked automatically: record a review when you have looked.</p>
      <Field label="Observed from"><input className={field} type="date" value={windowFrom} onChange={(e) => setWindowFrom(e.target.value)} /></Field>
      <Field label="Observed to"><input className={field} type="date" value={windowTo} onChange={(e) => setWindowTo(e.target.value)} /></Field>
      <Field label="Observed environment"><input className={field} value={environment} maxLength={120} onChange={(e) => setEnvironment(e.target.value)} /></Field>
      <fieldset data-testid="product-review-evidence" className="sm:col-span-2">
        <legend className="text-sm font-medium text-fg">Evidence to cite</legend>
        {view.citable.length === 0 ? <p className="text-sm text-muted">No Project Brain source to cite yet.</p> : (
          <span className="mt-1 grid max-h-48 gap-1 overflow-y-auto">
            {view.citable.map((c) => <label key={keyOf(c)} className="flex items-start gap-1.5 text-sm text-fg"><input type="checkbox" className="mt-0.5" checked={cited.includes(keyOf(c))} onChange={(e) => setCited((xs) => (e.target.checked ? [...xs, keyOf(c)] : xs.filter((x) => x !== keyOf(c))))} /><span className="wrap-anywhere">{c.label} <span className="break-all font-mono text-mono text-muted">{keyOf(c)}</span></span></label>)}
          </span>
        )}
      </fieldset>
      <Field label="Outcome plan"><select className={field} value={plan.recordId} onChange={(e) => setPlanId(e.target.value)}>{plans.map((p) => <option key={p.recordId} value={p.recordId}>{p.kind === 'outcome_plan' ? p.content.metric.slice(0, 60) : p.recordId}</option>)}</select></Field>
      <Field label="Release"><select className={field} value={release.recordId} onChange={(e) => setReleaseId(e.target.value)}>{releases.map((r) => <option key={r.recordId} value={r.recordId}>{r.kind === 'release_note' ? `${r.content.runId} on ${r.content.releasedOn}` : r.recordId}</option>)}</select></Field>
      <div className="sm:col-span-2"><MeasureFields name="Result" value={value} unit={unit} provenance={provenance} onChange={(v) => { if (v.value !== undefined) setValue(v.value); if (v.unit !== undefined) setUnit(v.unit); if (v.provenance) setProvenance(v.provenance); }} /></div>
      <Field label="What was observed"><textarea className={textArea} value={summary} maxLength={600} onChange={(e) => setSummary(e.target.value)} /></Field>
      <Field label="Unknowns, one per line"><textarea className={textArea} value={unknowns} onChange={(e) => setUnknowns(e.target.value)} /></Field>
      <Field label="Decision"><select className={field} value={decision} onChange={(e) => setDecision(e.target.value as ProductDecision)}>{PRODUCT_DECISIONS.map((d) => <option key={d} value={d}>{d}</option>)}</select></Field>
      <Field label="Follow-up task title" hint="optional, a proposal"><input className={field} value={followTitle} maxLength={120} onChange={(e) => setFollowTitle(e.target.value)} /></Field>
      <Field label="Why the follow-up" hint="needed with a title"><input className={field} value={followReason} maxLength={300} onChange={(e) => setFollowReason(e.target.value)} /></Field>
      <div className="sm:col-span-2"><button type="submit" className={buttonPrimary} disabled={!live || summary.trim() === '' || environment.trim() === '' || !day.test(windowFrom) || !day.test(windowTo) || measureProblem(value, provenance) !== null || (followTitle.trim() !== '' && !follow)}>Record outcome review</button></div>
    </form>
  );
}

function NotesSection({ view, live, act }: { view: ProductViewData; live: boolean; act: Act }) {
  return (
    <Panel title="Outcome notes" labelId="product-notes" aside={`${view.releases.length} release${view.releases.length === 1 ? '' : 's'}, ${view.reviews.length} review${view.reviews.length === 1 ? '' : 's'}`}>
      <ul className="space-y-2">
        {view.releases.map((r) => r.kind === 'release_note' ? (
          <li key={r.recordId} data-testid="product-release" className="rounded-chip border border-line p-3 text-sm text-fg">Released <span className="break-all font-mono text-mono">{r.content.runId}</span> to {r.content.environment} on {r.content.releasedOn}{r.content.configuration ? `, ${r.content.configuration}` : ''}. Recorded by {r.proposedBy.id}, <Exact iso={r.recordedAt} />.{r.content.note ? ` ${r.content.note}` : ''}</li>
        ) : null)}
        {view.reviews.map((r) => r.kind === 'outcome_review' ? (
          <li key={r.recordId} data-testid="product-review" className="rounded-chip border border-line p-3 text-sm">
            <p className="text-fg"><Chip tone="active">Decision: {r.content.decision}</Chip> Result {measureLabel(r.content.result)}. <span className="wrap-anywhere">{r.content.summary}</span></p>
            <p className="mt-1 text-muted">Unknowns: {r.content.unknowns.length === 0 ? 'none recorded' : r.content.unknowns.join('; ')}</p>
            {r.content.followUp ? <p className="mt-1 text-muted">Follow-up proposed: {r.content.followUp.title}. Not in any plan.</p> : null}
          </li>
        ) : null)}
      </ul>
      <div className="mt-4 space-y-6">
        <ReleaseForm key={view.mergedRuns.map((r) => `${r.runId}:${r.released}`).join(',')} view={view} live={live} act={act} />
        <ReviewForm key={`${view.plans.length}:${view.releases.length}:${view.reviews.length}`} view={view} live={live} act={act} />
      </div>
    </Panel>
  );
}

/** Product: the brief, outcome plans, the trace, milestone summaries and outcome notes. */
export function ProductView({ port, connection, mode }: ProductViewProps) {
  const product = useProduct(port);
  const live = connection === 'live' && !product.busy;
  const [notice, setNotice] = useState('');
  const view = product.view;
  const act: Act = async (a, done) => {
    const r = await product.act(a);
    setNotice(r === null ? '' : r.redacted ? `${done} Some text was redacted before saving.` : done);
    return r !== null;
  };
  if (!port) return <EmptyState title="Product records are not available">This connection does not serve product records.</EmptyState>;
  return (
    <div data-testid="product-view" className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-fg">Product</h1>
          <p className="mt-1 max-w-prose text-muted">The problem, the intended outcome, and the evidence between them. Every figure says observed, estimated or unknown, and unknowns stay unknown. Release and outcome states come from records, never from time.</p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <DemoBadge mode={mode} testId="product-demo-badge" />
          <button type="button" className={buttonQuiet} onClick={product.reload}>Read again</button>
        </span>
      </header>
      {mode === 'mock' ? <p className="text-sm text-warning">Simulated records. Nothing here is evidence.</p> : null}
      <p role="status" aria-live="polite" data-testid="product-notice" className="text-sm text-fg">{notice}</p>
      {product.error ? <p role="alert" className="text-danger">{product.error}</p> : null}
      {product.loading && !view ? <p role="status" className="text-muted">Loading the product records</p> : null}
      {view ? (
        <>
          <BriefSection key={`brief:${view.brief.revision}`} view={view} live={live} act={act} />
          <PlanSection view={view} live={live} act={act} />
          <TraceSection view={view} />
          <MilestoneSection view={view} />
          <NotesSection view={view} live={live} act={act} />
        </>
      ) : null}
    </div>
  );
}

/** Follow-ups outcome reviews proposed, on the Decisions screen. Each is a proposal: it changes no plan until the owner adds it through a plan revision. */
export function ProductFollowUps({ port }: { port: ProductPort | null }) {
  const product = useProduct(port);
  const items = product.view?.followUps ?? [];
  if (items.length === 0) return null;
  return (
    <Panel title="Follow-ups proposed by outcome reviews" labelId="product-follow-ups" aside={`${items.length} proposed`}>
      <ul className="space-y-3">
        {items.map((f) => (
          <li key={f.reviewRecordId} data-testid="product-follow-up" className="rounded-card border border-warning bg-panel p-4">
            <div className="flex flex-wrap items-center gap-2"><Chip tone="warning">Proposal</Chip><h3 className="font-medium text-fg wrap-anywhere">{f.title}</h3></div>
            <p className="mt-1 text-fg wrap-anywhere">{f.reason}</p>
            <p className="mt-1 text-sm text-muted">From a review that decided to {f.decision}{f.requirementIds.length > 0 ? `, about ${f.requirementIds.join(', ')}` : ''}. It is not in any plan: to do it, add it through a plan revision. Nothing changes until you do.</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
