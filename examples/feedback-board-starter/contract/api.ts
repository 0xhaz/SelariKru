// Frozen API contract for the Feedback Board benchmark (docs/demo-project.md section 3).
// Changing it requires a new cohort. Do not edit mid-run.

export const FEEDBACK_STATUSES = ['open', 'planned', 'done'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Query filter values for GET /api/feedback. */
export type StatusFilter = 'all' | FeedbackStatus;

export interface Feedback {
  /** Application-generated string ID with a stable lexical order. */
  id: string;
  /** Trimmed, 3 to 120 Unicode code points. */
  title: string;
  /** Trimmed, at most 1,000 Unicode code points; empty string when omitted. */
  description: string;
  status: FeedbackStatus;
  /** UTC ISO 8601 timestamp. */
  createdAt: string;
}

export interface FeedbackCounts {
  all: number;
  open: number;
  planned: number;
  done: number;
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
}
/** Alias matching the spec's name for the error shape. */
export type Error = ErrorBody;

/** GET /api/feedback?status=all|open|planned|done -> 200 (400 for an unknown status). */
export interface ListFeedbackResponse {
  items: Feedback[];
  counts: FeedbackCounts;
}

/** POST /api/feedback -> 201 (400 on invalid input). */
export interface CreateFeedbackRequest {
  title: string;
  description?: string;
}
export interface CreateFeedbackResponse {
  item: Feedback;
}

/** PATCH /api/feedback/:id -> 200 (400 on invalid status, 404 when the item is missing). */
export interface UpdateFeedbackRequest {
  status: FeedbackStatus;
}
export interface UpdateFeedbackResponse {
  item: Feedback;
}
