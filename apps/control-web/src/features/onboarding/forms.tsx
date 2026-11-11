import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { COST_PAYERS, LEDGER_BASIS, NO_ASSUMPTIONS, PROJECT_TRACKS, TEMPLATE_CATALOG, TRACK_LABELS, costPlanFor, ledgerTotals, pilotCriteriaProblem, templateSupport, type BlueprintContent, type CostAssumptions, type CostLine, type ExecutionChoice, type GoalAssist, type LedgerKey, type OnboardingView as View, type ProjectTrack } from '@selarikru/domain';
import type { RestrictedDraftHold } from '@selarikru/inference-firebase-web';
import { Chip, buttonPrimary, buttonQuiet } from '@selarikru/ui';
import type { AssistantPort } from '../assistant/types.ts';
import type { ApiResult, InferenceChoice, OnboardingApi, OwnerCostLine } from './api.ts';
import { AssistPanel, type AssistedGoal } from './assist.tsx';
import type { StepId } from './steps.ts';
import { CHECK_STATUS, CodeText, EXECUTION_TEXT, FailureText, Field, INFERENCE_TEXT, Notice, StatusChip, StepFrame, inputClass, usd } from './ui.tsx';
import { useIntentKeys } from './useKeys.ts';

export interface StepProps {
  readonly api: OnboardingApi;
  readonly view: View | null;
  readonly busy: boolean;
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } | null;
  readonly run: (call: () => Promise<ApiResult<View>>, next?: StepId | ((v: View) => StepId)) => Promise<boolean>;
  readonly onGo: (s: StepId) => void;
  readonly onCreated: (id: string) => void;
  readonly adapter: AssistantPort | null;
  readonly hold: RestrictedDraftHold | null;
  readonly mode: 'mock' | 'live';
  readonly heading: RefObject<HTMLHeadingElement>;
}

/** Server problems a field can show itself, keyed by the request path. */
export function fieldErrors(error: StepProps['error']): Map<string, string> {
  const out = new Map<string, string>();
  if (!error) return out;
  if (error.code === 'invalid_request' && Array.isArray(error.details)) for (const d of error.details as { path?: unknown; message?: unknown }[]) if (typeof d.path === 'string' && typeof d.message === 'string') out.set(d.path, d.message);
  if (error.code === 'credential_in_input') for (const path of (error.details as { paths?: unknown } | undefined)?.paths as string[] ?? []) out.set(path, 'This looks like a credential. Remove it: this setup never stores credentials.');
  return out;
}
const Failure = ({ error }: { error: StepProps['error'] }) => (error ? <Notice tone="danger" title="That did not work">{fieldErrors(error).size > 0 ? 'Check the fields marked below.' : <FailureText code={error.code} message={error.message} />}</Notice> : null);
const backTo = (onGo: StepProps['onGo'], step: StepId) => <button type="button" className={buttonQuiet} onClick={() => onGo(step)}>Back</button>;
const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter(Boolean);

// ---- 1. goal ------------------------------------------------------------------------------------------------------

