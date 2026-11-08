import type { AssistRequest, AssistantProposal, Readiness } from '@selarikru/inference-firebase-web';

/** The adapter surface the UI uses. FirebaseHybridAssistantAdapter satisfies it; tests inject a fake. */
export interface AssistantPort {
  draftBrief(req: AssistRequest): Promise<AssistantProposal>;
  suggestCriteria(req: AssistRequest): Promise<AssistantProposal>;
  draftTaskPlan(req: AssistRequest): Promise<AssistantProposal>;
  getReadiness(): Promise<Readiness>;
  downloadModel(onProgress: (fraction: number) => void): Promise<void>;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string; readonly details?: unknown };

/** A TaskSpec candidate as the server built it. Passed back verbatim to plan-revisions. */
export type ReviewedTask = { readonly taskId: string; readonly title: string; readonly requirementIds: readonly string[] } & Readonly<Record<string, unknown>>;

export interface ReviewIssue {
  readonly kind: string;
  readonly path: string;
  readonly message: string;
}

export interface ReviewResponse {
  readonly expectedRevision: number;
  readonly tasks: readonly ReviewedTask[];
  readonly needsReview: boolean;
  readonly droppedFields: readonly string[];
  readonly issues: readonly ReviewIssue[];
}

export interface PlanRevisionResponse {
  readonly planRevision: number;
  readonly taskIds: readonly string[];
}

/** Route, source and model labels only. Never prompt text or output. */
export interface ClientInferenceReport {
  readonly kind: 'inference';
  readonly mode: 'ONLY_ON_DEVICE' | 'PREFER_ON_DEVICE' | 'ONLY_IN_CLOUD' | 'PREFER_IN_CLOUD';
  readonly observedSource: 'on_device' | 'in_cloud' | 'unknown';
  readonly model?: string;
}

/** Calls the authenticated owner makes. The implementation attaches the owner token. */
export interface AssistantApi {
  reviewProposal(a: {
    runId: string;
    envelope: { operation: string; status: string; data: unknown };
    acknowledgedIssuePaths?: readonly string[];
  }): Promise<ApiResult<ReviewResponse>>;
  createPlanRevision(a: { runId: string; expectedRevision: number; tasks: readonly ReviewedTask[] }): Promise<ApiResult<PlanRevisionResponse>>;
  postClientReport(a: { taskId: string; report: ClientInferenceReport }): Promise<ApiResult<{ reportId: string }>>;
}
