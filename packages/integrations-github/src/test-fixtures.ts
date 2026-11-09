import { VerificationRecordSchema, type VerificationRecord } from '@selarikru/domain';
import { schema, type Db } from '@selarikru/persistence';
import { eq, and, sql } from 'drizzle-orm';
import { PROJECT, RUN, TENANT, seedTask, specFor } from '@selarikru/workflow/test-helpers';

export { PROJECT, RUN, TENANT };
export const SHA = 'a'.repeat(40);
export const BASE = 'b'.repeat(40);
export const REPO = 'acme/feedback-board';
export const T0 = new Date('2026-11-09T02:00:00Z');

export function record(over: Partial<VerificationRecord> = {}): VerificationRecord {
  return VerificationRecordSchema.parse({
    schemaVersion: 1, recordId: 'rec_1', taskId: 'task_a', runId: RUN, partTaskIds: ['task_a', 'task_b'], candidateSha: SHA, candidateTreeSha: 'c'.repeat(40),
    candidateContentSha256: 'd'.repeat(64), baseSha: BASE, contractRevisions: [], checkManifestSha256: 'e'.repeat(64), verifierSha256: '1'.repeat(64),
    toolVersions: {}, configVersions: {}, environmentImageDigest: 'sha256:img', host: 'local-docker', fixtures: [],
    startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z', result: 'passed', exitCode: 0,
    results: [
      { checkId: 'FB-01', status: 'passed', tests: [{ runner: 'vitest', title: 'creates a post', status: 'passed' }], failures: [], evidenceReferences: [] },
      { checkId: 'FB-02', status: 'passed', tests: [{ runner: 'playwright', title: 'lists posts', status: 'passed' }], failures: [], evidenceReferences: [] },
    ],
    runs: [{ attempt: 1, startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:01:00Z', exitCode: 0, infrastructureError: null, results: [], resultArtifactId: null, logArtifactId: null }],
    flaky: [], taskOutcomes: [], artifactIds: [], verifier: { kind: 'verifier', id: 'verifier-local-1' },
    ...over,
  });
}

/** A run that is ready for review with an assembled candidate and two verified tasks. */
export async function seedReadyRun(db: Db, over: { trial?: boolean; defaultBranch?: string; lifecycle?: string; taskStatus?: string } = {}): Promise<void> {
  await db.update(schema.projects).set({ repository: REPO, defaultBranch: over.defaultBranch ?? 'main' }).where(eq(schema.projects.projectId, PROJECT));
  await db.update(schema.runs).set({ lifecycle: over.lifecycle ?? 'ready_for_review', trial: over.trial ?? false }).where(and(eq(schema.runs.projectId, PROJECT), eq(schema.runs.runId, RUN)));
  for (const id of ['task_a', 'task_b']) await seedTask(db, specFor(id, { baseSha: BASE }), over.taskStatus ?? 'verified');
  await db.insert(schema.candidates).values({ tenantId: TENANT, projectId: PROJECT, candidateId: 'cand_1', runId: RUN, target: 'main', sha: SHA, baseSha: BASE, treeSha: 'c'.repeat(40), status: 'assembled' });
}

export const q = async (db: Db, text: string): Promise<Record<string, unknown>[]> => [...(await db.execute(sql.raw(text)))];

export async function setRun(db: Db, set: { lifecycle?: string; trial?: boolean }): Promise<void> {
  await db.update(schema.runs).set(set).where(and(eq(schema.runs.projectId, PROJECT), eq(schema.runs.runId, RUN)));
}
export async function setDefaultBranch(db: Db, defaultBranch: string): Promise<void> {
  await db.update(schema.projects).set({ defaultBranch }).where(eq(schema.projects.projectId, PROJECT));
}
