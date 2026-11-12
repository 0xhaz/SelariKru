import { createStore } from 'zustand/vanilla';

/**
 * H9 fix round 2: the panel's own "Draft a plan" action, offered to the guided tour while the panel can run it (it has the agents and a task to ask about).
 * Null: not ready. The tour calls this, so its question takes exactly the button's path: the same route, lock, history and checkpoint. True: a plan came back.
 */
export const pmPanelAction = createStore<{ askPlan: ((question: string) => Promise<boolean>) | null }>()(() => ({ askPlan: null }));


/**
 * M1: one call at a time, decided synchronously. A React state flag only changes on the next render, so two calls in the same tick both saw it clear; this one is a
 * plain object (the panel keeps it in a ref) set before anything is awaited.
 */
export interface BusyGuard { current: boolean }

/** Runs `run` unless one is already running on this guard, in which case it answers `whenBusy` at once and starts nothing. */
export async function exclusive<T>(guard: BusyGuard, whenBusy: T, run: () => Promise<T>): Promise<T> {
  if (guard.current) return whenBusy;
  guard.current = true;
  try {
    return await run();
  } finally {
    guard.current = false;
  }
}
