/** Whether a task has a change the browser can read, and how long its input is. Read with a bounded retry; a failure is never cached as an answer. */
export interface TaskFacts {
  readonly hasChange: boolean;
  readonly inputChars: number;
}

/** Waits between tries. Bounded: after these the read gives up and the screen offers a retry. */
export const FACTS_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 4000];

export async function loadFactsWithRetry(read: () => Promise<TaskFacts>, wait: (ms: number) => Promise<void>): Promise<TaskFacts | null> {
  for (let i = 0; ; i++) {
    try {
      return await read();
    } catch {
      const ms = FACTS_RETRY_DELAYS_MS[i];
      if (ms === undefined) return null;
      await wait(ms);
    }
  }
}
