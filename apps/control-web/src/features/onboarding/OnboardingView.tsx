import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TRACK_LABELS, type OnboardingList, type OnboardingView as View } from '@selarikru/domain';
import type { RestrictedDraftHold } from '@selarikru/inference-firebase-web';
import { Chip, buttonPrimary, buttonQuiet } from '@selarikru/ui';
import { useHashQuery } from '../../shell/route.ts';
import type { AssistantPort } from '../assistant/types.ts';
import type { ApiResult, OnboardingApi } from './api.ts';
import { ENTRY_STEPS } from './entry.ts';
import { BlueprintStep, ConnectionsStep, ExecutionStep, FeasibilityStep, FocusStep, GoalStep, ReadinessStep, SourceStep, StartStep, type StepProps } from './forms.tsx';
import { EXECUTION_TEXT, FailureText, INFERENCE_TEXT, Notice, ReadOnlyContext, SignInContext, usd, type SignInAgain } from './ui.tsx';
import { CONDITION_LABELS, STATE_LABELS, STEPS, furthestStep, reachableSteps, stepIndex, type StepId } from './steps.ts';

export interface OnboardingViewProps {
  /** Null when no control API is configured: the screen says so and offers nothing. */
  readonly api: OnboardingApi | null;
  /** The browser assistant. Null under demo data. */
  readonly adapter: AssistantPort | null;
  readonly hold: RestrictedDraftHold | null;
  readonly mode: 'mock' | 'live';
  readonly leaveDemoHref?: string | undefined;
  /** Called when a setup is activated on this page: the project now exists, so the shell can open it. Not called for one activated earlier. */
  readonly onActivated?: ((projectId: string) => void) | undefined;
  /** Signs the same account in again in place, offered where a request failed for the sign-in. */
  readonly signInAgain?: SignInAgain | undefined;
}

