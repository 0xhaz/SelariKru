import { z } from 'zod';

/** A git commit id. Anything else (and so any secret-shaped string) is rejected rather than stored in an event. */
export const CommitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'expected a 40 or 64 digit hex commit id');
/** sha256 (lowercase hex) of the stored change manifest in the artifact store. */
const ManifestSha = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase hex sha256');
const Cost = z.number().finite().min(0).nullable().optional();

/** The runner presents only what it was given at claim. The API rebuilds the rest from the database. */
export const LeaseRefSchema = z
  .object({ attemptId: z.string().min(1), fence: z.number().int().min(0), leaseToken: z.string().min(1) })
  .strict();
export type LeaseRef = z.infer<typeof LeaseRefSchema>;

export const ClaimRequestSchema = z.object({}).strict();

export const HeartbeatRequestSchema = z.object({ lease: LeaseRefSchema }).strict();

export const ResultRequestSchema = z
  .object({
    lease: LeaseRefSchema,
    result: z.discriminatedUnion('outcome', [
      z.object({ outcome: z.literal('completed'), headSha: CommitSha.optional(), changeManifestSha256: ManifestSha.optional(), reportedCostUsd: Cost }).strict(),
      z.object({ outcome: z.literal('failed'), reason: z.string().min(1).max(500), reportedCostUsd: Cost }).strict(),
      z.object({ outcome: z.literal('blocked'), reason: z.string().min(1).max(500), reportedCostUsd: Cost }).strict(),
      z.object({ outcome: z.literal('approval_requested'), reason: z.string().min(1).max(500), reportedCostUsd: Cost }).strict(),
    ]),
  })
  .strict();
export type ResultRequest = z.infer<typeof ResultRequestSchema>;
