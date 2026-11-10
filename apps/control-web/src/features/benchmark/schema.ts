import { BenchmarkFileSchema, type BenchmarkFile } from '@selarikru/view-protocol';

/** The results file's schema lives in `@selarikru/view-protocol`, shared with `tools/benchmarks`, which exports and publishes it. This module only loads it. */
export { ASSISTANT_EVIDENCE_IDS, ASSISTANT_MODES, BenchmarkFileSchema, COMMIT_SHA, FEEDBACK_CRITERIA, WORKER_MODES, allCriteriaPassed } from '@selarikru/view-protocol';
export type { AssistantMode, BenchmarkCohort, BenchmarkFile, BenchmarkRecord, WorkerMode } from '@selarikru/view-protocol';

export type BenchmarkLoad =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] }
  | { readonly kind: 'ok'; readonly file: BenchmarkFile };

export const RESULTS_FILE = 'benchmark-results.json';

/** Far larger than a real cohort's export. A bigger answer is refused rather than parsed. */
export const MAX_RESULTS_CHARS = 8 * 1024 * 1024;

/** Reads the published results file. No file, or a host answering with its HTML page, means nothing has been measured. Anything else either parses or is refused, and nothing is invented in its place. */
export async function loadBenchmark(url: string = `${import.meta.env.BASE_URL}${RESULTS_FILE}`, fetchFn: typeof fetch = fetch): Promise<BenchmarkLoad> {
  let response: Response;
  let body: string;
  try {
    response = await fetchFn(url, { cache: 'no-store' });
    if (response.status === 404) return { kind: 'absent' };
    if (!response.ok) return { kind: 'unreachable', detail: `The server answered ${response.status}.` };
    if (Number(response.headers.get('content-length') ?? 0) > MAX_RESULTS_CHARS) return { kind: 'invalid', issues: ['The results file is too large to read.'] };
    body = await response.text();
  } catch {
    return { kind: 'unreachable', detail: 'The results file could not be requested.' };
  }
  if (body.length > MAX_RESULTS_CHARS) return { kind: 'invalid', issues: ['The results file is too large to read.'] };
  if (/^\s*<(?:!doctype\s+html|html)[\s>]/i.test(body)) return { kind: 'absent' };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { kind: 'invalid', issues: ['The results file is not valid JSON.'] };
  }
  const parsed = BenchmarkFileSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', issues: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'file'}: ${i.message}`) };
  return { kind: 'ok', file: parsed.data };
}
