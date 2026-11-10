import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { COMMIT_SHA } from '@selarikru/view-protocol';

/**
 * The benchmark manifest (fixtures/benchmarks/manifest.json): protocol, cohort plan and every value that must be pinned
 * before a live run. Reading, parsing or validating it touches the file system only. Nothing here dispatches a run,
 * calls a model, spends or opens a connection. A null field is unresolved, and preflight blocks live dispatch on it.
 *
 * Protocol notes recorded in the manifest itself (`protocolNotes`): the payload hash definition, per-request
 * requirement-ID narrowing, one record per trial, how a permitted human action outside control mode is recorded,
 * configuration filled from the manifest, and the lockfile freeze.
 */

const text = z.string().min(1);
const nullableText = text.nullable();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase sha-256');
const commitSha = z.string().regex(COMMIT_SHA, 'a full lowercase commit SHA');
const isoUtc = z.iso.datetime({ offset: true });

export const WORKER_MODE_IDS = ['L1', 'C1', 'H2', 'L2', 'C2'] as const;
export const ASSISTANT_ROUTES = ['ONLY_ON_DEVICE', 'ONLY_IN_CLOUD'] as const;

const RequiredModeSchema = z.strictObject({
  id: z.enum(WORKER_MODE_IDS),
  localCodingSlots: z.number().int().nonnegative(),
  cloudCodingSlots: z.number().int().nonnegative(),
  implementationOrder: z.array(text).optional(),
  backendPlacement: z.enum(['local', 'cloud']).optional(),
  frontendPlacement: z.enum(['local', 'cloud']).optional(),
  /** `unsupported` keeps the mode in the plan and the report, shown as Not measured with its reason. It is never dropped. */
  availability: z.enum(['supported', 'unsupported']),
  unavailableReason: nullableText,
}).refine((m) => (m.availability === 'unsupported') === (m.unavailableReason !== null), { message: 'an unsupported mode states why, and only an unsupported mode does' });

export const ManifestSchema = z.strictObject({
  protocolVersion: z.literal('0.1'),
  status: text,
  project: text,
  purpose: text,
  cohortId: nullableText,
  randomization: z.strictObject({
    seed: nullableText,
    order: z.array(text),
    orderSha256: sha256Hex.nullable(),
    frozenAtUtc: isoUtc.nullable(),
    freezeBeforeStart: z.literal(true),
  }),
  repository: z.strictObject({
    url: nullableText,
    starterSha: commitSha.nullable(),
    lockfileSha256: sha256Hex.nullable(),
    contractSha256: sha256Hex.nullable(),
    verifierSha: nullableText,
    /** The frozen verifierSha256 from services/verifier/suites/feedback-board/HASHES.json. Preflight refuses a live cohort when it differs. */
    verifierSha256: sha256Hex.nullable(),
  }),
  environment: z.strictObject({
    harness: nullableText,
    harnessVersion: nullableText,
    codingModel: nullableText,
    inferenceProvider: nullableText,
    modelSettings: nullableText,
    accountTier: nullableText,
    priceReference: nullableText,
    localHost: nullableText,
    cloudBackend: nullableText,
    imageDigest: nullableText,
    verificationEnvironment: nullableText,
    cpuRamLimitsVerified: z.boolean(),
    verifierHostFrozen: z.boolean(),
  }),
  credentials: z.strictObject({
    /** The environment variable holding the one benchmark API key (D6). Preflight checks it is set; its value is never read into output. */
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    checkedBy: z.literal('presence_only_never_printed'),
  }),
  assistant: z.strictObject({
    fixtureFile: text,
    fixtureIds: z.array(text).min(1),
    requestedModes: z.tuple([z.literal('ONLY_ON_DEVICE'), z.literal('ONLY_IN_CLOUD')]),
    expectedObservedSources: z.tuple([z.literal('ON_DEVICE'), z.literal('IN_CLOUD')]),
    repetitionsPerFixture: z.number().int().positive(),
    excludedWarmupsPerRoute: z.number().int().nonnegative(),
    coldStartCohort: text,
    sdkVersion: nullableText,
    browserVersion: nullableText,
    origin: nullableText,
    cloudModel: nullableText,
    deviceModel: nullableText,
    appCheckReadiness: z.enum(['unverified', 'verified']),
  }),
  workers: z.strictObject({
    attemptsPerRequiredMode: z.number().int().positive(),
    minimumExploratoryAttemptsPerMode: z.number().int().positive(),
    requiredModes: z.array(RequiredModeSchema).min(1),
    optionalModes: z.array(z.enum(WORKER_MODE_IDS)),
    attemptTimeoutSeconds: z.literal(1800),
    repairPolicy: nullableText,
    resetWorktreeDatabaseAndAgentSession: z.literal(true),
    installationPolicy: text,
    verificationPolicy: text,
  }),
  proposedVariableBudgetUsd: z.strictObject({
    total: z.number().nonnegative(),
    codingPlanningVerificationModelsAndTools: z.number().nonnegative(),
    cloudRuntime: z.number().nonnegative(),
    assistantInference: z.number().nonnegative(),
    /** D4: `authorized` with a named payer and approver is the only state that lets a live cohort spend. */
    status: z.enum(['proposal_not_authorized', 'authorized']),
    payer: nullableText,
    authorizedBy: nullableText,
    authorizedAtUtc: isoUtc.nullable(),
    excludes: z.array(text),
  }),
  privacy: z.strictObject({
    fixtures: z.literal('synthetic_cloud_permitted'),
    credentialsInResults: z.literal(false),
    rawPrivatePromptsInHostedTelemetry: z.literal(false),
  }),
  preflight: z.strictObject({
    blockOnMissingRepositoryIdentity: z.literal(true),
    blockOnUnresolvedRuntimeModelPolicyAndBudgets: z.literal(true),
    blockOnUnavailableTrustedVerifier: z.literal(true),
    unsupportedModesMustRemainVisible: z.literal(true),
    noLiveDispatchByReadingThisManifest: z.literal(true),
    blockOnUnfrozenLockfile: z.literal(true),
    blockOnUnfrozenSeedAndOrder: z.literal(true),
  }),
  protocolNotes: z.array(z.strictObject({ id: text, text })),
  resultTemplate: text,
  requirementIds: z.array(z.string().regex(/^FB-0[1-8]$/)).length(8),
}).superRefine((m, ctx) => {
  const ids = m.workers.requiredModes.map((r) => r.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['workers', 'requiredModes'], message: 'a mode appears twice' });
  if (m.workers.optionalModes.some((o) => ids.includes(o))) ctx.addIssue({ code: 'custom', path: ['workers', 'optionalModes'], message: 'a mode is both required and optional' });
  const budget = m.proposedVariableBudgetUsd;
  if (budget.codingPlanningVerificationModelsAndTools + budget.cloudRuntime + budget.assistantInference > budget.total) ctx.addIssue({ code: 'custom', path: ['proposedVariableBudgetUsd'], message: 'the parts exceed the total' });
});

