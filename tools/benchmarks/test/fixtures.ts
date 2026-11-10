import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifierHashes } from '@selarikru/verifier/hashing';
import { freezeOrder, parseManifest, recordStart, type Manifest, type StartRecords } from '../src/manifest.ts';
import type { RawRecord } from '../src/report.ts';

/** Test data only. Every value here is synthetic; none is a measurement. */

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURE_MANIFEST_PATH = join(REPO_ROOT, 'fixtures/benchmarks/manifest.json');
export const fixtureManifestText = (): string => readFileSync(FIXTURE_MANIFEST_PATH, 'utf8');

export const STARTER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const HASHES = { verifierSha256: '1'.repeat(64), lockfileSha256: '2'.repeat(64) } as const;
export const SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/** The fixture manifest with every required field resolved, both cloud modes available, and its seed and order frozen. */
export function resolvedManifest(over: (m: Manifest) => void = () => {}): Manifest {
  const m = parseManifest(fixtureManifestText()).manifest;
  m.cohortId = 'cohort-2026-11';
  // The T8.1 tests exercise the API-key path; the tracked manifest's mode (D6) is cli_login, tested on its own.
  m.credentials = { ...m.credentials, mode: 'api_key' };
  m.repository = { url: 'https://github.com/example/feedback-board', starterSha: STARTER, lockfileSha256: HASHES.lockfileSha256, contractSha256: '3'.repeat(64), verifierSha: 'feedbeef00112233445566778899aabbccddeeff', verifierSha256: HASHES.verifierSha256 };
  m.environment = {
    harness: 'claude-code', harnessVersion: '2.1.0', codingModel: 'claude-sonnet-5-5', inferenceProvider: 'anthropic', modelSettings: 'default', accountTier: 'tier-2', priceReference: 'rc-2026-11',
    localHost: 'arm64-laptop', cloudBackend: 'cloud-run', imageDigest: `sha256:${'4'.repeat(64)}`, verificationEnvironment: 'verifier-image', cpuRamLimitsVerified: true, verifierHostFrozen: true,
  };
  m.assistant = { ...m.assistant, sdkVersion: '12.5.0', browserVersion: 'Chrome 140', origin: 'https://selarikru.web.app', cloudModel: 'gemini-2.5-flash', deviceModel: 'gemini-nano', appCheckReadiness: 'verified' };
  m.workers = { ...m.workers, repairPolicy: 'two repairs per task revision', requiredModes: m.workers.requiredModes.map((r) => ({ ...r, availability: 'supported', unavailableReason: null })) };
  m.proposedVariableBudgetUsd = { ...m.proposedVariableBudgetUsd, status: 'authorized', payer: 'project owner', authorizedBy: 'owner', authorizedAtUtc: '2026-11-15T09:00:00.000Z' };
  over(m);
  return freezeOrder(m, 'seed-7f1e', '2026-11-15T10:00:00.000Z');
}

/** Both tracks started: the stamped manifest and the two cohort-start files. */
export function started(manifest: Manifest = resolvedManifest()): { manifest: Manifest; starts: StartRecords } {
  const w = recordStart(manifest, 'workers', '2026-11-16T09:00:00.000Z');
  const a = recordStart(w.manifest, 'assistant', '2026-11-16T09:05:00.000Z');
  return { manifest: a.manifest, starts: { workers: w.start, assistant: a.start } };
}

/**
 * A minimal verifier package and repository root on disk, shaped as the verifier's hashing expects, with HASHES.json
 * written from the verifier's own hashing. Returns the paths and the hashes.
 */
export function verifierTree(dir: string): { verifierRoot: string; repoRoot: string; hashes: { verifierSha256: string; lockfileSha256: string } } {
  const repoRoot = join(dir, 'repo');
  const verifierRoot = join(repoRoot, 'services/verifier');
  const suite = join(verifierRoot, 'suites/feedback-board');
  mkdirSync(suite, { recursive: true });
  mkdirSync(join(verifierRoot, 'src'), { recursive: true });
  writeFileSync(join(suite, 'manifest.json'), '{"suite":"fixture"}');
  writeFileSync(join(suite, 'checks.spec.ts'), '// fixture suite');
  writeFileSync(join(verifierRoot, 'src/run.ts'), '// fixture runner');
  writeFileSync(join(verifierRoot, 'Dockerfile'), 'FROM scratch');
  writeFileSync(join(verifierRoot, 'package.json'), '{"name":"fixture-verifier"}');
  writeFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: fixture');
  const h = verifierHashes(verifierRoot, repoRoot);
  writeFileSync(join(suite, 'HASHES.json'), JSON.stringify(h));
  return { verifierRoot, repoRoot, hashes: { verifierSha256: h.verifierSha256, lockfileSha256: h.lockfileSha256 } };
}

