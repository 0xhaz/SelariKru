import { z } from 'zod';
import { err, ok, type Result } from './result.ts';

/**
 * The deterministic onboarding controller's vocabulary: states, the template catalogue, the versioned blueprint and the cost plan. Pure and browser-safe.
 * States and transitions come from architecture.md section 5. The guide's output is only ever a proposal; nothing here takes one as a transition.
 */

export const ONBOARDING_STATES = ['draft', 'discovering', 'blueprint_ready', 'configuring', 'readiness_check', 'ready', 'activated'] as const;
export const OnboardingStateSchema = z.enum(ONBOARDING_STATES);
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

/** Reasoned conditions: they say what is wrong and preserve the last valid step. */
export const ONBOARDING_CONDITIONS = ['needs_input', 'blocked', 'failed'] as const;
export const OnboardingConditionSchema = z.enum(ONBOARDING_CONDITIONS);
export type OnboardingCondition = z.infer<typeof OnboardingConditionSchema>;

export type OnboardingEvent = 'answers_saved' | 'blueprint_created' | 'blueprint_accepted' | 'configuration_saved' | 'readiness_blocked' | 'readiness_passed' | 'activated';

const SETUP: readonly OnboardingState[] = ['discovering', 'blueprint_ready', 'configuring', 'readiness_check', 'ready'];
const CONFIGURED: readonly OnboardingState[] = ['configuring', 'readiness_check', 'ready'];
const TRANSITIONS: Readonly<Record<OnboardingEvent, { from: readonly OnboardingState[]; to: OnboardingState }>> = {
  answers_saved: { from: ['draft', ...SETUP], to: 'discovering' },
  blueprint_created: { from: SETUP, to: 'blueprint_ready' },
  blueprint_accepted: { from: ['blueprint_ready'], to: 'configuring' },
  configuration_saved: { from: CONFIGURED, to: 'configuring' },
  readiness_blocked: { from: CONFIGURED, to: 'readiness_check' },
  readiness_passed: { from: CONFIGURED, to: 'ready' },
  activated: { from: ['ready'], to: 'activated' },
};

export function advanceOnboarding(state: OnboardingState, event: OnboardingEvent): Result<OnboardingState, { reason: string }> {
  const t = TRANSITIONS[event];
  return t.from.includes(state) ? ok(t.to) : err({ reason: `${event} is not allowed from ${state}` });
}

// ---- templates ------------------------------------------------------------------------------------------------

export const PROJECT_TRACKS = ['saas_web', 'mobile', 'backend_api', 'internal_tool', 'ai_app', 'custom'] as const;
export const ProjectTrackSchema = z.enum(PROJECT_TRACKS);
export type ProjectTrack = z.infer<typeof ProjectTrackSchema>;

export interface TemplateDefinition {
  readonly track: ProjectTrack;
  readonly version: number;
  readonly label: string;
  /** `executable` is certified to run end to end today. `blueprint_only` can be planned here, but a run refuses to start. */
  readonly support: 'executable' | 'blueprint_only';
  /** Why it can or cannot run, shown as written. */
  readonly reason: string;
  readonly summary: string;
  readonly milestone: string;
  readonly roles: readonly { readonly role: string; readonly reason: string }[];
}

