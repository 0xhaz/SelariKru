import { z } from 'zod';
import { AGENT_LIMITS, applyFileDiff, canonicalPath, checkPatch, parseUnifiedDiff, reservedPath } from './agents.ts';
import type { RunnerHarnessReport } from './assignment.ts';
import { insideAllowedPaths, secretFileReason } from './checkpoint.ts';
import { allowedPathProblem } from './plan.ts';
import { redactSecrets } from './redact.ts';
import { sha256Hex } from './sha256.ts';

/**
 * Accepted patch proposals (plan.md §3 Option A, H5). Every AI step runs in the owner's browser through Firebase AI Logic; the runner only puts the accepted change into a
 * clean workspace, then builds, tests and verifies it. Nothing here calls a model.
 *
 * The proposal a person accepts carries the checked `results` of `checkPatch` (each file's full contents after the patch, or a delete) and the diff text for review. The
 * runner writes the results, never the diff. The server checks everything it can without the base files, and the runner, which has the repository, checks the rest
 * (`reproduceProposal`) before it writes anything.
 */

/** The no-model worker that applies an accepted proposal. Recorded on the attempt like any assignment, with route `none`: it makes no model call at all. */
export const APPLY_PROVIDER = 'selarikru';
export const APPLY_MODEL = 'apply-proposal';
export const APPLY_HARNESS_VERSION = '1.0.0';
export const APPLY_WORKER_LABEL = 'Applies accepted changes (no model)';
/** What a runner that can apply accepted proposals reports with every claim. */
export const APPLY_HARNESS_REPORT: RunnerHarnessReport = { provider: APPLY_PROVIDER, harnessVersion: APPLY_HARNESS_VERSION, models: [APPLY_MODEL] };
export const isApplyAssignment = (a: { readonly provider: string; readonly model: string } | null | undefined): boolean => a?.provider === APPLY_PROVIDER && a.model === APPLY_MODEL;

/**
 * Which coding workers this build launches. `off` (the default, and the hackathon build): only `apply_proposal`, so no worker calls a model API; every AI step is the
 * browser's, through Firebase AI Logic. `claude_code`: Claude Code workers too, an integration outside Firebase AI Logic.
 */
export const CODING_WORKERS = ['off', 'claude_code'] as const;
export type CodingWorkers = (typeof CODING_WORKERS)[number];
export const DEFAULT_CODING_WORKERS: CodingWorkers = 'off';
export const CODING_WORKERS_OFF_LABEL = 'Not used in the hackathon build (outside Firebase AI Logic)';
export const parseCodingWorkers = (raw: string | undefined): CodingWorkers | null => (raw === undefined || raw.trim() === '' ? DEFAULT_CODING_WORKERS : (CODING_WORKERS as readonly string[]).includes(raw.trim()) ? (raw.trim() as CodingWorkers) : null);

/** The refusal for a restricted task's proposal: its content never goes to the server. */
export const RESTRICTED_APPLY_REFUSAL = 'Restricted work is applied by the local runner on this device';

export const APPLY_LIMITS = {
  /** Files one proposal may change: the patch agent's own limit. */
  files: AGENT_LIMITS.patchFiles,
  /** One result's contents, in characters. A given file is at most 20k and the diff adds at most 20k more, so a larger result was not produced by a checked patch. */
  fileChars: AGENT_LIMITS.fileChars + AGENT_LIMITS.patchDiffChars,
  /** All results together. */
  totalChars: AGENT_LIMITS.filesTotalChars + AGENT_LIMITS.patchDiffChars,
  diffChars: AGENT_LIMITS.patchDiffChars,
} as const;

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const RefId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** One checked result: the file's full contents after the patch and their sha256, or a delete (both null). */
export const AcceptedResultSchema = z.strictObject({ path: z.string().min(1).max(200), sha256: Hex64.nullable(), content: z.string().max(APPLY_LIMITS.fileChars + 1).nullable() });
export type AcceptedResult = z.infer<typeof AcceptedResultSchema>;

export const AcceptedProposalSchema = z.strictObject({
  /** The proposal's own id (the browser call's request id). */
  proposalId: RefId,
  taskId: RefId,
  taskRevision: z.number().int().min(1),
  baseSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  /** The route record of the call that produced it (its request id). */
  routeRecordId: RefId,
  /** For review only: the runner never applies it. */
  diff: z.string().min(1).max(APPLY_LIMITS.diffChars),
  results: z.array(AcceptedResultSchema).min(1).max(APPLY_LIMITS.files),
});
export type AcceptedProposal = z.infer<typeof AcceptedProposalSchema>;

/** The digest of the results, by path, hash and delete: what the event, the lease and the runner name. Never content. */
export function acceptedProposalDigest(p: Pick<AcceptedProposal, 'baseSha' | 'results'>): string {
  const rows = [...p.results].map((r) => `${r.path}\0${r.sha256 ?? 'deleted'}`).sort();
  return sha256Hex(`${p.baseSha}\n${rows.join('\n')}`);
}

