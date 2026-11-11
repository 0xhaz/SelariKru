import { createContext, useContext, useEffect, useState } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AuthorizedViewCommand, CommandReceipt, ProjectViewSnapshot } from '@selarikru/view-protocol';
import { CommandNotSent } from '../../shell/projection-store.ts';
import { NETWORK_MESSAGE, NOT_SENT_MESSAGE, rejectionView } from '../decisions/copy.ts';
import type { AgentsOutcome, AgentsPort, InFlightCall } from './agents.ts';
import type { AgentActionKind, BrowserInputs } from './model.ts';

/** What the "Runs on" control and the agent actions read: the snapshot (display only), the owner's commands and the task agents. */
export interface HybridValue {
  readonly projectId: string;
  readonly snapshot: ProjectViewSnapshot | null;
  readonly live: boolean;
  readonly mode: 'mock' | 'live';
  readonly execute: (command: AuthorizedViewCommand) => Promise<CommandReceipt>;
  readonly refresh: () => void;
  readonly resync: () => void;
  readonly agents: AgentsPort | null;
  readonly browser: BrowserInputs;
}

const Ctx = createContext<HybridValue | null>(null);
export const HybridProvider = Ctx.Provider;
export const useHybrid = (): HybridValue | null => useContext(Ctx);

/** The browser's own word on whether it is online. Feeds the suggestion only; it never routes a call. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = (): void => setOnline(true);
    const off = (): void => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** The agents' calls in flight, for the office. */
export function useInFlight(agents: AgentsPort | null): readonly InFlightCall[] {
  const [calls, setCalls] = useState<readonly InFlightCall[]>(() => agents?.inFlight() ?? []);
  useEffect(() => {
    if (!agents) return;
    setCalls(agents.inFlight());
    return agents.onInFlight(setCalls);
  }, [agents]);
  return calls;
}

export type SendResult = { readonly ok: true } | { readonly ok: false; readonly text: string };

/** Sends one owner command and says what happened in words. A refusal that means the screen was stale asks for a fresh snapshot. */
export async function sendCommand(h: Pick<HybridValue, 'execute' | 'resync' | 'refresh'>, intent: Omit<AuthorizedViewCommand, 'idempotencyKey'>): Promise<SendResult> {
  try {
    const receipt = await h.execute({ ...intent, idempotencyKey: `h4-${crypto.randomUUID()}` } as AuthorizedViewCommand);
    if (receipt.accepted) {
      h.refresh();
      return { ok: true };
    }
    const v = rejectionView(receipt.rejection);
    if (v.changed) h.resync();
    return { ok: false, text: v.text };
  } catch (e) {
    return { ok: false, text: e instanceof CommandNotSent ? NOT_SENT_MESSAGE : NETWORK_MESSAGE };
  }
}

// ---- results, held in memory only ---------------------------------------------------------------------------------------------

/** One step's latest result. Kept in this tab's memory only: never stored, so a restricted result never leaves the device this way. */
export type StepResult =
  | { readonly phase: 'running' }
  | { readonly phase: 'done'; readonly outcome: AgentsOutcome };

export interface HybridResults {
  readonly results: Readonly<Record<string, StepResult>>;
  /** The pull request description field, per run: filled from an accepted proposal, then the owner's to edit. */
  readonly prBody: Readonly<Record<string, string>>;
  set(key: string, r: StepResult | null): void;
  setPrBody(runId: string, body: string): void;
}

export const resultKey = (taskId: string, kind: AgentActionKind): string => `${taskId}|${kind}`;

export const hybridResults: StoreApi<HybridResults> = createStore<HybridResults>()((set) => ({
  results: {},
  prBody: {},
  set: (key, r) => set((s) => {
    const next = { ...s.results };
    if (r === null) delete next[key];
    else next[key] = r;
    return { results: next };
  }),
  setPrBody: (runId, body) => set((s) => ({ prBody: { ...s.prBody, [runId]: body } })),
}));

export const useHybridResults = <T,>(pick: (s: HybridResults) => T): T => useStore(hybridResults, pick);
