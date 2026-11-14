import { z } from 'zod';
import { insideAllowedPaths, secretFileReason } from './checkpoint.ts';
import { allowedPathProblem, validatePlanRevision } from './plan.ts';
import { PLAN_TASK_ROLES } from './proposal.ts';
import { ROUTE_STEP_KINDS, type RouteStepKind } from './route-policy.ts';
import { SKILL_WORKSPACE_ROOT } from './skills.ts';
import type { TaskSpec } from './task.ts';

/**
 * The agent catalog's outputs (plan.md §4.3). Each AI step of a task is one Firebase AI Logic agent: a role prompt, the task's route, bounded read-only inputs, and one
 * of these outputs. An output is an untrusted proposal: it goes through the accept and approve flows, and nothing here runs, grants or authorizes anything.
 *
 * Pure and browser-safe. The browser adapter validates every response against these before it calls a response `ok`; the server can run the same checks on anything a
 * person submits from a proposal.
 */
export const AGENT_KINDS = ROUTE_STEP_KINDS;
export type AgentKind = RouteStepKind;

export const AGENT_LIMITS = {
  criteria: 8,
  planTasks: 12,
  pathsPerItem: 8,
  breakdownSteps: 10,
  reviewFindings: 20,
  /** A patch proposal's diff text, in characters. */
  patchDiffChars: 20_000,
  patchFiles: 8,
  /** Added plus removed lines across the whole patch. */
  patchChangedLines: 400,
  prTitleChars: 72,
  prBodyChars: 4_000,
  /** One file's contents given to an agent, in characters. A larger file is left out and listed, never cut. */
  fileChars: 20_000,
  /** All file contents given to one call. */
  filesTotalChars: 60_000,
  /** A failed check's output given to triage. Larger output is refused, never cut. */
  checkOutputChars: 16_000,
} as const;

/** Whether the agent's output cites the task's criterion IDs, so a call without any is refused before it reaches a model. */
export const AGENT_CITES_CRITERIA: Readonly<Record<AgentKind, boolean>> = {
  brief: true, criteria: true, plan: true, breakdown: true, patch: false, review: true, triage: false, prDescription: true,
  pmAnswer: false, pmResearch: false, pmPlan: true, pmDelegate: false, pmBrief: false, pmVerify: false, pmVerifyNoWeb: false,
};

/**
 * H13: the plan brief's bounds. The owner's points and open questions go in; Nano returns a goal, items and uncertainties, each short enough to check, and counts
 * what it left out. The cloud checks the approved brief and nothing else.
 */
export const PLAN_BRIEF_LIMITS = { goalChars: 280, itemChars: 280, items: 20, uncertainties: 10, omitted: 40, explanationChars: 400, answerChars: 600, sources: 5, inputLines: 60 } as const;
export const PLAN_BRIEF_ITEM_KINDS = ['requirement', 'decision', 'constraint', 'assumption', 'fact'] as const;
export const PLAN_BRIEF_OMIT_REASONS = ['private', 'duplicate', 'empty'] as const;
export const PLAN_BRIEF_VERDICTS = ['supported', 'contradicted', 'unclear', 'not_checkable'] as const;
/** Without web search the cloud can only judge a point against what it knows: never "supported" by the web. */
export const PLAN_BRIEF_NO_WEB_VERDICTS = ['consistent', 'inconsistent', 'unclear'] as const;
export const PLAN_BRIEF_CONFIDENCE = ['high', 'medium', 'low'] as const;
/** A pmPlan's architecture section (H13), part of the call's output and so of its hash; the server maps only the tasks. */
export const PM_PLAN_ARCHITECTURE_CHARS = 2000;

export const REVIEW_OUTCOMES = ['no_issues', 'changes_suggested', 'blocking_issues'] as const;
export const REVIEW_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export const TRIAGE_CATEGORIES = ['test_failure', 'build_error', 'type_error', 'lint', 'timeout', 'environment', 'flaky', 'unknown'] as const;

const text = (max: number) => z.string().min(1).max(max);
const path = z.string().min(1).max(200);
const planKey = z.string().regex(/^T[0-9]{1,2}$/);