/** Phase 1 certifies one pilot stack for execution (architecture.md section 5). Every other track is honest about being a plan only. */
export const TEMPLATE_CATALOG: Readonly<Record<ProjectTrack, TemplateDefinition>> = {
  saas_web: {
    track: 'saas_web', version: 1, label: 'SaaS or web app', support: 'executable', summary: 'One authenticated vertical slice',
    reason: 'A web app on the pilot stack is what the verifier is certified to build and check today.',
    milestone: 'One vertical slice with passing acceptance checks',
    roles: [
      { role: 'Lead', reason: 'Keeps the plan to one small vertical slice' },
      { role: 'Frontend', reason: 'Builds the screen the first outcome needs' },
      { role: 'Backend', reason: 'Builds the API and storage behind it' },
      { role: 'QA', reason: 'Checks the acceptance criteria independently' },
    ],
  },
  mobile: {
    track: 'mobile', version: 1, label: 'Mobile app', support: 'blueprint_only', summary: 'One navigable flow',
    reason: 'Mobile builds need a platform toolchain and device or emulator access this service cannot verify yet.',
    milestone: 'One navigable flow against a fixture API',
    roles: [{ role: 'Mobile', reason: 'Builds the flow' }, { role: 'QA', reason: 'Platform-aware checks' }],
  },
  backend_api: {
    track: 'backend_api', version: 1, label: 'Backend or API', support: 'blueprint_only', summary: 'One documented endpoint',
    reason: 'There is no certified verification suite for standalone services yet.',
    milestone: 'One documented endpoint with authorization and error-path checks',
    roles: [{ role: 'Backend', reason: 'Builds the endpoint' }, { role: 'QA', reason: 'Contract and error-path checks' }],
  },
  internal_tool: {
    track: 'internal_tool', version: 1, label: 'Internal tool', support: 'blueprint_only', summary: 'One permitted read workflow',
    reason: 'Source-system access scopes cannot be verified by this service yet.',
    milestone: 'One permitted read workflow on synthetic data',
    roles: [{ role: 'Integration', reason: 'Connects the workflow' }, { role: 'QA', reason: 'Checks with synthetic data' }],
  },
  ai_app: {
    track: 'ai_app', version: 1, label: 'AI application', support: 'blueprint_only', summary: 'One bounded interaction',
    reason: 'Model evaluation and cost evidence for generated apps are not certified yet.',
    milestone: 'One bounded interaction with evaluation and cost evidence',
    roles: [{ role: 'AI workflow', reason: 'Designs the bounded interaction' }, { role: 'Evaluation', reason: 'Measures quality and cost' }],
  },
  custom: {
    track: 'custom', version: 1, label: 'Something else', support: 'blueprint_only', summary: 'One small verified change',
    reason: 'A custom stack has no verification suite this service can vouch for.',
    milestone: 'One small verified enhancement to the existing stack',
    roles: [{ role: 'Repository analysis', reason: 'Learns the existing conventions' }, { role: 'QA', reason: 'Verifies the change' }],
  },
};

export interface TemplateVerdict {
  readonly executable: boolean;
  readonly unsupported: readonly { readonly track: ProjectTrack; readonly reason: string }[];
}

/** A project can start a run only when every track it combines is executable. */
export function templateSupport(tracks: readonly ProjectTrack[]): TemplateVerdict {
  const unsupported = tracks.filter((t) => TEMPLATE_CATALOG[t].support !== 'executable').map((t) => ({ track: t, reason: TEMPLATE_CATALOG[t].reason }));
  return { executable: tracks.length > 0 && unsupported.length === 0, unsupported };
}

// ---- answers and blueprint --------------------------------------------------------------------------------------

const Text = (max: number) => z.string().trim().min(1).max(max);
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._/-]{0,239}$/;

export const INFERENCE_CHOICES = ['ONLY_ON_DEVICE', 'PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD'] as const;
export const EXECUTION_CHOICES = ['local', 'cloud', 'hybrid'] as const;
export const ExecutionChoiceSchema = z.enum(EXECUTION_CHOICES);
export type ExecutionChoice = z.infer<typeof ExecutionChoiceSchema>;

export const GoalAnswersSchema = z.strictObject({
  name: Text(80),
  idea: Text(800),
  audience: Text(300),
  firstOutcome: Text(300),
  /** Text entered here is stored. Restricted material stays on the device and never comes through this form. */
  classification: z.enum(['public', 'internal']).default('internal'),
});
export type GoalAnswers = z.infer<typeof GoalAnswersSchema>;

export const SourceAnswersSchema = z.strictObject({
  kind: z.enum(['new', 'existing']),
  note: z.string().trim().max(300).optional(),
});
export type SourceAnswers = z.infer<typeof SourceAnswersSchema>;

export const FocusAnswersSchema = z.strictObject({ tracks: z.array(ProjectTrackSchema).min(1).max(PROJECT_TRACKS.length) });
export type FocusAnswers = z.infer<typeof FocusAnswersSchema>;

export const OnboardingAnswersSchema = z.strictObject({ goal: GoalAnswersSchema, source: SourceAnswersSchema, focus: FocusAnswersSchema });
export type OnboardingAnswers = z.input<typeof OnboardingAnswersSchema>;

