/**
 * Clocks for the runners. A trial's durations are taken from one monotonic clock and never from subtracting wall
 * timestamps of different machines (plan section 4).
 */

/** Milliseconds from a monotonic source. Never goes backwards. */
export type Monotonic = () => number;

export const performanceClock: Monotonic = () => performance.now();

/**
 * A `Date` clock that only moves forward: anchored to the wall clock once, then advanced by the monotonic source. The
 * worker runner hands it to the control API, its scheduler and the assembly and verification drivers, so every event
 * they stamp is on one monotonic server clock and intervals between them are `server-monotonic` durations. The dates
 * stay close to wall time for audit; a wall-clock step during a run does not move them.
 */
export function monotonicDateClock(mono: Monotonic = performanceClock, origin: number = Date.now()): () => Date {
  const start = mono();
  return () => new Date(origin + (mono() - start));
}
