import { OutcomePlanContentSchema, OutcomeReviewContentSchema, ProblemBriefContentSchema, ReleaseNoteContentSchema } from '@selarikru/domain';
import { z } from 'zod';
import { LeaseRefSchema } from './runner.ts';

/** A label the owner may raise a record to. A record is never labelled below what it cites: the server takes the strongest. */
const RaiseLabel = z.enum(['public', 'internal', 'restricted']).optional();

/** Save the brief against the revision last read: as a draft (`confirm: false`, a proposal) or confirmed. Only an owner session can send this. */
export const ProductBriefRequestSchema = z.strictObject({
  expectedRevision: z.number().int().min(0), confirm: z.boolean(), content: ProblemBriefContentSchema, classification: RaiseLabel,
  /** The worker proposal the owner chose to start from, explicitly. Recorded with the revision; the proposal is then removed from the pending list. */
  fromProposalId: z.string().min(1).max(80).optional(),
});
export type ProductBriefRequest = z.infer<typeof ProductBriefRequestSchema>;
/** A new outcome plan (`recordId` null), or the next revision of one against the revision last read. */
export const OutcomePlanRequestSchema = z.strictObject({ recordId: z.string().min(1).max(80).nullable(), expectedRevision: z.number().int().min(0), content: OutcomePlanContentSchema, classification: RaiseLabel });
export const ReleaseNoteRequestSchema = z.strictObject({ content: ReleaseNoteContentSchema, classification: RaiseLabel });
export const OutcomeReviewRequestSchema = z.strictObject({ content: OutcomeReviewContentSchema, classification: RaiseLabel });
/** A worker's proposed brief, for the attempt it holds. Only ever a proposal: confirming one takes an owner. */
export const ProductBriefProposalRequestSchema = z.strictObject({ lease: LeaseRefSchema, content: ProblemBriefContentSchema });
