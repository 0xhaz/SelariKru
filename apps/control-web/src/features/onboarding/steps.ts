import type { OnboardingView } from '@selarikru/domain';

export const STEPS = [
  { id: 'goal', label: 'Goal' },
  { id: 'source', label: 'Starting point' },
  { id: 'focus', label: 'Focus' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'feasibility', label: 'Cost plan' },
  { id: 'execution', label: 'Execution' },
  { id: 'connections', label: 'Connections' },
  { id: 'readiness', label: 'Readiness' },
  { id: 'start', label: 'Start' },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

export const stepIndex = (id: StepId): number => STEPS.findIndex((s) => s.id === id);

/** The furthest step the server's record allows. Derived from the view; the browser keeps no separate progress. */
export function furthestStep(view: OnboardingView | null): StepId {
  if (!view) return 'goal';
  switch (view.state) {
    case 'activated':
    case 'ready':
      return 'start';
    case 'readiness_check':
      return 'readiness';
    case 'configuring':
      if (!view.costPlan?.confirmed) return 'feasibility';
      if (!view.execution) return 'execution';
      if (!view.connection) return 'connections';
      return 'readiness';
    case 'blueprint_ready':
      return 'blueprint';
    default:
      if (!view.goal) return 'goal';
      if (!view.source) return 'source';
      if (!view.focus) return 'focus';
      return 'blueprint';
  }
}

/** Steps up to and including the furthest one can be revisited. */
export const reachableSteps = (view: OnboardingView | null): number => stepIndex(furthestStep(view));

export const CONDITION_LABELS: Readonly<Record<NonNullable<OnboardingView['condition']>['kind'], string>> = { needs_input: 'Needs input', blocked: 'Blocked', failed: 'Failed' };

export const STATE_LABELS: Readonly<Record<OnboardingView['state'], string>> = {
  draft: 'Draft',
  discovering: 'Gathering answers',
  blueprint_ready: 'Blueprint ready for review',
  configuring: 'Configuring',
  readiness_check: 'Checking readiness',
  ready: 'Ready to start',
  activated: 'First run accepted',
};
