import { advanceOnboarding, blueprintFromAnswers, costPlanFor, templateSupport, type BlueprintContent, type OnboardingView } from '@selarikru/domain';
import type { ApiResult, OnboardingApi } from './api.ts';

const REASON = 'Demo mode never runs a real check, so this could not be confirmed.';
const fail = (message: string): ApiResult<never> => ({ ok: false, status: 409, code: 'demo_data', message });

/**
 * The onboarding screens over in-memory data, for `?demo` only. It never touches a network and it cannot reach `ready`: every check is unknown, whatever was entered.
 * Its only job is to let someone see the flow without connecting a real app, clearly labelled as demo data.
 */
export function createDemoOnboardingApi(): OnboardingApi {
  const views = new Map<string, OnboardingView>();
  let content: BlueprintContent | null = null;
  const save = (v: OnboardingView): ApiResult<OnboardingView> => {
    const next = { ...v, revision: v.revision + 1 };
    views.set(v.projectId, next);
    return { ok: true, value: next };
  };
  const moved = (v: OnboardingView, event: Parameters<typeof advanceOnboarding>[1]): OnboardingView['state'] => {
    const r = advanceOnboarding(v.state, event);
    return r.ok ? r.value : v.state;
  };
  const get = (id: string): OnboardingView => views.get(id)!;
  const planFor = (v: OnboardingView, agentBudgetUsd: number | null, provider: readonly never[] = [], app: readonly never[] = []): OnboardingView['costPlan'] => {
    const plan = costPlanFor({ execution: v.execution?.execution ?? null, agentBudgetUsd, provider, app });
    return { agentBudgetUsd, confirmed: true, ledgers: { platform: { lines: [...plan.ledgers.platform.lines], totals: plan.ledgers.platform.totals }, provider: { lines: [...plan.ledgers.provider.lines], totals: plan.ledgers.provider.totals }, app: { lines: [...plan.ledgers.app.lines], totals: plan.ledgers.app.totals } } };
  };
  return {
    list: async () => ({ ok: true, value: { items: [...views.values()].map((v) => ({ projectId: v.projectId, name: v.name, state: v.state, condition: null, updatedAt: new Date(0).toISOString() })) } }),
    get: async (id) => (views.has(id) ? { ok: true, value: get(id) } : { ok: false, status: 404, code: 'onboarding_not_found', message: 'No such setup.' }),
    create: async ({ goal }) => {
      const v: OnboardingView = { projectId: 'demo-setup-1', name: goal.name, state: 'draft', condition: null, revision: 0, goal, source: null, focus: null, blueprint: null, template: null, costPlan: null, execution: null, connection: null, readiness: null, firstRunId: null, deployment: { sourceCheckout: null, servesRepository: null, checker: false } };
      return save(v);
    },
    saveAnswers: async (id, b) => { const v = get(id); return save({ ...v, ...(b.goal ? { goal: b.goal, name: b.goal.name } : {}), ...(b.source ? { source: b.source } : {}), ...(b.focus ? { focus: b.focus, template: templateSupport(b.focus.tracks) as OnboardingView['template'] } : {}), state: moved(v, 'answers_saved') }); },
    createBlueprint: async (id, b) => {
      const v = get(id);
      content = b.content ?? blueprintFromAnswers({ goal: v.goal!, source: v.source!, focus: v.focus! });
      return save({ ...v, state: moved(v, 'blueprint_created'), readiness: null, blueprint: { version: (v.blueprint?.version ?? 0) + 1, accepted: false, origin: b.content ? 'owner' : 'controller', contentSha256: 'demo', createdAt: new Date(0).toISOString(), content } });
    },
    acceptBlueprint: async (id) => { const v = get(id); return save({ ...v, state: moved(v, 'blueprint_accepted'), blueprint: v.blueprint && { ...v.blueprint, accepted: true } }); },
    saveCostPlan: async (id, b) => { const v = get(id); return save({ ...v, costPlan: planFor(v, b.agentBudgetUsd) }); },
    saveExecution: async (id, b) => { const v = get(id); return save({ ...v, execution: { execution: b.execution, inference: b.inference } }); },
    saveConnection: async (id, b) => { const v = get(id); return save({ ...v, connection: { repository: b.repository, defaultBranch: b.defaultBranch } }); },
    runReadiness: async (id) => {
      const v = get(id);
      const ids = [['template_supported', 'Template can run'], ['repository_path', 'Repository reachable'], ['repository_identity', 'Checkout matches repository'], ['base_commit', 'Base commit resolves'], ['runner_enrolled', 'Runner enrolled'], ['policy_loaded', 'Policy loaded'], ['github_auth', 'GitHub sign-in'], ['budget_limit', 'Agent budget set']] as const;
      return save({ ...v, state: moved(v, 'readiness_blocked'), condition: { kind: 'blocked', reason: 'Demo data cannot pass readiness.' }, readiness: { blueprintVersion: v.blueprint?.version ?? 1, outcome: 'blocked', checkedAt: new Date().toISOString(), baseSha: null, checks: ids.map(([cid, label]) => ({ id: cid, label, status: 'unknown', reason: REASON, nextAction: 'Run the real stack to perform this check.', required: true })) } });
    },
    activate: async () => fail('Demo data cannot start a run.'),
    cancel: async (id) => { views.delete(id); return { ok: true, value: {} as OnboardingView }; },
    reviewAssist: async () => fail('The assistant is off in demo mode.'),
  };
}
