import { redactSecrets, validateProposal, advanceOnboarding, blueprintFromAnswers, costPlanFor, templateSupport, type BlueprintContent, type CostAssumptions, type LedgerKey, type OnboardingView } from '@selarikru/domain';
import type { ApiResult, OnboardingApi } from './api.ts';

const REASON = 'Demo mode never runs a real check, so this could not be confirmed.';
const fail = (message: string): ApiResult<never> => ({ ok: false, status: 409, code: 'demo_data', message });

/**
 * The onboarding screens over in-memory data, for `?demo` only. It never touches a network and it cannot reach `ready`: every check is unknown, whatever was entered.
 * Its only job is to let someone see the flow without connecting a real app, clearly labelled as demo data.
 */
const ASSIST_CRITERIA_IDS = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7', 'AC-8'];
const hasSecret = (v: unknown): boolean => typeof v === 'string' ? redactSecrets(v) !== v : Array.isArray(v) ? v.some(hasSecret) : v !== null && typeof v === 'object' ? Object.values(v).some(hasSecret) : false;

/**
 * H9, hosted demo: the guide's answer comes from a real model, and there is no control API to review it. It is checked here with the server's own rule
 * (control-api `/v1/onboarding/assist-review`): a draftBrief that passed, citing only the known criteria, with no credential in it. Nothing is saved.
 */
async function reviewLocally(input: Parameters<OnboardingApi['reviewAssist']>[0]): ReturnType<OnboardingApi['reviewAssist']> {
  if (input.restricted === true) return { ok: false, status: 422, code: 'restricted_stays_on_device', message: 'A draft made from restricted text stays on your device, so it cannot be applied here.' };
  if (input.envelope.status !== 'ok' || input.envelope.operation !== 'draftBrief') return { ok: false, status: 422, code: 'proposal_not_acceptable', message: 'This proposal cannot be used.' };
  const v = validateProposal(input.envelope.data, { operation: 'draftBrief', allowedRequirementIds: ASSIST_CRITERIA_IDS, forbiddenMandatoryScope: [] });
  if (v.status === 'rejected' || v.data === null || !('summary' in v.data) || hasSecret(v.data)) return { ok: false, status: 422, code: 'proposal_rejected', message: 'The proposal failed validation.' };
  return { ok: true, value: { status: v.status === 'needs_review' ? 'needs_review' : 'valid', summary: v.data.summary, acceptanceCriteria: v.data.acceptanceCriteria.map((c) => ({ id: c.requirementId, text: c.text })), issues: v.issues.map((i) => ({ kind: i.kind, path: i.path, message: i.message })) } };
}

export function createDemoOnboardingApi(opts: { readonly reviewLocally?: boolean } = {}): OnboardingApi {
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
  const planFor = (v: OnboardingView, agentBudgetUsd: number | null, assumptions: CostAssumptions): OnboardingView['costPlan'] => {
    const plan = costPlanFor({ execution: v.execution?.execution ?? null, agentBudgetUsd, effort: [], production: [], agentUsage: [], assumptions });
    const copy = (k: LedgerKey) => ({ lines: [...plan.ledgers[k].lines], totals: plan.ledgers[k].totals });
    return { agentBudgetUsd, confirmed: true, assumptions, ledgers: { build_effort: copy('build_effort'), production: copy('production'), agent_usage: copy('agent_usage') } };
  };
  return {
    list: async () => ({ ok: true, value: { items: [...views.values()].map((v) => ({ projectId: v.projectId, name: v.name, state: v.state, condition: null, updatedAt: new Date(0).toISOString() })) } }),
    get: async (id) => (views.has(id) ? { ok: true, value: get(id) } : { ok: false, status: 404, code: 'onboarding_not_found', message: 'No such setup.' }),
    create: async ({ goal }) => {
      const v: OnboardingView = { projectId: 'demo-setup-1', name: goal.name, state: 'draft', condition: null, revision: 0, goal, goalAssist: null, source: null, focus: null, blueprint: null, template: null, costPlan: null, execution: null, connection: null, readiness: null, firstRunId: null, deployment: { sourceCheckout: null, servesRepository: null, checker: false } };
      return save(v);
    },
    saveAnswers: async (id, b) => { const v = get(id); return save({ ...v, ...(b.goal ? { goal: b.goal, name: b.goal.name } : {}), ...(b.source ? { source: b.source } : {}), ...(b.focus ? { focus: b.focus, template: templateSupport(b.focus.tracks) as OnboardingView['template'] } : {}), state: moved(v, 'answers_saved') }); },
    createBlueprint: async (id, b) => {
      const v = get(id);
      content = b.content ?? blueprintFromAnswers({ goal: v.goal!, source: v.source!, focus: v.focus! });
      return save({ ...v, state: moved(v, 'blueprint_created'), readiness: null, blueprint: { version: (v.blueprint?.version ?? 0) + 1, accepted: false, origin: b.content ? 'owner' : 'controller', contentSha256: 'demo', createdAt: new Date(0).toISOString(), content } });
    },
    acceptBlueprint: async (id) => { const v = get(id); return save({ ...v, state: moved(v, 'blueprint_accepted'), blueprint: v.blueprint && { ...v.blueprint, accepted: true } }); },
    saveCostPlan: async (id, b) => { const v = get(id); return save({ ...v, costPlan: planFor(v, b.agentBudgetUsd, b.assumptions) }); },
    saveExecution: async (id, b) => { const v = get(id); return save({ ...v, execution: { execution: b.execution, inference: b.inference } }); },
    saveConnection: async (id, b) => { const v = get(id); return save({ ...v, connection: { repository: b.repository, defaultBranch: b.defaultBranch } }); },
    runReadiness: async (id) => {
      const v = get(id);
      const ids = [['template_supported', 'Template can run'], ['stack_certified', 'Checkout is the pilot stack'], ['checkout_present', 'Checkout present'], ['repository_identity', 'Checkout matches repository'], ['repository_reachable', 'Repository reachable'], ['base_commit', 'Base commit resolves'], ['runner_enrolled', 'Runner enrolled'], ['runner_has_project', 'Runner has this project'], ['pipeline_drivers', 'Build and verification running'], ['policy_loaded', 'Policy loaded'], ['budget_limit', 'Agent budget set']] as const;
      return save({ ...v, state: moved(v, 'readiness_blocked'), condition: { kind: 'blocked', reason: 'Demo data cannot pass readiness.' }, readiness: { blueprintVersion: v.blueprint?.version ?? 1, outcome: 'blocked', checkedAt: new Date().toISOString(), baseSha: null, snapshot: null, checks: ids.map(([cid, label]) => ({ id: cid, label, status: 'unknown', reason: REASON, nextAction: 'Run the real stack to perform this check.', required: true })) } });
    },
    activate: async () => fail('Demo data cannot start a run.'),
    cancel: async (id) => { views.delete(id); return { ok: true, value: {} as OnboardingView }; },
    reviewAssist: opts.reviewLocally ? reviewLocally : async () => fail('The assistant is off in demo mode.'),
  };
}
