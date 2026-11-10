import { BrainClassificationSchema, BrainKeySchema, BrainRevisionRefSchema } from '@selarikru/domain';
import { z } from 'zod';
import { LeaseRefSchema } from './runner.ts';

/**
 * An owner's note for the Project Brain: data, never an instruction. It is stored as a `proposed` source, so it can support or dispute a claim but never becomes
 * accepted scope, and its label is never weaker than the project's.
 */
export const BrainNoteRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  sections: z.array(z.strictObject({ heading: z.string().trim().min(1).max(200), text: z.string().max(2000), key: BrainKeySchema.optional() })).min(1).max(50),
  /** Raised to the project's label when weaker. Absent: the project's label. */
  classification: BrainClassificationSchema.optional(),
  /** Sources this note repeats. A note made from another source adds no independent support. */
  derivedFrom: z.array(BrainRevisionRefSchema).max(20).optional(),
});
export type BrainNoteRequest = z.infer<typeof BrainNoteRequestSchema>;

export const BrainRevokeRequestSchema = z.strictObject({ reason: z.string().trim().min(1).max(200) });

/** A repository path: relative, no `..`, no backslash. */
const RepoPath = z.string().regex(/^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.-][A-Za-z0-9_./-]{0,199}$/, 'expected a relative repository path');

/**
 * What a runner read from its own checkout at the task's base commit: counts and hashes, and the hashes of a few named documents. Read with git, never by running anything
 * in the repository. Sent only for work whose data may leave the device.
 */
export const RepoManifestSchema = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  fileCount: z.number().int().min(0).max(10_000_000),
  totalBytes: z.number().int().min(0).max(1e13),
  docs: z.array(z.strictObject({ path: RepoPath, bytes: z.number().int().min(0).max(1e10), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).max(50),
});
export type RepoManifest = z.infer<typeof RepoManifestSchema>;

export const BrainManifestRequestSchema = z.strictObject({ lease: LeaseRefSchema, manifest: RepoManifestSchema });
