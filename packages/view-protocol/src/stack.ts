import { StackActionSchema, StackDocumentSchema, type StackAction } from '@selarikru/domain';
import { z } from 'zod';

/** A project's stack settings as the server reports them. Metadata only: no credential, connection or command in effect is part of it. */
export const StackViewSchema = z.object({
  projectId: z.string(),
  /** Every owner write names the revision it was made against; a stale one is refused. */
  revision: z.number().int().min(0),
  /** Rises with each stored detection, separately from the owner's revision. */
  detectionRevision: z.number().int().min(0),
  /** The stored document could not be read by this build: it is shown as empty and every write is refused. */
  unreadable: z.boolean(),
  catalogVersion: z.string(),
  document: StackDocumentSchema,
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** What runners report they can build natively. */
  native: z.object({ ios: z.boolean(), android: z.boolean() }).strict(),
  /** Reviewed, pinned knowledge packs bound to the project, with the stack entries their triggers name. Absent from an older server: none. */
  skills: z.array(z.object({ name: z.string(), version: z.string(), entries: z.array(z.string()) }).strict()).default([]),
}).strict();
export type StackView = z.infer<typeof StackViewSchema>;

export const StackActionRequestViewSchema = z.object({ expectedRevision: z.number().int().min(0), action: StackActionSchema }).strict();
export interface StackActionRequestView {
  readonly expectedRevision: number;
  readonly action: StackAction;
}
