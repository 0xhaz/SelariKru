import { REPLACEABLE_STATUSES } from '@selarikru/view-protocol';
import { isFrozen, parseSlot, startIssues, type Manifest, type Slot, type StartRecords, type Track } from './manifest.ts';
import type { PreflightReport } from './preflight.ts';
import type { RawRecord } from './report.ts';

/**
 * What both runners share: which slot attempts to run next, the gate in front of every live path, and the parts of a
 * record that say "nothing was measured".
 */

export class LiveRefusedError extends Error {
  constructor(readonly blockers: readonly string[]) {
    super(`live dispatch refused: ${blockers.join(', ')}`);
    this.name = 'LiveRefusedError';
  }
}

export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

/**
 * A live run needs all of: the explicit `--live` request (the caller only builds this with it), a passing preflight
 * for the track (which itself requires the budget authorized, D4), and the track's start recorded under this exact
 * manifest. Anything else is refused before a single trial is dispatched.
 */
export interface LiveAuthorization {
  readonly preflight: PreflightReport;
  readonly starts: StartRecords;
}

export function assertLive(manifest: Manifest, track: Track, live: LiveAuthorization): void {
  const blockers = [...live.preflight.liveDispatch[track].blockers];
  if (!live.preflight.liveDispatch[track].allowed && blockers.length === 0) blockers.push('preflight_blocked');
  if (manifest.starts[track] === null && live.starts[track] === null) blockers.push(`cohort_not_started: ${track}`);
  else blockers.push(...startIssues(manifest, track, live.starts[track]));
  if (blockers.length > 0) throw new LiveRefusedError([...new Set(blockers)]);
}

export interface PlannedTrial {
  readonly slot: Slot;
  readonly slotAttempt: number;
  readonly trialId: string;
}

export const trialIdFor = (slotId: string, slotAttempt: number): string => `${slotId}#${slotAttempt}`;

/**
 * The trials still to run, in the frozen order. The order comes only from a frozen manifest, is copied once, and the
 * returned list is frozen, so nothing a runner does afterwards can reorder it.
 *
 * Per slot: no record yet is attempt 1. A slot whose last attempt was an infrastructure outcome (denied start,
 * abandoned, not run) gets the next attempt, unless `keep` says that outcome still stands (for example a mode that is
 * still unavailable); any other outcome is final and the slot is skipped. Prior records are those of the same data
 * kind, so a dry run never continues a measured slot.
 */
export function plannedTrials(manifest: Manifest, track: Track, prior: readonly RawRecord[], keep: (slot: Slot, last: RawRecord) => boolean = () => false): readonly PlannedTrial[] {
  if (!isFrozen(manifest)) throw new OrderError('the seed and order must be frozen before any trial runs');
  const order = Object.freeze([...manifest.randomization.order]);
  const planned: PlannedTrial[] = [];
  for (const id of order) {
    const slot = parseSlot(id);
    if (slot === null) throw new OrderError(`the frozen order holds an entry that is not a slot: ${id}`);
    if (slot.track !== track) continue;
    const attempts = prior.filter((r) => r.slotId === id).sort((a, b) => (a.slotAttempt ?? 0) - (b.slotAttempt ?? 0));
    const lastRecord = attempts.at(-1);
    if (lastRecord !== undefined && (!REPLACEABLE_STATUSES.includes(lastRecord.status) || keep(slot, lastRecord))) continue;
    const slotAttempt = (lastRecord?.slotAttempt ?? 0) + 1;
    planned.push(Object.freeze({ slot, slotAttempt, trialId: trialIdFor(id, slotAttempt) }));
  }
  return Object.freeze(planned);
}

/** The record parts that carry no measurement. */
export const NO_TIMINGS: RawRecord['timings'] = {
  clockDomain: null, startedAtUtc: null, endedAtUtc: null, firstOutputMs: null, generationCompleteMs: null, schemaValidationMs: null, endToEndVerifiedMs: null,
  queueMs: null, startupMs: null, implementationMs: null, integrationMs: null, verificationMs: null, initialSetupMs: null, modelDownloadMs: null,
};

export const NO_RESOURCES: RawRecord['resources'] = {
  localWorkerHours: null, cloudWorkerHours: null, integrationAndVerificationHours: null, workerHoursProvenance: 'unavailable', workerHoursSource: null,
  requestedVcpus: null, requestedMemoryGib: null, peakRssMiB: null, energyKwh: null, providerUsageByRole: [], usageCoverage: 'none',
  integrationAndVerificationHoursAreSubsetOfHostTotals: true,
};

export const NO_COST: RawRecord['cost'] = {
  currency: 'USD', platformPaidActual: null, platformPaidEstimated: null, customerDirectActual: null, allocatedFixedCost: null, localHardwareEnergyCost: null,
  localCostProvenance: 'unavailable', localCostSource: null, rateCardVersion: null, settlementStatus: 'unavailable', exclusions: [],
};

export const NO_HUMAN_MINUTES: RawRecord['humanMinutes'] = {
  initialSetup: null, scoping: null, intervention: null, correction: null, review: null, permittedAction: null, provenance: 'unavailable', source: null,
};

export const NO_OPERATIONS: RawRecord['operations'] = {
  repairCount: null, deniedActionCount: null, cleanupConfirmed: null, externalPrUrl: null, humanIntervened: null, permittedHumanActions: null,
};
