import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Executor, Tx } from './db.ts';
import { usageEntries } from './schema/index.ts';

export const USAGE_PROVENANCE = ['observed', 'estimated', 'unavailable'] as const;
export type UsageProvenance = (typeof USAGE_PROVENANCE)[number];

export const TOKEN_METRICS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'] as const;
export type TokenMetric = (typeof TOKEN_METRICS)[number];
export type UsageMetric = TokenMetric | 'worker_seconds' | 'cost_usd';

export const WORKER_PHASES = ['setup', 'active', 'idle', 'abandoned'] as const;
export type WorkerPhase = (typeof WORKER_PHASES)[number];
export type WorkerHost = 'local' | 'cloud';
export type WorkerTimeBasis = 'measured' | 'billed';
/** What a cost figure is priced on, kept in the entry's `detail.costBasis`. `list` is list price, not money billed. */
export type CostBasis = 'list' | 'billed';

/** Sources whose figures come from inside the worker. They can be `estimated` or `unavailable`, never `observed`. */
export const SELF_REPORTED_SOURCES = ['worker_report', 'harness_report'] as const;
export type UsageSource = (typeof SELF_REPORTED_SOURCES)[number] | 'controller_clock' | 'lease_reaper' | 'verifier' | 'integration' | 'provider_response' | 'rate_card';

export const INTEGRATION_ROLE = 'integration';
export const VERIFICATION_ROLE = 'verification';

export interface UsageRunScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
}

export interface UsageFigures {
  readonly quantity: string | null;
  readonly provenance: UsageProvenance;
  readonly source: UsageSource;
  readonly rateCardVersion?: string | null;
  /** Never raw prompts, worker text or secrets. */
  readonly detail?: Record<string, unknown>;
}

export interface NewUsageEntry extends UsageRunScope, UsageFigures {
  readonly dedupeKey: string;
  readonly taskId?: string | null;
  readonly revision?: number | null;
  readonly attemptId?: string | null;
  readonly role: string;
  readonly metric: UsageMetric;
  readonly phase?: WorkerPhase | null;
  readonly host?: WorkerHost | null;
  readonly basis?: WorkerTimeBasis | null;
  readonly recordedAt: Date;
}

export type UsageEntryRow = typeof usageEntries.$inferSelect;

export class InvalidUsageEntry extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUsageEntry';
  }
}

const DECIMAL = /^\d{1,18}(\.\d{1,6})?$/;
const SCALE = 1_000_000n;

function assertFigures(f: UsageFigures): void {
  if (f.provenance === 'unavailable') {
    if (f.quantity !== null) throw new InvalidUsageEntry('an unavailable figure has no quantity');
    return;
  }
  if (f.quantity === null || !DECIMAL.test(f.quantity)) throw new InvalidUsageEntry(`quantity must be a non-negative decimal string, got ${String(f.quantity)}`);
  if (f.provenance === 'observed' && (SELF_REPORTED_SOURCES as readonly string[]).includes(f.source)) {
    throw new InvalidUsageEntry(`a figure from ${f.source} cannot be observed`);
  }
}

/**
 * Appends one ledger row in the caller's transaction. A repeated `dedupeKey` adds nothing and returns the existing row's id,
 * so a retried write cannot count twice.
 */
export async function appendUsage(tx: Tx, entry: NewUsageEntry): Promise<string> {
  assertFigures(entry);
  const entryId = `usg_${randomUUID()}`;
  const inserted = await tx
    .insert(usageEntries)
    .values({
      tenantId: entry.tenantId, projectId: entry.projectId, entryId, dedupeKey: entry.dedupeKey, runId: entry.runId,
      taskId: entry.taskId ?? null, revision: entry.revision ?? null, attemptId: entry.attemptId ?? null, role: entry.role, metric: entry.metric,
      quantity: entry.quantity, provenance: entry.provenance, source: entry.source, phase: entry.phase ?? null, host: entry.host ?? null, basis: entry.basis ?? null,
      rateCardVersion: entry.rateCardVersion ?? null, recordedAt: entry.recordedAt, detail: entry.detail ?? {},
    })
    .onConflictDoNothing({ target: [usageEntries.tenantId, usageEntries.projectId, usageEntries.dedupeKey] })
    .returning({ entryId: usageEntries.entryId });
  if (inserted[0]) return inserted[0].entryId;
  const existing = await tx
    .select({ entryId: usageEntries.entryId })
    .from(usageEntries)
    .where(and(eq(usageEntries.tenantId, entry.tenantId), eq(usageEntries.projectId, entry.projectId), eq(usageEntries.dedupeKey, entry.dedupeKey)));
  return existing[0]!.entryId;
}

/**
 * Corrects an entry by appending its replacement; the original row stays. The replacement keeps the original's dimensions and states its own
 * figures and source, so a correction cannot launder a self-report into `observed`. Only the latest row of a chain can be corrected.
 */
export async function correctUsage(tx: Tx, target: { readonly tenantId: string; readonly projectId: string; readonly entryId: string }, dedupeKey: string, figures: UsageFigures, recordedAt: Date): Promise<string> {
  assertFigures(figures);
  const rows = await tx
    .select()
    .from(usageEntries)
    .where(and(eq(usageEntries.tenantId, target.tenantId), eq(usageEntries.projectId, target.projectId), eq(usageEntries.entryId, target.entryId)));
  const original = rows[0];
  if (!original) throw new InvalidUsageEntry(`unknown usage entry: ${target.entryId}`);
  const entryId = `usg_${randomUUID()}`;
  await tx.insert(usageEntries).values({
    ...original, entryId, dedupeKey, correctsEntryId: original.entryId, quantity: figures.quantity, provenance: figures.provenance, source: figures.source,
    rateCardVersion: figures.rateCardVersion ?? null, recordedAt, createdAt: recordedAt, detail: figures.detail ?? {},
  });
  return entryId;
}

