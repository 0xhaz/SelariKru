/**
 * Production driver of candidate assembly. It calls `assembleCandidate` for any run with a `verifying` part that is not in a live candidate.
 *
 * - Level-triggered, from durable rows: what is due is recomputed every tick, so a restart or a retired candidate is simply picked up. "In a live candidate"
 *   means a candidate with status `assembled` holding this exact (taskId, revision, attemptId). A candidate retired or rebuilt away leaves its parts due.
 * - The assembly itself holds the single integration lease (`leaseSeconds`, renewed while running, fenced at every write). A pass that lost the race to
 *   another one re-checks under the lease (`stillDue`) and stops, so it writes nothing.
 * - Siblings: a part is not assembled while a task that belongs in its candidate is unfinished, or the full suite would judge a partial tree and burn a
 *   repair on good work. The one exception is a task held back by a dependency edge on a part waiting for this verdict (any condition: all of them need the
 *   predecessor verified or merged), which by construction cannot finish first. Without it such a plan would wait for ever.
 * - A failed or conflicted row is the verdict on these inputs until they change: its `inputsKey` matches and nothing is written again. A new part, attempt
 *   or base is a new key.
 * - An infrastructure failure (`INFRASTRUCTURE_FAILURES`, a stale git lock, a moved artifact directory, a tip that cannot be read) is no verdict. It writes
 *   no failure row and no event, keeps its count and next time on a `retrying` row, and is tried again on a doubling delay. Past the bound the parts move to
 *   `blocked` with the reason, one `task.blocked` each, so the owner sees it and can re-verify.
 *
 * Imports are relative for the same reason as `service.ts`.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { TaskSpecSchema, type TaskSpec } from '../../../packages/domain/src/index.ts';
import { sql, withTx, type Db, type Tx } from '../../../packages/persistence/src/index.ts';
import { redactSecrets } from '../../../packages/protocol/src/redact.ts';
import { closeVerificationWithoutVerdict } from '../../workflow/src/verification.ts';
import { assembleCandidate, type IntegrationDeps } from './integrate.ts';

const execFileP = promisify(execFile);
/** The integration lease held by a driven assembly: short, because it renews while live, so a crash frees the target within this window. */
export const ASSEMBLY_LEASE_SECONDS = 120;
/** Further tries after the first infrastructure failure, and the delay before the first of them (doubling): 31 minutes in all, enough for a restart. */
export const ASSEMBLY_RETRIES = 5;
export const ASSEMBLY_RETRY_BACKOFF_SECONDS = 60;
const DONE_STATUSES = new Set(['verifying', 'verified', 'merged']);
/** Finished for this rule: done, or never going to be part of the run's result. */
const SETTLED_STATUSES = new Set([...DONE_STATUSES, 'cancelled', 'superseded']);
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/;
const gitEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };

export interface AssemblyDriverOptions extends Pick<IntegrationDeps, 'db' | 'artifacts' | 'now' | 'workRoot' | 'protectedPaths' | 'leaseSeconds' | 'beforePublish'> {
  readonly tenantId: string;
  /** Local source repository holding the base commits and receiving the candidate ref. */
  readonly repoPath: string;
  /** Default `ASSEMBLY_RETRIES`. */
  readonly maxInfrastructureRetries?: number;
  /** Default `ASSEMBLY_RETRY_BACKOFF_SECONDS`. */
  readonly infrastructureBackoffSeconds?: number;
  /** Called once each time an infrastructure failure is scheduled for another try (the count changed), never per poll. `reason` is a code, not free text. */
  readonly onRetry?: (info: { readonly runId: string; readonly reason: string; readonly count: number; readonly maxRetries: number }) => void;
}

