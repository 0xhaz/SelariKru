import type { RunnerHarnessReport, RuntimeAdapter } from '@selarikru/protocol';
import { runAttempt, type AttemptDeps } from './attempt.ts';
import type { RunnerApi } from './api.ts';

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
  /** Project ids to report to the server as having a checkout. Defaults to every configured repo. */
  readonly projects?: readonly string[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
}

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

/** Claims one task at a time over outbound HTTPS, runs it, and repeats. Opens no port. */
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
    let failures = 0;
    while (!signal.aborted) {
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
