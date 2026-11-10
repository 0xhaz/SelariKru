import { StackActionSchema, StackDocumentSchema, type StackAction } from '@selarikru/domain';
import { z } from 'zod';

/** A project's stack settings as the server reports them. Metadata only: no credential, connection or command in effect is part of it. */
export const StackViewSchema = z.object({
  projectId: z.string(),
  /** Every write names the revision it was made against; a stale one is refused. */
  revision: z.number().int().min(0),
  catalogVersion: z.string(),
  document: StackDocumentSchema,
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** What runners report they can build natively. */
  native: z.object({ ios: z.boolean(), android: z.boolean() }).strict(),
}).strict();
export type StackView = z.infer<typeof StackViewSchema>;

export const StackActionRequestViewSchema = z.object({ expectedRevision: z.number().int().min(0), action: StackActionSchema }).strict();
export interface StackActionRequestView {
  readonly expectedRevision: number;
  readonly action: StackAction;
}