/** The output schema for one agent, with criterion IDs narrowed to the ones this call allows. No IDs: no criterion can be cited. */
/** What a Project Manager call may name (H11): the Brain sources it was given, and the accepted plan's tasks and the workers it may delegate to. */
export interface PmIds {
  readonly sourceIds?: readonly string[];
  readonly taskIds?: readonly string[];
  readonly workerIds?: readonly string[];
  /** Fix round 2 (I4): the roles a PM plan task may take (the plan's roles); absent: the coding roles. */
  readonly roles?: readonly string[];
  /** H13: the approved brief's item and question ids a check may answer. */
  readonly briefItemIds?: readonly string[];
  readonly briefQuestionIds?: readonly string[];
}

const oneOf = (ids: readonly string[] | undefined): z.ZodType => (ids && ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never());

export function agentOutputSchema(kind: AgentKind, criteriaIds: readonly string[], pm: PmIds = {}): z.ZodType {
  const id: z.ZodType = criteriaIds.length > 0 ? z.enum(criteriaIds as [string, ...string[]]) : z.never();
  const criteria = z.array(z.strictObject({ requirementId: id, text: text(400) })).min(1).max(AGENT_LIMITS.criteria);
  switch (kind) {
    case 'brief':
      return z.strictObject({ summary: text(400), acceptanceCriteria: criteria });
    case 'criteria':
      return z.strictObject({ acceptanceCriteria: criteria });
    case 'plan':
      return z.strictObject({
        tasks: z.array(z.strictObject({
          key: planKey, title: text(120), description: text(600), role: z.enum(PLAN_TASK_ROLES),
          requirementIds: z.array(id).min(1).max(AGENT_LIMITS.criteria), paths: z.array(path).min(1).max(AGENT_LIMITS.pathsPerItem),
          dependsOn: z.array(planKey).max(AGENT_LIMITS.planTasks - 1),
        })).min(1).max(AGENT_LIMITS.planTasks),
      });
    case 'breakdown':
      return z.strictObject({
        steps: z.array(z.strictObject({ title: text(120), detail: text(400), paths: z.array(path).max(AGENT_LIMITS.pathsPerItem), criteriaIds: z.array(id).max(AGENT_LIMITS.criteria) }))
          .min(1).max(AGENT_LIMITS.breakdownSteps),
      });
    case 'patch':
      return z.strictObject({ summary: text(400), diff: text(AGENT_LIMITS.patchDiffChars) });
    case 'review':
      return z.strictObject({
        outcome: z.enum(REVIEW_OUTCOMES), summary: text(600),
        findings: z.array(z.strictObject({ file: path, line: z.int().min(1).max(1_000_000), severity: z.enum(REVIEW_SEVERITIES), criterionId: id.optional(), message: text(400) }))
          .max(AGENT_LIMITS.reviewFindings),
      });
    case 'triage':
      return z.strictObject({
        summary: text(400), category: z.enum(TRIAGE_CATEGORIES), likelyCause: text(600), nextStep: text(400),
        location: z.strictObject({ file: path, line: z.int().min(1).max(1_000_000).optional() }).optional(),
      });
    case 'prDescription':
      return z.strictObject({ title: text(AGENT_LIMITS.prTitleChars), body: text(AGENT_LIMITS.prBodyChars), criteriaCovered: z.array(id).max(AGENT_LIMITS.criteria) });
    // H11: the Project Manager. Its answer may cite only the Brain sources it was given; research findings carry no URLs (the web sources come from the
    // SDK's grounding metadata, never from the model's text); a delegation names only the accepted plan's tasks and the project's workers, and nothing else.
    case 'pmAnswer':
      return z.strictObject({ answer: text(2000), citations: z.array(z.strictObject({ sourceId: oneOf(pm.sourceIds), note: text(300) })).max(8) });
    case 'pmResearch':
      return z.strictObject({ answer: text(2000), findings: z.array(z.strictObject({ point: text(400) })).max(8) });
    // Fix round 2 (I4): like a plan, with the run's roles and an optional `revises` naming one of the run's current tasks it was shown.
    case 'pmPlan':
      return z.strictObject({
        tasks: z.array(z.strictObject({
          key: planKey, title: text(120), description: text(600), role: pm.roles && pm.roles.length > 0 ? oneOf(pm.roles) : z.enum(PLAN_TASK_ROLES),
          requirementIds: z.array(id).min(1).max(AGENT_LIMITS.criteria), paths: z.array(path).min(1).max(AGENT_LIMITS.pathsPerItem),
          dependsOn: z.array(planKey).max(AGENT_LIMITS.planTasks - 1),
          revises: oneOf(pm.taskIds).optional(),
        })).min(1).max(AGENT_LIMITS.planTasks),
        // H13: components, data and key decisions, citing the brief's item ids. Shown above the tasks; covered by the call's output hash.
        architecture: text(PM_PLAN_ARCHITECTURE_CHARS).optional(),
      });
    case 'pmDelegate':
      return z.strictObject({ assignments: z.array(z.strictObject({ taskId: oneOf(pm.taskIds), workerId: oneOf(pm.workerIds), why: text(200) })).min(1).max(AGENT_LIMITS.planTasks) });
    // H13: the plan brief, formatted on the device. Ids P1..P20 and U1..U10; what was left out is counted with a reason, never quoted.
    case 'pmBrief': {
      const B = PLAN_BRIEF_LIMITS;
      // Fix round 1 (I1): `from`, the input line numbers (points first, then questions) each entry covers, so completeness is checked per point. Grouping is
      // allowed; an item that names no line is shown as invented. An omitted entry names at least one.
      const from = z.array(z.int().min(1).max(B.inputLines)).max(B.inputLines);
      return z.strictObject({
        goal: z.string().max(B.goalChars),
        items: z.array(z.strictObject({ id: z.string().regex(/^P(?:[1-9]|1[0-9]|20)$/), text: text(B.itemChars), kind: z.enum(PLAN_BRIEF_ITEM_KINDS), checkable: z.boolean(), source: z.enum(['points', 'conversation']), from })).max(B.items),
        uncertainties: z.array(z.strictObject({ id: z.string().regex(/^U(?:[1-9]|10)$/), question: text(B.itemChars), from })).max(B.uncertainties),
        omitted: z.array(z.strictObject({ reason: z.enum(PLAN_BRIEF_OMIT_REASONS), from: from.min(1) })).max(B.omitted),
      });
    }
    // H13: the cloud's checks of the approved brief. Only the ids it was given. Web sources are shown as text links, https only (the screen drops any other).
    case 'pmVerify':
    case 'pmVerifyNoWeb': {
      const B = PLAN_BRIEF_LIMITS;
      const web = kind === 'pmVerify';
      const sources = { sources: z.array(z.strictObject({ title: text(200), url: z.string().min(1).max(500) })).max(B.sources) };
      return z.strictObject({
        items: z.array(z.strictObject({ id: oneOf(pm.briefItemIds), verdict: web ? z.enum(PLAN_BRIEF_VERDICTS) : z.enum(PLAN_BRIEF_NO_WEB_VERDICTS), explanation: text(B.explanationChars), ...(web ? sources : {}) })).max(B.items),
        uncertainties: z.array(z.strictObject({ id: oneOf(pm.briefQuestionIds), answer: text(B.answerChars), confidence: z.enum(PLAN_BRIEF_CONFIDENCE), ...(web ? sources : {}) })).max(B.uncertainties),
      });
    }
  }
}

