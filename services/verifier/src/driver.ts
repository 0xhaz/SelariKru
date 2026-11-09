/**
 * Production driver of verification. It runs `verifyCandidate` once for each assembled candidate and closes the ones that got no verdict.
 *
 * - A candidate is verified at most once. A single `UPDATE ... FOR UPDATE SKIP LOCKED` claims it (`detail.verificationDriver`), and a stored
 *   verification record, whatever its result, ends the driver's interest for good. Only a crash (a claim that expired with no record) repeats a run.
 * - A run that yields no verdict (`error` or `skipped`) leaves its tasks `verifying` with claims held. The reaper, on every tick, moves those tasks to
 *   `blocked` and retires the candidate, so an owner can replan or cancel instead of waiting forever. It keys off durable rows, so it survives a restart.
 *
 * The injected runner is the only thing that touches Docker; tests inject a fake. Imports are relative for the same reason as `service.ts`.
 */
import { sql, withTx, type Db, type Tx } from '../../../packages/persistence/src/index.ts';
import { emit } from '../../workflow/src/events.ts';
import { closeVerificationWithoutVerdict } from '../../workflow/src/verification.ts';
import { CandidateNotVerifiable, verifyCandidate, type VerificationDeps } from './service.ts';

export interface VerificationDriverOptions extends Omit<VerificationDeps, 'db'> {
  readonly db: Db;
  readonly tenantId: string;
  /** Local source repository holding the candidate commits. */
  readonly repoPath: string;
  /** How long one claim lasts. It must exceed a whole verification; a claim that expires with no record is retried. Default 2 h, as in `verifyCandidate`. */
  readonly leaseSeconds?: number;
}

export interface VerificationTick {
  /** The candidate verified this tick, if any. */
  readonly verified: string | null;
  readonly reaped: readonly string[];
}

export interface VerificationDriver {
  tick(): Promise<VerificationTick>;
  ticks(): number;
  /** Stops scheduling. A verification can run for many minutes, so this waits only `graceMs` (default 30 s); a claim left behind is retried after it expires. */
  stop(graceMs?: number): Promise<void>;
}

interface Part { readonly taskId: string; readonly revision: number; readonly attemptId: string }
interface CandidateRow { readonly project_id: string; readonly run_id: string; readonly sha: string; readonly parts: Part[] }

/** A candidate this driver still owes a run: assembled, no record of any kind, no live claim, and at least one part still waiting for a verdict. */
const CANDIDATE_DUE = (now: Date) => sql`
  c.status = 'assembled' AND c.sha IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.tenant_id = c.tenant_id AND a.project_id = c.project_id AND a.run_id = c.run_id AND a.type = 'verification_record' AND a.source_revision = c.sha)
  AND (c.detail -> 'verificationDriver' IS NULL OR (c.detail -> 'verificationDriver' ->> 'expiresAt')::timestamptz <= ${now.toISOString()}::timestamptz)
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.parts) p JOIN task_status s ON s.tenant_id = c.tenant_id AND s.project_id = c.project_id AND s.task_id = p ->> 'taskId' AND s.current_revision = (p ->> 'revision')::int AND s.status = 'verifying')`;