export interface AssemblyTick {
  readonly assembled: readonly string[];
  /** Runs where assembly ended in a recorded failure this tick, including those whose infrastructure retries ran out. */
  readonly failed: readonly { readonly runId: string; readonly reason: string }[];
  /** Runs where an infrastructure failure was scheduled for another try. Absent when there were none. */
  readonly retrying?: readonly { readonly runId: string; readonly reason: string }[];
}

export interface AssemblyDriver {
  tick(): Promise<AssemblyTick>;
  ticks(): number;
  stop(graceMs?: number): Promise<void>;
}

interface TaskRow { readonly spec: TaskSpec; readonly status: string; readonly attemptId: string | null; readonly manifest: string | null }
type Part = { readonly taskId: string; readonly revision: number; readonly attemptId: string };
interface Due { readonly target: string; readonly pinnedBaseSha: string; readonly currentBaseSha: string; readonly inputsKey: string; readonly partsKey: string; readonly parts: readonly Part[] }
/** Nothing to do, due, or a failure before assembly could start (the tip could not be read). */
type Assessment = { readonly kind: 'idle' } | { readonly kind: 'due'; readonly due: Due } | { readonly kind: 'infrastructure'; readonly partsKey: string; readonly parts: readonly Part[]; readonly pinnedBaseSha: string; readonly target: string; readonly reason: string; readonly message: string };
const RETRY_STATUS = 'retrying';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const partKey = (p: { taskId: string; revision: number; attemptId: string }): string => `${p.taskId}\0${p.revision}\0${p.attemptId}`;

async function loadRunTasks(db: Db, tenantId: string, projectId: string, runId: string): Promise<TaskRow[]> {
  const rows = await db.execute(sql`
    SELECT r.spec, s.status, a.attempt_id, a.manifest
    FROM task_revisions r
    JOIN task_status s ON s.tenant_id = r.tenant_id AND s.project_id = r.project_id AND s.task_id = r.task_id AND s.current_revision = r.revision
    LEFT JOIN LATERAL (
      SELECT attempt_id, detail ->> 'changeManifestSha256' AS manifest FROM attempts x
      WHERE x.tenant_id = r.tenant_id AND x.project_id = r.project_id AND x.task_id = r.task_id AND x.revision = r.revision
        AND x.outcome IN ('running', 'succeeded') AND x.ended_at IS NOT NULL AND x.detail ->> 'changeManifestSha256' IS NOT NULL
      ORDER BY attempt_number DESC LIMIT 1
    ) a ON true
    WHERE r.tenant_id = ${tenantId} AND r.project_id = ${projectId} AND r.run_id = ${runId}
    ORDER BY r.task_id`);
  return rows.map((r) => ({ spec: TaskSpecSchema.parse(r['spec']), status: String(r['status']), attemptId: r['attempt_id'] === null ? null : String(r['attempt_id']), manifest: r['manifest'] === null ? null : String(r['manifest']) }));
}

/** Tasks that are unfinished because they (transitively) wait on `waitingFor`: they cannot belong in a candidate built now. */
function heldByDependency(tasks: readonly TaskRow[], waitingFor: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of tasks) {
      if (held.has(t.spec.taskId) || SETTLED_STATUSES.has(t.status)) continue;
      if (t.spec.dependencies.some((d) => waitingFor.has(d.taskId) || held.has(d.taskId))) {
        held.add(t.spec.taskId);
        changed = true;
      }
    }
  }
  return held;
}