const passedCriteria = (): RawRecord['quality']['criteria'] => Array.from({ length: 8 }, (_, i) => ({ id: `FB-0${i + 1}`, status: 'passed' as const, evidenceReferences: [`#/evidence?check=FB-0${i + 1}`] }));
const notRunCriteria = (): RawRecord['quality']['criteria'] => Array.from({ length: 8 }, (_, i) => ({ id: `FB-0${i + 1}`, status: 'not_run' as const, evidenceReferences: [] }));

export interface WorkerOver {
  readonly mode: 'L1' | 'C1' | 'H2';
  readonly block: number;
  readonly ms?: number | null;
  readonly status?: RawRecord['status'];
  readonly dataKind?: RawRecord['dataKind'];
  readonly failed?: boolean;
  readonly actualUsd?: number | null;
  readonly estimatedUsd?: number | null;
  readonly clockDomain?: string;
  readonly trialId?: string;
  readonly humanIntervened?: boolean | null;
  readonly permittedHumanActions?: number;
  readonly failureDetail?: string;
  readonly account?: string;
  readonly slotAttempt?: number;
  readonly credentialMode?: 'cli_login' | 'api_key';
  readonly accountTier?: string;
}

/** One raw worker record, as a runner would write it. Completed and passing unless told otherwise. */
export function rawWorker(o: WorkerOver): RawRecord {
  const status = o.status ?? 'completed';
  const ran = status !== 'not_run';
  const verified = status === 'completed';
  const trialId = o.trialId ?? `w-b${o.block}-${o.mode}`;
  const sha = [...`${trialId}`].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(40, '0').slice(0, 40);
  const criteria = verified ? passedCriteria().map((c, i) => (o.failed && i === 2 ? { ...c, status: 'failed' as const } : c)) : notRunCriteria();
  const ms = o.ms === undefined ? 900_000 + o.block * 10_000 : o.ms;
  const actual = o.actualUsd === undefined ? 1.5 : o.actualUsd;
  const actions = o.permittedHumanActions ?? 0;
  return {
    dataKind: o.dataKind ?? 'measured', status, track: 'workers', trialId, mode: o.mode, blockId: `block-${o.block}`, attemptId: `${trialId}-a1`,
    slotId: `workers/block-${o.block}/${o.mode}`, slotAttempt: o.slotAttempt ?? 1,
    configuration: { candidateSha: verified ? sha : null, inferenceDestination: 'cloud', providerAccountReference: o.account ?? null, credentialMode: o.credentialMode ?? 'cli_login', accountTier: o.accountTier ?? 'tier-2', credentialPath: null, agentState: null, cacheCondition: 'warm', localHost: o.mode === 'C1' ? null : 'arm64-laptop', cloudHost: o.mode === 'L1' ? null : 'cloud-run-x86' },
    assistant: null,
    timings: { clockDomain: ran ? (o.clockDomain ?? 'server-monotonic') : null, startedAtUtc: null, endedAtUtc: null, firstOutputMs: null, generationCompleteMs: null, schemaValidationMs: null, endToEndVerifiedMs: verified ? ms : null, queueMs: null, startupMs: null, implementationMs: null, integrationMs: null, verificationMs: null, initialSetupMs: null, modelDownloadMs: null },
    resources: { localWorkerHours: null, cloudWorkerHours: null, integrationAndVerificationHours: null, workerHoursProvenance: 'unavailable', workerHoursSource: null, requestedVcpus: ran ? 2 : null, requestedMemoryGib: ran ? 4 : null, peakRssMiB: null, energyKwh: null, providerUsageByRole: ran ? [{ role: 'coding', inputTokens: 100_000 + o.block, outputTokens: 8_000, cacheTokens: null, provenance: 'observed', source: 'harness' }] : [], usageCoverage: ran ? 'partial' : 'none', integrationAndVerificationHoursAreSubsetOfHostTotals: true },
    cost: { currency: 'USD', platformPaidActual: ran ? actual : null, platformPaidEstimated: ran ? (o.estimatedUsd === undefined ? null : o.estimatedUsd) : null, customerDirectActual: null, allocatedFixedCost: null, localHardwareEnergyCost: null, localCostProvenance: 'unavailable', localCostSource: null, rateCardVersion: ran ? 'rc-2026-11' : null, settlementStatus: ran ? 'settled' : 'unavailable', exclusions: [] },
    humanMinutes: ran ? { initialSetup: null, scoping: null, intervention: o.humanIntervened ? 3 : 0, correction: 0, review: 2, permittedAction: actions > 0 ? actions : null, provenance: 'observed', source: 'reviewer log' } : { initialSetup: null, scoping: null, intervention: null, correction: null, review: null, permittedAction: null, provenance: 'unavailable', source: null },
    quality: { allRequiredChecksPassed: verified ? !o.failed : null, criteria, withinDeclaredLimits: verified ? true : null },
    operations: { repairCount: ran ? 0 : null, deniedActionCount: ran ? 0 : null, cleanupConfirmed: ran ? true : null, externalPrUrl: null, humanIntervened: ran ? (o.humanIntervened === undefined ? false : o.humanIntervened) : null, permittedHumanActions: ran ? actions : null },
    failures: status === 'failed' || status === 'timed_out' || status === 'denied_start' ? [{ category: status, detail: o.failureDetail ?? null }] : [],
    confounders: [],
    artifactReferences: verified ? [`#/evidence?run=${trialId}`] : [],
  };
}

