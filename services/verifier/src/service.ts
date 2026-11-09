/**
 * Verification service (docs/architecture.md section 10; section 6 rules).
 *
 * Runs the trusted suite against one exact assembled candidate and records evidence that only the verifier identity can
 * produce. It runs on the host that drives Docker; the suite runs inside the pinned verifier image through `scripts/docker-verify.sh`.
 *
 * - The candidate is taken by SHA from the `candidates` table. Exactly that commit's tree is exported (blob by blob, straight from
 *   git objects: no archive attributes, no filters, no symlinks) into a fresh directory that the Docker script mounts read-only. The result path is a
 *   different fresh directory outside the candidate, and the verdict comes only from the runner's output, never from a file inside the
 *   candidate, so the candidate has no way to write evidence.
 * - The result is accepted only if it names the trusted manifest hash, the verifier hash, the pinned image and the content hash of
 *   the tree that was exported. Anything else is an infrastructure `error`, never a candidate verdict.
 * - A record is bound to the candidate SHA. Assembling a different candidate invalidates it (integrate.ts marks its check runs
 *   `invalidated`); `loadValidRecord` only returns records whose candidate and check runs are still live.
 *
 * Imports are relative on purpose: the verifier image installs only this package. This file is never loaded by the runner.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactStore } from '../../../packages/artifacts/src/index.ts';
import { RunnerResultSchema, VerificationRecordSchema, TaskSpecSchema, type Actor, type CheckResult, type CheckStatus, type TaskOutcome, type VerificationRecord, type VerificationRun } from '../../../packages/domain/src/index.ts';
import { appendUsage, schema, sql, VERIFICATION_ROLE, withTx, type Db, type Tx } from '../../../packages/persistence/src/index.ts';
import { redactSecrets } from '../../../packages/protocol/src/redact.ts';
import { applyVerification, markRunReadyForReview } from '../../workflow/src/verification.ts';
import { loadLatestAppliedRecord, validRecordOf } from '../../workflow/src/verification-record.ts';
import { hashTree, sha256, verifierHashes } from './hashing.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '../..');
const suiteDir = join(pkgRoot, 'suites/feedback-board');

const DEFAULT_LOG_LIMIT = 64 * 1024;
const MESSAGE_LIMIT = 2000;
const FULL_SHA = /^[0-9a-f]{40}$/;
const gitEnv = { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

export class CandidateNotVerifiable extends Error {
  constructor(readonly reason: 'not_found' | 'not_assembled' | 'lease_held' | 'lease_lost' | 'task_not_in_candidate' | 'invalid_request' | 'export_failed', message: string) {
    super(message);
  }
}

export interface RunnerInput {
  /** Export of the candidate (mounted read-only into the image). */
  readonly candidateDir: string;
  /** A path in a verifier-owned directory outside the candidate. */
  readonly resultsPath: string;
}
export interface RunnerOutput {
  readonly exitCode: number | null;
  /** The parsed result file, or null when the runner produced none. */
  readonly result: unknown | null;
  readonly log: string;
}
export type VerifierRunner = (input: RunnerInput) => Promise<RunnerOutput>;

export interface CandidateRef {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly sha: string;
  /** The task this verification is recorded for. It must be a part of the candidate. */
  readonly taskId: string;
  /** Local source repository holding the candidate ref. */
  readonly repoPath: string;
}

export interface VerificationDeps {
  readonly db: Db;
  readonly artifacts: ArtifactStore;
  readonly runner: VerifierRunner;
  /** Must be a `verifier` principal. */
  readonly verifier: Actor;
  /** Named verifier host, recorded on every record. All modes of a benchmark cohort use the same one. */
  readonly host: string;
  readonly now?: () => Date;
  readonly workRoot?: string;
  /** Extra runs after a run with failed checks. Every run is kept. Default 0. */
  readonly flakyRetries?: number;
  readonly logLimitBytes?: number;
  /** The per-candidate verification lease. Renewed during the run, so a crash frees the candidate within this window. Default `VERIFICATION_LEASE_SECONDS`. */
  readonly leaseSeconds?: number;
}