export type Manifest = z.infer<typeof ManifestSchema>;

export class ManifestError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`the manifest is not valid: ${issues.join('; ')}`);
    this.name = 'ManifestError';
  }
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Parses manifest text. The hash is over the exact bytes read, so it names this file and no other. */
export function parseManifest(source: string): { manifest: Manifest; sha256: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new ManifestError(['not valid JSON']);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw new ManifestError(parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`));
  return { manifest: parsed.data, sha256: sha256(source) };
}

export function readManifest(path: string): { manifest: Manifest; sha256: string } {
  return parseManifest(readFileSync(path, 'utf8'));
}

/** Deterministic draws from a seed: sha-256 in counter mode. The same seed always yields the same order on any host. */
function drawer(seed: string): () => number {
  let counter = 0;
  return () => createHash('sha256').update(`${seed}:${counter++}`).digest().readUInt32BE(0) / 2 ** 32;
}

function shuffled<T>(items: readonly T[], draw: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(draw() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The predeclared order every planned trial runs in. Workers run in paired blocks, each block a shuffle of every
 * required mode, unsupported ones included so the order does not change when a mode becomes available. The assistant
 * runs its excluded warm-ups first, interleaved, then every measured request across both routes in one shuffle.
 */
export function deriveOrder(manifest: Manifest, seed: string): string[] {
  const draw = drawer(seed);
  const modes = manifest.workers.requiredModes.map((m) => m.id);
  const workers = Array.from({ length: manifest.workers.attemptsPerRequiredMode }, (_, b) => shuffled(modes, draw).map((mode) => `workers/block-${b + 1}/${mode}`)).flat();
  const a = manifest.assistant;
  const warmups = shuffled(ASSISTANT_ROUTES.flatMap((route) => Array.from({ length: a.excludedWarmupsPerRoute }, (_, k) => `assistant/warmup/${route}/${k + 1}`)), draw);
  const measured = shuffled(ASSISTANT_ROUTES.flatMap((route) => a.fixtureIds.flatMap((fixture) => Array.from({ length: a.repetitionsPerFixture }, (_, r) => `assistant/${route}/${fixture}/rep-${r + 1}`))), draw);
  return [...workers, ...warmups, ...measured];
}

export const orderSha256 = (order: readonly string[]): string => sha256(order.map((e) => `${e}\n`).join(''));

/** The seed and order are frozen when both are recorded, the order is exactly the one the seed derives, and its hash and freeze time are recorded. */
export function isFrozen(manifest: Manifest): boolean {
  const r = manifest.randomization;
  if (r.seed === null || r.order.length === 0 || r.orderSha256 === null || r.frozenAtUtc === null) return false;
  const derived = deriveOrder(manifest, r.seed);
  return derived.length === r.order.length && derived.every((e, i) => e === r.order[i]) && orderSha256(r.order) === r.orderSha256;
}

export const StartRecordSchema = z.strictObject({
  cohortId: nullableText,
  seed: text,
  orderSha256: sha256Hex,
  manifestSha256: sha256Hex,
  startedAtUtc: isoUtc,
});
export type StartRecord = z.infer<typeof StartRecordSchema>;

export class FrozenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrozenError';
  }
}

/** Records the seed and the order it derives. Refused once a cohort has started: the order is part of the experiment. */
export function freezeOrder(manifest: Manifest, seed: string, frozenAtUtc: string, start: StartRecord | null): Manifest {
  if (start !== null) throw new FrozenError(`the seed and order cannot change after start (started ${start.startedAtUtc})`);
  if (seed.trim() === '') throw new FrozenError('a seed is required');
  if (!isoUtc.safeParse(frozenAtUtc).success) throw new FrozenError('the freeze time must be an ISO timestamp');
  const order = deriveOrder(manifest, seed);
  return { ...manifest, randomization: { ...manifest.randomization, seed, order, orderSha256: orderSha256(order), frozenAtUtc } };
}

/** What a runner writes before its first trial: the frozen seed and order it is bound to. Refused on an unfrozen manifest. */
export function recordStart(manifest: Manifest, manifestSha256: string, startedAtUtc: string): StartRecord {
  if (!isFrozen(manifest)) throw new FrozenError('the seed and order must be frozen before start');
  return StartRecordSchema.parse({ cohortId: manifest.cohortId, seed: manifest.randomization.seed, orderSha256: manifest.randomization.orderSha256, manifestSha256, startedAtUtc });
}