/** The same schema as JSON Schema, for the model's structured output. No `$schema` key: the SDK and Ajv take the object as is. */
export function agentOutputJsonSchema(kind: AgentKind, criteriaIds: readonly string[], pm: PmIds = {}): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(agentOutputSchema(kind, criteriaIds, pm)) as Record<string, unknown>;
  return schema;
}

// ---- checks -------------------------------------------------------------------------------------------------------------------

export const AGENT_ISSUE_CODES = [
  'schema_invalid', 'path_invalid', 'path_reserved', 'path_secret', 'path_outside_allowed', 'diff_header_mismatch', 'duplicate_key', 'missing_dependency', 'self_dependency', 'cycle',
  'diff_empty', 'diff_unparseable', 'diff_unsupported', 'diff_duplicate_file', 'diff_too_large', 'diff_file_not_provided', 'diff_file_exists', 'diff_does_not_apply',
  'review_diff_unreadable', 'finding_file_not_in_diff', 'finding_line_out_of_range',
] as const;
export type AgentIssueCode = (typeof AGENT_ISSUE_CODES)[number];
/** A code and a JSON path into the output. Never the output's text, and never a path name the model chose. */
export interface AgentIssue {
  readonly code: AgentIssueCode;
  readonly path: string;
}

export interface AgentCheckContext {
  /** The criterion IDs this call may cite. */
  readonly criteriaIds: readonly string[];
  /** The task's allowed paths. A breakdown or patch path must be inside them (none allows nothing); a plan's paths must be when any are given. */
  readonly allowedPaths: readonly string[];
  /** The file contents the agent was given, by path. A patch may change only these, or create a file that is not among them. */
  readonly files?: ReadonlyMap<string, string>;
  /** The diff a review was asked about. */
  readonly reviewedDiff?: string;
  /** H11: what a Project Manager call may name. */
  readonly pm?: PmIds;
}

