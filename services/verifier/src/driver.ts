/**
 * Production driver of verification. It runs `verifyCandidate` once for each binding of an assembled candidate and closes the ones that got no verdict.
 *
 * - A claim is a short lease (`detail.verificationDriver`), taken with `FOR UPDATE SKIP LOCKED`, renewed while the run is live and released when it ends,
 *   however it ends. A crash frees the candidate within one lease. Together with the inner lease in `verifyCandidate` and its fence at record write, a
 *   run that lost its hold cannot write evidence.
 * - "Already verified" means a record of the current binding: one with live check runs. Re-assembly of the same commit (an identical repair) invalidates
 *   those check runs, so the new binding is verified in its own right.
 * - Every part must be live at its revision. A candidate with a part cancelled or replanned away is retired instead: verifying it could release a task on a
 *   tree containing that work. Its other parts are left as they are, for the next assembly.
 * - A run that yields no verdict (`error` or `skipped`) leaves its tasks `verifying` with claims held. The reaper, on every tick, moves those tasks to
 *   `blocked` and retires the candidate, so an owner can replan or cancel instead of waiting forever. It keys off durable rows, so it survives a restart.
 * - An `error` is the verifier failing, not the candidate: it gets up to `maxVerificationRetries` further runs of the same commit, with growing delays, before
 *   the reaper closes it. Nothing the workers did is redone. The attempts count is kept on the candidate and cleared when the binding changes.
 *
 * The injected runner is the only thing that touches Docker; tests inject a fake. Imports are relative for the same reason as `service.ts`.
 */
import { randomUUID } from 'node:crypto';
import { sql, withTx, type Db, type Tx } from '../../../packages/persistence/src/index.ts';
import { emit } from '../../workflow/src/events.ts';
import { closeVerificationWithoutVerdict } from '../../workflow/src/verification.ts';
import { CandidateNotVerifiable, VERIFICATION_LEASE_SECONDS, verifyCandidate, type VerificationDeps } from './service.ts';
import { readTip, type RemoteTips } from './tip.ts';

export interface VerificationDriverOptions extends Omit<VerificationDeps, 'db'> {
  readonly db: Db;
  readonly tenantId: string;
  /** Local source repository holding the candidate commits. */
  readonly repoPath: string;
  /** How long a claim lasts between renewals; one that expires with no record is retried. Default `VERIFICATION_LEASE_SECONDS`, renewed during the run. */
  readonly leaseSeconds?: number;
  /** Further runs after an infrastructure `error`. Default 0: the first error closes the candidate. The server wires `DEFAULT_VERIFICATION_RETRIES`. */
  readonly maxVerificationRetries?: number;
  /** Delay before the first re-verification; it doubles per retry. Default 60 s. */
  readonly retryBackoffSeconds?: number;
  /** With GitHub enabled: where main's tip is read. Absent: the local branch. */
  readonly remote?: RemoteTips;
}

/** Candidates passed over in one tick because main has moved past them. A bound on a pass, not on the queue: they are the assembly driver's to rebuild. */
const MAX_SKIPPED_PER_TICK = 25;

/** Infrastructure retries when the server starts the driver. Bounded, so a broken Docker cannot keep tasks `verifying` forever. */
export const DEFAULT_VERIFICATION_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_SECONDS = 60;

export interface VerificationTick {
  /** The candidate verified this tick, if any. */
  readonly verified: string | null;
  readonly reaped: readonly string[];
  /** Candidates whose infrastructure error was scheduled for another run this tick. Absent when there were none. */
  readonly retried?: readonly string[];
}

export interface VerificationDriver {
  tick(): Promise<VerificationTick>;
  ticks(): number;
  /** Stops scheduling. A verification can run for many minutes, so this waits only `graceMs` (default 30 s); a claim left behind expires within one short lease. */
  stop(graceMs?: number): Promise<void>;
}

interface Part { readonly taskId: string; readonly revision: number; readonly attemptId: string }
interface CandidateRow { readonly project_id: string; readonly run_id: string; readonly sha: string; readonly parts: Part[] }

/** A verification record of the candidate's current binding: re-assembly invalidates the check runs of earlier ones. */
const LIVE_RECORD = sql`
  FROM artifacts a WHERE a.tenant_id = c.tenant_id AND a.project_id = c.project_id AND a.run_id = c.run_id AND a.type = 'verification_record' AND a.source_revision = c.sha
    AND EXISTS (SELECT 1 FROM check_runs r WHERE r.tenant_id = a.tenant_id AND r.project_id = a.project_id AND r.candidate_sha = c.sha AND r.result <> 'invalidated' AND jsonb_exists(a.locator -> 'checkRunIds', r.check_run_id))`;