/** Short, because a live run renews it every third of its length: a crash blocks the candidate only this long. */
export const VERIFICATION_LEASE_SECONDS = 120;

/** A part must still be this revision and in one of these states for a verdict on the candidate to mean anything. */
export const LIVE_PART_STATUSES: readonly string[] = ['verifying', 'verified', 'merged'];

/** The host this build verifies on until the cloud backend exists. */
export const LOCAL_DOCKER_HOST = 'local-docker';

/** Content hash of an exported candidate: the same function and exclusions the runner applies to its copy. */
export function candidateContentHash(dir: string): string {
  return hashTree(dir, { exclude: (rel) => { const n = basename(rel); return n === 'dist' || n === '.git' || /\.sqlite(-wal|-shm)?$/.test(n); } });
}

function run(cmd: string, args: string[], opts: { cwd?: string; input?: Buffer; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: gitEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (b: Buffer) => out.push(b));
    p.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-4000); });
    p.once('error', rej);
    p.once('close', (code) => res({ code, stdout: Buffer.concat(out), stderr: err }));
    p.stdin.on('error', () => undefined);
    p.stdin.end(opts.input);
  });
}

/** Writes exactly the blobs of `sha`'s tree. Symlinks and submodules are dropped, as the runner would drop them. */
async function exportTree(repoPath: string, sha: string, treeSha: string, dest: string): Promise<void> {
  const fail = (m: string) => new CandidateNotVerifiable('export_failed', m);
  const tree = await run('git', ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`], { cwd: repoPath });
  if (tree.code !== 0 || tree.stdout.toString().trim() !== treeSha) throw fail('the candidate commit is missing from the repository or its tree differs from the recorded tree');
  const ls = await run('git', ['ls-tree', '-r', '-z', '--full-tree', sha], { cwd: repoPath });
  if (ls.code !== 0) throw fail(`git ls-tree failed: ${ls.stderr}`);
  const entries = ls.stdout.toString('utf8').split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    return { mode: mode!, type: type!, oid: oid!, path: line.slice(tab + 1) };
  }).filter((e) => e.type === 'blob' && e.mode !== '120000');
  const batch = await run('git', ['cat-file', '--batch'], { cwd: repoPath, input: Buffer.from(entries.map((e) => `${e.oid}\n`).join('')) });
  if (batch.code !== 0) throw fail(`git cat-file failed: ${batch.stderr}`);
  let at = 0;
  const base = resolve(dest);
  for (const e of entries) {
    const nl = batch.stdout.indexOf(10, at);
    const [oid, kind, size] = batch.stdout.subarray(at, nl).toString().split(' ');
    if (oid !== e.oid || kind !== 'blob') throw fail('unexpected git object');
    const start = nl + 1;
    const end = start + Number(size);
    const target = resolve(base, e.path);
    if (!target.startsWith(base + sep)) throw fail(`path escapes the export: ${e.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, batch.stdout.subarray(start, end));
    await chmod(target, e.mode === '100755' ? 0o755 : 0o644);
    at = end + 1;
  }
}

const clip = (s: string, n = MESSAGE_LIMIT): string => (s.length > n ? `${s.slice(0, n)}...[truncated]` : s);

function boundedLog(log: string, limit: number): string {
  const redacted = redactSecrets(log);
  const bytes = Buffer.from(redacted);
  return bytes.length <= limit ? redacted : `[log truncated to the last ${limit} bytes]\n${bytes.subarray(bytes.length - limit).toString()}`;
}

interface Expected { manifestSha: string; verifierSha: string; image: string; contentSha: string; criteria: string[] }
interface Evaluated { status: CheckStatus; results: CheckResult[]; infrastructureError: string | null; tools: Record<string, string> }