export type AgentCheck = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly issues: readonly AgentIssue[] };

const jsonPath = (p: readonly PropertyKey[]): string => `/${p.map((x) => (typeof x === 'symbol' ? '*' : String(x))).join('/')}`;

/**
 * The one spelling every check uses: leading `./` removed and Unicode NFC. Null when the path cannot be one plain repo-relative file path: empty, absolute, a trailing
 * `/`, an empty, `.` or `..` segment, a quote, a backslash, or a control character (NUL, CR, tab and the rest).
 */
export function canonicalPath(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (raw === '' || /[\u0000-\u001f\u007f"\\]/.test(raw)) return null;
  const p = raw.replace(/^(\.\/)+/, '').normalize('NFC');
  if (p === '' || p.endsWith('/')) return null;
  const segs = p.split('/');
  if (segs.some((x) => x === '' || x === '.' || x === '..')) return null;
  return p;
}

/**
 * Paths no agent output may touch, whatever the task's allowed paths say: the skills workspace (`.claude/skills`), SelariKru's own `.selarikru`, `.git` anywhere, and
 * `.env` or `.env.*` anywhere. Matched case-insensitively, since a case-insensitive file system makes `.Env` and `.env` one file.
 */
export function reservedPath(path: string): boolean {
  const segs = path.normalize('NFC').toLowerCase().replace(/^(\.\/)+/, '').replace(/\/+$/, '').split('/');
  const root = SKILL_WORKSPACE_ROOT.toLowerCase().split('/');
  if (root.every((r, i) => segs[i] === r)) return true;
  if (segs[0] === '.selarikru') return true;
  // `.env` and `.env.*` exactly, as a segment. `.envrc` or `.environment/` are not this rule's; credential-shaped names are `secretFileReason`'s.
  return segs.some((x) => x === '.git' || x === '.env' || x.startsWith('.env.'));
}

/**
 * Why a proposed path is not usable, or null. Plain repo-relative, not reserved, not a credentials file by name, and inside `allowed` when that is a bound. A plan or
 * breakdown names directory prefixes, so a trailing `/` is dropped first; a patch's paths come canonical from the parser.
 */
function pathIssue(raw: string, allowed: readonly string[] | null): AgentIssueCode | null {
  const p = canonicalPath(raw.replace(/\/+$/, ''));
  if (p === null || allowedPathProblem(p) !== null) return 'path_invalid';
  if (reservedPath(p)) return 'path_reserved';
  if (secretFileReason(p) !== null) return 'path_secret';
  if (allowed !== null && !insideAllowedPaths(p, allowed)) return 'path_outside_allowed';
  return null;
}

/** Schema first, then the checks that need the call's context. */
export function checkAgentOutput(kind: AgentKind, data: unknown, ctx: AgentCheckContext): AgentCheck {
  const parsed = agentOutputSchema(kind, ctx.criteriaIds, ctx.pm).safeParse(data);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ code: 'schema_invalid', path: jsonPath(i.path) })) };
  const issues: AgentIssue[] = [];
  const add = (code: AgentIssueCode, ...p: PropertyKey[]): void => void issues.push({ code, path: jsonPath(p) });
  const out = parsed.data as Record<string, unknown>;
  switch (kind) {
    case 'plan':
    case 'pmPlan':
      checkPlan(out as unknown as PlanOutput, ctx, add);
      break;
    case 'breakdown':
      (out as unknown as BreakdownOutput).steps.forEach((s, i) => s.paths.forEach((p, j) => { const c = pathIssue(p, ctx.allowedPaths); if (c) add(c, 'steps', i, 'paths', j); }));
      break;
    case 'patch': {
      const r = checkPatch((out as { diff: string }).diff, ctx);
      if (!r.ok) for (const i of r.issues) issues.push({ code: i.code, path: `/diff${i.path === '/' ? '' : i.path}` });
      break;
    }
    case 'review':
      checkReview(out as unknown as ReviewOutput, ctx, add);
      break;
    case 'pmBrief': {
      const b = out as { items: { id: string }[]; uncertainties: { id: string }[] };
      const seen = new Set<string>();
      b.items.forEach((x, i) => { if (seen.has(x.id)) add('duplicate_key', 'items', i, 'id'); seen.add(x.id); });
      b.uncertainties.forEach((x, i) => { if (seen.has(x.id)) add('duplicate_key', 'uncertainties', i, 'id'); seen.add(x.id); });
      break;
    }
    case 'pmVerify':
    case 'pmVerifyNoWeb': {
      const v = out as { items: { id: string }[]; uncertainties: { id: string }[] };
      const seen = new Set<string>();
      v.items.forEach((x, i) => { if (seen.has(x.id)) add('duplicate_key', 'items', i, 'id'); seen.add(x.id); });
      v.uncertainties.forEach((x, i) => { if (seen.has(x.id)) add('duplicate_key', 'uncertainties', i, 'id'); seen.add(x.id); });
      break;
    }
    case 'triage': {
      const loc = (out as { location?: { file: string } }).location;
      if (loc && allowedPathProblem(loc.file) !== null) add('path_invalid', 'location', 'file');
      break;
    }
    default:
      break;
  }
  return issues.length === 0 ? { ok: true, data: parsed.data } : { ok: false, issues };
}

