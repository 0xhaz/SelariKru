import {
  MilestoneSummarySchema, OutcomePlanContentSchema, OutcomeReviewContentSchema, PRODUCT_DECISIONS, ProblemBriefContentSchema, ProductRecordSchema, ReleaseNoteContentSchema, TraceRowSchema,
} from '@selarikru/domain';
import { z } from 'zod';

/**
 * The project's product-learning records as the server reports them (docs/product-engineer-alignment.md §4): the brief (confirmed and latest), outcome plans, release notes,
 * outcome reviews and their follow-up proposals, the trace from each accepted requirement to its outcome, and the per-run milestone summaries. Derived by the domain code.
 */
export const ProductViewSchema = z.object({
  projectId: z.string(),
  observedAt: z.string(),
  /** What creating a brief does not authorize. */
  notice: z.string(),
  brief: z.object({
    confirmed: ProductRecordSchema.nullable(),
    latest: ProductRecordSchema.nullable(),
    /** What a new revision starts from: the latest revision, or a draft from the onboarding brief. Null: nothing to start from. */
    seed: ProblemBriefContentSchema.nullable(),
    /** The latest revision, for the next save. 0: none yet. Workers' proposals never move it. */
    revision: z.number().int().min(0),
    /** Workers' proposed briefs, newest first. Shown beside the brief; used only when the owner chooses one. */
    proposals: z.array(z.object({ proposalId: z.string(), proposedBy: z.object({ kind: z.literal('worker'), id: z.string() }), attemptId: z.string(), proposedAt: z.string(), classification: z.string(), content: ProblemBriefContentSchema })).default([]),
    /** Proposals dropped because newer ones passed the cap. */
    droppedProposals: z.number().int().min(0).default(0),
    proposalCap: z.number().int().min(1).default(5),
  }),
  plans: z.array(ProductRecordSchema),
  releases: z.array(ProductRecordSchema),
  reviews: z.array(ProductRecordSchema),
  /** Follow-ups reviews suggested. Proposals only: each enters a plan through a plan revision, never by itself. */
  followUps: z.array(z.object({ reviewRecordId: z.string(), title: z.string(), requirementIds: z.array(z.string()), reason: z.string(), decision: z.enum(PRODUCT_DECISIONS), state: z.literal('proposed') })),
  requirements: z.array(z.object({ id: z.string(), text: z.string().nullable() })),
  /** Runs a person merged, for a release note. */
  mergedRuns: z.array(z.object({ runId: z.string(), prNumber: z.number().int(), mergeCommitSha: z.string(), released: z.boolean() })),
  /** Evidence a brief or review can cite: Brain source revisions and anchors. */
  citable: z.array(z.object({ sourceId: z.string(), revision: z.number().int().min(1), anchor: z.string(), label: z.string(), classification: z.string() })).default([]),
  trace: z.array(TraceRowSchema),
  milestones: z.array(MilestoneSummarySchema),
});
export type ProductView = z.infer<typeof ProductViewSchema>;

const RaiseLabel = z.enum(['public', 'internal', 'restricted']).optional();
/** One owner write. Answers with the product view as it is afterwards. */
export const ProductActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('save_brief'), expectedRevision: z.number().int().min(0), confirm: z.boolean(), content: ProblemBriefContentSchema, classification: RaiseLabel, fromProposalId: z.string().optional() }),
  z.object({ kind: z.literal('save_plan'), recordId: z.string().nullable(), expectedRevision: z.number().int().min(0), content: OutcomePlanContentSchema, classification: RaiseLabel }),
  z.object({ kind: z.literal('add_release'), content: ReleaseNoteContentSchema, classification: RaiseLabel }),
  z.object({ kind: z.literal('add_review'), content: OutcomeReviewContentSchema, classification: RaiseLabel }),
]);
export type ProductAction = z.infer<typeof ProductActionSchema>;

/** What a write answers: the records afterwards, and whether the server redacted secret-shaped text before storing it. */
export interface ProductActionResult { readonly product: ProductView; readonly redacted: boolean }