/** Turns the runner's raw result into per-FB results, or an infrastructure error when it does not match what was asked. */
function evaluate(out: RunnerOutput, want: Expected): Evaluated {
  const unusable = (reason: string): Evaluated => ({
    status: 'error', infrastructureError: clip(reason), tools: {},
    results: want.criteria.map((checkId) => ({ checkId, status: 'error', tests: [], failures: [{ test: '(verifier)', status: 'error', message: clip(reason) }], evidenceReferences: [] })),
  });
  if (out.result === null || typeof out.result !== 'object') return unusable(`the runner produced no result (exit ${out.exitCode ?? 'none'})`);
  const parsed = RunnerResultSchema.safeParse(out.result);
  if (!parsed.success) return unusable(`the result is malformed: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const r = parsed.data;
  if (r.verifier.manifestSha256 !== want.manifestSha) return unusable('the result names a different trusted manifest hash');
  if (r.verifier.verifierSha256 !== want.verifierSha) return unusable('the result names a different verifier hash');
  if (r.verifier.image !== want.image) return unusable('the result was not produced in the pinned verifier image');
  if (r.candidate.treeSha256 !== want.contentSha) return unusable('the result judged a different candidate tree than the one exported');
  const criteria = r.quality.criteria;
  const ids = criteria.map((c) => c.id);
  if (ids.length !== want.criteria.length || new Set(ids).size !== ids.length || !want.criteria.every((id) => ids.includes(id))) return unusable('the result does not cover exactly the trusted criteria');
  const results: CheckResult[] = want.criteria.map((id) => {
    const c = criteria.find((x) => x.id === id)!;
    return {
      checkId: id, status: c.status, tests: c.tests,
      failures: c.failures.map((f) => ({ ...f, message: clip(redactSecrets(f.message)) })),
      evidenceReferences: c.evidenceReferences,
    };
  });
  const has = (x: CheckStatus) => results.some((y) => y.status === x);
  const status: CheckStatus = has('error') ? 'error' : has('failed') ? 'failed' : has('skipped') ? 'skipped' : 'passed';
  // The runner exits 0 exactly when every required check passed. A disagreement is a broken run, not a verdict.
  if (status === 'passed' && (out.exitCode !== 0 || !r.quality.allRequiredChecksPassed)) return unusable(`all checks report passed but the run exited ${out.exitCode ?? 'without a code'} (allRequiredChecksPassed=${r.quality.allRequiredChecksPassed})`);
  if (status !== 'passed' && out.exitCode === 0) return unusable('the run exited 0 although a check did not pass');
  const tools = Object.fromEntries(Object.entries(r.verifier.tools).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return { status, results, infrastructureError: null, tools };
}

async function readFixtures(fixtures: string | undefined): Promise<{ path: string; sha256: string }[]> {
  if (!fixtures) return [];
  const p = join(suiteDir, fixtures);
  return [{ path: fixtures, sha256: (await lstat(p)).isDirectory() ? hashTree(p) : sha256(await readFile(p)) }];
}

/**
 * Verifies one assembled candidate and stores the record. See the file comment. Throws `CandidateNotVerifiable` when the SHA is not a
 * live assembled candidate, and an `Error` when the deps do not carry a verifier principal. Runner failures never throw: they become
 * a record with result `error`.
 */
export async function verifyCandidate(candidate: CandidateRef, deps: VerificationDeps): Promise<VerificationRecord> {
  if (deps.verifier.kind !== 'verifier') throw new Error('verification evidence can only be written by a verifier principal');
  if (!FULL_SHA.test(candidate.sha)) throw new CandidateNotVerifiable('invalid_request', 'a full candidate commit id is required');
  const now = deps.now ?? (() => new Date());
  const logLimit = deps.logLimitBytes ?? DEFAULT_LOG_LIMIT;

  const rows = await deps.db.execute(sql`
    SELECT status, base_sha, tree_sha, parts, detail FROM candidates
    WHERE tenant_id = ${candidate.tenantId} AND project_id = ${candidate.projectId} AND run_id = ${candidate.runId} AND sha = ${candidate.sha}`);
  const row = rows[0];
  if (!row) throw new CandidateNotVerifiable('not_found', 'no such candidate');
  if (row['status'] !== 'assembled') throw new CandidateNotVerifiable('not_assembled', `the candidate is ${String(row['status'])}`);
  const parts = (row['parts'] as { taskId: string; revision: number; attemptId: string }[]) ?? [];
  // An owner's re-verification of finished work: a failed verdict stops there and asks the owner, it does not start a repair worker.
  const reverification = (row['detail'] as { reverification?: unknown } | null)?.reverification !== undefined;
  if (!parts.some((p) => p.taskId === candidate.taskId)) throw new CandidateNotVerifiable('task_not_in_candidate', 'the task is not a part of this candidate');
  const baseSha = String(row['base_sha']);
  const treeSha = String(row['tree_sha']);
  const holder = `verify:${randomUUID()}`;
  const leaseSeconds = deps.leaseSeconds ?? VERIFICATION_LEASE_SECONDS;
  const candKey = sql`tenant_id = ${candidate.tenantId} AND project_id = ${candidate.projectId} AND run_id = ${candidate.runId} AND sha = ${candidate.sha}`;
  // One verification per candidate at a time: otherwise two runs can disagree about the same SHA.
  const taken = await deps.db.execute(sql`
    UPDATE candidates SET detail = jsonb_set(detail, '{verification}', jsonb_build_object('holder', ${holder}::text, 'expiresAt', ${new Date(now().getTime() + leaseSeconds * 1000).toISOString()}::text))
    WHERE ${candKey} AND status = 'assembled'
      AND (detail -> 'verification' IS NULL OR (detail -> 'verification' ->> 'expiresAt')::timestamptz <= ${now().toISOString()}::timestamptz)
    RETURNING 1`);
  if (taken.length === 0) throw new CandidateNotVerifiable('lease_held', 'another verification holds this candidate');

  // Renewal stops at the first sign the lease is gone; the fence at record write is what actually protects the evidence.
  const scratch: string[] = [];
  const renewer = setInterval(() => {
    void deps.db.execute(sql`
      UPDATE candidates SET detail = jsonb_set(detail, '{verification,expiresAt}', to_jsonb(${new Date(now().getTime() + leaseSeconds * 1000).toISOString()}::text))
      WHERE ${candKey} AND detail -> 'verification' ->> 'holder' = ${holder}`).catch(() => undefined);
  }, Math.max(1, (leaseSeconds * 1000) / 3));
  renewer.unref();
  try {
    const manifestBytes = await readFile(join(suiteDir, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString());
    const hashes = verifierHashes(pkgRoot, repoRoot);
    const fixtures = await readFixtures(manifest.fixtures);

    const contractRevisions = new Set<string>();
    for (const p of parts) {
      const r = await deps.db.execute(sql`SELECT spec FROM task_revisions WHERE tenant_id = ${candidate.tenantId} AND project_id = ${candidate.projectId} AND task_id = ${p.taskId} AND revision = ${p.revision}`);
      const spec = r[0] ? TaskSpecSchema.safeParse(r[0]['spec']) : null;
      if (spec?.success) for (const c of spec.data.contractRefs) contractRevisions.add(`${c.artifactId}@${c.sha256}`);
    }

    const parent = deps.workRoot ?? join(tmpdir(), 'selarikru-verify');
    await mkdir(parent, { recursive: true });
    const candidateDir = await mkdtemp(join(parent, 'verify-cand-'));
    scratch.push(candidateDir);
    const outDir = await mkdtemp(join(parent, 'verify-out-'));
    scratch.push(outDir);
    const recordId = `ver_${randomUUID()}`;
    const runs: VerificationRun[] = [];
    const pending: { type: string; id: string; sha256: string; locator: Record<string, unknown> }[] = [];
    let tools: Record<string, string> = {};
    await exportTree(candidate.repoPath, candidate.sha, treeSha, candidateDir);
    const want: Expected = {
      manifestSha: sha256(manifestBytes), verifierSha: hashes.verifierSha256, image: manifest.tools.playwrightImage,
      contentSha: candidateContentHash(candidateDir), criteria: manifest.criteria.map((c: { id: string }) => c.id),
    };

    const attempts = 1 + Math.max(0, deps.flakyRetries ?? 0);
    for (let n = 1; n <= attempts; n += 1) {
      const startedAt = now();
      const resultsPath = join(outDir, `result-${n}.json`);
      let out: RunnerOutput;
      try {
        out = await deps.runner({ candidateDir, resultsPath });
      } catch (e) {
        out = { exitCode: null, result: null, log: `runner failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      const ev = evaluate(out, want);
      tools = { ...tools, ...ev.tools };
      const logRef = await deps.artifacts.put(Buffer.from(boundedLog(out.log, logLimit)));
      const resultRef = await deps.artifacts.put(Buffer.from(JSON.stringify({ attempt: n, status: ev.status, infrastructureError: ev.infrastructureError, results: ev.results }, null, 2)));
      const logArtifactId = `art_${randomUUID()}`;
      const resultArtifactId = `art_${randomUUID()}`;
      pending.push({ type: 'verification_log', id: logArtifactId, sha256: logRef.sha256, locator: { recordId, attempt: n, size: logRef.size } });
      pending.push({ type: 'verification_result', id: resultArtifactId, sha256: resultRef.sha256, locator: { recordId, attempt: n, size: resultRef.size } });
      runs.push({ attempt: n, startedAt: startedAt.toISOString(), finishedAt: now().toISOString(), exitCode: out.exitCode, infrastructureError: ev.infrastructureError, results: ev.results, resultArtifactId, logArtifactId });
      if (ev.status !== 'failed') break; // only failed checks are retried; passed, skipped and error end the loop
    }

    const last = runs[runs.length - 1]!;
    const overall: CheckStatus = last.infrastructureError ? 'error'
      : last.results.some((r) => r.status === 'error') ? 'error'
      : last.results.some((r) => r.status === 'failed') ? 'failed'
      : last.results.some((r) => r.status === 'skipped') ? 'skipped' : 'passed';
    const flaky = want.criteria.filter((id) => new Set(runs.map((r) => r.results.find((x) => x.checkId === id)!.status)).size > 1);

    return await withTx(deps.db, async (tx: Tx) => {
      // Counted whatever the verdict: the time was spent even if the candidate was invalidated meanwhile. It is part of the host's total.
      const spentMs = runs.reduce((sum, r) => sum + Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt)), 0);
      await appendUsage(tx, {
        tenantId: candidate.tenantId, projectId: candidate.projectId, runId: candidate.runId, dedupeKey: `verification:${recordId}`, role: VERIFICATION_ROLE,
        metric: 'worker_seconds', quantity: (spentMs / 1000).toFixed(3), provenance: 'observed', source: 'verifier', phase: 'active', host: deps.host.startsWith('local') ? 'local' : 'cloud', basis: 'measured', recordedAt: now(),
      });
      const cur = await tx.execute(sql`
        SELECT status, detail -> 'verification' ->> 'holder' AS holder FROM candidates WHERE tenant_id = ${candidate.tenantId} AND project_id = ${candidate.projectId} AND run_id = ${candidate.runId} AND sha = ${candidate.sha} FOR UPDATE`);
      // The fence: a run that lost its lease (expired and taken, or the candidate re-assembled) writes nothing at all.
      if (cur[0]?.['holder'] !== holder) throw new CandidateNotVerifiable('lease_lost', 'this verification no longer holds the candidate');
      const assembled = cur[0]?.['status'] === 'assembled';
      // A part cancelled or replanned during the run means the tree contains work that is no longer wanted: the verdict can release nothing.
      let partsLive = true;
      for (const p of [...parts].sort((a, b) => (a.taskId < b.taskId ? -1 : 1))) {
        const row = await tx.execute(sql`SELECT status, current_revision FROM task_status WHERE tenant_id = ${candidate.tenantId} AND project_id = ${candidate.projectId} AND task_id = ${p.taskId} FOR UPDATE`);
        if (row.length === 0 || Number(row[0]!['current_revision']) !== p.revision || !LIVE_PART_STATUSES.includes(String(row[0]!['status']))) partsLive = false;
      }
      const live = assembled && partsLive;
      const notLiveReason = assembled ? 'candidate_part_not_live' : 'candidate_invalidated';
      const taskOutcomes: TaskOutcome[] = [];
      for (const p of parts) {
        const key = { tenantId: candidate.tenantId, projectId: candidate.projectId, taskId: p.taskId };
        if (!live) {
          const s = await tx.execute(sql`SELECT status FROM task_status WHERE tenant_id = ${key.tenantId} AND project_id = ${key.projectId} AND task_id = ${key.taskId}`);
          taskOutcomes.push({ taskId: p.taskId, revision: p.revision, applied: false, taskStatus: String(s[0]?.['status'] ?? 'unknown'), reason: notLiveReason });
          continue;
        }
        const failedChecks = last.results.filter((r) => r.status !== 'passed').map((r) => r.checkId);
        const applied = await applyVerification({ db: deps.db, now }, key, {
          actor: deps.verifier, outcome: overall, expect: { revision: p.revision, attemptId: p.attemptId },
          detail: { recordId, candidateSha: candidate.sha, checkManifestSha256: want.manifestSha, verifierSha256: want.verifierSha, host: deps.host, result: overall, failedChecks, flaky },
          repairable: !reverification,
        }, tx);
        taskOutcomes.push({ taskId: p.taskId, revision: p.revision, applied: applied.applied, taskStatus: applied.taskStatus, reason: applied.reason });
      }

      const anyApplied = taskOutcomes.some((o) => o.applied);
      if (live && overall === 'failed' && anyApplied) {
        // The candidate that failed is consumed: a repair attempt gets a new candidate, never this verdict's SHA.
        await tx.execute(sql`UPDATE candidates SET status = 'rejected', reason = 'verification_failed', updated_at = ${now().toISOString()}::timestamptz WHERE ${candKey}`);
      }
      if (live && overall === 'passed' && taskOutcomes.every((o) => o.applied)) {
        await markRunReadyForReview(tx, { tenantId: candidate.tenantId, projectId: candidate.projectId, taskId: candidate.taskId }, candidate.runId, parts.map((p) => p.taskId));
      }

      const record = VerificationRecordSchema.parse({
        schemaVersion: 1, recordId, taskId: candidate.taskId, runId: candidate.runId, partTaskIds: parts.map((p) => p.taskId),
        candidateSha: candidate.sha, candidateTreeSha: treeSha, candidateContentSha256: want.contentSha, baseSha,
        contractRevisions: [...contractRevisions].sort(), checkManifestSha256: want.manifestSha, verifierSha256: want.verifierSha,
        toolVersions: { ...Object.fromEntries(Object.entries(manifest.tools as Record<string, string>).filter(([k]) => k !== 'playwrightImage')), ...tools },
        configVersions: { suiteId: manifest.suiteId, suiteVersion: manifest.version, runnerProtocol: '0.1' },
        environmentImageDigest: want.image, host: deps.host, fixtures,
        startedAt: runs[0]!.startedAt, finishedAt: last.finishedAt, result: overall, exitCode: last.exitCode, results: last.results, runs, flaky,
        taskOutcomes, artifactIds: pending.map((a) => a.id), verifier: deps.verifier,
      });
      const recordRef = await deps.artifacts.put(Buffer.from(JSON.stringify(record, null, 2)));

      const checkRunIds: string[] = [];
      for (const p of parts) {
        const att = await tx.execute(sql`SELECT attempt_id FROM attempts WHERE tenant_id = ${candidate.tenantId} AND project_id = ${candidate.projectId} AND task_id = ${p.taskId} AND revision = ${p.revision} ORDER BY attempt_number DESC LIMIT 1`);
        const attemptId = att[0] ? String(att[0]['attempt_id']) : null;
        for (const r of runs) {
          for (const c of r.results) {
            const checkRunId = `chk_${recordId}_${p.taskId}_${r.attempt}_${c.checkId}`;
            checkRunIds.push(checkRunId);
            await tx.insert(schema.checkRuns).values({
              tenantId: candidate.tenantId, projectId: candidate.projectId, checkRunId, taskId: p.taskId, revision: p.revision, attemptId,
              checkId: c.checkId, checkVersion: manifest.version, candidateSha: candidate.sha, result: live ? c.status : 'invalidated',
              logRefs: [{ recordId, attempt: r.attempt, resultArtifactId: r.resultArtifactId, logArtifactId: r.logArtifactId }],
            });
          }
        }
      }
      for (const a of pending) {
        await tx.insert(schema.artifacts).values({
          tenantId: candidate.tenantId, projectId: candidate.projectId, artifactId: a.id, runId: candidate.runId, type: a.type, sha256: a.sha256,
          sourceRevision: candidate.sha, classification: 'internal', locator: a.locator,
        });
      }
      await tx.insert(schema.artifacts).values({
        tenantId: candidate.tenantId, projectId: candidate.projectId, artifactId: recordId, runId: candidate.runId, type: 'verification_record', sha256: recordRef.sha256,
        sourceRevision: candidate.sha, classification: 'internal', locator: { recordId, candidateSha: candidate.sha, checkManifestSha256: want.manifestSha, host: deps.host, applied: anyApplied, result: overall, checkRunIds },
      });
      return record;
    });
  } finally {
    clearInterval(renewer);
    await deps.db.execute(sql`UPDATE candidates SET detail = detail - 'verification' WHERE ${candKey} AND detail -> 'verification' ->> 'holder' = ${holder}`);
    for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  }
}

