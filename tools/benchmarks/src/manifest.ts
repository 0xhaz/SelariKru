import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { COMMIT_SHA } from '@selarikru/view-protocol';
import { canonicalSha256, sha256 } from './canonical.ts';

/**
 * The benchmark manifest (fixtures/benchmarks/manifest.json): protocol, cohort plan and every value that must be pinned
 * before a live run. Reading, parsing or validating it touches the file system only. Nothing here dispatches a run,
 * calls a model, spends or opens a connection. A null field is unresolved, and preflight blocks live dispatch on it.
 *
 * Protocol notes recorded in the manifest itself (`protocolNotes`): the payload hash definition, per-request
 * requirement-ID narrowing, one record per trial, how a permitted human action outside control mode is recorded,
 * configuration filled from the manifest, the lockfile freeze, slots and replacements, the published hash, and starts.
 *
 * The manifest's hash (`manifestSha256`) is over its canonical content with `starts` left out, so stamping a start into
 * the manifest does not change the hash that the start, and every record of the cohort, refers to.
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

const StartStampSchema = z.strictObject({ startedAtUtc: isoUtc, manifestSha256: sha256Hex });

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
    /**
     * D6: how the worker harness authenticates. `cli_login`: the owner's existing Claude Code CLI login; preflight checks the
     * `claude` CLI is present and logged in, read-only, printing no account details. `api_key`: the key named by `apiKeyEnv`,
     * checked by presence only. Every worker record carries the mode.
     */
    mode: z.enum(['cli_login', 'api_key']),
    /** The environment variable holding the benchmark API key in `api_key` mode. Preflight checks it is set; its value is never read into output. */
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
    /** M3: how long one route's setup (a device model download and readiness) may take, apart from any request limit. */
    setupTimeoutSeconds: z.number().int().positive(),
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
  /** When each track started, stamped by `record-start` alongside the cohort-start file. Once set, the seed and order cannot be re-frozen. */
  starts: z.strictObject({ workers: StartStampSchema.nullable(), assistant: StartStampSchema.nullable() }),
  protocolNotes: z.array(z.strictObject({ id: text, text })),
  resultTemplate: text,
  requirementIds: z.array(z.string().regex(/^FB-0[1-8]$/)).length(8),
}).superRefine((m, ctx) => {
  const ids = m.workers.requiredModes.map((r) => r.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['workers', 'requiredModes'], message: 'a mode appears twice' });
  if (m.workers.optionalModes.some((o) => ids.includes(o))) ctx.addIssue({ code: 'custom', path: ['workers', 'optionalModes'], message: 'a mode is both required and optional' });
  const budget = m.proposedVariableBudgetUsd;
  const parts = budget.codingPlanningVerificationModelsAndTools + budget.cloudRuntime + budget.assistantInference;
  if (parts > budget.total) ctx.addIssue({ code: 'custom', path: ['proposedVariableBudgetUsd'], message: 'the parts exceed the total' });
});

export type Manifest = z.infer<typeof ManifestSchema>;

export class ManifestError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`the manifest is not valid: ${issues.join('; ')}`);
    this.name = 'ManifestError';
  }
}

export { sha256 };

export type Track = 'workers' | 'assistant';
export const TRACKS: readonly Track[] = ['workers', 'assistant'];

/** The manifest's content hash, leaving out `starts`. Every record and every start refers to the manifest by this. */
export function manifestSha256(manifest: Manifest): string {
  const { starts: _starts, ...content } = manifest;
  return canonicalSha256(content);
}