/** A part that is missing, on another revision, or in a state where a verdict on this tree would no longer mean anything. */
const PART_NOT_LIVE = sql`
  EXISTS (SELECT 1 FROM jsonb_array_elements(c.parts) p
    LEFT JOIN task_status s ON s.tenant_id = c.tenant_id AND s.project_id = c.project_id AND s.task_id = p ->> 'taskId'
    WHERE s.task_id IS NULL OR s.current_revision <> (p ->> 'revision')::int OR s.status NOT IN ('verifying', 'verified', 'merged'))`;

/** Assembled, no record of this binding, no live claim, every part live, and at least one part still waiting for a verdict. */
const CANDIDATE_DUE = (now: Date) => sql`
  c.status = 'assembled' AND c.sha IS NOT NULL
  AND NOT EXISTS (SELECT 1 ${LIVE_RECORD})
  AND (c.detail -> 'verificationDriver' IS NULL OR (c.detail -> 'verificationDriver' ->> 'expiresAt')::timestamptz <= ${now.toISOString()}::timestamptz)
  AND (c.detail -> 'verificationRetry' IS NULL OR (c.detail -> 'verificationRetry' ->> 'notBefore')::timestamptz <= ${now.toISOString()}::timestamptz)
  AND NOT ${PART_NOT_LIVE}
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.parts) p JOIN task_status s ON s.tenant_id = c.tenant_id AND s.project_id = c.project_id AND s.task_id = p ->> 'taskId' AND s.current_revision = (p ->> 'revision')::int AND s.status = 'verifying')`;