/** Values the trusted verifier has right now. A record made under different ones is no longer evidence. */
export function currentTrusted(): { checkManifestSha256: string; verifierSha256: string } {
  return { checkManifestSha256: sha256(readFileSync(join(suiteDir, 'manifest.json'))), verifierSha256: verifierHashes(pkgRoot, repoRoot).verifierSha256 };
}

/**
 * The authoritative record for a candidate SHA: the latest one that was applied to task state (a non-applied, `error` or `skipped`
 * record is history, never evidence). It is returned only while the candidate is still live (`assembled`, or `rejected` for a failed
 * verdict), none of its check runs is invalidated, its bytes are intact, and it names this SHA and the current trusted hashes. The check
 * is `validRecordOf` in the workflow package, shared with the evidence report, so a pass cannot count in one and not the other.
 */
export async function loadValidRecord(
  db: Db, artifacts: ArtifactStore, key: { tenantId: string; projectId: string; sha: string }, opts: { trusted?: { checkManifestSha256: string; verifierSha256: string } } = {},
): Promise<VerificationRecord | null> {
  const cand = await db.execute(sql`SELECT 1 FROM candidates WHERE tenant_id = ${key.tenantId} AND project_id = ${key.projectId} AND sha = ${key.sha} AND status IN ('assembled', 'rejected')`);
  if (cand.length === 0) return null;
  const latest = await loadLatestAppliedRecord(db, key);
  return validRecordOf(latest, key.sha, { artifacts, trusted: () => opts.trusted ?? currentTrusted() });
}

