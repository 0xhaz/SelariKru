import type { ApiResult, AssistantApi, ClientInferenceReport, PlanRevisionResponse, ReviewResponse, ReviewedTask } from './types.ts';

export interface ApiClientOptions {
  readonly baseUrl: string;
  /** Returns a fresh Firebase ID token for the signed-in owner. */
  readonly getToken: () => Promise<string>;
}

/** Control API client. Every call carries the owner's ID token. */
export function createApiClient(opts: ApiClientOptions): AssistantApi {
  const base = opts.baseUrl.replace(/\/+$/, '');
  async function post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    try {
      const token = await opts.getToken();
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      if (res.ok) return { ok: true, value: json as T };
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      return { ok: false, status: res.status, code: err?.code ?? 'internal_error', message: err?.message ?? res.statusText, details: err?.details };
    } catch {
      return { ok: false, status: 0, code: 'network_error', message: 'network error' };
    }
  }
  const enc = encodeURIComponent;
  return {
    reviewProposal: ({ runId, envelope, acknowledgedIssuePaths }) =>
      post<ReviewResponse>(`/v1/runs/${enc(runId)}/proposals/review`, {
        envelope: { operation: envelope.operation, status: envelope.status, data: envelope.data },
        ...(acknowledgedIssuePaths && acknowledgedIssuePaths.length > 0 ? { acknowledgedIssuePaths } : {}),
      }),
    createPlanRevision: ({ runId, expectedRevision, tasks }: { runId: string; expectedRevision: number; tasks: readonly ReviewedTask[] }) =>
      post<PlanRevisionResponse>(`/v1/runs/${enc(runId)}/plan-revisions`, { expectedRevision, tasks }),
    postClientReport: ({ taskId, report }: { taskId: string; report: ClientInferenceReport }) =>
      post<{ reportId: string }>(`/v1/tasks/${enc(taskId)}/client-reports`, report),
  };
}
