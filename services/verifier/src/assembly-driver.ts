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
 *
 * Imports are relative for the same reason as `service.ts`.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { TaskSpecSchema, type TaskSpec } from '../../../packages/domain/src/index.ts';
import { sql, type Db } from '../../../packages/persistence/src/index.ts';
import { assembleCandidate, type IntegrationDeps } from './integrate.ts';

const execFileP = promisify(execFile);
/** The integration lease held by a driven assembly: short, because it renews while live, so a crash frees the target within this window. */
export const ASSEMBLY_LEASE_SECONDS = 120;
const DONE_STATUSES = new Set(['verifying', 'verified', 'merged']);
/** Finished for this rule: done, or never going to be part of the run's result. */
const SETTLED_STATUSES = new Set([...DONE_STATUSES, 'cancelled', 'superseded']);
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/;
const gitEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };

export interface AssemblyDriverOptions extends Pick<IntegrationDeps, 'db' | 'artifacts' | 'now' | 'workRoot' | 'protectedPaths' | 'leaseSeconds' | 'beforePublish'> {
  readonly tenantId: string;
  /** Local source repository holding the base commits and receiving the candidate ref. */
  readonly repoPath: string;
}

export interface AssemblyTick {
  readonly assembled: readonly string[];
  /** Runs where assembly ended in a recorded failure this tick. */
  readonly failed: readonly { readonly runId: string; readonly reason: string }[];
}

export interface AssemblyDriver {
  tick(): Promise<AssemblyTick>;
  ticks(): number;
  stop(graceMs?: number): Promise<void>;
}

interface TaskRow { readonly spec: TaskSpec; readonly status: string; readonly attemptId: string | null; readonly manifest: string | null }
interface Due { readonly target: string; readonly pinnedBaseSha: string; readonly currentBaseSha: string; readonly inputsKey: string }

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

  /** What assembling this run would mean right now, or null when nothing is due. */
  async function assess(projectId: string, runId: string): Promise<Due | null> {
    const tasks = await loadRunTasks(db, tenantId, projectId, runId);
    // A verifying part with no published change set cannot enter a candidate; it counts as unfinished below.
    const waiting = tasks.filter((t) => t.status === 'verifying' && t.attemptId !== null && t.manifest !== null);
    if (waiting.length === 0) return null;
    const liveRows = await db.execute(sql`SELECT parts FROM candidates WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND run_id = ${runId} AND status = 'assembled' AND sha IS NOT NULL`);
    const live = new Set(liveRows.flatMap((r) => (r['parts'] as { taskId: string; revision: number; attemptId: string }[]).map(partKey)));
    if (waiting.every((t) => live.has(partKey({ taskId: t.spec.taskId, revision: t.spec.revision, attemptId: t.attemptId! })))) return null;

    const waitingIds = new Set(waiting.map((t) => t.spec.taskId));
    const held = heldByDependency(tasks, waitingIds);
    const unfinished = tasks.filter((t) => !SETTLED_STATUSES.has(t.status) || (t.status === 'verifying' && t.manifest === null));
    if (unfinished.some((t) => !held.has(t.spec.taskId))) return null;

    const project = await db.execute(sql`SELECT default_branch FROM projects WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`);
    if (project.length === 0) return null;
    const target = String(project[0]!['default_branch']);
    const currentBaseSha = await resolveTip(repoPath, target);
    // The run's base: what its workers were planned on. A resolution task is built later on a newer tip and does not define it.
    const workers = tasks.filter((t) => DONE_STATUSES.has(t.status) && t.spec.role !== 'integration');
    const pinnedBaseSha = (workers[0] ?? waiting[0]!).spec.baseSha;
    const inputsKey = sha256(JSON.stringify({ pinnedBaseSha, currentBaseSha, target, parts: waiting.map((t) => [t.spec.taskId, t.spec.revision, t.attemptId, t.manifest]).sort() }));
    const handled = await db.execute(sql`SELECT 1 FROM candidates WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND run_id = ${runId} AND status IN ('failed', 'conflicted') AND detail ->> 'inputsKey' = ${inputsKey} LIMIT 1`);
    if (handled.length > 0) return null;
    return { target, pinnedBaseSha, currentBaseSha, inputsKey };
  }

  async function assembleRun(projectId: string, runId: string): Promise<{ sha?: string; failure?: string }> {
    const due = await assess(projectId, runId);
    if (!due) return {};
    const r = await assembleCandidate(
      { tenantId, projectId, runId, target: due.target, pinnedBaseSha: due.pinnedBaseSha, currentBaseSha: due.currentBaseSha, repoPath, inputsKey: due.inputsKey },
      {
        db, artifacts: options.artifacts, now, leaseSeconds,
        ...(options.workRoot !== undefined ? { workRoot: options.workRoot } : {}), ...(options.protectedPaths !== undefined ? { protectedPaths: options.protectedPaths } : {}), ...(options.beforePublish !== undefined ? { beforePublish: options.beforePublish } : {}),
        stillDue: async () => (await assess(projectId, runId))?.inputsKey === due.inputsKey,
      },
    );
    if (r.ok) return { sha: r.sha };
    // Another pass holds or took the work: nothing happened here and nothing is recorded.
    if (r.reason === 'lease_held' || r.reason === 'lease_lost' || r.reason === 'not_due') return {};
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
      const errors: unknown[] = [];
      // One run's trouble (an invalid stored spec, a missing ref) is that run's alone: the rest are still assembled.
      for (const row of runs) {
        const projectId = String(row['project_id']);
        const runId = String(row['run_id']);
        try {
          const out = await assembleRun(projectId, runId);
          if (out.sha) assembled.push(out.sha);
          if (out.failure) failed.push({ runId, reason: out.failure });
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `assembly: ${errors.length} run(s) failed`);
      return { assembled, failed };
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