const criterionId = z.string().regex(/^AC-\d{1,2}$/);
export const BlueprintContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  goals: z.strictObject({ idea: Text(800), audience: Text(300), firstOutcome: Text(300) }),
  tracks: z.array(ProjectTrackSchema).min(1),
  stack: z.array(z.strictObject({ name: Text(80), reason: Text(240) })).max(12),
  /** Repository paths workers may change. Each is relative and stays inside the repository. */
  allowedPaths: z.array(z.string().regex(SAFE_PATH, 'must be a relative path inside the repository')).min(1).max(20),
  acceptanceCriteria: z.array(z.strictObject({ id: criterionId, text: Text(400) })).min(1).max(8),
  roles: z.array(z.strictObject({ role: Text(60), reason: Text(200) })).min(1).max(8),
  requiredConnections: z.array(Text(60)).max(8),
  nonGoals: z.array(Text(200)).max(12),
  assumptions: z.array(Text(240)).max(12),
  firstMilestone: z.strictObject({
    title: Text(120),
    tasks: z.array(z.strictObject({ id: z.string().regex(/^T\d{1,2}$/), title: Text(120), dependsOn: z.array(z.string().regex(/^T\d{1,2}$/)).max(8) })).min(1).max(12),
  }),
  pendingDecisions: z.array(Text(240)).max(12),
}).superRefine((c, ctx) => {
  const ids = new Set(c.firstMilestone.tasks.map((t) => t.id));
  c.firstMilestone.tasks.forEach((t, i) => {
    for (const d of t.dependsOn) if (!ids.has(d)) ctx.addIssue({ code: 'custom', path: ['firstMilestone', 'tasks', i, 'dependsOn'], message: `unknown task ${d}` });
  });
  if (new Set(c.acceptanceCriteria.map((a) => a.id)).size !== c.acceptanceCriteria.length) ctx.addIssue({ code: 'custom', path: ['acceptanceCriteria'], message: 'criterion ids must be unique' });
});
export type BlueprintContent = z.infer<typeof BlueprintContentSchema>;

/** The controller's own first draft. Deterministic: the same answers give the same blueprint, and no model is involved. */
export function blueprintFromAnswers(answers: OnboardingAnswers): BlueprintContent {
  const a = OnboardingAnswersSchema.parse(answers);
  const lead = TEMPLATE_CATALOG[a.focus.tracks[0]!];
  const executable = templateSupport(a.focus.tracks);
  return {
    schemaVersion: 1,
    goals: { idea: a.goal.idea, audience: a.goal.audience, firstOutcome: a.goal.firstOutcome },
    tracks: a.focus.tracks,
    stack: [],
    allowedPaths: ['src', 'tests'],
    acceptanceCriteria: [{ id: 'AC-1', text: a.goal.firstOutcome }],
    roles: [...new Map(a.focus.tracks.flatMap((t) => TEMPLATE_CATALOG[t].roles).map((r) => [r.role, r])).values()],
    requiredConnections: ['GitHub repository'],
    nonGoals: [],
    assumptions: [a.source.kind === 'new' ? 'You will create an empty repository and connect it.' : 'The existing repository stays the source of truth; detected conventions outrank the template.'],
    firstMilestone: { title: lead.milestone, tasks: [{ id: 'T1', title: `Deliver: ${a.goal.firstOutcome}`.slice(0, 120), dependsOn: [] }] },
    pendingDecisions: executable.unsupported.map((u) => `${TEMPLATE_CATALOG[u.track].label}: ${u.reason}`),
  };
}

// ---- cost plan ----------------------------------------------------------------------------------------------------

export const COST_PROVENANCE = ['reference_price', 'user_estimate', 'unknown'] as const;
export const COST_CADENCES = ['monthly', 'one_time', 'per_worker_hour'] as const;

export const CostSourceSchema = z.strictObject({
  name: Text(120),
  url: z.url(),
  retrievedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  region: Text(40),
  currency: z.literal('USD'),
});
export type CostSource = z.infer<typeof CostSourceSchema>;

/** Prices checked and written down in docs/operating-costs.md section 3. Nothing is priced from memory. */
export const COST_REFERENCES = {
  /** E2B 2 vCPU / 4 GiB: $0.000014/vCPU-s + $0.0000045/GiB-s = $0.1656 per worker-hour. */
  cloudWorker2c4g: { name: 'E2B pricing page', url: 'https://e2b.dev/pricing', retrievedOn: '2026-11-08', region: 'Unspecified', currency: 'USD' },
} as const satisfies Record<string, CostSource>;

