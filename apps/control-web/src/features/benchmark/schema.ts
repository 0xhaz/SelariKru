import { z } from 'zod';

/** Benchmark results file: one record per attempt, as `tools/benchmarks` will export it. Strict on purpose: a field this panel does not know, or a contradiction, refuses the whole file. */

export const WORKER_MODES = ['L1', 'C1', 'H2', 'L2', 'C2'] as const;
export type WorkerMode = (typeof WORKER_MODES)[number];
export const ASSISTANT_MODES = ['ONLY_ON_DEVICE', 'PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD'] as const;
export type AssistantMode = (typeof ASSISTANT_MODES)[number];

const nullableText = z.string().min(1).nullable();
const nullableMs = z.number().finite().nonnegative().nullable();
const nullableQty = z.number().finite().nonnegative().nullable();
const nullableUsd = z.number().finite().nonnegative().nullable();
const nullableCount = z.number().int().nonnegative().nullable();
const isoDate = z.iso.datetime({ offset: true });

const UsageRoleSchema = z.strictObject({
  role: z.string().min(1),
  inputTokens: nullableCount,
  outputTokens: nullableCount,
  cacheTokens: nullableCount,
  provenance: z.enum(['observed', 'estimated', 'unavailable']),
  source: nullableText,
}).refine((u) => u.provenance !== 'unavailable' || (u.inputTokens === null && u.outputTokens === null && u.cacheTokens === null), { message: 'unavailable usage must be null, never a number' });

const CriterionSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(['passed', 'failed', 'error', 'skipped', 'not_run']),
  evidenceReferences: z.array(z.string()),
});

const ConfigurationSchema = z.strictObject({
  manifestSha256: nullableText,
  starterSha: nullableText,
  contractSha256: nullableText,
  verifierSha: nullableText,
  candidateSha: nullableText,
  /** Added to the template: harness name, since a version alone can match across two different harnesses. */
  harness: nullableText,
  harnessVersion: nullableText,
  codingModel: nullableText,
  /** Added to the template: where the coding model's inference ran, kept apart from where the worker ran. */
  inferenceDestination: z.enum(['device', 'cloud']).nullable(),
  providerAccountReference: nullableText,
  cacheCondition: z.enum(['warm', 'cold']).nullable(),
  localHost: nullableText,
  cloudHost: nullableText,
});

const AssistantSchema = z.strictObject({
  fixtureId: nullableText,
  requestedMode: z.enum(ASSISTANT_MODES).nullable(),
  observedInferenceSource: z.enum(['ON_DEVICE', 'IN_CLOUD']).nullable(),
  sdkVersion: nullableText,
  schemaValid: z.boolean().nullable(),
  /** Added to the template: the plan's excluded warm-up requests, retained and counted but never timed. */
  warmup: z.boolean(),
  semanticReview: z.strictObject({
    reviewer: nullableText,
    routeLabelHidden: z.boolean().nullable(),
    retainedFacts: nullableCount,
    missingFacts: nullableCount,
    inventedRequirements: nullableCount,
  }),
  providerInputTokens: nullableCount,
  providerOutputTokens: nullableCount,
  inputBytes: nullableCount,
  outputBytes: nullableCount,
});

const RecordSchema = z.strictObject({
  protocolVersion: z.literal('0.1'),
  /** Added to the template: `measured` is a real run; `simulated` and `fixture` are never evidence. Required, with no default. */
  dataKind: z.enum(['measured', 'simulated', 'fixture']),
  status: z.enum(['not_run', 'completed', 'failed', 'timed_out', 'cancelled', 'denied_start', 'abandoned']),
  track: z.enum(['assistant', 'workers']),
  cohortId: z.string().min(1),
  trialId: z.string().min(1),
  mode: z.string().min(1),
  blockId: nullableText,
  attemptId: z.string().min(1),
  configuration: ConfigurationSchema,
  assistant: AssistantSchema.nullable(),
  timings: z.strictObject({
    clockDomain: nullableText,
    startedAtUtc: isoDate.nullable(),
    endedAtUtc: isoDate.nullable(),
    firstOutputMs: nullableMs,
    generationCompleteMs: nullableMs,
    schemaValidationMs: nullableMs,
    endToEndVerifiedMs: nullableMs,
    queueMs: nullableMs,
    startupMs: nullableMs,
    implementationMs: nullableMs,
    integrationMs: nullableMs,
    verificationMs: nullableMs,
    initialSetupMs: nullableMs,
    modelDownloadMs: nullableMs,
  }),
  resources: z.strictObject({
    localWorkerHours: nullableQty,
    cloudWorkerHours: nullableQty,
    integrationAndVerificationHours: nullableQty,
    requestedVcpus: nullableQty,
    requestedMemoryGib: nullableQty,
    peakRssMiB: nullableQty,
    energyKwh: nullableQty,
    providerUsageByRole: z.array(UsageRoleSchema),
    usageCoverage: z.enum(['complete', 'partial', 'none', 'unknown']),
    integrationAndVerificationHoursAreSubsetOfHostTotals: z.literal(true),
  }),
  cost: z.strictObject({
    currency: z.literal('USD'),
    platformPaidActual: nullableUsd,
    platformPaidEstimated: nullableUsd,
    customerDirectActual: nullableUsd,
    allocatedFixedCost: nullableUsd,
    localHardwareEnergyCost: nullableUsd,
    rateCardVersion: nullableText,
    settlementStatus: z.enum(['settled', 'pending', 'unavailable']),
    exclusions: z.array(z.string()),
  }),
  humanMinutes: z.strictObject({
    initialSetup: nullableQty,
    scoping: nullableQty,
    intervention: nullableQty,
    correction: nullableQty,
    review: nullableQty,
  }),
  quality: z.strictObject({
    allRequiredChecksPassed: z.boolean().nullable(),
    criteria: z.array(CriterionSchema),
    withinDeclaredLimits: z.boolean().nullable(),
  }),
  operations: z.strictObject({
    repairCount: nullableCount,
    deniedActionCount: nullableCount,
    cleanupConfirmed: z.boolean().nullable(),
    externalPrUrl: nullableText,
    /** Added to the template: control mode was used. Null means not recorded, which is treated as unproven and kept out of comparisons. */
    humanIntervened: z.boolean().nullable(),
  }),
  failures: z.array(z.strictObject({ category: z.string().min(1), detail: nullableText })),
  confounders: z.array(z.string()),
  artifactReferences: z.array(z.string()),
  measuredResultsPresent: z.boolean(),
});