export const APPLY_ISSUE_CODES = [
  'task_mismatch', 'stale_revision', 'base_mismatch', 'path_invalid', 'path_reserved', 'path_secret', 'path_outside_allowed', 'result_duplicate', 'hash_mismatch',
  'result_too_large', 'secret_content', 'diff_unreadable', 'diff_results_mismatch',
] as const;
export type ApplyIssueCode = (typeof APPLY_ISSUE_CODES)[number];
export type ApplyCheck = { readonly ok: true; readonly digest: string } | { readonly ok: false; readonly code: ApplyIssueCode; readonly index?: number };

export interface ApplyTarget {
  readonly taskId: string;
  readonly revision: number;
  readonly baseSha: string;
  readonly allowedPaths: readonly string[];
}

/** Why a result's path may not be written, or null. Must already be canonical: the browser sends what `checkPatch` gave it. */
export function applyPathIssue(path: string, allowed: readonly string[]): ApplyIssueCode | null {
  if (canonicalPath(path) !== path || allowedPathProblem(path) !== null) return 'path_invalid';
  if (reservedPath(path)) return 'path_reserved';
  if (secretFileReason(path) !== null) return 'path_secret';
  if (!insideAllowedPaths(path, allowed)) return 'path_outside_allowed';
  return null;
}

/**
 * Everything that can be checked without the base files, the same on the server and the runner. The task, revision and base are the server's own; each path is canonical,
 * allowed and neither reserved nor a credentials file; each hash matches; sizes are capped; no content is secret-shaped; and the diff names exactly the results' paths,
 * with a delete where the diff deletes and, for a created file, exactly the contents the diff gives it.
 */
export function checkAcceptedProposal(p: AcceptedProposal, task: ApplyTarget): ApplyCheck {
  const fail = (code: ApplyIssueCode, index?: number): ApplyCheck => (index === undefined ? { ok: false, code } : { ok: false, code, index });
  if (p.taskId !== task.taskId) return fail('task_mismatch');
  if (p.taskRevision !== task.revision) return fail('stale_revision');
  if (p.baseSha !== task.baseSha) return fail('base_mismatch');
  if (p.results.length === 0 || p.results.length > APPLY_LIMITS.files) return fail('result_too_large');
  const seen = new Set<string>();
  let total = 0;
  for (const [i, r] of p.results.entries()) {
    const bad = applyPathIssue(r.path, task.allowedPaths);
    if (bad) return fail(bad, i);
    if (seen.has(r.path.toLowerCase())) return fail('result_duplicate', i);
    seen.add(r.path.toLowerCase());
    if ((r.content === null) !== (r.sha256 === null)) return fail('hash_mismatch', i);
    if (r.content === null) continue;
    if (r.content.length > APPLY_LIMITS.fileChars) return fail('result_too_large', i);
    total += r.content.length;
    if (total > APPLY_LIMITS.totalChars) return fail('result_too_large', i);
    if (sha256Hex(r.content) !== r.sha256) return fail('hash_mismatch', i);
    if (redactSecrets(r.content) !== r.content) return fail('secret_content', i);
  }
  if (p.diff.length > APPLY_LIMITS.diffChars) return fail('result_too_large');
  const parsed = parseUnifiedDiff(p.diff);
  if (!parsed.ok) return fail('diff_unreadable');
  const byPath = new Map(p.results.map((r) => [r.path, r]));
  if (parsed.files.length !== p.results.length || parsed.files.some((f) => !byPath.has(f.path))) return fail('diff_results_mismatch');
  for (const f of parsed.files) {
    const r = byPath.get(f.path)!;
    if ((f.change === 'delete') !== (r.content === null)) return fail('diff_results_mismatch');
    if (f.change === 'create') {
      const made = applyFileDiff(null, f);
      if (!made.ok || made.content !== r.content) return fail('diff_results_mismatch');
    }
  }
  return { ok: true, digest: acceptedProposalDigest(p) };
}

/**
 * The check only the repository can make: the diff, applied with `checkPatch` to the base files, gives exactly the results. `base` holds every result path's contents at
 * the base commit; a path absent from it does not exist there. Any difference is `base_mismatch`, and nothing may be written.
 */
export function reproduceProposal(p: Pick<AcceptedProposal, 'diff' | 'results'>, base: ReadonlyMap<string, string>, allowedPaths: readonly string[]): { readonly ok: true } | { readonly ok: false; readonly code: 'base_mismatch' } {
  const checked = checkPatch(p.diff, { allowedPaths, files: base });
  if (!checked.ok) return { ok: false, code: 'base_mismatch' };
  if (checked.results.size !== p.results.length) return { ok: false, code: 'base_mismatch' };
  for (const r of p.results) {
    if (!checked.results.has(r.path) || checked.results.get(r.path) !== r.content) return { ok: false, code: 'base_mismatch' };
  }
  return { ok: true };
}