interface PlanOutput { tasks: { key: string; paths: string[]; dependsOn: string[] }[] }
interface BreakdownOutput { steps: { paths: string[] }[] }
interface ReviewOutput { findings: { file: string; line: number }[] }

/** The structural rules are the plan validator's own: each proposed task becomes a stand-in task spec so duplicate IDs, missing dependencies and cycles read the same as an accepted plan's. */
function checkPlan(out: PlanOutput, ctx: AgentCheckContext, add: (code: AgentIssueCode, ...p: PropertyKey[]) => void): void {
  const bound = ctx.allowedPaths.length > 0 ? ctx.allowedPaths : null;
  out.tasks.forEach((t, i) => {
    t.paths.forEach((p, j) => { const c = pathIssue(p, bound); if (c) add(c, 'tasks', i, 'paths', j); });
    if (t.dependsOn.includes(t.key)) add('self_dependency', 'tasks', i, 'dependsOn');
  });
  const standIn = (t: PlanOutput['tasks'][number]) => ({
    projectId: 'proposal', runId: 'proposal', taskId: t.key, revision: 1, limits: { maxAttempts: 1, timeoutSeconds: 1, maxCostUsd: 1 },
    // Paths are checked above with their index; the stand-in carries none so they are not reported twice.
    allowedPaths: [], contractRefs: [], dependencies: t.dependsOn.map((d) => ({ taskId: d, revision: 1, condition: 'artifact_verified' as const })),
  }) as unknown as TaskSpec;
  const v = validatePlanRevision({ projectId: 'proposal', runId: 'proposal', revision: 1, tasks: out.tasks.map(standIn) }, { projectId: 'proposal', runId: 'proposal' });
  if (v.ok) return;
  const index = (key: string): number => out.tasks.findIndex((t) => t.key === key);
  for (const e of v.errors) {
    if (e.kind === 'duplicate_task_id') add('duplicate_key', 'tasks', index(e.taskId), 'key');
    else if (e.kind === 'missing_dependency') add('missing_dependency', 'tasks', index(e.taskId), 'dependsOn');
    else if (e.kind === 'cycle' && !(e.path.length === 2 && e.path[0] === e.path[1])) add('cycle', 'tasks', index(e.path[0]!), 'dependsOn');
  }
}

function checkReview(out: ReviewOutput, ctx: AgentCheckContext, add: (code: AgentIssueCode, ...p: PropertyKey[]) => void): void {
  const parsed = ctx.reviewedDiff === undefined ? null : parseUnifiedDiff(ctx.reviewedDiff);
  if (parsed === null || !parsed.ok) { add('review_diff_unreadable'); return; }
  const byPath = new Map(parsed.files.map((f) => [f.path, f]));
  out.findings.forEach((f, i) => {
    const fd = byPath.get(canonicalPath(f.file) ?? '');
    if (!fd) { add('finding_file_not_in_diff', 'findings', i, 'file'); return; }
    if (!lineExists(fd, f.line, ctx.files?.get(fd.path) ?? null)) add('finding_line_out_of_range', 'findings', i, 'line');
  });
}

