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
const provenanceField = z.enum(['observed', 'estimated', 'unavailable']);
/** Evidence is something a reader can open: a route in this app or an https link. */
const isEvidenceReference = (ref: string): boolean => /^(?:#\/|https:\/\/)\S+$/.test(ref);
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The eight required Feedback Board criteria. A worker record carries exactly these, and Passed is derived from them. */
export const FEEDBACK_CRITERIA = ['FB-01', 'FB-02', 'FB-03', 'FB-04', 'FB-05', 'FB-06', 'FB-07', 'FB-08'] as const;

const UsageRoleSchema = z.strictObject({
  role: z.string().min(1),
  inputTokens: nullableCount,
  outputTokens: nullableCount,
  cacheTokens: nullableCount,
  provenance: z.enum(['observed', 'estimated', 'unavailable']),
  source: nullableText,
}).refine((u) => u.provenance !== 'unavailable' || (u.inputTokens === null && u.outputTokens === null && u.cacheTokens === null), { message: 'unavailable usage must be null, never a number' })
  .refine((u) => u.provenance === 'unavailable' || u.source !== null, { message: 'usage needs a source unless it is unavailable' });

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
    /** Added to the template: who says how long the worker ran. A non-null figure with no provenance or source is refused. */
    workerHoursProvenance: provenanceField,
    workerHoursSource: nullableText,
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
    /** Added to the template: a local cost is measured or assumed, and the file must say which. */
    localCostProvenance: provenanceField,
    localCostSource: nullableText,
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
    /** Added to the template: where the minutes came from. */
    provenance: provenanceField,
    source: nullableText,
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
  /** Added to the template (plan section 5, "hash/tag every result"): sha-256 of the raw record. */
  resultSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  measuredResultsPresent: z.boolean(),
});

export type BenchmarkRecord = z.infer<typeof RecordSchema>;

/** All eight required criteria passed. This, not the record's own flag, is what decides Passed. */
export function allCriteriaPassed(record: BenchmarkRecord): boolean {
  const criteria = record.quality.criteria;
  return criteria.length === FEEDBACK_CRITERIA.length && FEEDBACK_CRITERIA.every((id) => criteria.some((c) => c.id === id && c.status === 'passed'));
}

function containsNumber(value: unknown): boolean {
  if (typeof value === 'number') return true;
  if (Array.isArray(value)) return value.some(containsNumber);
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsNumber);
  return false;
}

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
  const resultHashes = new Set<string>();
  const candidateTrials = new Map<string, string>();
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
    const { timings, resources, cost, humanMinutes, operations, assistant } = record;
    if (record.status === 'not_run' && containsNumber({ timings, resources, cost, humanMinutes, operations, assistant })) refuse('an attempt that did not run carries a number');

    if (record.track === 'workers') {
      const ids = record.quality.criteria.map((c) => c.id);
      if (ids.length !== FEEDBACK_CRITERIA.length || !FEEDBACK_CRITERIA.every((id) => ids.includes(id))) refuse('a worker record must carry exactly FB-01 to FB-08');
      else if ((record.quality.allRequiredChecksPassed === true) !== allCriteriaPassed(record)) refuse('allRequiredChecksPassed disagrees with the criteria');
    } else if (record.quality.criteria.length > 0) refuse('an assistant record has no delivery criteria');

    const unsourced = (present: boolean, provenance: string, source: string | null, what: string): void => {
      if (present && (provenance === 'unavailable' || source === null)) refuse(`${what} has a value with no provenance or source`);
      if (!present && provenance !== 'unavailable') refuse(`${what} claims ${provenance} with no value`);
    };
    unsourced(resources.localWorkerHours !== null || resources.cloudWorkerHours !== null, resources.workerHoursProvenance, resources.workerHoursSource, 'worker-hours');
    unsourced(humanMinutes.initialSetup !== null || humanMinutes.scoping !== null || humanMinutes.intervention !== null || humanMinutes.correction !== null || humanMinutes.review !== null, humanMinutes.provenance, humanMinutes.source, 'human minutes');
    unsourced(cost.localHardwareEnergyCost !== null, cost.localCostProvenance, cost.localCostSource, 'local cost');

    // `measured` is a claim. A record that ran must carry what would let someone check it.
    if (measured) {
      // A denied, abandoned or failed attempt may never have produced a candidate, and the plan keeps those records. What a reader must be able to check starts at verification.
      const verified = record.status === 'completed' || record.quality.criteria.some((c) => c.status !== 'not_run');
      if (record.track === 'workers') {
        const candidate = record.configuration.candidateSha;
        if (candidate === null) {
          if (verified) refuse('an attempt that reached verification needs its candidate commit');
        } else if (!COMMIT_SHA.test(candidate)) refuse('a candidate must be a commit SHA');
        else if (candidate !== record.configuration.starterSha) {
          // Every trial starts clean (plan section 3), so two trials cannot share a commit. A no-change attempt legitimately ends on the starter.
          const seenIn = candidateTrials.get(candidate);
          if (seenIn !== undefined && seenIn !== record.trialId) refuse(`candidate ${candidate} is reused by another trial`);
          candidateTrials.set(candidate, seenIn ?? record.trialId);
        }
      }
      if (record.configuration.manifestSha256 === null) refuse('a measured attempt needs its manifest hash');
      if (timings.clockDomain === null && (verified || containsNumber(timings))) refuse('a measured attempt with timings needs its clock domain');
      if (verified && record.artifactReferences.length === 0) refuse('an attempt that reached verification needs an artifact reference');
      if (!record.artifactReferences.every(isEvidenceReference)) refuse('artifact references must start #/ or https://');
      if (record.resultSha256 === null) refuse('a measured attempt needs its result hash');
      if (record.quality.criteria.some((c) => c.status === 'passed' && (c.evidenceReferences.length === 0 || !c.evidenceReferences.every(isEvidenceReference)))) refuse('a passing criterion needs evidence references starting #/ or https://');
    }
    if (record.resultSha256 !== null) {
      if (resultHashes.has(record.resultSha256)) refuse('a result hash is used by another attempt');
      resultHashes.add(record.resultSha256);
    }

    const minutes = (humanMinutes.intervention ?? 0) + (humanMinutes.correction ?? 0);
    if (record.operations.humanIntervened === false && minutes > 0) refuse('humanIntervened is false but intervention or correction minutes are recorded');

    const passing = record.status === 'completed' && (record.track === 'workers' ? allCriteriaPassed(record) && record.quality.withinDeclaredLimits === true : assistant?.schemaValid === true);
    if (passing && record.track === 'workers' && timings.endToEndVerifiedMs === null) refuse('a passing attempt needs its delivery time');
    if (passing && [timings.endToEndVerifiedMs, timings.firstOutputMs, timings.generationCompleteMs].includes(0)) refuse('a passing attempt cannot have taken no time');
    if (timings.firstOutputMs !== null && timings.generationCompleteMs !== null && timings.firstOutputMs > timings.generationCompleteMs) refuse('first output came after the complete response');
  });
  file.assistantEvidence.forEach((item, i) => {
    if (item.dataKind === 'measured' && item.status === 'recorded' && (item.references.length === 0 || !item.references.every(isEvidenceReference))) ctx.addIssue({ code: 'custom', path: ['assistantEvidence', i], message: 'recorded evidence needs references starting #/ or https://' });
  });
});

export type BenchmarkFile = z.infer<typeof BenchmarkFileSchema>;

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
