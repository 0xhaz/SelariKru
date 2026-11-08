import { z } from 'zod';

/**
 * Validation of untrusted assistant proposals (browser model output). Pure, browser-safe, never throws.
 * A proposal is data to review. Nothing here, and nothing in a proposal, creates authority: no commands,
 * tool grants, budget, permissions or policy.
 */

export const PROPOSAL_OPERATIONS = ['draftBrief', 'suggestCriteria', 'draftTaskPlan'] as const;
export type ProposalOperation = (typeof PROPOSAL_OPERATIONS)[number];

export interface FixtureCtx {
  readonly operation: ProposalOperation;
  readonly allowedRequirementIds: readonly string[];
  /** Phrases checked by deterministic phrase match. A heuristic, not semantic understanding. */
  readonly forbiddenMandatoryScope?: readonly string[];
  /** When set, a resource claim must name one of these keys. When absent, any claim is refused. */
  readonly knownResourceKeys?: readonly string[];
}

export type ProposalIssueKind =
  | 'malformed_json'
  | 'schema_invalid'
  | 'requirement_not_allowed'
  | 'forbidden_scope'
  | 'resource_claim_invalid'
  | 'authority_attempt';

export interface ProposalIssue {
  readonly kind: ProposalIssueKind;
  readonly path: string;
  readonly message: string;
  /** True when a human can resolve it in the acceptance step; false means the proposal is rejected. */
  readonly reviewable: boolean;
  /** Set when the check is a heuristic rather than a structural fact. */
  readonly heuristic?: 'deterministic_phrase_match' | 'authority_text_patterns';
}

export interface CriterionProposal { readonly requirementId: string; readonly text: string }
export interface TaskProposal {
  readonly title: string;
  readonly description: string;
  readonly requirementIds: readonly string[];
  /** Never read as authority. Mapping ignores it. */
  readonly resourceClaims?: readonly { readonly key: string; readonly mode: 'shared' | 'exclusive' }[];
}
export type ProposalData =
  | { readonly summary: string; readonly acceptanceCriteria: readonly CriterionProposal[] }
  | { readonly acceptanceCriteria: readonly CriterionProposal[] }
  | { readonly tasks: readonly TaskProposal[] };

export interface ProposalValidation {
  /** valid: no issues. needs_review: only heuristic scope findings. rejected: anything else. */
  readonly status: 'valid' | 'needs_review' | 'rejected';
  readonly issues: readonly ProposalIssue[];
  /** Validated data. Null when rejected. */
  readonly data: ProposalData | null;
  /** Malformed or schema-breaking output is a quality failure to show, never something to retry in the cloud. */
  readonly qualityFailure: boolean;
  readonly retry: 'none';
}

const criterion = z.strictObject({ requirementId: z.string(), text: z.string().min(1).max(400) });
const criteria = z.array(criterion).min(1).max(8);
const task = z.strictObject({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(600),
  requirementIds: z.array(z.string()).min(1),
});
const SCHEMAS: Record<ProposalOperation, z.ZodType> = {
  draftBrief: z.strictObject({ summary: z.string().min(1).max(400), acceptanceCriteria: criteria }),
  suggestCriteria: z.strictObject({ acceptanceCriteria: criteria }),
  draftTaskPlan: z.strictObject({ tasks: z.array(task).min(1).max(12) }),
};

/** Keys that claim authority. Their presence anywhere in a proposal is an attempt, whatever the value. */
const AUTHORITY_KEY =
  /^(shell|shellcommands?|commands?|cmd|exec|execute|scripts?|tools?|toolgrants?|allowedtools|grants?|permissions?|policy|policies|budget|maxcostusd|spend|limits|allowedpaths|classification|policyversion|basesha|approve|approvals?|verified|verification)$/i;

/** Patterns for text that claims a grant or carries a command. Plain words such as "secret" do not match. */
const AUTHORITY_TEXT: readonly RegExp[] = [
  /`[^`]*\b(curl|wget|rm|sudo|bash|sh|chmod|chown|npm|pnpm|npx|git|node|python|ssh|eval)\b[^`]*`/i,
  /\|\s*(sh|bash|zsh)\b/i,
  /\brm\s+-[a-z]*r/i,
  /(^|\n)\s*\$\s+\S/,
  /\bgrant(?:s|ed|ing)?\b[^.\n]{0,40}\b(tools?|shell|permissions?|access|credentials?|tokens?)\b/i,
  /\b(?:raise|increase|set|override)\b[^.\n]{0,20}\bbudget\b/i,
  /\bbudget\s*[:=]\s*\d/i,
  /\b(?:allowedTools|allowedPaths|permissions?|policy)\s*[:=]/i,
  /\b(?:bypass|disable|skip)\s+(?:the\s+)?(?:approval|policy|verification)/i,
];

const TEXT_KEYS = new Set(['summary', 'text', 'title', 'description']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function collectText(v: unknown, path: string, out: { path: string; text: string }[], key = ''): void {
  if (typeof v === 'string') {
    if (TEXT_KEYS.has(key)) out.push({ path, text: v });
  } else if (Array.isArray(v)) v.forEach((x, i) => collectText(x, `${path}/${i}`, out, key));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) collectText(x, `${path}/${k}`, out, k);
}