export function GoalStep(p: StepProps) {
  const { view, error, busy, run, api, heading, onCreated, adapter, hold, mode } = p;
  const keys = useIntentKeys();
  const [draft, setDraft] = useState<AssistedGoal>({ name: view?.goal?.name ?? '', idea: view?.goal?.idea ?? '', audience: view?.goal?.audience ?? '', firstOutcome: view?.goal?.firstOutcome ?? '' });
  const [classification, setClassification] = useState<'public' | 'internal'>(view?.goal?.classification ?? 'internal');
  const [restricted, setRestricted] = useState(false);
  const [assist, setAssist] = useState<GoalAssist | null>(view?.goalAssist ?? null);
  const errors = fieldErrors(error);
  const set = (k: keyof AssistedGoal) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const complete = draft.name.trim() && draft.idea.trim() && draft.audience.trim() && draft.firstOutcome.trim();
  const save = async (): Promise<void> => {
    if (restricted) return;
    const goal = { ...draft, classification };
    if (view) {
      if (await run(() => api.saveAnswers(view.projectId, { idempotencyKey: keys.keyFor('answers-goal'), expectedRevision: view.revision, goal, goalAssist: assist }), 'source')) keys.settle('answers-goal');
    } else {
      let createdId: string | null = null;
      const r = await run(async () => {
        const made = await api.create({ idempotencyKey: keys.keyFor('create'), goal, ...(assist ? { goalAssist: assist } : {}) });
        if (made.ok) createdId = made.value.projectId;
        return made;
      }, 'source');
      if (r) { keys.settle('create'); onCreated(createdId!); }
    }
  };
  return (
    <StepFrame title="What do you want to build, and who is it for?" heading={heading}
      intro={<p>Answer in your own words. You can edit everything later.</p>}
      footer={<><button type="button" className={buttonPrimary} disabled={!complete || busy || restricted} onClick={() => void save()}>Save and continue</button>{restricted ? <p className="text-sm text-warning">This text is marked restricted, so it cannot be saved.</p> : !complete ? <p className="text-sm text-muted">Fill in all four fields to continue.</p> : null}</>}>
      <Failure error={error} />
      <Field id="goal-name" label="Project name" error={errors.get('goal.name')}><input id="goal-name" className={inputClass} value={draft.name} maxLength={80} onChange={(e) => set('name')(e.target.value)} /></Field>
      <Field id="goal-idea" label="Your idea" hint="One or two sentences on what it does." error={errors.get('goal.idea')}>
        <textarea id="goal-idea" className={inputClass} rows={3} maxLength={800} value={draft.idea} onChange={(e) => set('idea')(e.target.value)} />
      </Field>
      <Field id="goal-audience" label="Who it is for" error={errors.get('goal.audience')}><input id="goal-audience" className={inputClass} value={draft.audience} maxLength={300} onChange={(e) => set('audience')(e.target.value)} /></Field>
      <Field id="goal-outcome" label="First useful outcome" hint="The smallest result that would make this worth it." error={errors.get('goal.firstOutcome')}>
        <input id="goal-outcome" className={inputClass} value={draft.firstOutcome} maxLength={300} onChange={(e) => set('firstOutcome')(e.target.value)} />
      </Field>
      <fieldset>
        <legend className="text-sm font-medium">Who may see what you type here?</legend>
        <div className="mt-1.5 space-y-1.5">
          {([['internal', 'Internal', 'Private to this workspace.'], ['public', 'Public', 'Fine to appear in public.']] as const).map(([value, label, hint]) => (
            <label key={value} className="flex items-start gap-2 text-sm">
              <input type="radio" className="mt-0.5" name="classification" checked={classification === value} onChange={() => setClassification(value)} />
              <span><span className="font-medium">{label}.</span> <span className="text-muted">{hint}</span></span>
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-sm text-muted">Whatever is saved here is stored by the control service, so restricted or secret material does not belong in it.</p>
      </fieldset>
      {restricted ? (
        <Notice tone="warning" title="Marked as restricted">
          This text cannot be saved while it includes restricted material. Remove that detail from the fields above, then confirm.
          <div className="mt-2"><button type="button" className={buttonQuiet} onClick={() => setRestricted(false)}>I have removed the restricted material</button></div>
        </Notice>
      ) : (
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={false} onChange={() => setRestricted(true)} /><span>This text includes restricted material</span></label>
      )}
      <AssistPanel adapter={adapter} hold={hold} api={api} mode={mode} goal={draft} restricted={restricted} recorded={view?.execution?.inference ?? null} projectId={view?.projectId ?? null} onApply={(next, source) => { setDraft((d) => ({ ...d, ...next })); setAssist(source); }} />
    </StepFrame>
  );
}

// ---- 2. source -----------------------------------------------------------------------------------------------------

export function SourceStep(p: StepProps) {
  const { view, error, busy, run, api, heading, onGo } = p;
  const keys = useIntentKeys();
  const [kind, setKind] = useState<'new' | 'existing'>(view?.source?.kind ?? 'new');
  const [note, setNote] = useState(view?.source?.note ?? '');
  const save = async (): Promise<void> => {
    if (!view) return;
    const source = { kind, ...(note.trim() ? { note: note.trim() } : {}) };
    if (await run(() => api.saveAnswers(view.projectId, { idempotencyKey: keys.keyFor('source'), expectedRevision: view.revision, source }), 'focus')) keys.settle('source');
  };
  return (
    <StepFrame title="Is this a new project or an existing app?" heading={heading}
      footer={<>{backTo(onGo, 'goal')}<button type="button" className={buttonPrimary} disabled={busy || !view} onClick={() => void save()}>Save and continue</button></>}>
      <Failure error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {([['new', 'A new project', 'Start from the Feedback Board starter: push a copy of examples/feedback-board-starter to a repository you create. An empty repository cannot pass the checks.'], ['existing', 'An existing app or repository', 'Work on code you already have. Its conventions come first.']] as const).map(([value, label, hint]) => (
          <label key={value} className={`cursor-pointer rounded-card border p-3 ${kind === value ? 'border-active bg-active-tint' : 'border-line bg-panel hover:border-line-strong'}`}>
            <span className="flex items-center gap-2 font-medium"><input type="radio" name="source-kind" checked={kind === value} onChange={() => setKind(value)} />{label}</span>
            <span className="mt-1 block text-sm text-muted">{hint}</span>
          </label>
        ))}
      </div>
      <Field id="source-note" label="Anything to note about the code? (optional)"><input id="source-note" className={inputClass} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
    </StepFrame>
  );
}

// ---- 3. focus ------------------------------------------------------------------------------------------------------

export function FocusStep(p: StepProps) {
  const { view, error, busy, run, api, heading, onGo } = p;
  const keys = useIntentKeys();
  const [tracks, setTracks] = useState<readonly ProjectTrack[]>(view?.focus?.tracks ?? []);
  const toggle = (t: ProjectTrack): void => setTracks((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const planOnly = tracks.filter((t) => TEMPLATE_CATALOG[t].support !== 'executable');
  const [why, setWhy] = useState<string | null>(null);
  const [modelFeatures, setModelFeatures] = useState<'yes' | 'no' | 'unsure' | undefined>(view?.focus?.modelFeatures);
  const recommend = (): void => { setTracks(['saas_web']); setWhy(TEMPLATE_CATALOG.saas_web.reason); };
  const unchanged = view?.focus !== null && view?.focus !== undefined && view.focus.modelFeatures === modelFeatures && view.focus.tracks.length === tracks.length && view.focus.tracks.every((t) => tracks.includes(t));
  const save = async (): Promise<void> => {
    if (!view) return;
    // Nothing changed, so nothing is sent: a resend must not replace the owner's edits or lose acceptance.
    if (unchanged && view.blueprint) { onGo('blueprint'); return; }
    const ok = await run(async () => {
      const saved = await api.saveAnswers(view.projectId, { idempotencyKey: keys.keyFor('focus'), expectedRevision: view.revision, focus: { tracks: [...tracks], ...(modelFeatures ? { modelFeatures } : {}) } });
      if (!saved.ok) return saved;
      return api.createBlueprint(saved.value.projectId, { idempotencyKey: keys.keyFor('draft-blueprint'), expectedRevision: saved.value.revision });
    }, 'blueprint');
    if (ok) { keys.settle('focus'); keys.settle('draft-blueprint'); }
  };
  return (
    <StepFrame title="What are you building first?" heading={heading} intro={<p>Pick all that apply. You can combine tracks in one project.</p>}
      footer={<>{backTo(onGo, 'source')}<button type="button" className={buttonPrimary} disabled={busy || !view || tracks.length === 0} onClick={() => void save()}>Draft the blueprint</button><button type="button" className={buttonQuiet} onClick={recommend}>Recommend for me</button></>}>
      <Failure error={error} />
      {why ? <Notice tone="neutral" title="Recommended: the pilot stack">{why} Everything else can be planned here but cannot run yet.</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {PROJECT_TRACKS.map((t) => {
          const def = TEMPLATE_CATALOG[t];
          const selected = tracks.includes(t);
          return (
            <label key={t} className={`cursor-pointer rounded-card border p-3 ${selected ? 'border-active bg-active-tint' : 'border-line bg-panel hover:border-line-strong'}`}>
              <span className="flex items-start justify-between gap-2">
                <span className="flex items-center gap-2 font-medium"><input type="checkbox" checked={selected} onChange={() => toggle(t)} />{def.label}</span>
                {def.support === 'executable' ? <Chip tone="success">Pilot stack</Chip> : <Chip tone="neutral">Plan only</Chip>}
              </span>
              <span className="mt-1 block text-sm text-muted">{def.summary}</span>
            </label>
          );
        })}
      </div>
      <fieldset>
        <legend className="text-sm font-medium">Will the product itself use AI models?</legend>
        <p className="text-sm text-muted">If it will, the blueprint adds an evaluation plan, a fallback and model limits.</p>
        <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
          {([['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure yet']] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1.5 text-sm"><input type="radio" name="model-features" checked={modelFeatures === value} onChange={() => setModelFeatures(value)} />{label}</label>
          ))}
        </div>
      </fieldset>
      {planOnly.length > 0 ? <Notice tone="warning" title="Plan only">{planOnly.map((t) => `${TRACK_LABELS[t]}: ${TEMPLATE_CATALOG[t].reason}`).join(' ')} You can still draft a blueprint, but a run is refused until every track can run.</Notice> : null}
    </StepFrame>
  );
}

// ---- 4. blueprint --------------------------------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-card border border-line bg-panel p-4"><h2 className="text-sm font-semibold">{title}</h2><div className="mt-2 text-sm">{children}</div></section>;
}
const Bullets = ({ items, empty }: { items: readonly string[]; empty: string }) => (items.length === 0 ? <p className="text-muted">{empty}</p> : <ul className="list-disc space-y-1 pl-5">{items.map((x) => <li key={x}>{x}</li>)}</ul>);

export function BlueprintStep(p: StepProps) {
  const { view, error, busy, run, api, heading, onGo } = p;
  const keys = useIntentKeys();
  const [editing, setEditing] = useState(false);
  const bp = view?.blueprint;
  const [nonGoals, setNonGoals] = useState('');
  const [assumptions, setAssumptions] = useState('');
  const [paths, setPaths] = useState('');
  const [criteria, setCriteria] = useState('');
  useEffect(() => {
    if (!bp) return;
    setNonGoals(bp.content.nonGoals.join('\n'));
    setAssumptions(bp.content.assumptions.join('\n'));
    setPaths(bp.content.allowedPaths.join('\n'));
    setCriteria(bp.content.acceptanceCriteria.map((c) => c.text).join('\n'));
  }, [bp]);
  if (!view || !bp) return <StepFrame title="Your blueprint" heading={heading}><Notice tone="neutral" title="Nothing yet">Finish the focus step to draft one.</Notice></StepFrame>;
  const c = bp.content;
  const saveEdit = async (): Promise<void> => {
    const criteriaLines = lines(criteria);
    const content: BlueprintContent = {
      ...c,
      nonGoals: lines(nonGoals), assumptions: lines(assumptions), allowedPaths: c.rolePaths ? c.allowedPaths : lines(paths),
      // The pilot stack's criteria belong to the verifier's suite; renumbering them here would leave a run judged on nothing.
      acceptanceCriteria: templateSupport(c.tracks).executable ? c.acceptanceCriteria : criteriaLines.map((text, i) => ({ id: `AC-${i + 1}`, text })),
    };
    if (await run(() => api.createBlueprint(view.projectId, { idempotencyKey: keys.keyFor('edit-blueprint'), expectedRevision: view.revision, content }))) {
      keys.settle('edit-blueprint');
      setEditing(false);
    }
  };
  const redraft = async (): Promise<void> => {
    if (await run(() => api.createBlueprint(view.projectId, { idempotencyKey: keys.keyFor('redraft'), expectedRevision: view.revision }))) keys.settle('redraft');
  };
  const accept = async (): Promise<void> => {
    if (await run(() => api.acceptBlueprint(view.projectId, { idempotencyKey: keys.keyFor('accept'), expectedRevision: view.revision, version: bp.version }), 'feasibility')) keys.settle('accept');
  };
  return (
    <StepFrame title="Review your blueprint" heading={heading}
      intro={<p>This is what agents will be given. Edit anything here. Editing makes a new version and any earlier readiness result stops counting.</p>}
      footer={editing ? (<>
        <button type="button" className={buttonPrimary} disabled={busy || lines(paths).length === 0 || lines(criteria).length === 0} onClick={() => void saveEdit()}>Save as version {bp.version + 1}</button>
        <button type="button" className={buttonQuiet} onClick={() => setEditing(false)}>Discard edits</button>
      </>) : (<>
        {backTo(onGo, 'focus')}
        {bp.accepted ? <button type="button" className={buttonPrimary} onClick={() => onGo('feasibility')}>Continue</button> : <button type="button" className={buttonPrimary} disabled={busy || view.state !== 'blueprint_ready'} onClick={() => void accept()}>Accept version {bp.version}</button>}
        <button type="button" className={buttonQuiet} onClick={() => setEditing(true)}>Edit blueprint</button>
      </>)}>
      <Failure error={error} />
      <div className="flex flex-wrap gap-2" data-testid="blueprint-version">
        <Chip tone={bp.accepted ? 'success' : 'active'}>Version {bp.version}{bp.accepted ? ', accepted' : ', awaiting your review'}</Chip>
        <Chip tone="neutral">{bp.origin === 'controller' ? 'Drafted from your answers' : 'Edited by you'}</Chip>
      </div>
      {view.template && !view.template.executable ? (
        <Notice tone="warning" title="Plan only">This blueprint can be kept and edited, but a run is refused while it includes {view.template.unsupported.map((u) => TRACK_LABELS[u.track]).join(' and ')}. {view.template.unsupported[0]!.reason}</Notice>
      ) : null}
      {view.state !== 'discovering' && !view.firstRunId && pilotCriteriaProblem(c) ? (
        <Notice tone="warning" title="This version needs redrafting">
          {pilotCriteriaProblem(c)}
          <div className="mt-2"><button type="button" className={buttonQuiet} disabled={busy} onClick={() => void redraft()}>Draft a new version</button></div>
        </Notice>
      ) : null}
      {view.state === 'discovering' ? (
        <Notice tone="warning" title="Your answers changed">
          This version was drafted before your last answers. Draft a new version to carry them in.
          <div className="mt-2"><button type="button" className={buttonQuiet} disabled={busy} onClick={() => void redraft()}>Draft a new version</button></div>
        </Notice>
      ) : null}
      {editing ? (
        <div className="space-y-4 rounded-card border border-active bg-panel p-4">
          {templateSupport(c.tracks).executable ? <Notice tone="neutral" title="Acceptance criteria">These are fixed by the verification suite, FB-01 to FB-08, so they cannot be edited here.</Notice> : <Field id="edit-criteria" label="Acceptance criteria" hint="One per line. Each becomes something a run must pass."><textarea id="edit-criteria" className={inputClass} rows={4} value={criteria} onChange={(e) => setCriteria(e.target.value)} /></Field>}
          {c.rolePaths ? null : <Field id="edit-paths" label="Paths workers may change" hint="One per line, relative to the repository."><textarea id="edit-paths" className={`${inputClass} font-mono text-mono`} rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} /></Field>}
          <Field id="edit-nongoals" label="Non-goals" hint="One per line. Agents treat these as out of scope."><textarea id="edit-nongoals" className={inputClass} rows={3} value={nonGoals} onChange={(e) => setNonGoals(e.target.value)} /></Field>
          <Field id="edit-assumptions" label="Assumptions" hint="One per line."><textarea id="edit-assumptions" className={inputClass} rows={3} value={assumptions} onChange={(e) => setAssumptions(e.target.value)} /></Field>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <Section title="First milestone">
            <p className="font-medium">{c.firstMilestone.title}</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">{c.firstMilestone.tasks.map((t) => <li key={t.id}>{t.title}</li>)}</ol>
          </Section>
          <Section title="Acceptance criteria"><ul className="space-y-1">{c.acceptanceCriteria.map((a) => <li key={a.id} className="flex gap-2"><span className="shrink-0 whitespace-nowrap font-mono text-mono text-muted">{a.id}</span><span className="min-w-0 wrap-anywhere">{a.text}</span></li>)}</ul></Section>
          <Section title="Who works on it"><ul className="space-y-1">{c.roles.map((r) => <li key={r.role}><span className="font-medium">{r.role}.</span> <span className="text-muted">{r.reason}</span></li>)}</ul></Section>
          <Section title="Paths workers may change"><ul className="space-y-1 font-mono text-mono">{c.rolePaths ? (Object.entries(c.rolePaths) as [string, string[]][]).map(([role, paths]) => <li key={role}>{role}: {paths.join(", ")}</li>) : c.allowedPaths.map((x) => <li key={x}>{x}</li>)}</ul></Section>
          <Section title="Non-goals"><Bullets items={c.nonGoals} empty="None listed. Add any you want agents to leave alone." /></Section>
          <Section title="Assumptions"><Bullets items={c.assumptions} empty="None listed." /></Section>
          <Section title="Connections needed"><Bullets items={c.requiredConnections} empty="None." /></Section>
          <Section title="Decisions still open"><Bullets items={c.pendingDecisions} empty="None." /></Section>
        </div>
      )}
    </StepFrame>
  );
}

// ---- 4a. cost plan -------------------------------------------------------------------------------------------------

const PROVENANCE: Readonly<Record<CostLine['provenance'], { label: string; tone: 'active' | 'neutral' | 'warning' }>> = {
  reference_price: { label: 'Reference price', tone: 'active' },
  user_estimate: { label: 'Your estimate', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'warning' },
};
const PAYER: Readonly<Record<CostLine['payer'], string>> = { platform: 'SelariKru', your_provider: 'Your provider', your_hardware: 'Your machine', your_accounts: 'Your accounts', you: 'You' };
const cadenceSuffix = (c: CostLine['cadence']): string => (c === 'monthly' ? '/month' : c === 'per_worker_hour' ? '/worker-hour' : '');
const amountText = (n: number, unit: CostLine['unit']): string => (unit === 'hours' ? `${n} h` : n < 1 && n > 0 ? `$${n.toFixed(4)}` : usd(n));
const money = (l: CostLine): string => {
  if (l.provenance === 'unknown') return 'Unknown';
  return l.lowUsd === l.highUsd ? `${amountText(l.baseUsd!, l.unit)}${cadenceSuffix(l.cadence)}` : `${amountText(l.lowUsd!, l.unit)}–${amountText(l.highUsd!, l.unit)}${cadenceSuffix(l.cadence)}`;
};
const isOwnerLine = (l: { id: string }): boolean => l.id.startsWith('line_');
const OWNER_DEFAULT_LINES = new Set(['build_effort', 'app_hosting']);

function Ledger({ ledgerKey, title, sub, lines: ls, unit, defaultPayer, onAdd, onRemove }: { ledgerKey: LedgerKey; title: string; sub: string; lines: readonly CostLine[]; unit: CostLine['unit']; defaultPayer: CostLine['payer']; onAdd: (l: OwnerCostLine) => void; onRemove: (id: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [low, setLow] = useState('');
  const [base, setBase] = useState('');
  const [high, setHigh] = useState('');
  const [basis, setBasis] = useState('');
  const [payer, setPayer] = useState<CostLine['payer']>(defaultPayer);
  const n = Number(base);
  const anyAmount = low !== '' || base !== '' || high !== '';
  const validNumbers = !anyAmount || (Number(low) >= 0 && Number(base) >= 0 && Number(high) >= 0 && Number.isFinite(n) && low !== '' && high !== '' && base !== '' && Number(low) <= n && n <= Number(high));
  const ok = label.trim() !== '' && basis.trim() !== '' && validNumbers;
  const reset = (): void => { setLabel(''); setLow(''); setBase(''); setHigh(''); setBasis(''); setPayer(defaultPayer); setAdding(false); };
  const add = (): void => {
    onAdd({ id: `line_${Date.now().toString(36)}`, label: label.trim(), cadence: unit === 'hours' ? 'one_time' : 'monthly', unit, payer, lowUsd: anyAmount ? Number(low) : null, baseUsd: anyAmount ? n : null, highUsd: anyAmount ? Number(high) : null, provenance: anyAmount ? 'user_estimate' : 'unknown', basis: basis.trim() });
    reset();
  };
  // From the rows on screen, so the total always matches them, including lines not saved yet.
  const totals = ledgerTotals(ls, LEDGER_BASIS[ledgerKey]);
  const known = totals.knownBase !== null ? `${amountText(totals.knownLow!, totals.unit)}–${amountText(totals.knownHigh!, totals.unit)}` : null;
  const totalText = known === null ? 'No known figure yet' : totals.unit === 'hours' ? `Known effort: ${known}` : `Known monthly: ${known}`;
  const unitLabel = unit === 'hours' ? 'hours' : '$/month';
  return (
    <section className="rounded-card border border-line bg-panel" aria-label={title} data-testid={`ledger-${ledgerKey}`}>
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted">{sub}</p>
      </header>
      <ul className="divide-y divide-line">
        {ls.map((l) => (
          <li key={l.id} className="px-4 py-3" data-testid={`cost-line-${l.id}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="min-w-0 wrap-anywhere font-medium">{l.label}</p>
              <p className={`text-sm font-medium ${l.provenance === 'unknown' ? 'text-warning' : 'text-fg'}`}>{money(l)}</p>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Chip tone={PROVENANCE[l.provenance].tone}>{PROVENANCE[l.provenance].label}</Chip>
              <span className="text-sm text-muted">Paid by {PAYER[l.payer]}</span>
              {isOwnerLine(l) ? <button type="button" className="text-sm text-muted underline" onClick={() => onRemove(l.id)}>Remove<span className="sr-only"> {l.label}</span></button> : null}
            </div>
            <p className="mt-1 wrap-anywhere text-sm text-muted">{l.basis}{l.source ? <> Source: <a className="underline" href={l.source.url} target="_blank" rel="noreferrer">{l.source.name}</a>, checked {l.source.retrievedOn}, {l.source.region}, {l.source.currency}.</> : null}</p>
          </li>
        ))}
      </ul>
      <footer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-sm">
        <span className="font-medium" data-testid={`ledger-total-${ledgerKey}`}>{totalText}</span>
        {totals.unknownLines > 0 ? <span className="text-warning">{totals.unknownLines} unknown, not counted as zero</span> : null}
      </footer>
      <div className="border-t border-line px-4 py-3">
        {adding ? (
          <div className="space-y-3">
            <Field id={`${ledgerKey}-label`} label="What is it"><input id={`${ledgerKey}-label`} className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field id={`${ledgerKey}-low`} label={`Low, ${unitLabel}`}><input id={`${ledgerKey}-low`} className={inputClass} inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} /></Field>
              <Field id={`${ledgerKey}-base`} label="Base"><input id={`${ledgerKey}-base`} className={inputClass} inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} /></Field>
              <Field id={`${ledgerKey}-high`} label="High"><input id={`${ledgerKey}-high`} className={inputClass} inputMode="decimal" value={high} onChange={(e) => setHigh(e.target.value)} /></Field>
            </div>
            <Field id={`${ledgerKey}-payer`} label="Who pays">
              <select id={`${ledgerKey}-payer`} className={inputClass} value={payer} onChange={(e) => setPayer(e.target.value as CostLine['payer'])}>
                {COST_PAYERS.map((x) => <option key={x} value={x}>{PAYER[x]}</option>)}
              </select>
            </Field>
            <Field id={`${ledgerKey}-basis`} label="What this is based on" hint="Leave the amounts empty if you don't know yet. It will stay Unknown, never zero."><input id={`${ledgerKey}-basis`} className={inputClass} value={basis} onChange={(e) => setBasis(e.target.value)} /></Field>
            <div className="flex gap-2"><button type="button" className={buttonQuiet} disabled={!ok} onClick={add}>Add line</button><button type="button" className={buttonQuiet} onClick={reset}>Cancel</button></div>
          </div>
        ) : <button type="button" className={buttonQuiet} onClick={() => setAdding(true)}>Add a line<span className="sr-only"> to {title}</span></button>}
      </div>
    </section>
  );
}

const ASSUMPTION_LABELS: readonly { key: keyof CostAssumptions; label: string; hint: string }[] = [
  { key: 'users', label: 'Users', hint: 'For example, 200 a day.' },
  { key: 'traffic', label: 'Traffic', hint: 'For example, peak requests a minute.' },
  { key: 'storage', label: 'Storage', hint: 'For example, 5 GB in the first year.' },
  { key: 'aiUsage', label: 'AI usage', hint: 'Model calls in the product, if any.' },
];

export function FeasibilityStep(p: StepProps) {
  const { view, error, busy, run, api, heading, onGo } = p;
  const keys = useIntentKeys();
  const plan = view?.costPlan ?? null;
  const owned = (k: LedgerKey): OwnerCostLine[] => (plan?.ledgers[k].lines ?? []).filter(isOwnerLine).map(stripSource);
  const [budget, setBudget] = useState(plan?.agentBudgetUsd != null ? String(plan.agentBudgetUsd) : '');
  const [effort, setEffort] = useState<OwnerCostLine[]>(() => owned('build_effort'));
  const [production, setProduction] = useState<OwnerCostLine[]>(() => owned('production'));
  const [agentUsage, setAgentUsage] = useState<OwnerCostLine[]>(() => owned('agent_usage'));
  const [assumptions, setAssumptions] = useState<CostAssumptions>(plan?.assumptions ?? NO_ASSUMPTIONS);
  // Before the first save the server has no plan, so the labels and unknowns come from the same function it uses.
  const preview = useMemo(() => view?.costPlan ?? costPlanFor({ execution: view?.execution?.execution ?? null, agentBudgetUsd: null, effort: [], production: [], agentUsage: [] }), [view]);
  if (!view) return <StepFrame title="What will it cost?" heading={heading}><Notice tone="neutral" title="Not yet">Accept the blueprint first.</Notice></StepFrame>;
  const n = Number(budget);
  const budgetOk = budget.trim() !== '' && Number.isFinite(n) && n > 0;
  const save = async (): Promise<void> => {
    if (await run(() => api.saveCostPlan(view.projectId, { idempotencyKey: keys.keyFor('cost'), expectedRevision: view.revision, agentBudgetUsd: budgetOk ? n : null, effort, production, agentUsage, assumptions }), 'execution')) keys.settle('cost');
  };
  // What is on screen: the server's own lines plus what has been added here, with a placeholder dropped once something replaces it.
  const merged = (k: LedgerKey, own: readonly OwnerCostLine[]): CostLine[] => [...preview.ledgers[k].lines.filter((l) => !isOwnerLine(l) && !(OWNER_DEFAULT_LINES.has(l.id) && own.length > 0)), ...own.map((l) => ({ ...l, source: null }))];
  const setAssumption = (k: keyof CostAssumptions, patch: Partial<CostAssumptions[keyof CostAssumptions]>): void => setAssumptions((a) => ({ ...a, [k]: { ...a[k], ...patch } }));
  const cloudChanged = plan !== null && !plan.confirmed && view.execution !== null && view.execution.execution !== 'local';
  return (
    <StepFrame title="What will it cost?" heading={heading}
      intro={<p>Three separate things, never added together. A blank is unknown, not zero. This is a plan, not a quote.</p>}
      footer={<>{backTo(onGo, 'blueprint')}<button type="button" className={buttonPrimary} disabled={busy || !budgetOk} onClick={() => void save()}>Save cost plan</button>{!budgetOk ? <p className="text-sm text-warning">Set an agent budget to continue. Work with no limit is refused.</p> : null}</>}>
      <Failure error={error} />
      {plan && !plan.confirmed ? <Notice tone="warning" title="Needs review">{cloudChanged ? 'Your execution choice added cloud worker time to the plan. Check the new line, then save to confirm.' : 'Something this plan depends on changed. Save it again to confirm it still holds.'}</Notice> : null}
      <Field id="agent-budget" label="Agent budget ceiling, USD" hint="A limit on what agents may spend on this project. It is not an estimate of build effort or of running costs. A run is refused without one." error={fieldErrors(error).get('agentBudgetUsd')}><input id="agent-budget" className={inputClass} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
      {budgetOk && view?.deployment.attemptShares && view.deployment.maxAttempts ? <p className="text-sm text-muted" data-testid="attempt-cap">With up to {view.deployment.maxAttempts} attempts per worker and the models set now, each attempt may hold at most: {Object.entries(view.deployment.attemptShares).map(([role, share]) => `${role} ${usd(n * share)}`).join(', ')}. That is its worst case, and holds are not handed back, so this is sized for every repair.</p> : null}
      <Ledger ledgerKey="build_effort" title="Building the app" sub="Engineering effort for the first milestone, as a range." unit="hours" defaultPayer="you" lines={merged('build_effort', effort)} onAdd={(l) => setEffort((c) => [...c, l])} onRemove={(id) => setEffort((c) => c.filter((l) => l.id !== id))} />
      <Ledger ledgerKey="production" title="Running the app in production" sub="Hosting, database, paid APIs, once your app exists." unit="usd" defaultPayer="your_accounts" lines={merged('production', production)} onAdd={(l) => setProduction((c) => [...c, l])} onRemove={(id) => setProduction((c) => c.filter((l) => l.id !== id))} />
      <Ledger ledgerKey="agent_usage" title="Platform agent usage" sub="Agents, models and workers while building. Each line says who pays." unit="usd" defaultPayer="your_provider" lines={merged('agent_usage', agentUsage)} onAdd={(l) => setAgentUsage((c) => [...c, l])} onRemove={(id) => setAgentUsage((c) => c.filter((l) => l.id !== id))} />
      <section className="rounded-card border border-line bg-panel p-4" aria-label="Workload assumptions">
        <h2 className="text-base font-semibold">What these figures assume</h2>
        <p className="text-sm text-muted">Leave a row blank if you don&apos;t know yet.</p>
        <div className="mt-3 space-y-3">
          {ASSUMPTION_LABELS.map(({ key, label, hint }) => (
            <div key={key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
              <Field id={`assume-${key}`} label={label} hint={hint}><input id={`assume-${key}`} className={inputClass} value={assumptions[key].value ?? ''} onChange={(e) => { const v = e.target.value; setAssumption(key, v.trim() === '' ? { value: null, confidence: 'unknown' } : { value: v }); }} /></Field>
              <Field id={`confidence-${key}`} label="Confidence">
                <select id={`confidence-${key}`} className={inputClass} disabled={assumptions[key].value === null} value={assumptions[key].confidence} onChange={(e) => setAssumption(key, { confidence: e.target.value as CostAssumptions[keyof CostAssumptions]['confidence'] })}>
                  {(['unknown', 'low', 'medium', 'high'] as const).map((c) => <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>)}
                </select>
              </Field>
            </div>
          ))}
        </div>
      </section>
    </StepFrame>
  );
}
const stripSource = (l: CostLine): OwnerCostLine => { const { source: _s, ...rest } = l; return rest; };

// ---- 5. execution --------------------------------------------------------------------------------------------------

export function ExecutionStep(p: StepProps) {
  const { view, error, busy, run, api, heading, onGo } = p;
  const keys = useIntentKeys();
  const [execution, setExecution] = useState<ExecutionChoice>(view?.execution?.execution ?? 'local');
  const [inference, setInference] = useState<InferenceChoice>(view?.execution?.inference ?? 'PREFER_ON_DEVICE');
  if (!view) return null;
  const save = async (): Promise<void> => {
    if (await run(() => api.saveExecution(view.projectId, { idempotencyKey: keys.keyFor('execution'), expectedRevision: view.revision, execution, inference }), (v) => (v.costPlan && !v.costPlan.confirmed ? 'feasibility' : 'connections'))) keys.settle('execution');
  };
  const group = <T extends string>(name: string, value: T, set: (v: T) => void, options: readonly T[], text: Readonly<Record<T, { label: string; hint: string }>>) => (
    <div className="space-y-2">
      {options.map((o) => (
        <label key={o} className={`flex cursor-pointer items-start gap-2 rounded-card border p-3 text-sm ${value === o ? 'border-active bg-active-tint' : 'border-line bg-panel hover:border-line-strong'}`}>
          <input type="radio" className="mt-0.5" name={name} checked={value === o} onChange={() => set(o)} />
          <span><span className="block font-medium">{text[o].label}</span><span className="text-muted">{text[o].hint}</span></span>
        </label>
      ))}
    </div>
  );
  return (
    <StepFrame title="Where should work happen?" heading={heading}
      intro={<p>These are two separate choices. A local worker can still call a cloud model.</p>}
      footer={<>{backTo(onGo, 'feasibility')}<button type="button" className={buttonPrimary} disabled={busy} onClick={() => void save()}>Save and continue</button></>}>
      <Failure error={error} />
      <div className="grid gap-5 md:grid-cols-2">
        <fieldset>
          <legend className="text-sm font-semibold">Worker execution</legend>
          <p className="mb-2 text-sm text-muted">Where the coding agents run.</p>
          {group('execution', execution, setExecution, ['local', 'cloud', 'hybrid'] as const, EXECUTION_TEXT)}
        </fieldset>
        <fieldset>
          <legend className="text-sm font-semibold">Assistant inference</legend>
          <p className="mb-2 text-sm text-muted">Where the browser assistant&apos;s model runs. It never starts work.</p>
          {group('inference', inference, setInference, ['ONLY_ON_DEVICE', 'PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD'] as const, INFERENCE_TEXT)}
        </fieldset>
      </div>
    </StepFrame>
  );
}

// ---- 6. connections ------------------------------------------------------------------------------------------------

export function ConnectionsStep(p: StepProps) {
  const { view, error, busy, run, api, heading, onGo } = p;
  const keys = useIntentKeys();
  const served = view?.deployment.servesRepository ?? null;
  const [repository, setRepository] = useState(view?.connection?.repository ?? served ?? '');
  const [branch, setBranch] = useState(view?.connection?.defaultBranch ?? 'main');
  if (!view) return null;
  const save = async (): Promise<void> => {
    if (await run(() => api.saveConnection(view.projectId, { idempotencyKey: keys.keyFor('connection'), expectedRevision: view.revision, repository: repository.trim(), defaultBranch: branch.trim() }), 'readiness')) keys.settle('connection');
  };
  return (
    <StepFrame title="Connect the repository" heading={heading}
      intro={<p>Only what the first milestone needs. This step asks for no tokens or passwords. Agents use the credentials already on the machine they run on, and nothing here stores any.</p>}
      footer={<>{backTo(onGo, 'execution')}<button type="button" className={buttonPrimary} disabled={busy || !repository.includes('/') || branch.trim() === ''} onClick={() => void save()}>Save and continue</button></>}>
      <Failure error={error} />
      {served && served !== repository ? <Notice tone="warning" title="This deployment serves one repository">It already builds {served}. A different repository is refused, because the one source checkout cannot build it.</Notice> : null}
      <Field id="conn-repo" label="GitHub repository" hint="owner/name, for example acme/clinic-queue. A draft pull request opens here; a person merges it on GitHub." error={fieldErrors(error).get('repository')}><input id="conn-repo" className={`${inputClass} font-mono text-mono`} value={repository} onChange={(e) => setRepository(e.target.value)} spellCheck={false} autoCapitalize="none" /></Field>
      <Field id="conn-branch" label="Base branch" error={fieldErrors(error).get('defaultBranch')}><input id="conn-branch" className={`${inputClass} font-mono text-mono`} value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} autoCapitalize="none" /></Field>
      <div>
        <p className="text-sm font-medium">Source checkout on this server</p>
        <p className="mt-0.5 text-sm text-muted">Set by SELARIKRU_SOURCE_REPO. Checks and builds read this one checkout.</p>
        <p className="mt-1 wrap-anywhere font-mono text-mono" data-testid="source-checkout">{view.deployment.sourceCheckout ?? <span className="text-warning">None configured on this server</span>}</p>
      </div>
    </StepFrame>
  );
}

// ---- 7. readiness --------------------------------------------------------------------------------------------------

const OVERALL = { ready: { tone: 'success' as const, title: 'Ready', text: 'Every required check passed for this blueprint.' }, blocked: { tone: 'warning' as const, title: 'Blocked', text: 'An unknown result blocks just as a failure does.' } };

export function ReadinessStep(p: StepProps) {
  const { view, error, busy, run, api, heading, onGo } = p;
  if (!view) return null;
  const pass = view.readiness;
  const passedCount = pass?.checks.filter((c) => c.status === 'passed').length ?? 0;
  const check = (): void => void run(() => api.runReadiness(view.projectId, { expectedRevision: view.revision }));
  return (
    <StepFrame title="Is everything really ready?" heading={heading}
      intro={<p>Checks run on the server against real state. Nothing you typed or that the assistant said can make one pass.</p>}
      footer={<>{backTo(onGo, 'connections')}<button type="button" className={buttonPrimary} disabled={busy} onClick={check}>{busy ? 'Checking' : pass ? 'Run checks again' : 'Run the checks'}</button>{view.state === 'ready' ? <button type="button" className={buttonQuiet} onClick={() => onGo('start')}>Continue</button> : null}</>}>
      <Failure error={error} />
      {!view.deployment.checker ? <Notice tone="warning" title="No trusted checker">This server cannot perform the repository and GitHub checks, so they will report unknown.</Notice> : null}
      {pass ? (
        <>
          <Notice tone={OVERALL[pass.outcome].tone} title={OVERALL[pass.outcome].title}>{view.condition && pass.outcome === 'blocked' ? `${view.condition.reason} ` : null}{OVERALL[pass.outcome].text}</Notice>
          <p className="text-sm text-muted">{passedCount} of {pass.checks.length} checks passed for blueprint version {pass.blueprintVersion}. Checked {new Date(pass.checkedAt).toLocaleString()}.</p>
          <ul className="space-y-2" data-testid="readiness-checks">
            {pass.checks.map((c) => (
              <li key={c.id} data-testid={`check-${c.id}`} data-status={c.status} className={`rounded-card border bg-panel p-3 ${c.status === 'failed' ? 'border-danger' : c.status === 'unknown' ? 'border-warning' : 'border-line'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{c.label}</p>
                  <StatusChip status={c.status} />
                </div>
                <p className="mt-1 wrap-anywhere text-sm text-muted"><CodeText text={c.reason} /></p>
                {c.nextAction ? <p className="mt-1 wrap-anywhere text-sm"><span className="font-medium">Next:</span> <CodeText text={c.nextAction} /></p> : null}
              </li>
            ))}
          </ul>
        </>
      ) : <Notice tone="neutral" title="Not run yet">Run the checks to see whether this project can start.</Notice>}
    </StepFrame>
  );
}

// ---- 8. start ------------------------------------------------------------------------------------------------------

const GUIDANCE: readonly { route: string; label: string; text: string }[] = [
  { route: 'team', label: 'Team', text: 'Who owns the current task, and why a worker is waiting.' },
  { route: 'pipeline', label: 'Pipeline', text: 'How independent tasks run side by side.' },
  { route: 'evidence', label: 'Evidence', text: 'What the checks actually verified.' },
  { route: 'actions', label: 'Action items', text: 'Where a decision or pull request needs you. People merge; agents never do.' },
];

export function StartStep(p: StepProps) {
  const { view, error, busy, run, api, heading, onGo } = p;
  const keys = useIntentKeys();
  if (!view || !view.blueprint) return null;
  const activated = view.state === 'activated';
  const ready = view.state === 'ready';
  const start = async (): Promise<void> => {
    if (await run(() => api.activate(view.projectId, { idempotencyKey: keys.keyFor('activate'), expectedRevision: view.revision, blueprintVersion: view.blueprint!.version }))) keys.settle('activate');
  };
  const c = view.blueprint.content;
  return (
    <StepFrame title={activated ? 'Your first run is accepted' : 'Confirm the first run'} heading={heading} keepFooter
      intro={activated ? <p>The run exists but has no tasks yet. Next, plan it in the Assistant: draft the tasks, have the server check them, and accept the plan. Accepted does not mean your app is delivered or released.</p> : <p>This starts one bounded run under the limits below. No compute starts before you confirm.</p>}
      footer={activated ? (<>
        <a className={buttonPrimary} href={`?project=${encodeURIComponent(view.projectId)}#/assistant?run=${encodeURIComponent(view.firstRunId ?? '')}`}>Plan the run</a>
        <a className={buttonQuiet} href={`?project=${encodeURIComponent(view.projectId)}#/office`}>Open the project</a>
      </>) : (<>
        {backTo(onGo, 'readiness')}
        <button type="button" className={buttonPrimary} disabled={busy || !ready} onClick={() => void start()}>Start first run</button>
        {!ready ? <p className="text-sm text-warning">Readiness has not passed, so a run cannot start.</p> : null}
      </>)}>
      <Failure error={error} />
      <dl className="grid gap-3 rounded-card border border-line bg-panel p-4 text-sm sm:grid-cols-2">
        <div><dt className="text-muted">First milestone</dt><dd className="mt-0.5 font-medium">{c.firstMilestone.title}</dd></div>
        <div><dt className="text-muted">Blueprint</dt><dd className="mt-0.5">Version {view.blueprint.version}</dd></div>
        <div><dt className="text-muted">Agent budget ceiling</dt><dd className="mt-0.5">{view.costPlan?.agentBudgetUsd != null ? usd(view.costPlan.agentBudgetUsd) : 'Not set'}</dd></div>
        <div><dt className="text-muted">Worker execution</dt><dd className="mt-0.5">{view.execution ? EXECUTION_TEXT[view.execution.execution].label : 'Not chosen'}</dd></div>
        <div><dt className="text-muted">Assistant inference</dt><dd className="mt-0.5">{view.execution ? INFERENCE_TEXT[view.execution.inference].label : 'Not chosen'}</dd></div>
        <div><dt className="text-muted">Repository</dt><dd className="mt-0.5 wrap-anywhere font-mono text-mono">{view.connection?.repository ?? 'Not connected'}</dd></div>
        {view.readiness?.baseSha ? <div className="sm:col-span-2"><dt className="text-muted">Base commit</dt><dd className="mt-0.5 wrap-anywhere font-mono text-mono">{view.readiness.baseSha}</dd></div> : null}
      </dl>
      {activated && view.firstRunId ? <Notice tone="success" title="Run recorded"><span className="font-mono text-mono">{view.firstRunId}</span></Notice> : null}
      <section aria-labelledby="guide-title" className="rounded-card border border-line bg-panel p-4">
        <h2 id="guide-title" className="text-sm font-semibold">{activated ? 'Following this run' : 'Once it is running'}</h2>
        <dl className="mt-2 space-y-2 text-sm">
          {GUIDANCE.map((g) => <div key={g.route}><dt className="inline font-medium">{activated ? <a className="underline" href={`?project=${encodeURIComponent(view.projectId)}#/${g.route}`}>{g.label}</a> : g.label}.</dt> <dd className="inline text-muted">{g.text}</dd></div>)}
        </dl>
      </section>
    </StepFrame>
  );
}

export { CHECK_STATUS };