export function createVerificationDriver(options: VerificationDriverOptions): Pick<VerificationDriver, 'tick'> {
  const { db, tenantId } = options;
  const now = options.now ?? (() => new Date());

  /** Atomically claims the oldest due candidate. Concurrent ticks and processes cannot claim the same one. */
  async function claimDue(): Promise<CandidateRow | null> {
    const at = now();
    const expiresAt = new Date(at.getTime() + (options.leaseSeconds ?? 7200) * 1000).toISOString();
    const rows = await db.execute(sql`
      WITH due AS (
        SELECT c.tenant_id, c.project_id, c.candidate_id FROM candidates c WHERE c.tenant_id = ${tenantId} AND ${CANDIDATE_DUE(at)}
        ORDER BY c.created_at, c.candidate_id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE candidates c SET detail = jsonb_set(c.detail, '{verificationDriver}', jsonb_build_object('claimedAt', ${at.toISOString()}::text, 'expiresAt', ${expiresAt}::text))
      FROM due WHERE c.tenant_id = due.tenant_id AND c.project_id = due.project_id AND c.candidate_id = due.candidate_id
      RETURNING c.project_id, c.run_id, c.sha, c.parts`);
    return (rows[0] as unknown as CandidateRow | undefined) ?? null;
  }

  async function announce(c: CandidateRow): Promise<void> {
    await withTx(db, async (tx: Tx) => {
      for (const p of c.parts) {
        const rows = await tx.execute(sql`SELECT row_revision FROM task_status WHERE tenant_id = ${tenantId} AND project_id = ${c.project_id} AND task_id = ${p.taskId} AND status = 'verifying' AND current_revision = ${p.revision} FOR UPDATE`);
        if (rows.length === 0) continue;
        await emit(tx, { projectId: c.project_id, runId: c.run_id, taskId: p.taskId, aggregateRevision: Number(rows[0]!['row_revision']) }, now(), {
          type: 'verification.started', attemptId: p.attemptId, actor: options.verifier, payload: { candidateSha: c.sha },
        });
      }
    });
  }

  async function verifyOne(c: CandidateRow): Promise<void> {
    await announce(c);
    const { tenantId: _t, repoPath: _r, ...deps } = options;
    try {
      await verifyCandidate({ tenantId, projectId: c.project_id, runId: c.run_id, sha: c.sha, taskId: c.parts[0]!.taskId, repoPath: options.repoPath }, { ...deps, leaseSeconds: options.leaseSeconds ?? 7200 });
    } catch (e) {
      if (e instanceof CandidateNotVerifiable) {
        // The candidate's commit could not be exported: no run happened and none can.
        if (e.reason === 'export_failed') await close(c, 'verification_export_failed');
        return; // Anything else (re-assembled, another process holds it) is already someone else's state to handle.
      }
      throw e;
    }
  }

  /** In one transaction: lock the candidate, close its waiting parts, retire it. A candidate no longer assembled is left alone. */
  async function close(c: Pick<CandidateRow, 'project_id' | 'run_id' | 'sha' | 'parts'>, reason: string): Promise<boolean> {
    return withTx(db, async (tx: Tx) => {
      const key = sql`tenant_id = ${tenantId} AND project_id = ${c.project_id} AND run_id = ${c.run_id} AND sha = ${c.sha}`;
      const locked = await tx.execute(sql`SELECT 1 FROM candidates WHERE ${key} AND status = 'assembled' FOR UPDATE`);
      if (locked.length === 0) return false;
      for (const p of c.parts) {
        await closeVerificationWithoutVerdict({ now }, tx, { tenantId, projectId: c.project_id, taskId: p.taskId }, { reason, candidateSha: c.sha, expect: { revision: p.revision, attemptId: p.attemptId } });
      }
      await tx.execute(sql`UPDATE candidates SET status = 'invalidated', reason = ${reason}, updated_at = ${now().toISOString()}::timestamptz WHERE ${key}`);
      return true;
    });
  }

  /** Assembled candidates whose only records applied nothing, and whose checks say `error` or `skipped`. */
  async function reap(): Promise<string[]> {
    const rows = await db.execute(sql`
      SELECT c.project_id, c.run_id, c.sha, c.parts,
        (SELECT array_agg(DISTINCT r.result) FROM check_runs r WHERE r.tenant_id = c.tenant_id AND r.project_id = c.project_id AND r.candidate_sha = c.sha) AS results
      FROM candidates c
      WHERE c.tenant_id = ${tenantId} AND c.status = 'assembled' AND c.sha IS NOT NULL
        AND EXISTS (SELECT 1 FROM artifacts a WHERE a.tenant_id = c.tenant_id AND a.project_id = c.project_id AND a.run_id = c.run_id AND a.type = 'verification_record' AND a.source_revision = c.sha AND a.locator ->> 'applied' = 'false')
        AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.tenant_id = c.tenant_id AND a.project_id = c.project_id AND a.run_id = c.run_id AND a.type = 'verification_record' AND a.source_revision = c.sha AND a.locator ->> 'applied' = 'true')`);
    const reaped: string[] = [];
    for (const row of rows) {
      const results = (row['results'] as string[] | null) ?? [];
      const reason = results.includes('error') ? 'verification_error' : results.includes('skipped') && !results.includes('failed') ? 'verification_skipped' : null;
      if (reason === null) continue;
      const c = row as unknown as CandidateRow;
      if (await close(c, reason)) reaped.push(c.sha);
    }
    return reaped;
  }

  return {
    async tick() {
      const candidate = await claimDue();
      if (candidate) {
        try {
          await verifyOne(candidate);
        } catch (e) {
          // Whatever went wrong here, closing the already-recorded non-verdicts must still happen.
          await reap();
          throw e;
        }
      }
      // Closes this tick's non-verdict and any an earlier process left behind.
      return { verified: candidate?.sha ?? null, reaped: await reap() };
    },
  };
}

/** The interval around `createVerificationDriver`: passes never overlap, and a failing pass is reported and retried on the next interval. */
export function startVerificationDriver(options: VerificationDriverOptions & { readonly intervalMs: number; readonly onError?: (e: unknown) => void }): VerificationDriver {
  const driver = createVerificationDriver(options);
  let stopped = false;
  let count = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();
  const tick = async (): Promise<VerificationTick> => { try { return await driver.tick(); } finally { count += 1; } };
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