const Amount = z.number().finite().min(0).nullable();
export const CostLineSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]{1,60}$/),
  label: Text(120),
  cadence: z.enum(COST_CADENCES),
  lowUsd: Amount,
  baseUsd: Amount,
  highUsd: Amount,
  provenance: z.enum(COST_PROVENANCE),
  /** What the figure rests on, or why there is none. Required on every line. */
  basis: Text(300),
  source: CostSourceSchema.nullable(),
}).superRefine((l, ctx) => {
  const amounts = [l.lowUsd, l.baseUsd, l.highUsd];
  const known = amounts.every((a) => a !== null);
  if (l.provenance === 'unknown' && amounts.some((a) => a !== null)) ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'an unknown cost cannot carry an amount' });
  if (l.provenance !== 'unknown' && !known) ctx.addIssue({ code: 'custom', path: ['baseUsd'], message: 'a known cost needs low, base and high amounts' });
  if (l.provenance === 'reference_price' && l.source === null) ctx.addIssue({ code: 'custom', path: ['source'], message: 'a reference price must name its source' });
  if (known && !(l.lowUsd! <= l.baseUsd! && l.baseUsd! <= l.highUsd!)) ctx.addIssue({ code: 'custom', path: ['lowUsd'], message: 'low, base and high must be in order' });
});
export type CostLine = z.infer<typeof CostLineSchema>;

export interface LedgerTotals {
  /** Sum of monthly lines with a figure. Null when no line has one: never zero. */
  readonly knownLowUsd: number | null;
  readonly knownBaseUsd: number | null;
  readonly knownHighUsd: number | null;
  /** Lines with no figure. They are never part of a total. */
  readonly unknownLines: number;
}

export function ledgerTotals(lines: readonly CostLine[]): LedgerTotals {
  const monthly = lines.filter((l) => l.cadence === 'monthly' && l.provenance !== 'unknown');
  const sum = (key: 'lowUsd' | 'baseUsd' | 'highUsd'): number | null => (monthly.length === 0 ? null : Math.round(monthly.reduce((a, l) => a + l[key]!, 0) * 10_000) / 10_000);
  return { knownLowUsd: sum('lowUsd'), knownBaseUsd: sum('baseUsd'), knownHighUsd: sum('highUsd'), unknownLines: lines.filter((l) => l.provenance === 'unknown').length };
}

export type LedgerKey = 'platform' | 'provider' | 'app';
export interface CostLedger { readonly lines: readonly CostLine[]; readonly totals: LedgerTotals }
export interface CostPlan {
  /** The ceiling the owner set for agent execution. Null means not set, and a missing limit blocks. */
  readonly agentBudgetUsd: number | null;
  readonly ledgers: Readonly<Record<LedgerKey, CostLedger>>;
}

const unknownLine = (id: string, label: string, basis: string): CostLine => ({ id, label, cadence: 'monthly', lowUsd: null, baseUsd: null, highUsd: null, provenance: 'unknown', basis, source: null });

/** Builds the three ledgers. Platform and provider reference lines come from this function; a browser cannot price them. Unknown stays null. */
export function costPlanFor(input: { execution: ExecutionChoice | null; agentBudgetUsd: number | null; provider: readonly CostLine[]; app: readonly CostLine[] }): CostPlan {
  const cloud = input.execution === 'cloud' || input.execution === 'hybrid';
  const platform = [
    unknownLine('platform_access', 'Platform access', 'No launch price is set. The figures in planning documents are test hypotheses, not prices.'),
    unknownLine('managed_usage', 'Managed model or worker usage', 'This local release meters nothing on your behalf, and no managed lane is enabled.'),
  ];
  const provider: CostLine[] = [
    unknownLine('coding_model', 'Coding model usage', 'Billed by your model provider. No usage has been observed yet, and token prices depend on the model you assign.'),
    ...(cloud
      ? [{ id: 'cloud_worker', label: 'Cloud worker time, 2 vCPU / 4 GiB', cadence: 'per_worker_hour' as const, lowUsd: 0.1656, baseUsd: 0.1656, highUsd: 0.1656, provenance: 'reference_price' as const, basis: 'E2B per-second rates for a 2 vCPU / 4 GiB worker, derived to one hour. A reference, not a quote.', source: COST_REFERENCES.cloudWorker2c4g }]
      : [unknownLine('local_hardware', 'Local hardware and electricity', 'Your own machine. This service cannot see those costs, and local is not the same as free.')]),
    ...input.provider,
  ];
  const app = input.app.length > 0 ? [...input.app] : [unknownLine('app_hosting', 'Running the app you build', 'Add hosting, database and API lines once you know the architecture. No figure is assumed.')];
  const ledger = (lines: readonly CostLine[]): CostLedger => ({ lines, totals: ledgerTotals(lines) });
  return { agentBudgetUsd: input.agentBudgetUsd, ledgers: { platform: ledger(platform), provider: ledger(provider), app: ledger(app) } };
}