export interface AssistantOver {
  readonly route: 'ONLY_ON_DEVICE' | 'ONLY_IN_CLOUD';
  readonly index: number;
  readonly ms?: number;
  readonly firstMs?: number | null;
  readonly observed?: 'ON_DEVICE' | 'IN_CLOUD' | null;
  readonly warmup?: boolean;
  readonly status?: RawRecord['status'];
}

export function rawAssistant(o: AssistantOver): RawRecord {
  const status = o.status ?? 'completed';
  const ran = status !== 'not_run';
  const device = o.route === 'ONLY_ON_DEVICE';
  const trialId = `a-${device ? 'dev' : 'cloud'}-${o.index}${o.warmup ? '-w' : ''}`;
  const ms = o.ms ?? 1000 + o.index * 10;
  const fixtureId = `brief-${String((o.index % 10) + 1).padStart(2, '0')}`;
  const slotId = o.warmup ? `assistant/warmup/${o.route}/${(o.index % 2) + 1}` : `assistant/${o.route}/${fixtureId}/rep-${Math.floor(o.index / 10) + 1}`;
  return {
    dataKind: 'measured', status, track: 'assistant', trialId, mode: o.route, blockId: null, attemptId: `${trialId}-a1`, slotId, slotAttempt: 1,
    configuration: { candidateSha: null, inferenceDestination: device ? 'device' : 'cloud', providerAccountReference: null, credentialMode: null, accountTier: null, credentialPath: null, agentState: null, cacheCondition: 'warm', localHost: null, cloudHost: null },
    assistant: {
      fixtureId, requestedMode: o.route, observedInferenceSource: ran ? (o.observed === undefined ? (device ? 'ON_DEVICE' : 'IN_CLOUD') : o.observed) : null, sdkVersion: '12.5.0', schemaValid: ran ? true : null, warmup: o.warmup ?? false,
      payloadSha256: '9'.repeat(63) + String(o.index % 10), semanticReview: { reviewer: null, routeLabelHidden: null, retainedFacts: null, missingFacts: null, inventedRequirements: null },
      providerInputTokens: null, providerOutputTokens: null, inputBytes: ran ? 2048 : null, outputBytes: ran ? 512 : null,
    },
    timings: { clockDomain: ran ? 'browser-monotonic' : null, startedAtUtc: null, endedAtUtc: null, firstOutputMs: ran ? (o.firstMs === undefined ? null : o.firstMs) : null, generationCompleteMs: ran ? ms : null, schemaValidationMs: null, endToEndVerifiedMs: null, queueMs: null, startupMs: null, implementationMs: null, integrationMs: null, verificationMs: null, initialSetupMs: null, modelDownloadMs: null },
    resources: { localWorkerHours: null, cloudWorkerHours: null, integrationAndVerificationHours: null, workerHoursProvenance: 'unavailable', workerHoursSource: null, requestedVcpus: null, requestedMemoryGib: null, peakRssMiB: null, energyKwh: null, providerUsageByRole: [], usageCoverage: 'none', integrationAndVerificationHoursAreSubsetOfHostTotals: true },
    cost: { currency: 'USD', platformPaidActual: null, platformPaidEstimated: null, customerDirectActual: null, allocatedFixedCost: null, localHardwareEnergyCost: null, localCostProvenance: 'unavailable', localCostSource: null, rateCardVersion: null, settlementStatus: 'unavailable', exclusions: [] },
    humanMinutes: { initialSetup: null, scoping: null, intervention: null, correction: null, review: null, permittedAction: null, provenance: 'unavailable', source: null },
    quality: { allRequiredChecksPassed: null, criteria: [], withinDeclaredLimits: null },
    operations: { repairCount: null, deniedActionCount: null, cleanupConfirmed: null, externalPrUrl: null, humanIntervened: false, permittedHumanActions: null },
    failures: [], confounders: [], artifactReferences: ran ? [`#/evidence?run=${trialId}`] : [],
  };
}

/** Five paired blocks of L1 and C1, all passing. */
export function pairedWorkers(blocks = 5): RawRecord[] {
  return Array.from({ length: blocks }, (_, i) => [rawWorker({ mode: 'L1', block: i + 1, ms: 1_200_000 + i * 10_000 }), rawWorker({ mode: 'C1', block: i + 1, ms: 960_000 + i * 10_000 })]).flat();
}
