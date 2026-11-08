import { z } from 'zod';
import { ActorSchema, Id, Sha256, SchemaVersion, Timestamp } from './common.ts';

/** Minimum verification record (architecture section 10). T4.6 extends it. */
export const VerificationRecordSchema = z
  .object({
    schemaVersion: SchemaVersion,
    taskId: Id,
    runId: Id,
    candidateSha: Id,
    baseSha: Id,
    contractRevisions: z.array(Id),
    checkManifestSha256: Sha256,
    toolVersions: z.record(z.string(), z.string()),
    environmentImageDigest: Id,
    startedAt: Timestamp,
    finishedAt: Timestamp,
    /** A skipped check stays `skipped`; it is never reported as passed. */
    result: z.enum(['passed', 'failed', 'skipped']),
    exitCode: z.number().int().nullable(),
    artifactIds: z.array(Id),
    verifier: ActorSchema,
  })
  .strict();
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;