/** The coding agent as the worker drawer names it. The apply worker has no model, and says so. */
export function codingAgentLabel(rec: { readonly provider: string; readonly model: string }, harness: { readonly label: string; readonly harnessVersion: string | null } | null | undefined): string {
  if (isApplyAssignment(rec)) return APPLY_WORKER_LABEL;
  return `${harness?.label ?? rec.provider}${harness?.harnessVersion ? ` ${harness.harnessVersion}` : ''} ${rec.model}`;
}

/** The owner's pull request description: a title line and the agent's body as the owner edited them. */
export const PR_DESCRIPTION_MAX_CHARS = 6_000;

/** The description as it may be sent: secret-shaped values redacted, trimmed, capped. Null when nothing is left. */
export function ownerPrDescription(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = redactSecrets(raw).replace(/\r\n?/g, '\n').trim();
  return text === '' ? null : text.slice(0, PR_DESCRIPTION_MAX_CHARS);
}

// ---- base file contents for the patch agent (H5 item 5) ------------------------------------------------------------------------

/**
 * The patch agent reads the task's files at the base commit. The local runner reads them with git (`git cat-file` at the base, never the working tree), and they reach
 * the owner's browser only through the owner-authenticated API relay, which keeps nothing. Restricted tasks are never served. Counts are the patch agent's own limits.
 */
export const BASE_FILE_LIMITS = { requestPaths: AGENT_LIMITS.patchFiles, files: AGENT_LIMITS.patchFiles, fileChars: AGENT_LIMITS.fileChars, totalChars: AGENT_LIMITS.filesTotalChars } as const;
export const BASE_FILE_OMISSIONS = ['too_large', 'too_many', 'not_found', 'not_text', 'secret_content', 'reserved', 'secret_file_name', 'outside_allowed'] as const;
export type BaseFileOmission = (typeof BASE_FILE_OMISSIONS)[number];

const RelayPath = z.string().min(1).max(200);
/** What the server asks a runner for: files under these paths (each inside the task's allowed paths) at this base. */
export const BaseFileRequestSchema = z.strictObject({
  requestId: RefId, projectId: RefId, baseSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  paths: z.array(RelayPath).min(1).max(BASE_FILE_LIMITS.requestPaths), allowedPaths: z.array(RelayPath).max(64),
});
export type BaseFileRequest = z.infer<typeof BaseFileRequestSchema>;
export const BaseFileAnswerSchema = z.strictObject({
  requestId: RefId,
  files: z.array(z.strictObject({ path: RelayPath, content: z.string().max(BASE_FILE_LIMITS.fileChars) })).max(BASE_FILE_LIMITS.files),
  omitted: z.array(z.strictObject({ path: RelayPath, reason: z.enum(BASE_FILE_OMISSIONS) })).max(200),
});
export type BaseFileAnswer = z.infer<typeof BaseFileAnswerSchema>;

/** Why one listed base file may not be served, or null. The same rule on the runner and the server. */
export function baseFileIssue(path: string, allowed: readonly string[]): BaseFileOmission | null {
  if (canonicalPath(path) !== path || allowedPathProblem(path) !== null) return 'outside_allowed';
  if (reservedPath(path)) return 'reserved';
  if (secretFileReason(path) !== null) return 'secret_file_name';
  if (!insideAllowedPaths(path, allowed)) return 'outside_allowed';
  return null;
}

/**
 * The answer as it may be relayed: every file re-checked by path, size and content, the caps applied in path order, and anything else listed by path and reason only.
 * Runs on the server over a runner's answer, so a runner cannot widen what the browser gets.
 */
export function screenBaseFiles(answer: Pick<BaseFileAnswer, 'files' | 'omitted'>, allowed: readonly string[]): Pick<BaseFileAnswer, 'files' | 'omitted'> {
  const files: { path: string; content: string }[] = [];
  const omitted: { path: string; reason: BaseFileOmission }[] = answer.omitted.map((o) => ({ path: o.path, reason: o.reason }));
  let total = 0;
  const seen = new Set<string>();
  for (const f of [...answer.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    const bad = baseFileIssue(f.path, allowed);
    if (bad) { omitted.push({ path: f.path, reason: bad }); continue; }
    if (f.content.length > BASE_FILE_LIMITS.fileChars || total + f.content.length > BASE_FILE_LIMITS.totalChars) { omitted.push({ path: f.path, reason: 'too_large' }); continue; }
    if (files.length >= BASE_FILE_LIMITS.files) { omitted.push({ path: f.path, reason: 'too_many' }); continue; }
    if (redactSecrets(f.content) !== f.content) { omitted.push({ path: f.path, reason: 'secret_content' }); continue; }
    total += f.content.length;
    files.push({ path: f.path, content: f.content });
  }
  // A withheld path is never named to the browser unless it is inside the task's scope and was only too large or too many.
  return { files, omitted: omitted.filter((o) => baseFileIssue(o.path, allowed) === null) };
}
