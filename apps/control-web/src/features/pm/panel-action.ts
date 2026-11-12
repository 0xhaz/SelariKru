import { createStore } from 'zustand/vanilla';

/**
 * H9 fix round 2: the panel's own "Draft a plan" action, offered to the guided tour while the panel can run it (it has the agents and a task to ask about).
 * Null: not ready. The tour calls this, so its question takes exactly the button's path: the same route, lock, history and checkpoint. True: a plan came back.
 */
export const pmPanelAction = createStore<{ askPlan: ((question: string) => Promise<boolean>) | null }>()(() => ({ askPlan: null }));

