import { APPLY_HARNESS_REPORT, BaseFileRequestSchema, type CodingWorkers } from '@selarikru/domain';
import type { RunnerHarnessReport, RuntimeAdapter } from '@selarikru/protocol';
import { runAttempt, type AttemptDeps } from './attempt.ts';
import { answerFileRequest } from './files.ts';
import type { RunnerApi } from './api.ts';
import type { RunnerSettings } from './settings.ts';

export interface SweepingRuntime extends RuntimeAdapter {
  sweepOrphans(active: ReadonlySet<string>): Promise<string[]>;
}

export interface LoopDeps {
  readonly api: RunnerApi;
  readonly runtime: SweepingRuntime;
  readonly attempt: AttemptDeps;
  readonly pollMs: number;
  /** What this machine can launch, sent with every claim so the scheduler never hands it a model it cannot run. */
  readonly harnessReport?: () => Promise<readonly RunnerHarnessReport[]>;
  /** How many attempts this runner may hold at once. Defaults to one. */
  readonly slots?: number;
  /** Project ids to report to the server as having a checkout. Defaults to every configured repo. */
  readonly projects?: readonly string[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** The owner's settings as the server last sent them. Absent: every slot claims. */
  readonly settings?: RunnerSettings;
  /** How often to ask for base file reads waiting for this runner's checkouts (H5). Absent: this runner serves none. */
  readonly fileRequestMs?: number;
}

/**
 * What this runner reports it can launch. The no-model apply worker always; a model harness only when coding workers are on, and only then is it probed, so with
 * coding workers off no model CLI is ever started on this machine, not even for its version.
 */
export const harnessReportFor = (codingWorkers: CodingWorkers, probe: () => Promise<readonly RunnerHarnessReport[]>) => async (): Promise<readonly RunnerHarnessReport[]> =>
  (codingWorkers === 'off' ? [APPLY_HARNESS_REPORT] : [...(await probe()), APPLY_HARNESS_REPORT]);

const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/** Claims one task per slot over outbound HTTPS, runs it, and repeats. Opens no port. */
export class RunnerLoop {
  constructor(private readonly d: LoopDeps) {}

  async run(signal: AbortSignal): Promise<void> {
    const sleep = this.d.sleep ?? ((ms: number) => sleepUnlessAborted(ms, signal));
    // Reconcile first: a crash or sleep may have left a worker from a lease that has since expired.
    try {
      const removed = await this.d.runtime.sweepOrphans(new Set());
      if (removed.length > 0) this.d.log(`removed ${removed.length} orphaned sandbox(es) from an earlier run`);
    } catch (err) {
      this.d.log(`orphan sweep failed: ${err instanceof Error ? err.message : 'error'}`);
    }
    const slots = this.d.slots ?? 1;
    if (!Number.isInteger(slots) || slots < 1) throw new Error(`slots must be a whole number of at least 1, got ${String(slots)}`);
    await Promise.all([...Array.from({ length: slots }, (_, i) => this.worker(signal, sleep, i)), this.serveFiles(signal, sleep)]);
  }

  /** Answers base file reads for the patch agent from this runner's checkouts, git at the base only. Never blocks a slot. */
  private async serveFiles(signal: AbortSignal, sleep: (ms: number) => Promise<void>): Promise<void> {
    const every = this.d.fileRequestMs;
    const api = this.d.api;
    if (every === undefined || api.fileRequests === undefined || api.answerFiles === undefined) return;
    while (!signal.aborted) {
      try {
        const raw = await api.fileRequests();
        for (const r of Array.isArray(raw) ? raw : []) {
          const req = BaseFileRequestSchema.safeParse(r);
          if (!req.success) continue;
          const answer = await answerFileRequest(this.d.attempt.repos[req.data.projectId], req.data);
          await api.answerFiles(answer);
          // Counts only: no path or content reaches the log.
          this.d.log(`answered a base file read: ${answer.files.length} file(s), ${answer.omitted.length} left out`);
        }
      } catch (err) {
        this.d.log(`base file read not answered: ${err instanceof Error ? err.message : 'error'}`);
      }
      await sleep(every);
    }
  }

  /** One slot: claim, run, repeat. The server's limits decide how many slots actually hold work. */
  private async worker(signal: AbortSignal, sleep: (ms: number) => Promise<void>, slot: number): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      // A slot the owner took away asks for nothing more; it comes back if the owner gives it back.
      if (this.d.settings && !this.d.settings.mayClaim(slot)) {
        await sleep(this.d.pollMs);
        continue;
      }
      try {
        const claim = await this.d.api.claim(await this.d.harnessReport?.(), this.d.projects ?? Object.keys(this.d.attempt.repos));
        failures = 0;
        if (claim.lease) {
          this.d.log(`claimed ${claim.lease.taskId} as ${claim.lease.attemptId}`);
          const report = await runAttempt({ ...this.d.attempt, signal }, claim.lease);
          this.d.log(`attempt ${claim.lease.attemptId} ended: ${report.outcome}`);
          continue;
        }
        await sleep(this.d.pollMs);
      } catch (err) {
        failures += 1;
        this.d.log(`claim failed: ${err instanceof Error ? err.message : 'error'}`);
        await sleep(Math.min(this.d.pollMs * 2 ** failures, 60_000));
      }
    }
  }
}
