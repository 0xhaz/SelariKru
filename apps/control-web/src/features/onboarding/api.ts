import { AssistReviewResponseSchema, OnboardingListSchema, OnboardingViewSchema, type AssistReviewResponse, type BlueprintContent, type CostLine, type ExecutionChoice, type FocusAnswers, type GoalAnswers, type OnboardingList, type OnboardingView, type SourceAnswers } from '@selarikru/domain';
import type { z } from 'zod';
import type { ApiResult } from '../assistant/types.ts';

export type { ApiResult } from '../assistant/types.ts';
export type OwnerCostLine = Omit<CostLine, 'source'>;
export interface Write { readonly idempotencyKey: string; readonly expectedRevision: number }
export type InferenceChoice = NonNullable<OnboardingView['execution']>['inference'];

/** Every onboarding write goes through the server, which owns the state. Results are validated before the screen uses them. */
export interface OnboardingApi {
  list(): Promise<ApiResult<OnboardingList>>;
  get(id: string): Promise<ApiResult<OnboardingView>>;
  create(input: { idempotencyKey: string; goal: GoalAnswers }): Promise<ApiResult<OnboardingView>>;
  saveAnswers(id: string, input: Write & { goal?: GoalAnswers; source?: SourceAnswers; focus?: FocusAnswers }): Promise<ApiResult<OnboardingView>>;
  createBlueprint(id: string, input: Write & { content?: BlueprintContent }): Promise<ApiResult<OnboardingView>>;
  acceptBlueprint(id: string, input: Write & { version: number }): Promise<ApiResult<OnboardingView>>;
  saveCostPlan(id: string, input: Write & { agentBudgetUsd: number | null; provider: readonly OwnerCostLine[]; app: readonly OwnerCostLine[] }): Promise<ApiResult<OnboardingView>>;
  saveExecution(id: string, input: Write & { execution: ExecutionChoice; inference: InferenceChoice }): Promise<ApiResult<OnboardingView>>;
  saveConnection(id: string, input: Write & { repository: string; defaultBranch: string }): Promise<ApiResult<OnboardingView>>;
  runReadiness(id: string, input: { expectedRevision: number }): Promise<ApiResult<OnboardingView>>;
  activate(id: string, input: Write & { blueprintVersion: number }): Promise<ApiResult<OnboardingView>>;
  cancel(id: string, input: { expectedRevision: number }): Promise<ApiResult<OnboardingView>>;
  reviewAssist(input: { envelope: { operation: string; status: string; data: unknown }; restricted?: boolean }): Promise<ApiResult<AssistReviewResponse>>;
}

export function createOnboardingApi(opts: { baseUrl: string; getToken: () => Promise<string> }): OnboardingApi {
  const base = opts.baseUrl.replace(/\/+$/, '');
  async function send<S extends z.ZodType>(schema: S, path: string, body?: unknown): Promise<ApiResult<z.infer<S>>> {
    try {
      const token = await opts.getToken();
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
        return { ok: false, status: res.status, code: e?.code ?? 'internal_error', message: e?.message ?? 'The request failed.', details: e?.details };
      }
      const parsed = schema.safeParse(json);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, status: 0, code: 'bad_response', message: 'The server sent a response this page could not read.' };
    } catch {
      return { ok: false, status: 0, code: 'network_error', message: 'Could not reach the server. Your answers are still here; try again.' };
    }
  }
  const v = OnboardingViewSchema;
  const id = encodeURIComponent;
  return {
    list: () => send(OnboardingListSchema, '/v1/onboarding'),
    get: (p) => send(v, `/v1/onboarding/${id(p)}`),
    create: (b) => send(v, '/v1/onboarding', b),
    saveAnswers: (p, b) => send(v, `/v1/onboarding/${id(p)}/answers`, b),
    createBlueprint: (p, b) => send(v, `/v1/onboarding/${id(p)}/blueprints`, b),
    acceptBlueprint: (p, b) => send(v, `/v1/onboarding/${id(p)}/blueprint/accept`, b),
    saveCostPlan: (p, b) => send(v, `/v1/onboarding/${id(p)}/cost-plan`, b),
    saveExecution: (p, b) => send(v, `/v1/onboarding/${id(p)}/execution`, b),
    saveConnection: (p, b) => send(v, `/v1/onboarding/${id(p)}/connections`, b),
    runReadiness: (p, b) => send(v, `/v1/onboarding/${id(p)}/readiness`, b),
    activate: (p, b) => send(v, `/v1/onboarding/${id(p)}/activate`, b),
    cancel: (p, b) => send(v, `/v1/onboarding/${id(p)}/cancel`, b),
    reviewAssist: (b) => send(AssistReviewResponseSchema, '/v1/onboarding/assist-review', b),
  };
}