export function createVerificationDriver(options: VerificationDriverOptions): Pick<VerificationDriver, 'tick'> {
  const { db, tenantId } = options;
  const now = options.now ?? (() => new Date());
  const leaseSeconds = options.leaseSeconds ?? VERIFICATION_LEASE_SECONDS;
  const expiry = () => new Date(now().getTime() + leaseSeconds * 1000).toISOString();
  const maxRetries = options.maxVerificationRetries ?? 0;
  const backoffSeconds = options.retryBackoffSeconds ?? DEFAULT_RETRY_BACKOFF_SECONDS;
  const candKey = (c: Pick<CandidateRow, 'project_id' | 'run_id' | 'sha'>) => sql`tenant_id = ${tenantId} AND project_id = ${c.project_id} AND run_id = ${c.run_id} AND sha = ${c.sha}`;
  const candKeyFor = (alias: string, c: Pick<CandidateRow, 'project_id' | 'run_id' | 'sha'>) => sql`${sql.raw(alias)}.tenant_id = ${tenantId} AND ${sql.raw(alias)}.project_id = ${c.project_id} AND ${sql.raw(alias)}.run_id = ${c.run_id} AND ${sql.raw(alias)}.sha = ${c.sha}`;

  /** Atomically claims the oldest due candidate. Concurrent ticks and processes cannot claim the same one. */
  async function claimDue(holder: string, skip: readonly string[]): Promise<CandidateRow | null> {
    const at = now();
    const rows = await db.execute(sql`
      WITH due AS (
        SELECT c.tenant_id, c.project_id, c.candidate_id FROM candidates c WHERE c.tenant_id = ${tenantId} AND ${CANDIDATE_DUE(at)}${skip.length > 0 ? sql` AND c.sha NOT IN (${sql.join(skip.map((s) => sql`${s}`), sql`, `)})` : sql``}
        ORDER BY c.created_at, c.candidate_id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE candidates c SET detail = jsonb_set(c.detail, '{verificationDriver}', jsonb_build_object('holder', ${holder}::text, 'claimedAt', ${at.toISOString()}::text, 'expiresAt', ${expiry()}::text))
      FROM due WHERE c.tenant_id = due.tenant_id AND c.project_id = due.project_id AND c.candidate_id = due.candidate_id
      RETURNING c.project_id, c.run_id, c.sha, c.parts`);
    return (rows[0] as unknown as CandidateRow | undefined) ?? null;
  }

  /** False only on a definite answer: the candidate is gone or main has moved past it. A tip that cannot be read is no answer. */
  async function stillCurrent(c: Pick<CandidateRow, 'project_id' | 'run_id' | 'sha'>): Promise<boolean> {
    const [row] = await db.execute(sql`SELECT c.status, c.base_sha, c.target, p.repository FROM candidates c JOIN projects p ON p.tenant_id = c.tenant_id AND p.project_id = c.project_id WHERE c.tenant_id = ${tenantId} AND c.project_id = ${c.project_id} AND c.run_id = ${c.run_id} AND c.sha = ${c.sha}`);
    if (!row || row['status'] !== 'assembled') return false;
    const tip = await readTip(options.repoPath, options.remote, String(row['repository']), String(row['target'])).catch(() => null);
    return tip === null || tip === row['base_sha'];
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

  /** Runs one claimed candidate. True when a run completed; false when it could not start or lost its hold. The claim is released however this ends. */
  async function verifyOne(c: CandidateRow, holder: string): Promise<boolean> {
    const held = sql`${candKey(c)} AND detail -> 'verificationDriver' ->> 'holder' = ${holder}`;
    const renewer = setInterval(() => {
      void db.execute(sql`UPDATE candidates SET detail = jsonb_set(detail, '{verificationDriver,expiresAt}', to_jsonb(${expiry()}::text)) WHERE ${held}`).catch(() => undefined);
    }, Math.max(1, (leaseSeconds * 1000) / 3));
    renewer.unref();
    try {
      await announce(c);
      const { tenantId: _t, repoPath: _r, maxVerificationRetries: _m, retryBackoffSeconds: _b, remote: _g, ...deps } = options;
      await verifyCandidate({ tenantId, projectId: c.project_id, runId: c.run_id, sha: c.sha, taskId: c.parts[0]!.taskId, repoPath: options.repoPath }, { ...deps, leaseSeconds, stillCurrent: () => stillCurrent(c) });
      return true;
    } catch (e) {
      if (!(e instanceof CandidateNotVerifiable)) throw e;
      // The commit could not be exported: no run happened and none can. Anything else (re-assembled, another holder) is someone else's state to handle.
      if (e.reason === 'export_failed') await close(c, 'verification_export_failed');
      return false;
    } finally {
      clearInterval(renewer);
      await db.execute(sql`UPDATE candidates SET detail = detail - 'verificationDriver' WHERE ${held}`).catch(() => undefined);
    }
  }

  /** In one transaction: lock the candidate, close its waiting parts, retire it. A candidate no longer assembled is left alone. */
  async function close(c: Pick<CandidateRow, 'project_id' | 'run_id' | 'sha' | 'parts'>, reason: string): Promise<boolean> {
    return withTx(db, async (tx: Tx) => {
      const locked = await tx.execute(sql`SELECT 1 FROM candidates WHERE ${candKey(c)} AND status = 'assembled' FOR UPDATE`);
      if (locked.length === 0) return false;
      for (const p of c.parts) {
        await closeVerificationWithoutVerdict({ now }, tx, { tenantId, projectId: c.project_id, taskId: p.taskId }, { reason, candidateSha: c.sha, expect: { revision: p.revision, attemptId: p.attemptId } });
      }
      await tx.execute(sql`UPDATE candidates SET status = 'invalidated', reason = ${reason}, updated_at = ${now().toISOString()}::timestamptz WHERE ${candKey(c)}`);
      return true;
    });
  }

  /**
   * Keeps one infrastructure error alive for another run while retries remain: its check runs are invalidated, so the candidate is due again once the delay
   * passes. Under the candidate lock the same record must still be live, or another pass already dealt with it (`gone`). `exhausted` means the bound is reached
   * and the caller closes the candidate.
   */
  async function scheduleRetry(c: Pick<CandidateRow, 'project_id' | 'run_id' | 'sha'>, recordId: string): Promise<'scheduled' | 'exhausted' | 'gone'> {
    if (maxRetries <= 0) return 'exhausted';
    return withTx(db, async (tx: Tx) => {
      const locked = await tx.execute(sql`SELECT detail, (SELECT 1 ${sql`FROM artifacts a WHERE a.tenant_id = c.tenant_id AND a.project_id = c.project_id AND a.artifact_id = ${recordId} AND a.type = 'verification_record'`} AND a.locator ->> 'applied' = 'false' AND a.locator ->> 'result' = 'error' AND EXISTS (SELECT 1 FROM check_runs r WHERE r.tenant_id = a.tenant_id AND r.project_id = a.project_id AND r.candidate_sha = c.sha AND r.result <> 'invalidated' AND jsonb_exists(a.locator -> 'checkRunIds', r.check_run_id))) AS live FROM candidates c WHERE ${candKeyFor('c', c)} AND c.status = 'assembled' FOR UPDATE`);
      if (locked.length === 0 || locked[0]!['live'] === null) return 'gone';
      const retry = (locked[0]!['detail'] as { verificationRetry?: { count?: number } }).verificationRetry;
      const count = typeof retry?.count === 'number' ? retry.count : 0;
      if (count >= maxRetries) return 'exhausted';
      const notBefore = new Date(now().getTime() + backoffSeconds * 1000 * 2 ** count).toISOString();
      await tx.execute(sql`UPDATE check_runs SET result = 'invalidated' WHERE tenant_id = ${tenantId} AND project_id = ${c.project_id} AND candidate_sha = ${c.sha} AND result <> 'invalidated'`);
      await tx.execute(sql`UPDATE candidates SET detail = jsonb_set(detail, '{verificationRetry}', jsonb_build_object('count', ${count + 1}::int, 'notBefore', ${notBefore}::text)), updated_at = ${now().toISOString()}::timestamptz WHERE ${candKey(c)}`);
      return 'scheduled';
    });
  }

  /** Assembled candidates of this binding whose run applied nothing and ended `error` or `skipped`. An `error` with retries left is scheduled for another run instead of closing. */
  async function reap(retried: string[] = []): Promise<string[]> {
    const rows = await db.execute(sql`
      SELECT c.project_id, c.run_id, c.sha, c.parts,
        (SELECT a.locator ->> 'result' ${LIVE_RECORD} AND a.locator ->> 'applied' = 'false' ORDER BY a.created_at DESC, a.artifact_id DESC LIMIT 1) AS result,
        (SELECT a.artifact_id ${LIVE_RECORD} AND a.locator ->> 'applied' = 'false' ORDER BY a.created_at DESC, a.artifact_id DESC LIMIT 1) AS record_id
      FROM candidates c
      WHERE c.tenant_id = ${tenantId} AND c.status = 'assembled' AND c.sha IS NOT NULL
        AND NOT EXISTS (SELECT 1 ${LIVE_RECORD} AND a.locator ->> 'applied' = 'true')`);
    const reaped: string[] = [];
    for (const row of rows) {
      const reason = row['result'] === 'error' ? 'verification_error' : row['result'] === 'skipped' ? 'verification_skipped' : null;
      if (reason === null) continue;
      const c = row as unknown as CandidateRow;
      if (reason === 'verification_error') {
        const next = await scheduleRetry(c, String(row['record_id']));
        if (next === 'gone') continue;
        if (next === 'scheduled') { retried.push(c.sha); continue; }
      }
      if (await close(c, reason)) reaped.push(c.sha);
    }
    return reaped;
  }

  /** Retires assembled candidates that have a part no longer live and no record of this binding. Their other parts wait for the next assembly. */
  async function retire(): Promise<void> {
    await withTx(db, async (tx: Tx) => {
      const at = now();
      const rows = await tx.execute(sql`
        UPDATE candidates c SET status = 'invalidated', reason = 'candidate_part_not_live', updated_at = ${at.toISOString()}::timestamptz
        WHERE c.tenant_id = ${tenantId} AND c.status = 'assembled' AND c.sha IS NOT NULL AND NOT EXISTS (SELECT 1 ${LIVE_RECORD}) AND ${PART_NOT_LIVE}
        RETURNING c.candidate_id, c.project_id, c.run_id, c.sha`);
      for (const r of rows) {
        await emit(tx, { projectId: String(r['project_id']), runId: String(r['run_id']), taskId: String(r['run_id']), aggregateRevision: 0 }, at, {
          type: 'candidate.failed', attemptId: null, actor: { kind: 'integration', id: 'verification_driver' },
          payload: { candidateId: r['candidate_id'], reason: 'candidate_part_not_live', sha: r['sha'] },
        });
      }
    });
  }

  return {
    async tick() {
      const holder = `driver:${randomUUID()}`;
      await retire();
      // Oldest first, passing over any candidate main has already moved past: its Docker run would answer a question nobody is asking, and the rest of the queue should not wait behind it.
      let candidate: CandidateRow | null = null;
      const skipped: string[] = [];
      while (skipped.length <= MAX_SKIPPED_PER_TICK) {
        const next = await claimDue(holder, skipped);
        if (!next) break;
        if (await stillCurrent(next)) { candidate = next; break; }
        await db.execute(sql`UPDATE candidates SET detail = detail - 'verificationDriver' WHERE ${candKey(next)} AND detail -> 'verificationDriver' ->> 'holder' = ${holder}`);
        skipped.push(next.sha);
      }
      let verified: string | null = null;
      if (candidate) {
        try {
          if (await verifyOne(candidate, holder)) verified = candidate.sha;
        } catch (e) {
          // Whatever went wrong here, closing the already-recorded non-verdicts must still happen.
          await reap();
          throw e;
        }
      }
      // After the run, so a part cancelled mid-run retires its candidate on this tick and not the next.
      await retire();
      // Closes this tick's non-verdict and any an earlier process left behind, or schedules another run of an infrastructure error.
      const retried: string[] = [];
      const reaped = await reap(retried);
      return { verified, reaped, ...(retried.length > 0 ? { retried } : {}) };
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
