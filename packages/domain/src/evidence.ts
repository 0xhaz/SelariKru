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

/**
 * What the trusted runner writes (services/verifier/src/run.ts). The criteria subtree is strict: an unknown field or a malformed
 * entry makes the whole result unusable instead of being filtered out. Envelope objects tolerate extra fields the runner adds.
 */
export const RunnerResultSchema = z
  .object({
    verifier: z
      .object({
        manifestSha256: Sha256, verifierSha256: Sha256, image: z.string().min(1),
        tools: z.record(z.string(), z.string().nullable()).default({}),
      })
      .passthrough(),
    candidate: z.object({ treeSha256: Sha256 }).passthrough(),
    quality: z
      .object({
        allRequiredChecksPassed: z.boolean(),
        criteria: z.array(
          z
            .object({
              id: Id,
              status: CheckStatusSchema,
              evidenceReferences: z.array(z.string()),
              failures: z.array(z.object({ test: z.string(), status: CheckStatusSchema, message: z.string() }).strict()),
              tests: z.array(z.object({ runner: z.enum(['vitest', 'playwright']), title: z.string(), status: CheckStatusSchema }).strict()),
            })
            .strict(),
        ),
      })
      .passthrough(),
  })
  .passthrough();
export type RunnerResult = z.infer<typeof RunnerResultSchema>;

/**
 * How long after its last call a runner still counts as reachable: two lease expiries (60 s each), so a runner busy in one long request is not written off.
 * A longer silence means an enrolment that is probably gone, typically the old one left behind by a re-pair.
 */
export const RUNNER_RECENT_SECONDS = 120;

/** One observation of one criterion on one candidate, as `check_runs` holds it. Invalidated rows never reach this. */
export interface CriterionObservation {
  readonly checkRunId: string;
  readonly checkId: string;
  readonly checkVersion: string;
  readonly taskId: string;
  readonly revision: number;
  readonly attemptId: string | null;
  readonly recordId: string | null;
  /** The trusted-suite pass this row came from; a retry is a higher number. */
  readonly verificationAttempt: number;
  readonly candidateSha: string;
  readonly result: CheckStatus;
  readonly at: string;
}

export interface EvidenceTask {
  readonly taskId: string;
  readonly revision: number;
  readonly status: string;
  /** Requirement ids (FB-IDs) this task delivers, from its current spec. */
  readonly requirementIds: readonly string[];
}

export type CriterionState = CheckStatus | 'not_run' | 'not_delivered';

/** What each Feedback Board acceptance criterion asks for, as approved in the brief. A criterion outside this list simply has no description. */
const CRITERION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'FB-01': 'Create feedback with a trimmed title of 3 to 120 characters and an optional description',
  'FB-02': 'Reject invalid titles, oversized descriptions, wrong types and invalid statuses',
  'FB-03': 'List feedback newest first, breaking equal timestamps by item ID',
  'FB-04': 'New feedback starts Open; updates permit Open, Planned or Done',
  'FB-05': 'Filter by status; status counts describe the full dataset',
  'FB-06': 'Saved feedback and status survive a browser reload and an API restart',
  'FB-07': 'Loading, empty and failed states are usable; failed writes do not appear saved',
  'FB-08': 'Controls have accessible names, work from the keyboard and render text as text',
};
export const criterionDescription = (id: string): string | null => CRITERION_DESCRIPTIONS[id] ?? null;

export interface CriterionEvidence {
  readonly criterionId: string;
  readonly description: string | null;
  readonly state: CriterionState;
  /** Counted as verified: the same bar as opening a pull request (see `deriveRunEvidence`). */
  readonly verified: boolean;
  readonly taskIds: readonly string[];
  /** The observation shown, or null when no check has reported on this criterion or it was not delivered. */
  readonly check: Omit<CriterionObservation, 'candidateSha' | 'result'> | null;
  readonly candidateSha: string | null;
}

const WORSE: readonly CheckStatus[] = ['error', 'failed', 'skipped', 'passed'];
const FINISHED: readonly string[] = ['verified', 'merged'];

/**
 * Per-criterion evidence for one run. The denominator is the approved criteria: the requirement ids of its current tasks, so a task count can never stand in for them, and
 * stopping work never shrinks it. With no requirement ids the result is null. Only superseded work leaves: its requirements were replaced by the revised plan. A criterion that a
 * cancelled task carries, alone or shared, was not delivered, whether or not another task reached it.
 *
 * A criterion is verified only on the same bar as opening a pull request: a pass from the newest verification, on a candidate still live, under a record that is still valid, at the
 * revision each owing task is on now, and with every task carrying it `verified` or `merged`.
 */
export function deriveRunEvidence(input: { readonly tasks: readonly EvidenceTask[]; readonly observations: readonly CriterionObservation[]; readonly candidateSha: string | null; readonly candidateLive: boolean; readonly recordValid: boolean }): { readonly criteria: readonly CriterionEvidence[]; readonly verified: number; readonly total: number } | null {
  const owing = input.tasks.filter((t) => t.status !== 'superseded');
  const ids = [...new Set(owing.flatMap((t) => t.requirementIds))].sort();
  if (ids.length === 0) return null;
  const onCandidate = input.observations.filter((o) => o.candidateSha === input.candidateSha);
  const criteria = ids.map((criterionId): CriterionEvidence => {
    const carriers = owing.filter((t) => t.requirementIds.includes(criterionId));
    const taskIds = carriers.map((t) => t.taskId);
    const base = { criterionId, description: criterionDescription(criterionId), taskIds };
    if (carriers.some((t) => t.status === 'cancelled')) return { ...base, state: 'not_delivered', verified: false, check: null, candidateSha: null };
    // The newest observation per task carrying it: a later suite pass replaces an earlier one, and an earlier task revision says nothing about this one.
    const newest = carriers.map((t) => onCandidate.filter((o) => o.checkId === criterionId && o.taskId === t.taskId && o.revision === t.revision)
      .sort((a, b) => b.at.localeCompare(a.at) || b.verificationAttempt - a.verificationAttempt)[0]);
    const seen = newest.filter((o): o is CriterionObservation => o !== undefined);
    if (seen.length === 0) return { ...base, state: 'not_run', verified: false, check: null, candidateSha: null };
    const shown = [...seen].sort((a, b) => WORSE.indexOf(a.result) - WORSE.indexOf(b.result))[0]!;
    const { candidateSha, result, ...check } = shown;
    const verified = input.candidateLive && input.recordValid && carriers.every((t) => FINISHED.includes(t.status)) && seen.length === carriers.length && seen.every((o) => o.result === 'passed');
    return { ...base, state: result, verified, check, candidateSha };
  });
  return { criteria, verified: criteria.filter((c) => c.verified).length, total: criteria.length };
}
