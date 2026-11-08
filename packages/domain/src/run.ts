import { z } from 'zod';
import { Id, SchemaVersion } from './common.ts';

export const RUN_STATUSES = ['planning', 'running', 'blocked', 'ready_for_review', 'merged', 'failed', 'cancelled'] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Minimal FeatureRun shape. `merged` only after authoritative GitHub reconciliation. */
export const RunSchema = z
  .object({
    schemaVersion: SchemaVersion,
    projectId: Id,
    runId: Id,
    status: RunStatusSchema,
    planRevision: z.number().int().min(1),
  })
  .strict();
export type Run = z.infer<typeof RunSchema>;
