import { BrainBundleSchema, BrainCompilationSchema, BrainProvenanceSchema, BrainRevocationSchema, BrainSourceRevisionSchema } from '@selarikru/domain';
import { z } from 'zod';

/** One source as the Brain view lists it: its latest revision's facts, never its text. */
export const BrainSourceSummarySchema = z.object({
  sourceId: z.string(),
  kind: z.string(),
  title: z.string(),
  standing: z.enum(['accepted', 'proposed']),
  classification: z.string(),
  allowedUse: z.array(z.string()),
  provenance: BrainProvenanceSchema,
  latestRevision: z.number().int().min(1),
  recordedAt: z.string(),
  revoked: z.boolean(),
  sectionCount: z.number().int().min(0),
}).strict();
export type BrainSourceSummary = z.infer<typeof BrainSourceSummarySchema>;

const Cited = z.object({ sourceId: z.string(), revision: z.number().int(), anchor: z.string(), text: z.string() }).strict();
export const BrainConflictViewSchema = z.object({
  conflictId: z.string(),
  key: z.string(),
  accepted: Cited,
  proposed: Cited,
  classification: z.string(),
  /** `open` waits for a person. `kept_accepted`: a person kept the accepted value. */
  state: z.enum(['open', 'kept_accepted']),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
}).strict();
export type BrainConflictView = z.infer<typeof BrainConflictViewSchema>;

/** The Project Brain as the server reports it: the latest compilation, the source library, revocations and conflicts. */
export const BrainViewSchema = z.object({
  projectId: z.string(),
  observedAt: z.string(),
  sourceHead: z.number().int().min(0),
  indexLag: z.number().int().min(0),
  compilation: BrainCompilationSchema.nullable(),
  sources: z.array(BrainSourceSummarySchema),
  revocations: z.array(BrainRevocationSchema),
  conflicts: z.array(BrainConflictViewSchema),
}).strict();
export type BrainView = z.infer<typeof BrainViewSchema>;

/** One stored revision, opened from a citation. */
export const BrainSourceRevisionViewSchema = BrainSourceRevisionSchema.extend({ revocation: BrainRevocationSchema.nullable() });
export type BrainSourceRevisionView = z.infer<typeof BrainSourceRevisionViewSchema>;

/** The context bundle one attempt received at claim, as recorded. */
export const AttemptContextViewSchema = z.object({
  attemptId: z.string(),
  taskId: z.string(),
  destination: z.enum(['local', 'cloud']),
  recordedAt: z.string(),
  bundle: BrainBundleSchema,
}).strict();
export type AttemptContextView = z.infer<typeof AttemptContextViewSchema>;

/** What a person can do in the Brain view. Neither changes accepted scope: revoking takes a source out of use, keeping settles a conflict in favour of what is accepted. */
export type BrainAction =
  | { readonly kind: 'revoke'; readonly sourceId: string; readonly reason: string }
  | { readonly kind: 'keep'; readonly conflictId: string };