/** The run's current entries: every row that no later row corrects. */
export async function readUsageEntries(db: Executor, scope: UsageRunScope): Promise<UsageEntryRow[]> {
  const corrected = sql`SELECT c.corrects_entry_id FROM usage_entries c WHERE c.tenant_id = ${scope.tenantId} AND c.project_id = ${scope.projectId} AND c.corrects_entry_id IS NOT NULL`;
  return db
    .select()
    .from(usageEntries)
    .where(and(eq(usageEntries.tenantId, scope.tenantId), eq(usageEntries.projectId, scope.projectId), eq(usageEntries.runId, scope.runId), sql`${usageEntries.entryId} NOT IN (${corrected})`));
}

/** A total with its provenance. `value` is a decimal string; null means nothing known, never zero. */
export interface UsageFigure {
  readonly value: string | null;
  readonly provenance: UsageProvenance;
  /** Entries in this total whose value is unknown. Above zero, the total is partial and cannot read as `observed`. */
  readonly unavailableEntries: number;
}

export interface UsageSummary {
  readonly tokensByRole: Readonly<Record<string, Readonly<Record<TokenMetric, UsageFigure>>>>;
  readonly workerSeconds: {
    /** Every role on the host, integration and verification included. */
    readonly byHost: Readonly<Record<WorkerHost, Readonly<Record<WorkerTimeBasis, UsageFigure>>>>;
    /** Sum of the hosts. Billed and measured time stay separate. */
    readonly total: Readonly<Record<WorkerTimeBasis, UsageFigure>>;
    /** Measured time by phase. */
    readonly byPhase: Readonly<Record<WorkerPhase, UsageFigure>>;
    /** Measured time of these workers. Already inside the host totals, so it must not be added to them. */
    readonly integrationSubtotal: UsageFigure;
    readonly verificationSubtotal: UsageFigure;
  };
  readonly costUsd: UsageFigure;
  /** The bases of the known cost figures, sorted; `unknown` for a figure that states none. Empty when no cost is known. */
  readonly costBases: readonly string[];
}

function toScaled(quantity: string): bigint {
  const [whole, fraction = ''] = quantity.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

function fromScaled(scaled: bigint): string {
  const fraction = (scaled % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction === '' ? (scaled / SCALE).toString() : `${scaled / SCALE}.${fraction}`;
}

/** Sums exactly, in integer millionths. Worst provenance wins; a partial total is never `observed`. */
export function aggregateUsage(rows: readonly Pick<UsageEntryRow, 'quantity' | 'provenance'>[]): UsageFigure {
  let total = 0n;
  let known = 0;
  let unavailableEntries = 0;
  let estimated = false;
  for (const r of rows) {
    if (r.quantity === null || r.provenance === 'unavailable') {
      unavailableEntries += 1;
      continue;
    }
    total += toScaled(r.quantity);
    known += 1;
    if (r.provenance === 'estimated') estimated = true;
  }
  if (known === 0) return { value: null, provenance: 'unavailable', unavailableEntries };
  return { value: fromScaled(total), provenance: estimated || unavailableEntries > 0 ? 'estimated' : 'observed', unavailableEntries };
}

export function summarizeUsage(rows: readonly UsageEntryRow[]): UsageSummary {
  const of = (test: (r: UsageEntryRow) => boolean): UsageFigure => aggregateUsage(rows.filter(test));
  const time = (test: (r: UsageEntryRow) => boolean): UsageFigure => of((r) => r.metric === 'worker_seconds' && test(r));
  const measured = (test: (r: UsageEntryRow) => boolean): UsageFigure => time((r) => r.basis === 'measured' && test(r));
  const hostFigures = (host: WorkerHost): Record<WorkerTimeBasis, UsageFigure> => ({
    measured: measured((r) => r.host === host),
    billed: time((r) => r.basis === 'billed' && r.host === host),
  });
  const roles = [...new Set(rows.filter((r) => (TOKEN_METRICS as readonly string[]).includes(r.metric)).map((r) => r.role))].sort();
  return {
    tokensByRole: Object.fromEntries(roles.map((role) => [role, Object.fromEntries(TOKEN_METRICS.map((m) => [m, of((r) => r.role === role && r.metric === m)])) as Record<TokenMetric, UsageFigure>])),
    workerSeconds: {
      byHost: { local: hostFigures('local'), cloud: hostFigures('cloud') },
      total: { measured: measured(() => true), billed: time((r) => r.basis === 'billed') },
      byPhase: Object.fromEntries(WORKER_PHASES.map((p) => [p, measured((r) => r.phase === p)])) as Record<WorkerPhase, UsageFigure>,
      integrationSubtotal: measured((r) => r.role === INTEGRATION_ROLE),
      verificationSubtotal: measured((r) => r.role === VERIFICATION_ROLE),
    },
    costUsd: of((r) => r.metric === 'cost_usd'),
    costBases: [...new Set(rows.filter((r) => r.metric === 'cost_usd' && r.quantity !== null).map((r) => (typeof r.detail['costBasis'] === 'string' ? r.detail['costBasis'] : 'unknown')))].sort(),
  };
}

export const loadUsageSummary = async (db: Executor, scope: UsageRunScope): Promise<UsageSummary> => summarizeUsage(await readUsageEntries(db, scope));
