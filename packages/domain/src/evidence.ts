import { z } from 'zod';
import { ActorSchema, Id, Sha256, SchemaVersion, Timestamp } from './common.ts';

/** A check's observed status. `skipped` stays `skipped`; `error` is a verifier-side problem, never a candidate verdict. */
export const CheckStatusSchema = z.enum(['passed', 'failed', 'skipped', 'error']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

/** One acceptance criterion (FB-ID) as observed in one verification run. */
export const CheckResultSchema = z
  .object({
    checkId: Id,
    status: CheckStatusSchema,
    tests: z.array(z.object({ runner: z.string(), title: z.string(), status: CheckStatusSchema }).strict()),
    failures: z.array(z.object({ test: z.string(), status: CheckStatusSchema, message: z.string() }).strict()),
    evidenceReferences: z.array(z.string()),
  })
  .strict();
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** One execution of the trusted suite. A retry is another entry; entries are never overwritten. */
export const VerificationRunSchema = z
  .object({
    attempt: z.number().int().min(1),
    startedAt: Timestamp,
    finishedAt: Timestamp,
    exitCode: z.number().int().nullable(),
    /** Set when the run produced no usable verdict (runner or Docker problem, or a result that does not match what was asked). */
    infrastructureError: z.string().nullable(),
    results: z.array(CheckResultSchema),
    resultArtifactId: Id.nullable(),
    logArtifactId: Id.nullable(),
  })
  .strict();
export type VerificationRun = z.infer<typeof VerificationRunSchema>;

/** What the verdict did to a part task. A task that is no longer `verifying` is only history: no state changes. */
export const TaskOutcomeSchema = z
  .object({
    taskId: Id,
    revision: z.number().int().min(1),
    applied: z.boolean(),
    taskStatus: z.string(),
    reason: z.string(),
  })
  .strict();
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;

/**
 * Verification record (architecture section 10). Bound to one exact candidate commit and the trusted manifest hash.
 * Only the verifier writes it. Any candidate change or new candidate invalidates it (the stored check runs become `invalidated`).
 */
export const VerificationRecordSchema = z
  .object({
    schemaVersion: SchemaVersion,
    recordId: Id,
    taskId: Id,
    runId: Id,
    /** Every task whose change set is part of the candidate. */
    partTaskIds: z.array(Id),
    candidateSha: Id,
    /** Git tree of the candidate commit. */
    candidateTreeSha: Id,
    /** Content hash of the exported directory the suite judged (same function as the runner's). */
    candidateContentSha256: Sha256,
    baseSha: Id,
    /** `artifactId@sha256` of each contract reference in the parts' task specs. */
    contractRevisions: z.array(Id),
    checkManifestSha256: Sha256,
    verifierSha256: Sha256,
    toolVersions: z.record(z.string(), z.string()),
    configVersions: z.record(z.string(), z.string()),
    environmentImageDigest: Id,
    /** Named verifier host. All modes of a benchmark cohort use the same one. */
    host: Id,
    fixtures: z.array(z.object({ path: z.string(), sha256: Sha256 }).strict()),
    startedAt: Timestamp,
    finishedAt: Timestamp,
    /** Overall result of the last run. `skipped` is never reported as passed; `error` is not a candidate failure. */
    result: z.enum(['passed', 'failed', 'skipped', 'error']),
    exitCode: z.number().int().nullable(),
    /** Per-FB-ID results of the last run. */
    results: z.array(CheckResultSchema),
    /** Every run, in order, including retries. */
    runs: z.array(VerificationRunSchema).min(1),
    /** Checks whose result differed between runs. A flaky retry stays visible. */
    flaky: z.array(Id),
    taskOutcomes: z.array(TaskOutcomeSchema),
    artifactIds: z.array(Id),
    verifier: ActorSchema,
  })
  .strict();
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;