/**
 * Runs `scripts/docker-verify.sh` (the hardened image) against `candidateDir`. The script mounts the candidate read-only and copies the
 * result out with `docker cp` after the container exits. Only the last 256 KiB of its output is kept.
 */
export function dockerRunner(opts: { script?: string; timeoutMs?: number; dockerCommand?: string } = {}): VerifierRunner {
  const script = opts.script ?? join(pkgRoot, 'scripts/docker-verify.sh');
  const timeoutMs = opts.timeoutMs ?? 45 * 60_000;
  const docker = opts.dockerCommand ?? 'docker';
  return ({ candidateDir, resultsPath }) => new Promise((res, rej) => {
    const name = `selarikru-verify-${randomUUID()}`;
    const p = spawn(script, [candidateDir, resultsPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? tmpdir(), DOCKER_HOST: process.env['DOCKER_HOST'] ?? '', VERIFY_CONTAINER_NAME: name },
    });
    let log = '';
    const add = (b: Buffer) => { log = (log + b.toString()).slice(-256 * 1024); };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const timer = setTimeout(() => {
      log += `\n[verifier] docker run timed out after ${timeoutMs / 1000}s`;
      // Killing the script alone would leave the container running: stop it by name, then the script (its trap removes the container).
      spawn(docker, ['kill', name], { stdio: 'ignore' }).on('error', () => undefined);
      p.kill('SIGKILL');
    }, timeoutMs);
    p.once('error', (e) => { clearTimeout(timer); rej(e); });
    p.once('close', async (code) => {
      clearTimeout(timer);
      let result: unknown = null;
      try { result = JSON.parse(await readFile(resultsPath, 'utf8')); } catch { /* no usable result */ }
      res({ exitCode: code, result, log });
    });
  });
}