/** A line a review may point at: in the file after the change (before it, for a deleted file). Without the base contents, a line inside one of the hunks. */
function lineExists(fd: FileDiff, line: number, base: string | null): boolean {
  if (base !== null || fd.change === 'create') {
    const applied = applyFileDiff(base, fd);
    if (applied.ok) return line <= splitLines(applied.content ?? base ?? '').lines.length;
  }
  return fd.hunks.some((h) => (fd.change === 'delete' ? line >= h.oldStart && line < h.oldStart + h.oldCount : line >= h.newStart && line < h.newStart + h.newCount));
}

// ---- unified diff ---------------------------------------------------------------------------------------------------------------

export interface DiffLine {
  readonly op: ' ' | '-' | '+';
  readonly text: string;
}
export interface DiffHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly DiffLine[];
  /** `\ No newline at end of file` followed the last line of the old side, or of the new side. */
  readonly oldNoEol: boolean;
  readonly newNoEol: boolean;
}
export interface FileDiff {
  readonly path: string;
  readonly change: 'modify' | 'create' | 'delete';
  readonly hunks: readonly DiffHunk[];
}
export type DiffParseCode = 'diff_empty' | 'diff_unparseable' | 'diff_unsupported' | 'diff_duplicate_file' | 'diff_header_mismatch' | 'path_invalid';
export type DiffParse = { readonly ok: true; readonly files: readonly FileDiff[] } | { readonly ok: false; readonly code: DiffParseCode };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** Extended git headers a plain text change may carry. Anything else (renames, copies, mode changes, binary patches) is not a change this flow applies. */
const PLAIN_GIT_HEADER = /^(?:index [0-9a-f]{4,64}\.\.[0-9a-f]{4,64}(?: 100644)?|new file mode 100644|deleted file mode 100644)$/;

/** A header path, canonical, or `/dev/null`. Null when it is not a plain path. A tab starts the optional timestamp; nothing else is trimmed. */
const headerPath = (raw: string, prefix: 'a/' | 'b/'): string | null => {
  const p = raw.split('\t')[0]!;
  if (p === '/dev/null') return p;
  return canonicalPath(p.startsWith(prefix) ? p.slice(2) : p);
};
const GIT_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

/**
 * A unified diff of text files: `--- a/<path>` and `+++ b/<path>` headers, `/dev/null` for a created or deleted file, and hunks whose line counts match their headers.
 * Strict: prose around the diff, renames, copies, mode changes and binary patches are refused, as is a file named twice.
 */
