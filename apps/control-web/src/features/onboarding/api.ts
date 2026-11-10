import { AssistReviewResponseSchema, OnboardingListSchema, OnboardingViewSchema, type AssistReviewResponse, type BlueprintContent, type CostAssumptions, type CostLine, type ExecutionChoice, type FocusAnswers, type GoalAnswers, type GoalAssist, type OnboardingList, type OnboardingView, type SourceAnswers } from '@selarikru/domain';
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
  create(input: { idempotencyKey: string; goal: GoalAnswers; goalAssist?: GoalAssist }): Promise<ApiResult<OnboardingView>>;
  saveAnswers(id: string, input: Write & { goal?: GoalAnswers; goalAssist?: GoalAssist | null; source?: SourceAnswers; focus?: FocusAnswers }): Promise<ApiResult<OnboardingView>>;
  createBlueprint(id: string, input: Write & { content?: BlueprintContent }): Promise<ApiResult<OnboardingView>>;
  acceptBlueprint(id: string, input: Write & { version: number }): Promise<ApiResult<OnboardingView>>;
  saveCostPlan(id: string, input: Write & { agentBudgetUsd: number | null; effort: readonly OwnerCostLine[]; production: readonly OwnerCostLine[]; agentUsage: readonly OwnerCostLine[]; assumptions: CostAssumptions }): Promise<ApiResult<OnboardingView>>;
  saveExecution(id: string, input: Write & { execution: ExecutionChoice; inference: InferenceChoice }): Promise<ApiResult<OnboardingView>>;
  saveConnection(id: string, input: Write & { repository: string; defaultBranch: string }): Promise<ApiResult<OnboardingView>>;
  runReadiness(id: string, input: { expectedRevision: number }): Promise<ApiResult<OnboardingView>>;
  activate(id: string, input: Write & { blueprintVersion: number }): Promise<ApiResult<OnboardingView>>;
  cancel(id: string, input: { expectedRevision: number }): Promise<ApiResult<OnboardingView>>;
  reviewAssist(input: { envelope: { operation: string; status: string; data: unknown }; restricted?: boolean; projectId?: string; observed?: { source: 'ON_DEVICE' | 'IN_CLOUD' | 'UNKNOWN'; requestedMode: InferenceChoice | null } }): Promise<ApiResult<AssistReviewResponse>>;
}

const SIGN_IN_AGAIN = 'Your sign-in has expired. Sign in again to continue; answers already saved are kept.';
const NOT_OWNER = 'This account is not the project owner, so it cannot set up projects here. Sign in with the owner account.';
/** Refusals a fresh sign-in can fix, so the screen offers one. */
export const SIGN_IN_CODES: readonly string[] = ['unauthenticated', 'invalid_token', 'not_owner'];
/** Firebase Auth codes a retry can fix. Any other `auth/` code (signed out, expired, revoked or disabled) needs the person to sign in again. */
const TRANSIENT_AUTH_CODES: readonly string[] = ['auth/network-request-failed', 'auth/too-many-requests', 'auth/internal-error', 'auth/timeout'];

/** True for a sign-in that cannot give a token, read by its code and never by its wording. */
function isSignInFailure(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('auth/') && !TRANSIENT_AUTH_CODES.includes(code);
}

export function createOnboardingApi(opts: { baseUrl: string; getToken: () => Promise<string> }): OnboardingApi {
  const base = opts.baseUrl.replace(/\/+$/, '');
  async function send<S extends z.ZodType>(schema: S, path: string, body?: unknown): Promise<ApiResult<z.infer<S>>> {
    let token: string;
    try {
      token = await opts.getToken();
    } catch (e) {
      // Nothing was sent: a stale sign-in is not the server being down, and saying so would send the person to check the wrong thing.
      if (isSignInFailure(e)) return { ok: false, status: 0, code: 'unauthenticated', message: SIGN_IN_AGAIN };
      return { ok: false, status: 0, code: 'network_error', message: 'Could not reach the server. Your answers are still here; try again.' };
    }
    try {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
        const code = e?.code ?? 'internal_error';
        if (code === 'not_owner') return { ok: false, status: res.status, code, message: NOT_OWNER, details: e?.details };
        if (res.status === 401 || SIGN_IN_CODES.includes(code)) return { ok: false, status: res.status, code, message: SIGN_IN_AGAIN, details: e?.details };
        return { ok: false, status: res.status, code, message: e?.message ?? 'The request failed.', details: e?.details };
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
