import { SkillBindingSchema, SkillIdSchema, SkillVersionIdSchema } from '@selarikru/domain';
import { z } from 'zod';
import { LeaseRefSchema } from './runner.ts';

/** Stage a third-party pack from a local directory the owner names. Read and scanned in place: nothing is fetched, installed or run. */
export const SkillIntakeRequestSchema = z.strictObject({ path: z.string().min(1).max(1024) });
/** An owner marks one exact version Reviewed. Findings the scan raised for review must be acknowledged by name of the version. */
export const SkillReviewRequestSchema = z.strictObject({ versionId: SkillVersionIdSchema, acknowledgeFindings: z.boolean() });
export const SkillRevokeRequestSchema = z.strictObject({ versionId: SkillVersionIdSchema, reason: z.string().min(1).max(200) });
/** Bind one skill to one reviewed version, or remove its binding (null), against the binding revision last read. */
export const SkillBindingRequestSchema = z.strictObject({ skillId: SkillIdSchema, expectedRevision: z.number().int().min(0), binding: SkillBindingSchema.nullable() });
export type SkillBindingRequest = z.infer<typeof SkillBindingRequestSchema>;

/** A runner's confirmation, after its own digest check and before the worker starts, that it materialized exactly these packs. Ids and digests only. */
export const SkillConfirmRequestSchema = z.strictObject({
  lease: LeaseRefSchema,
  packs: z.array(z.strictObject({ versionId: SkillVersionIdSchema, digest: z.string().regex(/^[0-9a-f]{64}$/) })).max(10),
});
export type SkillConfirmRequest = z.infer<typeof SkillConfirmRequestSchema>;

export { DeliveredSkillsSchema, DeliveredSkillPackSchema, verifyDeliveredPack, deliveredDigest, type DeliveredSkills, type DeliveredSkillPack } from '@selarikru/domain';