export function parseManifest(source: string): { manifest: Manifest; sha256: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new ManifestError(['not valid JSON']);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw new ManifestError(parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`));
  return { manifest: parsed.data, sha256: manifestSha256(parsed.data) };
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

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

/**
 * The predeclared order every planned trial runs in. Each entry is a slot. Workers run in paired blocks, each block a
 * shuffle of every required mode, unsupported ones included so the order does not change when a mode becomes
 * available. The assistant runs its excluded warm-ups first, interleaved, then every measured request across both
 * routes in one shuffle.
 */
export function deriveOrder(manifest: Manifest, seed: string): string[] {
  const draw = drawer(seed);
  const modes = manifest.workers.requiredModes.map((m) => m.id);
  const workers = range(manifest.workers.attemptsPerRequiredMode)
    .flatMap((b) => shuffled(modes, draw).map((mode) => `workers/block-${b}/${mode}`));
  const a = manifest.assistant;
  const warmupSlots = ASSISTANT_ROUTES.flatMap((route) => range(a.excludedWarmupsPerRoute).map((k) => `assistant/warmup/${route}/${k}`));
  const measuredSlots = ASSISTANT_ROUTES.flatMap((route) =>
    a.fixtureIds.flatMap((fixture) => range(a.repetitionsPerFixture).map((r) => `assistant/${route}/${fixture}/rep-${r}`)));
  return [...workers, ...shuffled(warmupSlots, draw), ...shuffled(measuredSlots, draw)];
}

export type Slot =
  | { readonly track: 'workers'; readonly id: string; readonly block: string; readonly mode: string }
  | { readonly track: 'assistant'; readonly id: string; readonly warmup: false; readonly mode: string; readonly fixtureId: string }
  | { readonly track: 'assistant'; readonly id: string; readonly warmup: true; readonly mode: string };

/** Reads a frozen order entry. Null for anything that is not a slot this protocol plans. */
export function parseSlot(id: string): Slot | null {
  let m = /^workers\/(block-\d+)\/([A-Z0-9]+)$/.exec(id);
  if (m) return { track: 'workers', id, block: m[1]!, mode: m[2]! };
  m = /^assistant\/warmup\/([A-Z_]+)\/\d+$/.exec(id);
  if (m) return { track: 'assistant', id, warmup: true, mode: m[1]! };
  m = /^assistant\/([A-Z_]+)\/([^/]+)\/rep-\d+$/.exec(id);
  if (m) return { track: 'assistant', id, warmup: false, mode: m[1]!, fixtureId: m[2]! };
  return null;
}

export const orderSha256 = (order: readonly string[]): string => sha256(order.map((e) => `${e}\n`).join(''));

/**
 * The seed and order are frozen when both are recorded, the order is exactly the one the seed derives, and its hash
 * and freeze time are recorded.
 */
export function isFrozen(manifest: Manifest): boolean {
  const r = manifest.randomization;
  if (r.seed === null || r.order.length === 0 || r.orderSha256 === null || r.frozenAtUtc === null) return false;
  const derived = deriveOrder(manifest, r.seed);
  return derived.length === r.order.length && derived.every((e, i) => e === r.order[i]) && orderSha256(r.order) === r.orderSha256;
}

/** The cohort-start file: the preregistration record a track is bound to. */
export const StartRecordSchema = z.strictObject({
  track: z.enum(['workers', 'assistant']),
  cohortId: nullableText,
  seed: text,
  orderSha256: sha256Hex,
  manifestSha256: sha256Hex,
  startedAtUtc: isoUtc,
});
export type StartRecord = z.infer<typeof StartRecordSchema>;
export type StartRecords = Readonly<Record<Track, StartRecord | null>>;
export const NO_STARTS: StartRecords = { workers: null, assistant: null };

export class FrozenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrozenError';
  }
}

const startedTracks = (manifest: Manifest, files: StartRecords): Track[] =>
  TRACKS.filter((t) => manifest.starts[t] !== null || files[t] !== null);

/**
 * Records the seed and the order it derives. Refused once any track has started, whether the manifest says so or a
 * cohort-start file does: the order is part of the experiment.
 */
export function freezeOrder(manifest: Manifest, seed: string, frozenAtUtc: string, files: StartRecords = NO_STARTS): Manifest {
  const started = startedTracks(manifest, files);
  if (started.length > 0) throw new FrozenError(`the seed and order cannot change after start (${started.join(' and ')} started)`);
  if (seed.trim() === '') throw new FrozenError('a seed is required');
  if (!isoUtc.safeParse(frozenAtUtc).success) throw new FrozenError('the freeze time must be an ISO timestamp');
  const order = deriveOrder(manifest, seed);
  return { ...manifest, randomization: { ...manifest.randomization, seed, order, orderSha256: orderSha256(order), frozenAtUtc } };
}

/**
 * What a runner writes before a track's first trial: the cohort-start file, and the same start stamped into the
 * manifest. Refused on an unfrozen manifest or a track already started. The caller must have a passing preflight for
 * the track first; the CLI does.
 */
export function recordStart(manifest: Manifest, track: Track, startedAtUtc: string): { start: StartRecord; manifest: Manifest } {
  if (!isFrozen(manifest)) throw new FrozenError('the seed and order must be frozen before start');
  if (manifest.starts[track] !== null) throw new FrozenError(`${track} already started at ${manifest.starts[track]!.startedAtUtc}`);
  const hash = manifestSha256(manifest);
  const start = StartRecordSchema.parse({
    track, cohortId: manifest.cohortId, seed: manifest.randomization.seed, orderSha256: manifest.randomization.orderSha256, manifestSha256: hash, startedAtUtc,
  });
  return { start, manifest: { ...manifest, starts: { ...manifest.starts, [track]: { startedAtUtc, manifestSha256: hash } } } };
}

/**
 * Why a track's start does not hold for this manifest. Empty when the track has not started (neither the manifest
 * nor a file says so) or when its start matches: the stamp and the file agree, and the manifest's content, seed and
 * order are the ones the track started under.
 */
export function startIssues(manifest: Manifest, track: Track, file: StartRecord | null): string[] {
  const stamp = manifest.starts[track];
  if (stamp === null && file === null) return [];
  const issues: string[] = [];
  const agree = stamp !== null && file !== null && file.track === track && stamp.startedAtUtc === file.startedAtUtc && stamp.manifestSha256 === file.manifestSha256;
  if (!agree) issues.push('start_record_mismatch');
  if ((stamp ?? file)!.manifestSha256 !== manifestSha256(manifest)) issues.push('manifest_changed_after_start');
  if (file !== null && (file.seed !== manifest.randomization.seed || file.orderSha256 !== manifest.randomization.orderSha256)) issues.push('seed_or_order_changed_after_start');
  return issues;
}

/**
 * Reconciles a half-recorded start: a stamp with no cohort-start file (the file write failed after the stamp), or a
 * file with no stamp. It copies what is there and never re-hashes, so a manifest changed since start stays blocked;
 * a file recorded under a different manifest is refused outright rather than stamped.
 * Refused when both exist (they agree, or disagree and repair cannot choose), when neither does, or when the file
 * belongs to another cohort.
 */
export function repairStart(manifest: Manifest, track: Track, file: StartRecord | null): { start: StartRecord; manifest: Manifest } {
  const stamp = manifest.starts[track];
  if (stamp === null && file === null) throw new FrozenError(`${track} has not started; there is nothing to repair`);
  if (stamp !== null && file !== null) {
    const agree = file.track === track && file.startedAtUtc === stamp.startedAtUtc && file.manifestSha256 === stamp.manifestSha256;
    throw new FrozenError(agree ? `${track}: the stamp and the file agree; nothing to repair` : `${track}: the stamp and the file disagree; repair cannot choose between them`);
  }
  if (file !== null) {
    if (file.track !== track || file.cohortId !== manifest.cohortId) throw new FrozenError(`${track}: the start file belongs to another cohort or track`);
    // A same-cohort file from a different manifest would stamp a hash this manifest does not have: refused up front.
    if (file.manifestSha256 !== manifestSha256(manifest)) throw new FrozenError(`${track}: the start file was recorded under a different manifest; repair cannot restore its stamp`);
    const restored = { startedAtUtc: file.startedAtUtc, manifestSha256: file.manifestSha256 };
    return { start: file, manifest: { ...manifest, starts: { ...manifest.starts, [track]: restored } } };
  }
  const start = StartRecordSchema.parse({
    track, cohortId: manifest.cohortId, seed: manifest.randomization.seed, orderSha256: manifest.randomization.orderSha256,
    manifestSha256: stamp!.manifestSha256, startedAtUtc: stamp!.startedAtUtc,
  });
  return { start, manifest };
}

/** Benchmarks measure coding workers, so they run with Claude Code workers on: outside the hackathon build's AI path (Firebase AI Logic). See the `coding-workers` protocol note. */
export const BENCH_CODING_WORKERS = 'claude_code' as const;
