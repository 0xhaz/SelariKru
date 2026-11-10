import { COMMIT_SHA, REPLACEABLE_STATUSES, type BenchmarkFile, type BenchmarkRecord } from '@selarikru/view-protocol';
import { manifestSha256, parseSlot, type Manifest } from './manifest.ts';

/**
 * The checks every results file must pass against its manifest, beyond the shared schema. Export, the report and the
 * publish step all run this one function, so a file that export would refuse is refused everywhere.
 */

export const SERVER_CLOCK = 'server-monotonic';

export const cohortIdFor = (manifest: Manifest, track: BenchmarkRecord['track']): string => `${manifest.cohortId}-${track}`;

/** How a cohort names its frozen order in the results file. Null when the seed and order are not recorded. */
export function orderLabel(manifest: Manifest): string | null {
  const r = manifest.randomization;
  return r.seed !== null && r.orderSha256 !== null ? `seed ${r.seed}; order sha256 ${r.orderSha256}` : null;
}

const plannedModes = (m: Manifest, track: BenchmarkRecord['track']): readonly string[] =>
  track === 'workers' ? m.workers.requiredModes.map((r) => r.id) : m.assistant.requestedModes;

function modelFor(m: Manifest, r: BenchmarkRecord): string | null {
  if (r.track === 'workers') return m.environment.codingModel;
  return r.mode === 'ONLY_ON_DEVICE' || r.mode === 'PREFER_ON_DEVICE' ? m.assistant.deviceModel : m.assistant.cloudModel;
}

/** The configuration a record must carry from its manifest. */
type ManifestFields = 'manifestSha256' | 'starterSha' | 'contractSha256' | 'verifierSha' | 'harness' | 'harnessVersion' | 'codingModel';
export type ManifestConfiguration = Pick<BenchmarkRecord['configuration'], ManifestFields>;

export function manifestConfiguration(m: Manifest, r: Pick<BenchmarkRecord, 'track' | 'mode'>): ManifestConfiguration {
  return {
    manifestSha256: manifestSha256(m),
    starterSha: m.repository.starterSha,
    contractSha256: m.repository.contractSha256,
    verifierSha: m.repository.verifierSha,
    harness: m.environment.harness,
    harnessVersion: m.environment.harnessVersion,
    codingModel: modelFor(m, r as BenchmarkRecord),
  };
}

function slotIssue(r: BenchmarkRecord, order: ReadonlySet<string>): string | null {
  if (r.slotId === null || r.slotAttempt === null) return `trial ${r.trialId} needs its slot and slot attempt`;
  if (!order.has(r.slotId)) return `trial ${r.trialId}: slot ${r.slotId} is not in the frozen order`;
  const slot = parseSlot(r.slotId);
  const matches = slot !== null && slot.track === r.track && slot.mode === r.mode && (slot.track === 'workers'
    ? slot.block === r.blockId
    : slot.warmup === (r.assistant?.warmup ?? false) && (slot.warmup || slot.fixtureId === r.assistant?.fixtureId));
  return matches ? null : `slot ${r.slotId} does not match trial ${r.trialId}`;
}

function configurationIssues(m: Manifest, r: BenchmarkRecord): string[] {
  const issues: string[] = [];
  const c = r.configuration;
  for (const [field, sha] of [['starterSha', c.starterSha], ['candidateSha', c.candidateSha]] as const) {
    if (sha !== null && !COMMIT_SHA.test(sha)) issues.push(`trial ${r.trialId}: ${field} is not a full lowercase commit SHA`);
  }
  const expected = manifestConfiguration(m, r);
  if (c.manifestSha256 !== expected.manifestSha256) issues.push(`trial ${r.trialId} was exported under another manifest`);
  else {
    const differs = (Object.keys(expected) as (keyof typeof expected)[]).filter((k) => c[k] !== expected[k]);
    if (differs.length > 0) issues.push(`trial ${r.trialId}: ${differs.join(', ')} not as the manifest records`);
  }
  return issues;
}

/**
 * Within each slot (and data kind), attempts run 1..n with no gaps, and every attempt but the last ended in an
 * infrastructure outcome. A completed, failed, timed-out or cancelled attempt is final: retrying it would turn the
 * cohort into best-of-N.
 */
function attemptIssues(records: readonly BenchmarkRecord[]): string[] {
  const slots = new Map<string, BenchmarkRecord[]>();
  for (const r of records) {
    if (r.slotId === null || r.slotAttempt === null) continue;
    const key = `${r.dataKind}\0${r.slotId}`;
    slots.set(key, [...(slots.get(key) ?? []), r]);
  }
  const issues: string[] = [];
  for (const attempts of slots.values()) {
    const slotId = attempts[0]!.slotId!;
    const sorted = [...attempts].sort((x, y) => x.slotAttempt! - y.slotAttempt!);
    const numbers = sorted.map((r) => r.slotAttempt!);
    const repeated = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    for (const n of new Set(repeated)) issues.push(`slot ${slotId} has attempt ${n} twice`);
    if (repeated.length === 0 && numbers.some((n, i) => n !== i + 1)) issues.push(`slot ${slotId}: attempts must run 1..n with no gaps (found ${numbers.join(', ')})`);
    for (const r of sorted.slice(0, -1)) {
      if (!REPLACEABLE_STATUSES.includes(r.status)) {
        issues.push(`slot ${slotId}: attempt ${r.slotAttempt} (${r.status}) cannot be replaced; only ${REPLACEABLE_STATUSES.join(', ')} can`);
      }
    }
  }
  return issues;
}

export function checkResults(file: BenchmarkFile, m: Manifest): string[] {
  const issues: string[] = [];
  if (m.cohortId === null) return ['the manifest cohortId is unresolved'];
  for (const c of file.cohorts) {
    if (c.cohortId !== cohortIdFor(m, c.track)) issues.push(`cohort ${c.cohortId} is not this manifest's ${c.track} cohort`);
    if (c.order !== orderLabel(m)) issues.push(`cohort ${c.cohortId} does not name this manifest's frozen order`);
  }
  const order = new Set(m.randomization.order);
  const trials = new Set<string>();
  for (const r of file.records) {
    if (r.cohortId !== cohortIdFor(m, r.track)) issues.push(`trial ${r.trialId} is not in this manifest's cohort`);
    if (!plannedModes(m, r.track).includes(r.mode)) issues.push(`trial ${r.trialId}: mode ${r.mode} is not planned in the manifest`);
    const trialKey = `${r.track}\0${r.trialId}`;
    if (trials.has(trialKey)) issues.push(`one record per trial: trial ${r.trialId} has two records`);
    trials.add(trialKey);
    const slot = slotIssue(r, order);
    if (slot !== null) issues.push(slot);
    if (r.track === 'workers' && r.timings.endToEndVerifiedMs !== null && r.timings.clockDomain !== SERVER_CLOCK) {
      issues.push(`trial ${r.trialId}: a delivery time must be on the ${SERVER_CLOCK} clock`);
    }
    issues.push(...configurationIssues(m, r));
  }
  issues.push(...attemptIssues(file.records));
  return issues;
}
