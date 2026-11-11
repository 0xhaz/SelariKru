import { create } from 'zustand';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';
import { workerIdentity } from '../team/identity.ts';
import { pmRefusal } from './copy.ts';

/**
 * H11 fix round 1 (I3): the Project Manager's assignments that were not applied (refused by the plan rule, or all of them while auto-delegation is off) wait in
 * Action items for the owner: "Assign <task> to <Name>? (proposed by the PM)", with Assign (the owner's own delegation, through the same rule) and Dismiss.
 * Kept in this tab, like the conversation they came from.
 */
export interface PmProposalItem {
  readonly id: string;
  readonly runId: string;
  readonly planRevision: number;
  readonly taskId: string;
  readonly workerId: string;
  readonly reason: string;
}

interface Store {
  readonly items: readonly PmProposalItem[];
  addRefused(runId: string, planRevision: number, refused: readonly { taskId: string; workerId: string; reason: string }[]): void;
  dismiss(id: string): void;
  clear(): void;
}

export const pmProposals = create<Store>((set) => ({
  items: [],
  addRefused: (runId, planRevision, refused) => set((s) => {
    const next = [...s.items];
    for (const r of refused) {
      const id = `${runId}:${r.taskId}:${r.workerId}`;
      const i = next.findIndex((x) => x.id === id);
      const item = { id, runId, planRevision, taskId: r.taskId, workerId: r.workerId, reason: r.reason };
      if (i >= 0) next[i] = item; else next.push(item);
    }
    return { items: next };
  }),
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
  clear: () => set({ items: [] }),
}));

export interface PmProposalRow extends PmProposalItem {
  readonly text: string;
  readonly why: string;
}

const roleOf = (snap: ProjectViewSnapshot, workerId: string): string | null => {
  const held = snap.workers[workerId]?.taskId;
  return held ? snap.tasks[held]?.role ?? null : null;
};

/** The rows to show: a proposal whose task now has a delegation (to anyone) or is gone is no longer asked. */
export function proposalRows(snap: ProjectViewSnapshot | null, items: readonly PmProposalItem[]): PmProposalRow[] {
  if (!snap) return [];
  return items.flatMap((x) => {
    const t = snap.tasks[x.taskId];
    if (!t || t.delegation) return [];
    const name = workerIdentity(snap, x.workerId, roleOf(snap, x.workerId) ?? t.role ?? null).label;
    return [{ ...x, text: `Assign ${t.title ?? t.taskId} to ${name}? (proposed by the PM)`, why: pmRefusal(x.reason, name) }];
  });
}