export function parseUnifiedDiff(diffText: string): DiffParse {
  const L = diffText.split('\n');
  if (L.at(-1) === '') L.pop();
  if (L.every((l) => l.trim() === '')) return { ok: false, code: 'diff_empty' };
  const files: FileDiff[] = [];
  /** Lower-cased: on a case-insensitive file system `src/A.ts` and `src/a.ts` are one file. */
  const seen = new Set<string>();
  let i = 0;
  /** The names from the last `diff --git` line, which the `---` and `+++` paths must repeat. */
  let gitNames: [string, string] | null = null;
  const bad = (code: DiffParseCode): DiffParse => ({ ok: false, code });
  while (i < L.length) {
    const line = L[i]!;
    if (line.trim() === '') { i++; continue; }
    if (line.startsWith('diff --git ')) {
      const g = GIT_HEADER.exec(line);
      if (!g) return bad('diff_unparseable');
      const a = canonicalPath(g[1]!), b = canonicalPath(g[2]!);
      if (a === null || b === null) return bad('path_invalid');
      gitNames = [a, b];
      i++;
      while (i < L.length && !L[i]!.startsWith('--- ') && !L[i]!.startsWith('diff --git ')) {
        if (!PLAIN_GIT_HEADER.test(L[i]!)) return bad('diff_unsupported');
        i++;
      }
      if (i >= L.length || !L[i]!.startsWith('--- ')) return bad('diff_unparseable');
      continue;
    }
    if (!line.startsWith('--- ') || !(L[i + 1] ?? '').startsWith('+++ ')) return bad('diff_unparseable');
    const oldPath = headerPath(line.slice(4), 'a/');
    const newPath = headerPath(L[i + 1]!.slice(4), 'b/');
    i += 2;
    if (oldPath === null || newPath === null) return bad('path_invalid');
    if (oldPath === '/dev/null' && newPath === '/dev/null') return bad('diff_unparseable');
    if (oldPath !== '/dev/null' && newPath !== '/dev/null' && oldPath !== newPath) return bad('diff_unsupported');
    const change = oldPath === '/dev/null' ? 'create' : newPath === '/dev/null' ? 'delete' : 'modify';
    const filePath = change === 'create' ? newPath : oldPath;
    if (gitNames !== null && (gitNames[0] !== filePath || gitNames[1] !== filePath)) return bad('diff_header_mismatch');
    gitNames = null;
    const hunks: DiffHunk[] = [];
    while (i < L.length && L[i]!.startsWith('@@')) {
      const m = HUNK.exec(L[i]!);
      if (!m) return bad('diff_unparseable');
      const oldStart = Number(m[1]), oldCount = m[2] === undefined ? 1 : Number(m[2]), newStart = Number(m[3]), newCount = m[4] === undefined ? 1 : Number(m[4]);
      i++;
      const lines: DiffLine[] = [];
      let o = 0, n = 0, oldNoEol = false, newNoEol = false;
      while (o < oldCount || n < newCount || L[i]?.startsWith('\\')) {
        const l = L[i];
        if (l === undefined) return bad('diff_unparseable');
        if (l.startsWith('\\')) {
          const prev = lines.at(-1);
          if (!prev) return bad('diff_unparseable');
          if (prev.op !== '+') oldNoEol = true;
          if (prev.op !== '-') newNoEol = true;
          i++;
          continue;
        }
        const op = l === '' ? ' ' : l[0];
        if (op !== ' ' && op !== '-' && op !== '+') return bad('diff_unparseable');
        if (op !== '+') o++;
        if (op !== '-') n++;
        if (o > oldCount || n > newCount) return bad('diff_unparseable');
        lines.push({ op, text: l.slice(1) });
        i++;
      }
      // More body lines than the header counted: the header is wrong.
      const next = L[i];
      if (next !== undefined && (next.startsWith(' ') || next.startsWith('+') || (next.startsWith('-') && !(next.startsWith('--- ') && (L[i + 1] ?? '').startsWith('+++ '))))) return bad('diff_unparseable');
      hunks.push({ oldStart, oldCount, newStart, newCount, lines, oldNoEol, newNoEol });
    }
    if (hunks.length === 0) return bad('diff_unparseable');
    if (change === 'create' && (hunks.length !== 1 || hunks[0]!.oldCount !== 0)) return bad('diff_unparseable');
    if (change === 'delete' && hunks.some((h) => h.newCount !== 0)) return bad('diff_unparseable');
    if (!hunks.some((h) => h.lines.some((l) => l.op !== ' '))) return bad('diff_empty');
    if (seen.has(filePath.toLowerCase())) return bad('diff_duplicate_file');
    seen.add(filePath.toLowerCase());
    files.push({ path: filePath, change, hunks });
  }
  return files.length === 0 ? { ok: false, code: 'diff_empty' } : { ok: true, files };
}

function splitLines(s: string): { lines: string[]; eol: boolean } {
  if (s === '') return { lines: [], eol: false };
  return s.endsWith('\n') ? { lines: s.slice(0, -1).split('\n'), eol: true } : { lines: s.split('\n'), eol: false };
}

export type FileApply = { readonly ok: true; readonly content: string | null } | { readonly ok: false; readonly code: 'diff_does_not_apply' };

/**
 * Applies one file's hunks to its contents (null: the file does not exist). Exact: every context and removed line must match at the line its hunk names, hunks must be in
 * order, and the end-of-file newline must agree. No fuzz and no offset search, so what a person reviews is exactly what applies. Content null in the result: deleted.
 */
export function applyFileDiff(base: string | null, fd: FileDiff): FileApply {
  const fail: FileApply = { ok: false, code: 'diff_does_not_apply' };
  if (fd.change === 'create') {
    if (base !== null) return fail;
    const h = fd.hunks[0]!;
    const lines = h.lines.map((l) => l.text);
    return { ok: true, content: lines.length === 0 ? '' : `${lines.join('\n')}${h.newNoEol ? '' : '\n'}` };
  }
  if (base === null) return fail;
  const old = splitLines(base);
  const out: string[] = [];
  let pos = 0;
  let endEol = old.eol;
  for (const h of fd.hunks) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    if (start < pos || start > old.lines.length) return fail;
    out.push(...old.lines.slice(pos, start));
    pos = start;
    for (const l of h.lines) {
      if (l.op === '+') { out.push(l.text); continue; }
      if (old.lines[pos] !== l.text) return fail;
      if (l.op === ' ') out.push(l.text);
      pos++;
    }
    const atEnd = pos === old.lines.length;
    if (h.oldNoEol && (!atEnd || old.eol)) return fail;
    if (atEnd && h.oldCount > 0 && !h.oldNoEol && !old.eol) return fail;
    if (atEnd) endEol = !h.newNoEol;
  }
  out.push(...old.lines.slice(pos));
  if (fd.change === 'delete') return out.length === 0 ? { ok: true, content: null } : fail;
  return { ok: true, content: out.length === 0 ? '' : `${out.join('\n')}${endEol ? '\n' : ''}` };
}

