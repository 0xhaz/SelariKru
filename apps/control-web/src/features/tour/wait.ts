import { pmPanelAction } from '../pm/panel-action.ts';

export const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => new Promise((resolve) => {
  const t = setTimeout(() => resolve('timeout'), ms);
  void p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve('timeout'); });
});

/** How long the tour gives the PM's plan. Development only: a test may shorten it (`window.__selarikruTourPmTimeoutMs`). */
export function pmTimeoutMs(): number {
  const dev = import.meta.env.DEV && typeof window !== 'undefined' ? (window as unknown as { __selarikruTourPmTimeoutMs?: unknown }).__selarikruTourPmTimeoutMs : undefined;
  return typeof dev === 'number' && dev > 0 ? dev : 60_000;
}

export type AskPlan = NonNullable<ReturnType<typeof pmPanelAction.getState>['askPlan']>;

/** H9 fix round 2, round 3: the PM panel's ready signal, or 'timeout'; the listener is removed either way. */
export function waitForPanel(ms: number): Promise<AskPlan | 'timeout'> {
  return new Promise((resolve) => {
    const now = pmPanelAction.getState().askPlan;
    if (now) { resolve(now); return; }
    const off = pmPanelAction.subscribe((st) => { if (st.askPlan) { off(); clearTimeout(timer); resolve(st.askPlan); } });
    const timer = setTimeout(() => { off(); resolve('timeout'); }, ms);
  });
}