async function resolveTip(repoPath: string, target: string): Promise<string> {
  if (!SAFE_BRANCH.test(target) || target.includes('..')) throw new Error(`refusing an unsafe target branch name`);
  const { stdout } = await execFileP('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`], { cwd: repoPath, env: gitEnv, encoding: 'utf8' });
  return stdout.trim();
}

export function createAssemblyDriver(options: AssemblyDriverOptions): Pick<AssemblyDriver, 'tick'> {
  const { db, tenantId, repoPath } = options;
  const now = options.now ?? (() => new Date());
  const leaseSeconds = options.leaseSeconds ?? ASSEMBLY_LEASE_SECONDS;
  const maxRetries = options.maxInfrastructureRetries ?? ASSEMBLY_RETRIES;
  const backoffSeconds = options.infrastructureBackoffSeconds ?? ASSEMBLY_RETRY_BACKOFF_SECONDS;
  const retryId = (runId: string, target: string) => `cand_assembly_retry_${sha256(`${runId}\0${target}`).slice(0, 24)}`;

  /** The retry row is the one piece of durable state an infrastructure failure writes. Its count belongs to these parts; different parts start again. */
  async function noteInfrastructure(tx: Tx, projectId: string, runId: string, target: string, partsKey: string, parts: readonly Part[], pinnedBaseSha: string, reason: string, message: string): Promise<{ outcome: 'retrying' | 'blocked'; count: number }> {
    const id = retryId(runId, target);
    const at = now();
    const rows = await tx.execute(sql`SELECT detail FROM candidates WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND candidate_id = ${id} AND status = ${RETRY_STATUS} FOR UPDATE`);
    const retry = (rows[0]?.['detail'] as { retry?: { partsKey?: string; count?: number } } | undefined)?.retry;
    const count = retry?.partsKey === partsKey && typeof retry.count === 'number' ? retry.count + 1 : 1;
    if (count > maxRetries) {
      for (const p of [...parts].sort((a, b) => (a.taskId < b.taskId ? -1 : 1))) {
        await closeVerificationWithoutVerdict({ now }, tx, { tenantId, projectId, taskId: p.taskId }, { reason: `assembly_infrastructure:${reason}`, expect: { revision: p.revision, attemptId: p.attemptId } });
      }
      await tx.execute(sql`DELETE FROM candidates WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND candidate_id = ${id}`);
      return { outcome: 'blocked', count };
    }
    const notBefore = new Date(at.getTime() + backoffSeconds * 1000 * 2 ** (count - 1)).toISOString();
    const detail = JSON.stringify({ retry: { partsKey, count, notBefore, reason, message } });
    await tx.execute(sql`
      INSERT INTO candidates (tenant_id, project_id, candidate_id, run_id, target, sha, base_sha, tree_sha, parts, status, reason, detail, updated_at)
      VALUES (${tenantId}, ${projectId}, ${id}, ${runId}, ${target}, NULL, ${pinnedBaseSha}, NULL, '[]'::jsonb, ${RETRY_STATUS}, ${reason}, ${detail}::jsonb, ${at.toISOString()}::timestamptz)
      ON CONFLICT (tenant_id, project_id, candidate_id) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, detail = EXCLUDED.detail, updated_at = EXCLUDED.updated_at`);
    return { outcome: 'retrying', count };
  }

  const clearRetry = (projectId: string, runId: string, target: string) => db.execute(sql`DELETE FROM candidates WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND candidate_id = ${retryId(runId, target)} AND status = ${RETRY_STATUS}`);

  /** What assembling this run would mean right now, or null when nothing is due. */
  async function assess(projectId: string, runId: string): Promise<Assessment> {
    const tasks = await loadRunTasks(db, tenantId, projectId, runId);
    // A verifying part with no published change set cannot enter a candidate; it counts as unfinished below.
    const waiting = tasks.filter((t) => t.status === 'verifying' && t.attemptId !== null && t.manifest !== null);
    if (waiting.length === 0) return { kind: 'idle' };
    const liveRows = await db.execute(sql`SELECT parts FROM candidates WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND run_id = ${runId} AND status = 'assembled' AND sha IS NOT NULL`);
    const live = new Set(liveRows.flatMap((r) => (r['parts'] as { taskId: string; revision: number; attemptId: string }[]).map(partKey)));
    if (waiting.every((t) => live.has(partKey({ taskId: t.spec.taskId, revision: t.spec.revision, attemptId: t.attemptId! })))) return { kind: 'idle' };

    const waitingIds = new Set(waiting.map((t) => t.spec.taskId));
    const held = heldByDependency(tasks, waitingIds);
    const unfinished = tasks.filter((t) => !SETTLED_STATUSES.has(t.status) || (t.status === 'verifying' && t.manifest === null));
    if (unfinished.some((t) => !held.has(t.spec.taskId))) return { kind: 'idle' };

    const project = await db.execute(sql`SELECT default_branch FROM projects WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`);
    if (project.length === 0) return { kind: 'idle' };
    const target = String(project[0]!['default_branch']);
    // The run's base: what its workers were planned on. A resolution task is built later on a newer tip and does not define it.
    const workers = tasks.filter((t) => DONE_STATUSES.has(t.status) && t.spec.role !== 'integration');
    const pinnedBaseSha = (workers[0] ?? waiting[0]!).spec.baseSha;
    const parts = waiting.map((t) => ({ taskId: t.spec.taskId, revision: t.spec.revision, attemptId: t.attemptId! }));
    const partsKey = sha256(JSON.stringify({ pinnedBaseSha, target, parts: waiting.map((t) => [t.spec.taskId, t.spec.revision, t.attemptId, t.manifest]).sort() }));

    // Waiting out an infrastructure failure: no git, no work, nothing written.
    const retrying = await db.execute(sql`SELECT detail FROM candidates WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND candidate_id = ${retryId(runId, target)} AND status = ${RETRY_STATUS}`);
    const retry = (retrying[0]?.['detail'] as { retry?: { partsKey?: string; notBefore?: string } } | undefined)?.retry;
    if (retry?.partsKey === partsKey && retry.notBefore !== undefined && Date.parse(retry.notBefore) > now().getTime()) return { kind: 'idle' };

    let currentBaseSha: string;
    try {
      currentBaseSha = await resolveTip(repoPath, target);
    } catch (e) {
      return { kind: 'infrastructure', partsKey, parts, pinnedBaseSha, target, reason: 'base_unavailable', message: `the tip of ${target} could not be read: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}` };
    }
    const inputsKey = sha256(JSON.stringify({ partsKey, currentBaseSha }));
    const handled = await db.execute(sql`SELECT 1 FROM candidates WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND run_id = ${runId} AND status IN ('failed', 'conflicted') AND detail ->> 'inputsKey' = ${inputsKey} LIMIT 1`);
    if (handled.length > 0) return { kind: 'idle' };
    return { kind: 'due', due: { target, pinnedBaseSha, currentBaseSha, inputsKey, partsKey, parts } };
  }

  async function assembleRun(projectId: string, runId: string): Promise<{ sha?: string; failure?: string; retrying?: string }> {
    const assessed = await assess(projectId, runId);
    if (assessed.kind === 'idle') return {};
    if (assessed.kind === 'infrastructure') {
      const a = assessed;
      const done = await withTx(db, (tx) => noteInfrastructure(tx, projectId, runId, a.target, a.partsKey, a.parts, a.pinnedBaseSha, a.reason, a.message));
      if (done.outcome === 'retrying') options.onRetry?.({ runId, reason: a.reason, count: done.count, maxRetries });
      return done.outcome === 'blocked' ? { failure: `assembly_infrastructure:${a.reason}` } : { retrying: a.reason };
    }
    const { due } = assessed;
    let deferred: { readonly reason: string; readonly outcome: 'retrying' | 'blocked' } | undefined;
    const r = await assembleCandidate(
      { tenantId, projectId, runId, target: due.target, pinnedBaseSha: due.pinnedBaseSha, currentBaseSha: due.currentBaseSha, repoPath, inputsKey: due.inputsKey },
      {
        db, artifacts: options.artifacts, now, leaseSeconds,
        ...(options.workRoot !== undefined ? { workRoot: options.workRoot } : {}), ...(options.protectedPaths !== undefined ? { protectedPaths: options.protectedPaths } : {}), ...(options.beforePublish !== undefined ? { beforePublish: options.beforePublish } : {}),
        stillDue: async () => { const again = await assess(projectId, runId); return again.kind === 'due' && again.due.inputsKey === due.inputsKey; },
        onInfrastructureFailure: async (f) => {
          const outcome = await withTx(db, (tx) => noteInfrastructure(tx, projectId, runId, due.target, due.partsKey, due.parts, due.pinnedBaseSha, f.reason, f.message));
          deferred = { reason: f.reason, outcome: outcome.outcome };
          if (outcome.outcome === 'retrying') options.onRetry?.({ runId, reason: f.reason, count: outcome.count, maxRetries });
        },
      },
    );
    if (r.ok) { await clearRetry(projectId, runId, due.target); return { sha: r.sha }; }
    if (deferred) return deferred.outcome === 'blocked' ? { failure: `assembly_infrastructure:${deferred.reason}` } : { retrying: deferred.reason };
    // Another pass holds or took the work: nothing happened here and nothing is recorded.
    if (r.reason === 'lease_held' || r.reason === 'lease_lost' || r.reason === 'not_due') return {};
    await clearRetry(projectId, runId, due.target);
    return { failure: r.reason };
  }

  return {
    async tick() {
      const runs = await db.execute(sql`
        SELECT DISTINCT r.project_id, r.run_id
        FROM task_status s JOIN task_revisions r ON r.tenant_id = s.tenant_id AND r.project_id = s.project_id AND r.task_id = s.task_id AND r.revision = s.current_revision
        JOIN runs ru ON ru.tenant_id = r.tenant_id AND ru.project_id = r.project_id AND ru.run_id = r.run_id
        WHERE s.tenant_id = ${tenantId} AND s.status = 'verifying' AND ru.lifecycle IN ('planning', 'running', 'blocked')
        ORDER BY r.project_id, r.run_id`);
      const assembled: string[] = [];
      const failed: { runId: string; reason: string }[] = [];
      const retrying: { runId: string; reason: string }[] = [];
      const errors: unknown[] = [];
      // One run's trouble (an invalid stored spec, a missing ref) is that run's alone: the rest are still assembled.
      for (const row of runs) {
        const projectId = String(row['project_id']);
        const runId = String(row['run_id']);
        try {
          const out = await assembleRun(projectId, runId);
          if (out.sha) assembled.push(out.sha);
          if (out.failure) failed.push({ runId, reason: out.failure });
          if (out.retrying) retrying.push({ runId, reason: out.retrying });
        } catch (e) {
          // The run ID travels with the cause, so a pass that fails for several runs says which is which.
          errors.push(new Error(`run ${runId}: ${redactSecrets(e instanceof Error ? e.message : String(e))}`, { cause: e }));
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `assembly: ${errors.length} run(s) failed`);
      return { assembled, failed, ...(retrying.length > 0 ? { retrying } : {}) };
    },
  };
}

/** The interval around `createAssemblyDriver`: passes never overlap, and a failing pass is reported and retried on the next interval. */
export function startAssemblyDriver(options: AssemblyDriverOptions & { readonly intervalMs: number; readonly onError?: (e: unknown) => void }): AssemblyDriver {
  const driver = createAssemblyDriver(options);
  let stopped = false;
  let count = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();
  const tick = async (): Promise<AssemblyTick> => { try { return await driver.tick(); } finally { count += 1; } };
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => { inFlight = tick().catch((e: unknown) => options.onError?.(e)).finally(schedule); }, options.intervalMs);
  };
  schedule();
  return {
    tick, ticks: () => count,
    async stop(graceMs = 30_000) {
      stopped = true;
      if (timer) clearTimeout(timer);
      await Promise.race([inFlight, new Promise<void>((resolve) => { const t = setTimeout(resolve, graceMs); t.unref(); })]);
    },
  };
}