export interface DiffFileSummary {
  readonly path: string;
  readonly change: FileDiff['change'];
  readonly added: number;
  readonly removed: number;
}
/** Paths, change kinds and line counts: what a PR description reads instead of the code. */
export function diffSummary(files: readonly FileDiff[]): DiffFileSummary[] {
  return files.map((f) => ({
    path: f.path, change: f.change,
    added: f.hunks.reduce((a, h) => a + h.lines.filter((l) => l.op === '+').length, 0),
    removed: f.hunks.reduce((a, h) => a + h.lines.filter((l) => l.op === '-').length, 0),
  }));
}

export type PatchCheck =
  | { readonly ok: true; readonly files: readonly DiffFileSummary[]; /** The contents after the change, by path. Null: deleted. */ readonly results: ReadonlyMap<string, string | null> }
  | { readonly ok: false; readonly issues: readonly AgentIssue[] };

/**
 * A patch proposal is usable only when its diff parses, stays within the size caps, touches only paths inside the task's allowed paths (never `.git` or a credentials
 * file), changes only files whose contents the agent was given or creates files that do not exist among them, and applies exactly to those contents.
 */
export function checkPatch(diff: string, ctx: Pick<AgentCheckContext, 'allowedPaths' | 'files'>): PatchCheck {
  const issue = (code: AgentIssueCode, p = '/'): PatchCheck => ({ ok: false, issues: [{ code, path: p }] });
  if (diff.length > AGENT_LIMITS.patchDiffChars) return issue('diff_too_large');
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return issue(parsed.code);
  const summary = diffSummary(parsed.files);
  if (parsed.files.length > AGENT_LIMITS.patchFiles || summary.reduce((a, f) => a + f.added + f.removed, 0) > AGENT_LIMITS.patchChangedLines) return issue('diff_too_large');
  const issues: AgentIssue[] = [];
  const results = new Map<string, string | null>();
  // The given files under their canonical spelling; lookups for "does it exist" ignore case, as a case-insensitive file system would.
  const files = new Map<string, string>();
  for (const [k, v] of ctx.files ?? []) { const c = canonicalPath(k); if (c !== null) files.set(c, v); }
  const known = new Set([...files.keys(), ...parsed.files.filter((f) => f.change !== 'create').map((f) => f.path)].map((k) => k.toLowerCase()));
  const created = parsed.files.filter((f) => f.change === 'create').map((f) => f.path.toLowerCase());
  /** A create collides when the file exists under any spelling, when a directory on its path is a file, or when it would be a directory over a file. */
  const collides = (path: string): boolean => {
    const l = path.toLowerCase();
    const segs = l.split('/');
    const parents = segs.slice(0, -1).map((_, j) => segs.slice(0, j + 1).join('/'));
    const others = [...known, ...created.filter((x) => x !== l)];
    return known.has(l) || parents.some((d) => others.includes(d)) || others.some((x) => x.startsWith(`${l}/`));
  };
  parsed.files.forEach((fd, i) => {
    const at = `/files/${i}`;
    const p = pathIssue(fd.path, ctx.allowedPaths);
    if (p) { issues.push({ code: p, path: at }); return; }
    if (fd.change === 'create' && collides(fd.path)) { issues.push({ code: 'diff_file_exists', path: at }); return; }
    if (fd.change !== 'create' && !files.has(fd.path)) { issues.push({ code: 'diff_file_not_provided', path: at }); return; }
    const applied = applyFileDiff(fd.change === 'create' ? null : files.get(fd.path)!, fd);
    if (!applied.ok) { issues.push({ code: applied.code, path: at }); return; }
    results.set(fd.path, applied.content);
  });
  return issues.length === 0 ? { ok: true, files: summary, results } : { ok: false, issues };
}