function Stepper({ current, reach, onGo }: { current: StepId; reach: number; onGo: (s: StepId) => void }) {
  const at = stepIndex(current);
  return (
    <nav aria-label="Setup steps">
      <p className="text-sm text-muted lg:hidden" data-testid="step-counter">Step {at + 1} of {STEPS.length}: <span className="font-medium text-fg">{STEPS[at]!.label}</span></p>
      <ol className="mt-2 flex items-center gap-1.5 lg:mt-0 lg:block lg:space-y-0.5">
        {STEPS.map((s, i) => {
          const state = i === at ? 'current' : i <= reach ? 'visited' : 'locked';
          const dot = (
            <span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${state === 'current' ? 'border-active bg-active text-bg' : state === 'visited' ? 'border-active text-active' : 'border-line text-muted'}`}>{i + 1}</span>
          );
          return (
            <li key={s.id} className="lg:relative">
              {state === 'locked' ? (
                <span className="flex items-center gap-3 rounded-chip py-1.5 text-sm text-muted lg:px-2" title="Finish the earlier steps first">{dot}<span className="hidden lg:inline">{s.label}</span><span className="sr-only lg:hidden">{s.label}</span><span className="sr-only">, not available yet</span></span>
              ) : (
                <button type="button" onClick={() => onGo(s.id)} aria-current={state === 'current' ? 'step' : undefined} className={`flex w-full items-center gap-3 rounded-chip py-1.5 text-left text-sm lg:px-2 ${state === 'current' ? 'font-medium text-fg lg:bg-panel-2' : 'text-muted hover:text-fg'}`}>
                  {dot}<span className="hidden lg:inline">{s.label}</span><span className="sr-only lg:hidden">{s.label}</span>
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function BriefRow({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-sm text-muted">{label}</dt><dd className="mt-0.5 wrap-anywhere text-sm text-fg">{children}</dd></div>;
}

/** Always shown, and always the server's record: the next outcome is a sentence about the record, not a guess. */
function Brief({ view }: { view: View | null }) {
  const tracks = view?.blueprint?.content.tracks ?? view?.focus?.tracks ?? [];
  return (
    <dl className="space-y-3">
      <BriefRow label="You are building">{view?.goal?.idea ?? <span className="text-muted">Not answered yet</span>}{view?.goalAssist ? <span className="mt-0.5 block text-muted">Wording suggested by the assistant ({view.goalAssist.observedSource === 'ON_DEVICE' ? 'on this device' : view.goalAssist.observedSource === 'IN_CLOUD' ? 'cloud model' : 'source unknown'}), reviewed by you</span> : null}</BriefRow>
      <BriefRow label="For">{view?.goal?.audience ?? <span className="text-muted">Not answered yet</span>}</BriefRow>
      <BriefRow label="First useful outcome">{view?.goal?.firstOutcome ?? <span className="text-muted">Not answered yet</span>}</BriefRow>
      <BriefRow label="Focus">{tracks.length ? tracks.map((t) => TRACK_LABELS[t]).join(', ') : <span className="text-muted">Not chosen</span>}</BriefRow>
      <BriefRow label="Worker execution">{view?.execution ? EXECUTION_TEXT[view.execution.execution].label : <span className="text-muted">Not chosen</span>}</BriefRow>
      <BriefRow label="Assistant inference">{view?.execution ? INFERENCE_TEXT[view.execution.inference].label : <span className="text-muted">Not chosen</span>}</BriefRow>
      <BriefRow label="Agent budget">{view?.costPlan?.agentBudgetUsd != null ? usd(view.costPlan.agentBudgetUsd) : <span className="text-warning">Not set</span>}</BriefRow>
      <BriefRow label="Repository">{view?.connection ? <span className="font-mono text-mono">{view.connection.repository}</span> : <span className="text-muted">Not connected</span>}</BriefRow>
      {view?.blueprint ? <BriefRow label="Blueprint">Version {view.blueprint.version}{view.blueprint.accepted ? ', accepted' : ', awaiting your review'}</BriefRow> : null}
    </dl>
  );
}

function Entry({ api, mode, onResume, onNew }: { api: OnboardingApi; mode: 'mock' | 'live'; onResume: (id: string) => void; onNew: () => void }) {
  const [list, setList] = useState<OnboardingList | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    let live = true;
    void api.list().then((r) => {
      if (!live) return;
      if (r.ok) setList(r.value);
      else setError({ code: r.code, message: r.message });
    });
    return () => { live = false; };
  }, [api]);
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Set up a project</h1>
      <p className="mt-2 max-w-prose text-muted">Answer a few questions and SelariKru drafts a blueprint you can edit. Nothing starts until your repository, runner and policy have passed real checks, and you confirm the first run.</p>
      {mode === 'mock' ? <div className="mt-4"><Notice tone="warning" title="Demo data">This walks through the flow with made-up data. Demo progress can never pass readiness or start a run.</Notice></div> : null}
      <div className="mt-6">
        <button type="button" className={buttonPrimary} onClick={onNew}>Start a new project</button>
      </div>
      <section aria-labelledby="preview-title" className="mt-8">
        <h2 id="preview-title" className="text-base font-semibold">What you will go through</h2>
        <ol className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {ENTRY_STEPS.map((s, i) => <li key={s.label} className="flex gap-2"><span aria-hidden="true" className="w-5 shrink-0 text-right text-muted">{i + 1}</span><span><span className="font-medium">{s.label}.</span> <span className="text-muted">{s.hint}</span></span></li>)}
        </ol>
      </section>
      {error ? <div className="mt-4"><Notice tone="danger" title="Could not load your setups"><FailureText code={error.code} message={error.message} /></Notice></div> : null}
      {list && list.items.length > 0 ? (
        <section aria-labelledby="resume-title" className="mt-8">
          <h2 id="resume-title" className="text-base font-semibold">Pick up where you left off</h2>
          <ul className="mt-3 divide-y divide-line rounded-card border border-line bg-panel">
            {list.items.map((item) => (
              <li key={item.projectId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="wrap-anywhere font-medium text-fg">{item.name}</p>
                  <p className="text-sm text-muted">{STATE_LABELS[item.state]}{item.condition ? `, ${item.condition.replace('_', ' ')}` : ''}</p>
                </div>
                {item.state === 'activated' ? <a className={buttonQuiet} href={`?project=${encodeURIComponent(item.projectId)}#/overview`}>Open project</a> : <button type="button" className={buttonQuiet} onClick={() => onResume(item.projectId)}>Continue setup</button>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Onboarding wizard. The server owns state; this keeps only the step being looked at. */
export function OnboardingView({ api, adapter, hold, mode, leaveDemoHref, onActivated, signInAgain }: OnboardingViewProps) {
  return <SignInContext.Provider value={signInAgain ?? null}><Onboarding api={api} adapter={adapter} hold={hold} mode={mode} leaveDemoHref={leaveDemoHref} onActivated={onActivated} /></SignInContext.Provider>;
}

function Onboarding({ api, adapter, hold, mode, leaveDemoHref, onActivated }: OnboardingViewProps) {
  const query = useHashQuery();
  const projectId = query.get('id');
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [step, setStep] = useState<StepId>('goal');
  const [error, setError] = useState<StepProps['error']>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(false);

  const load = useCallback(async (id: string) => {
    if (!api) return;
    const r = await api.get(id);
    if (r.ok) { setView(r.value); setStep(furthestStep(r.value)); setError(null); }
    else setError({ code: r.code, message: r.message, details: r.details });
  }, [api]);

  useEffect(() => {
    if (projectId) { setCreating(false); void load(projectId); }
    else setView(null);
  }, [projectId, load]);

  useEffect(() => { heading.current?.focus(); }, [step]);

  // Activated is the server's word that the project exists. Only a change to activated seen here opens it: looking at a setup activated earlier switches nothing.
  const seenState = useRef<{ projectId: string; state: View['state'] } | null>(null);
  useEffect(() => {
    if (!view) return;
    const before = seenState.current;
    seenState.current = { projectId: view.projectId, state: view.state };
    if (view.state === 'activated' && before !== null && before.projectId === view.projectId && before.state !== 'activated') onActivated?.(view.projectId);
  }, [view, onActivated]);

  const openProject = (id: string): void => {
    window.location.hash = `#/onboarding?id=${encodeURIComponent(id)}`;
  };

  /** Runs one server write. A busy guard stops a double submit reaching the server at all; the idempotency key covers anything that gets past it. */
  const run = useCallback(async (call: () => Promise<ApiResult<View>>, nextStep?: StepId | ((v: View) => StepId)): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const r = await call();
    busyRef.current = false;
    setBusy(false);
    if (r.ok) {
      setView(r.value);
      if (nextStep) setStep(typeof nextStep === 'function' ? nextStep(r.value) : nextStep);
      setNotice('Saved');
      return true;
    }
    if (r.code === 'stale_revision' && view) {
      await load(view.projectId);
      setError({ code: r.code, message: 'This setup changed somewhere else, so the latest version was loaded. Check it and continue.' });
      return false;
    }
    setError({ code: r.code, message: r.message, details: r.details });
    return false;
  }, [load, view]);

  if (!api) {
    return (
      <div className="mx-auto mt-10 max-w-xl">
        <h1 className="text-xl font-semibold">Setup is unavailable</h1>
        <p className="mt-2 text-muted">No control API is configured for this build, so a project cannot be set up here.</p>
      </div>
    );
  }
  if (!projectId && !creating) return <Entry api={api} mode={mode} onResume={openProject} onNew={() => { setCreating(true); setView(null); setStep('goal'); setError(null); }} />;

  const cancelSetup = async (): Promise<void> => {
    if (!view) return;
    if (await run(() => api.cancel(view.projectId, { expectedRevision: view.revision }))) {
      setConfirmingCancel(false);
      setCreating(false);
      window.location.hash = '#/onboarding';
    }
  };
  const go = (s: StepId): void => { setError(null); setStep(s); };
  const reach = reachableSteps(view);
  const props: StepProps = { api, view, busy, error, run, onGo: go, onCreated: openProject, adapter, hold, mode, heading };
  const reachIndex = Math.max(reach, stepIndex(step));
  return (
    <div>
      <p role="status" className="sr-only">{notice}</p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted">{projectId || creating ? 'New project' : ''}</p>
          <p className="mt-0.5 wrap-anywhere text-lg font-semibold tracking-tight" data-testid="setup-name">{view?.name ?? 'Untitled project'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view ? <Chip tone={view.condition ? 'warning' : 'neutral'} testId="setup-state">{view.condition ? CONDITION_LABELS[view.condition.kind] : STATE_LABELS[view.state]}</Chip> : null}
          {view && view.state !== 'activated' ? (confirmingCancel ? (
            <span className="flex items-center gap-2 text-sm">
              <span className="text-warning">Cancel this setup?</span>
              <button type="button" className="font-medium text-danger underline" onClick={() => void cancelSetup()}>Yes, cancel it</button>
              <button type="button" className="text-muted underline" onClick={() => setConfirmingCancel(false)}>Keep</button>
            </span>
          ) : <button type="button" className="text-sm text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => setConfirmingCancel(true)}>Cancel setup</button>) : null}
          <button type="button" className="text-sm text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => { window.location.hash = '#/onboarding'; setCreating(false); }}>All setups</button>
        </div>
      </div>
      {mode === 'mock' ? <div className="mt-3"><Notice tone="warning" title="Demo data">Nothing here creates a project.{leaveDemoHref ? <> <a className="underline" href={leaveDemoHref}>Leave demo mode</a></> : null}</Notice></div> : null}
      {view?.condition && step !== 'readiness' ? <div className="mt-3"><Notice tone={view.condition.kind === 'failed' ? 'danger' : 'warning'} title={view.condition.kind === 'needs_input' ? 'More information needed' : view.condition.kind === 'blocked' ? 'Blocked' : 'Failed'}>{view.condition.reason}</Notice></div> : null}

      <div className="mt-5 grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_20rem]">
        <div className="lg:sticky lg:top-28 lg:self-start"><Stepper current={step} reach={reachIndex} onGo={go} /></div>
        <ReadOnlyContext.Provider value={view?.state === 'activated'}>
        <fieldset disabled={view?.state === 'activated'} className="min-w-0 border-0 p-0">
          <legend className="sr-only">Setup step</legend>
          {step === 'goal' ? <GoalStep {...props} /> : null}
          {step === 'source' ? <SourceStep {...props} /> : null}
          {step === 'focus' ? <FocusStep {...props} /> : null}
          {step === 'blueprint' ? <BlueprintStep {...props} /> : null}
          {step === 'feasibility' ? <FeasibilityStep {...props} /> : null}
          {step === 'execution' ? <ExecutionStep {...props} /> : null}
          {step === 'connections' ? <ConnectionsStep {...props} /> : null}
          {step === 'readiness' ? <ReadinessStep {...props} /> : null}
          {step === 'start' ? <StartStep {...props} /> : null}
        </fieldset>
        </ReadOnlyContext.Provider>
        <aside aria-label="Project brief" className="min-w-0 lg:col-span-2 xl:col-span-1 xl:sticky xl:top-28 xl:self-start">
          <details className="rounded-card border border-line bg-panel xl:hidden" open={false}>
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Project brief</summary>
            <div className="border-t border-line p-4"><Brief view={view} /></div>
          </details>
          <div className="hidden rounded-card border border-line bg-panel p-4 xl:block">
            <h2 className="text-sm font-semibold">Project brief</h2>
            <div className="mt-3"><Brief view={view} /></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
