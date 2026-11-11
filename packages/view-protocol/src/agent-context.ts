import { BRAIN_DESTINATIONS, BrainBundleSchema, BrainClassificationSchema } from '@selarikru/domain';
import { z } from 'zod';

const Id = z.string().min(1);

/**
 * What a task's AI agents read in the browser (H4): the task's own words, its allowed paths and label, and the context bundle served for the call's destination.
 * `cloud` for any cloud-capable route, `local` only for a device-only one: a cloud bundle leaves out everything restricted, a local one may carry it and stays on the
 * device. Owner only. The adapter still reads the route fresh before the call; nothing here routes anything.
 *
 * `change` is the change a review or a PR description reads: a unified diff and each changed path's label. Null: the source has no change it can show in the browser,
 * and those steps are not offered. `spec` is the task's current spec, for the replan path (a criteria revision is a new revision of this spec). Absent: the source
 * has none to give, as in the demo.
 */
export const TaskAgentContextSchema = z.strictObject({
  taskId: Id,
  revision: z.number().int().min(1),
  runId: Id,
  /** The run's plan revision this was read at: a criteria revision sends it back as the expected revision. */
  planRevision: z.number().int().min(0),
  destination: z.enum(BRAIN_DESTINATIONS),
  task: z.strictObject({
    title: z.string().min(1),
    description: z.string().nullable(),
    criteria: z.array(z.strictObject({ id: Id, text: z.string().min(1) })),
    allowedPaths: z.array(z.string().min(1)),
    /** The strongest of the project's label, the spec's and every Brain source recorded for the task. */
    classification: BrainClassificationSchema,
  }),
  bundle: BrainBundleSchema,
  change: z.strictObject({ diff: z.string().min(1), files: z.array(z.strictObject({ path: z.string().min(1), classification: BrainClassificationSchema })) }).nullable(),
  spec: z.record(z.string(), z.unknown()).optional(),
  /** Demo data: never evidence. */
  simulated: z.boolean(),
}).superRefine((c, ctx) => {
  if (c.bundle.destination !== c.destination) ctx.addIssue({ code: 'custom', path: ['bundle', 'destination'], message: 'the bundle was served for another destination' });
  if (c.bundle.taskId !== c.taskId) ctx.addIssue({ code: 'custom', path: ['bundle', 'taskId'], message: 'the bundle is for another task' });
});
export type TaskAgentContext = z.infer<typeof TaskAgentContextSchema>;

/** A criteria proposal accepted through the replan path: the task's criteria, reworded by ID. IDs the task does not have are refused. */
export const CriteriaRevisionRequestSchema = z.strictObject({
  taskId: Id,
  expectedPlanRevision: z.number().int().min(0),
  idempotencyKey: Id,
  criteria: z.array(z.strictObject({ id: Id, text: z.string().trim().min(1).max(400) })).min(1),
});
export type CriteriaRevisionRequest = z.infer<typeof CriteriaRevisionRequestSchema>;

export const CriteriaRevisionResultSchema = z.strictObject({ planRevision: z.number().int().min(1), taskIds: z.array(Id), simulated: z.boolean() });
export type CriteriaRevisionResult = z.infer<typeof CriteriaRevisionResultSchema>;

/**
 * How big a task's agent input is for one destination, and whether it has a change: counts only, so the browser can size a step and say which steps it offers
 * without pulling the context (for a locked task, the local bundle) into the tab. Refused like the context when the route does not allow the destination.
 */
export const TaskContextSizeSchema = z.strictObject({
  taskId: Id,
  destination: z.enum(BRAIN_DESTINATIONS),
  hasChange: z.boolean(),
  inputChars: z.number().int().min(0),
});
export type TaskContextSize = z.infer<typeof TaskContextSizeSchema>;