export const READINESS_CHECK_IDS = ['template_supported', 'repository_path', 'repository_identity', 'base_commit', 'runner_enrolled', 'policy_loaded', 'github_auth', 'budget_limit'] as const;
export type ReadinessCheckId = (typeof READINESS_CHECK_IDS)[number];
export type ReadinessStatus = 'passed' | 'failed' | 'unknown';
export interface ReadinessCheck {
  readonly id: ReadinessCheckId;
  readonly label: string;
  readonly status: ReadinessStatus;
  /** Why, in words, from the code that performed the check. */
  readonly reason: string;
  /** Null when there is nothing for the owner to do. */
  readonly nextAction: string | null;
  /** Required checks block `ready` unless they passed. An unknown required check blocks exactly as a failure does. */
  readonly required: boolean;
}

/** Only an explicit pass of every required check counts. */
export const readinessPassed = (checks: readonly ReadinessCheck[]): boolean => checks.length > 0 && checks.every((c) => !c.required || c.status === 'passed');

// ---- responses --------------------------------------------------------------------------------------------------

const CostLedgerViewSchema = z.strictObject({
  lines: z.array(CostLineSchema),
  totals: z.strictObject({ knownLowUsd: z.number().nullable(), knownBaseUsd: z.number().nullable(), knownHighUsd: z.number().nullable(), unknownLines: z.number().int() }),
});
export const OnboardingCostPlanViewSchema = z.strictObject({
  agentBudgetUsd: z.number().nullable(),
  /** True once confirmed against the current blueprint version. */
  confirmed: z.boolean(),
  ledgers: z.strictObject({ platform: CostLedgerViewSchema, provider: CostLedgerViewSchema, app: CostLedgerViewSchema }),
});

export const ReadinessCheckViewSchema = z.strictObject({
  id: z.enum(READINESS_CHECK_IDS), label: z.string(), status: z.enum(['passed', 'failed', 'unknown']), reason: z.string(), nextAction: z.string().nullable(), required: z.boolean(),
});

export const OnboardingViewSchema = z.strictObject({
  projectId: z.string(),
  name: z.string(),
  state: OnboardingStateSchema,
  condition: z.strictObject({ kind: OnboardingConditionSchema, reason: z.string() }).nullable(),
  revision: z.number().int(),
  goal: GoalAnswersSchema.nullable(),
  source: SourceAnswersSchema.nullable(),
  focus: FocusAnswersSchema.nullable(),
  blueprint: z.strictObject({ version: z.number().int(), accepted: z.boolean(), origin: z.enum(['controller', 'owner']), contentSha256: z.string(), createdAt: z.string(), content: BlueprintContentSchema }).nullable(),
  template: z.strictObject({ executable: z.boolean(), unsupported: z.array(z.strictObject({ track: ProjectTrackSchema, reason: z.string() })) }).nullable(),
  costPlan: OnboardingCostPlanViewSchema.nullable(),
  execution: z.strictObject({ execution: z.enum(EXECUTION_CHOICES), inference: z.enum(INFERENCE_CHOICES) }).nullable(),
  connection: z.strictObject({ repository: z.string(), defaultBranch: z.string() }).nullable(),
  readiness: z.strictObject({ blueprintVersion: z.number().int(), outcome: z.enum(['ready', 'blocked']), checkedAt: z.string(), baseSha: z.string().nullable(), checks: z.array(ReadinessCheckViewSchema) }).nullable(),
  firstRunId: z.string().nullable(),
  deployment: z.strictObject({ sourceCheckout: z.string().nullable(), servesRepository: z.string().nullable(), checker: z.boolean() }),
});
export type OnboardingView = z.infer<typeof OnboardingViewSchema>;
export type ReadinessCheckView = z.infer<typeof ReadinessCheckViewSchema>;

export const OnboardingListSchema = z.strictObject({
  items: z.array(z.strictObject({ projectId: z.string(), name: z.string(), state: OnboardingStateSchema, condition: OnboardingConditionSchema.nullable(), updatedAt: z.string() })),
});
export type OnboardingList = z.infer<typeof OnboardingListSchema>;

export const AssistReviewResponseSchema = z.strictObject({
  status: z.enum(['valid', 'needs_review']),
  summary: z.string().nullable(),
  acceptanceCriteria: z.array(z.strictObject({ id: z.string(), text: z.string() })),
  issues: z.array(z.strictObject({ kind: z.string(), path: z.string(), message: z.string() })),
});
export type AssistReviewResponse = z.infer<typeof AssistReviewResponseSchema>;

export const TRACK_LABELS: Readonly<Record<ProjectTrack, string>> = Object.fromEntries(PROJECT_TRACKS.map((t) => [t, TEMPLATE_CATALOG[t].label])) as Record<ProjectTrack, string>;