function authorityKeys(v: unknown, path: string, out: string[]): void {
  if (Array.isArray(v)) v.forEach((x, i) => authorityKeys(x, `${path}/${i}`, out));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (AUTHORITY_KEY.test(k)) out.push(`${path}/${k}`);
      authorityKeys(x, `${path}/${k}`, out);
    }
  }
}

export function validateProposal(raw: unknown, ctx: FixtureCtx): ProposalValidation {
  const issues: ProposalIssue[] = [];
  const add = (kind: ProposalIssueKind, path: string, message: string, extra: Partial<ProposalIssue> = {}) =>
    issues.push({ kind, path, message, reviewable: false, ...extra });
  const finish = (data: ProposalData | null): ProposalValidation => {
    const blocking = issues.some((i) => !i.reviewable);
    const status = blocking ? 'rejected' : issues.length > 0 ? 'needs_review' : 'valid';
    return {
      status, issues, data: status === 'rejected' ? null : data,
      qualityFailure: issues.some((i) => i.kind === 'malformed_json' || i.kind === 'schema_invalid'),
      retry: 'none',
    };
  };

  try {
    let value: unknown = raw;
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw);
      } catch {
        add('malformed_json', '/', 'output is not valid JSON; not retried');
        return finish(null);
      }
    }

    // Authority first: these never become anything but a rejection.
    const keys: string[] = [];
    authorityKeys(value, '', keys);
    for (const p of keys) add('authority_attempt', p, 'field claims a command, tool, budget, permission or policy; proposals carry none');
    const texts: { path: string; text: string }[] = [];
    collectText(value, '', texts);
    for (const t of texts) {
      if (AUTHORITY_TEXT.some((re) => re.test(t.text))) {
        add('authority_attempt', t.path, 'text carries a command or claims a grant', { heuristic: 'authority_text_patterns' });
      }
    }

    // Resource claims are checked separately, then removed so the strict schema sees only the contract shape.
    let shaped = value;
    if (ctx.operation === 'draftTaskPlan' && isObj(value) && Array.isArray(value['tasks'])) {
      const known = new Set(ctx.knownResourceKeys ?? []);
      shaped = {
        ...value,
        tasks: value['tasks'].map((t, i) => {
          if (!isObj(t) || !Object.hasOwn(t, 'resourceClaims')) return t;
          const { resourceClaims, ...rest } = t;
          const base = `/tasks/${i}/resourceClaims`;
          if (!Array.isArray(resourceClaims)) add('resource_claim_invalid', base, 'resource claims must be a list');
          else {
            resourceClaims.forEach((c, j) => {
              const at = `${base}/${j}`;
              if (!isObj(c) || typeof c['key'] !== 'string' || (c['mode'] !== 'shared' && c['mode'] !== 'exclusive') || Object.keys(c).length !== 2) {
                add('resource_claim_invalid', at, 'a claim is {key, mode: shared|exclusive}');
              } else if (!known.has(c['key'])) add('resource_claim_invalid', at, `unknown resource ${c['key']}`);
            });
          }
          return rest;
        }),
      };
    }

    const parsed = SCHEMAS[ctx.operation].safeParse(shaped);
    if (!parsed.success) {
      for (const i of parsed.error.issues) add('schema_invalid', '/' + i.path.join('/'), i.message);
    }

    // Semantic checks on whatever structure is present.
    const allowed = new Set(ctx.allowedRequirementIds);
    const check = (id: unknown, path: string) => {
      if (typeof id === 'string' && !allowed.has(id)) add('requirement_not_allowed', path, `${id} is not an allowed requirement for this request`);
    };
    if (isObj(shaped)) {
      if (Array.isArray(shaped['acceptanceCriteria'])) {
        shaped['acceptanceCriteria'].forEach((c, i) => isObj(c) && check(c['requirementId'], `/acceptanceCriteria/${i}/requirementId`));
      }
      if (Array.isArray(shaped['tasks'])) {
        shaped['tasks'].forEach((t, i) => {
          if (isObj(t) && Array.isArray(t['requirementIds'])) t['requirementIds'].forEach((id, j) => check(id, `/tasks/${i}/requirementIds/${j}`));
        });
      }
    }

    for (const phrase of ctx.forbiddenMandatoryScope ?? []) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(phrase.trim())}($|[^\\p{L}\\p{N}])`, 'iu');
      for (const t of texts) {
        if (re.test(t.text)) {
          add('forbidden_scope', t.path, `text mentions "${phrase}", which is outside the supplied scope; a person decides`, { reviewable: true, heuristic: 'deterministic_phrase_match' });
        }
      }
    }

    return finish(parsed.success ? (parsed.data as ProposalData) : null);
  } catch (e) {
    add('schema_invalid', '/', `proposal could not be checked: ${e instanceof Error ? e.name : 'error'}`);
    return finish(null);
  }
}