export type BenchmarkRecord = z.infer<typeof RecordSchema>;

const CohortSchema = z.strictObject({
  cohortId: z.string().min(1),
  track: z.enum(['assistant', 'workers']),
  /** Attempts per mode predeclared before the run. A cohort cannot be complete without a target to be complete against. */
  plannedPerMode: z.number().int().positive(),
  requiredModes: z.array(z.string().min(1)).min(1),
  order: nullableText,
});

export type BenchmarkCohort = z.infer<typeof CohortSchema>;

export const ASSISTANT_EVIDENCE_IDS = ['pinned_configuration', 'device_only_response', 'approved_cloud_response', 'live_fallback', 'blocked_restricted_fallback', 'schema_validation', 'accepted_handoff'] as const;

const EvidenceItemSchema = z.strictObject({
  id: z.enum(ASSISTANT_EVIDENCE_IDS),
  status: z.enum(['recorded', 'failed', 'not_recorded']),
  dataKind: z.enum(['measured', 'simulated', 'fixture']),
  references: z.array(z.string()),
});

export const BenchmarkFileSchema = z.strictObject({
  protocolVersion: z.literal('0.1'),
  generatedAtUtc: isoDate,
  cohorts: z.array(CohortSchema),
  records: z.array(RecordSchema),
  assistantEvidence: z.array(EvidenceItemSchema),
}).superRefine((file, ctx) => {
  const declared = new Map(file.cohorts.map((c) => [c.cohortId, c]));
  if (declared.size !== file.cohorts.length) ctx.addIssue({ code: 'custom', path: ['cohorts'], message: 'a cohort id appears twice' });
  const attemptIds = new Set<string>();
  file.records.forEach((record, i) => {
    const path = ['records', i];
    const refuse = (message: string): void => { ctx.addIssue({ code: 'custom', path, message }); };
    const cohort = declared.get(record.cohortId);
    if (!cohort) refuse(`cohort ${record.cohortId} is not declared`);
    else if (cohort.track !== record.track) refuse(`track ${record.track} does not match cohort ${record.cohortId}`);
    if (attemptIds.has(record.attemptId)) refuse(`attempt ${record.attemptId} appears twice`);
    attemptIds.add(record.attemptId);
    const validMode = record.track === 'workers' ? (WORKER_MODES as readonly string[]).includes(record.mode) : (ASSISTANT_MODES as readonly string[]).includes(record.mode);
    if (!validMode) refuse(`mode ${record.mode} is not a ${record.track} mode`);
    if (record.track === 'assistant' && record.assistant === null) refuse('an assistant record needs its assistant fields');
    if (record.track === 'assistant' && record.assistant !== null && record.assistant.requestedMode !== record.mode) refuse('requested mode does not match the record mode');
    if (record.track === 'workers' && record.assistant !== null) refuse('a worker record has no assistant fields');
    // A number with `measuredResultsPresent: false`, or a simulated record that says it was measured, is a contradiction: it is refused rather than guessed at.
    const measured = record.dataKind === 'measured' && record.status !== 'not_run';
    if (record.measuredResultsPresent !== measured) refuse(`measuredResultsPresent ${record.measuredResultsPresent} contradicts dataKind ${record.dataKind} and status ${record.status}`);
    if (record.status === 'not_run' && record.timings.endToEndVerifiedMs !== null) refuse('an attempt that did not run has a timing');
  });
});

export type BenchmarkFile = z.infer<typeof BenchmarkFileSchema>;

export type BenchmarkLoad =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] }
  | { readonly kind: 'ok'; readonly file: BenchmarkFile };

export const RESULTS_FILE = 'benchmark-results.json';

/** Reads the published results file. No file, or a host answering with its HTML fallback page, means nothing has been measured: not an error, and nothing is invented in its place. */
export async function loadBenchmark(url: string = `${import.meta.env.BASE_URL}${RESULTS_FILE}`, fetchFn: typeof fetch = fetch): Promise<BenchmarkLoad> {
  let response: Response;
  try {
    response = await fetchFn(url, { cache: 'no-store' });
  } catch {
    return { kind: 'unreachable', detail: 'The results file could not be requested.' };
  }
  if (response.status === 404) return { kind: 'absent' };
  if (!response.ok) return { kind: 'unreachable', detail: `The server answered ${response.status}.` };
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return { kind: 'absent' };
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { kind: 'invalid', issues: ['The results file is not valid JSON.'] };
  }
  const parsed = BenchmarkFileSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', issues: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'file'}: ${i.message}`) };
  return { kind: 'ok', file: parsed.data };
}
