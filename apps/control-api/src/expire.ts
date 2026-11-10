import type { ExpiredLease, Scheduler } from '@selarikru/workflow';

export interface LeaseExpiryDriver {
  /** Runs one pass now. Used by tests and shutdown paths. */
  tick(): Promise<readonly ExpiredLease[]>;
  /** Completed or failed passes so far. */
  ticks(): number;
  /** Stops scheduling and waits for any pass in flight. */
  stop(): Promise<void>;
}

/**
 * Calls `scheduler.expireLeases(now())`, then the approval expiry sweep, on an interval. Passes never overlap (each is scheduled after the last one
 * ends), a failing pass is reported and retried on the next interval, and time comes from the injected clock.
 */
export function startLeaseExpiryDriver(options: {
  scheduler: Pick<Scheduler, 'expireLeases' | 'expireApprovals'>;
  now: () => Date;
  intervalMs: number;
  onError?: (error: unknown) => void;
  /** Runs after both sweeps, as a third independent one: a run cancel waiting only for a lease that has now expired is confirmed here. */
  afterPass?: (now: Date) => Promise<unknown>;
}): LeaseExpiryDriver {
  let stopped = false;
  let count = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();

  const tick = async (): Promise<readonly ExpiredLease[]> => {
    try {
      // Two independent sweeps: a thrown lease sweep must not skip approvals, or the reverse. Whatever failed is reported to `onError` once both have run.
      const failures: unknown[] = [];
      let expired: readonly ExpiredLease[] = [];
      try { expired = await options.scheduler.expireLeases(options.now()); } catch (e) { failures.push(e); }
      try { await options.scheduler.expireApprovals(options.now()); } catch (e) { failures.push(e); }
      if (options.afterPass) { try { await options.afterPass(options.now()); } catch (e) { failures.push(e); } }
      if (failures.length > 0) throw new AggregateError(failures, `lease expiry pass: ${failures.length} sweep(s) failed`);
      return expired;
    } finally {
      count += 1;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = tick()
        .catch((e: unknown) => options.onError?.(e))
        .finally(schedule);
    }, options.intervalMs);
  };
  schedule();

  return {
    tick,
    ticks: () => count,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
