import { z } from 'zod';

/**
 * Which provider and model a worker uses. An assignment is by role, with an optional per-task override, and is copied onto each attempt at claim:
 * the attempt's record is what the harness receives. These are identifiers only; no credential ever belongs here.
 */
const Ident = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'expected an identifier');

export const ModelSelectionSchema = z.object({ provider: Ident, model: Ident }).strict();
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

/** Where a worker's model calls go: the attempt's recorded inference route. `unknown` stays unknown and never reads as device. `none`: the worker makes no model call (apply_proposal). */
export const MODEL_ROUTES = ['device', 'cloud', 'unknown', 'none'] as const;
export type ModelRoute = (typeof MODEL_ROUTES)[number];

export const ASSIGNMENT_SCOPES = ['role', 'task'] as const;
export type AssignmentScope = (typeof ASSIGNMENT_SCOPES)[number];

/** How an attempt came to use a model. `trial_pin`: a benchmark trial's single pinned model, which refuses overrides. `proposal`: the owner accepted a patch proposal, applied with no model. */
export const ASSIGNMENT_SOURCES = ['task', 'role', 'default', 'trial_pin', 'proposal'] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

/** The assignment as recorded on an attempt. */
export const RecordedAssignmentSchema = z
  .object({ provider: Ident, model: Ident, source: z.enum(ASSIGNMENT_SOURCES), route: z.enum(MODEL_ROUTES) })
  .strict();
export type RecordedAssignment = z.infer<typeof RecordedAssignmentSchema>;

/** A list price per million tokens, as `source` publishes it. A list price is never an observed cost. */
export interface ModelRate {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly source: string;
}

export interface CatalogModel {
  readonly id: string;
  readonly label: string;
  readonly route: ModelRoute;
  /** Null when no rate is known. The budget hold then stays conservative. */
  readonly rate: ModelRate | null;
}

/** What one harness adapter declares for itself. */
export interface CatalogProvider {
  readonly provider: string;
  readonly label: string;
  readonly harnessVersion: string | null;
  readonly models: readonly CatalogModel[];
  /** The adapter's declared capability to run a chosen model. Anything but `supported` means the model cannot be honoured, so it is refused before launch. */
  readonly modelSelection: 'supported' | 'partial' | 'unsupported' | 'not established';
}

export const CATALOG_STATUSES = ['detected', 'none', 'unknown'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

/** Which adapters and models exist. Built from what this build declares, narrowed by runner reports (`availableCatalog`). `none`: nothing to offer. `unknown`: not established. Either way nothing is offered. */
export interface HarnessCatalog {
  readonly status: CatalogStatus;
  readonly detail: string | null;
  readonly providers: readonly CatalogProvider[];
}

export const NO_HARNESS_CATALOG: HarnessCatalog = { status: 'unknown', detail: 'No harness catalog was provided to this process.', providers: [] };

/** Typed reasons a selection cannot be used. Each is a stable code the screen can explain. */
export const MODEL_REFUSAL_REASONS = ['no_provider_detected', 'unsupported_provider', 'unsupported_model', 'model_not_allowed', 'model_not_assigned', 'trial_model_not_pinned', 'model_not_on_runner', 'restricted_requires_device_model', 'model_route_unknown'] as const;
export type ModelRefusalReason = (typeof MODEL_REFUSAL_REASONS)[number];

/** What a runner says it can launch, probed on the runner's own machine. Identifiers and a version only. Absent or empty means it can run nothing. */
export const RunnerHarnessReportSchema = z
  .object({ provider: Ident, harnessVersion: z.string().regex(/^\d+\.\d+\.\d+$/).nullable(), models: z.array(Ident).max(100) })
  .strict();
export type RunnerHarnessReport = z.infer<typeof RunnerHarnessReportSchema>;

/**
 * What the declared adapters can do, narrowed to what runners report. The result is what may be offered or launched. A version here is the runner's, never the control plane's.
 * `declared` says which adapters this build knows; only a report says one is installed anywhere.
 */
export function availableCatalog(declared: HarnessCatalog, reports: readonly RunnerHarnessReport[]): HarnessCatalog {
  if (declared.status !== 'detected') return declared;
  const providers = declared.providers.flatMap((p) => {
    const mine = reports.filter((r) => r.provider === p.provider);
    const models = p.models.filter((m) => mine.some((r) => r.models.includes(m.id)));
    if (models.length === 0) return [];
    const versions = [...new Set(mine.map((r) => r.harnessVersion))];
    return [{ ...p, models, harnessVersion: versions.length === 1 ? (versions[0] ?? null) : null }];
  });
  return providers.length > 0 ? { status: 'detected', detail: null, providers } : { status: 'none', detail: 'No runner has reported an installed harness, so no model can be assigned or started.', providers: [] };
}

export const findCatalogModel = (catalog: HarnessCatalog, s: ModelSelection): { provider: CatalogProvider; model: CatalogModel } | { provider: CatalogProvider | null; model: null } => {
  const provider = catalog.providers.find((p) => p.provider === s.provider) ?? null;
  const model = provider?.models.find((m) => m.id === s.model) ?? null;
  return provider && model ? { provider, model } : { provider, model: null };
};
