import type { ModelAssignmentView, ProjectViewSnapshot, TaskView } from '@selarikru/view-protocol';
import { explain } from '../overview/attention.ts';

export interface ModelChoice {
  readonly modelId: string;
  readonly label: string;
  readonly allowed: boolean;
  /** Why it cannot be chosen, in plain words. Null when it can. */
  readonly refusal: string | null;
}

export interface ProviderChoice {
  readonly provider: string;
  readonly label: string;
  readonly models: readonly ModelChoice[];
}

export interface AssignmentTarget {
  readonly scope: 'role' | 'task';
  readonly key: string;
  readonly label: string;
  /** Null: no assignment here, so the fallback applies. */
  readonly current: { readonly provider: string; readonly model: string } | null;
  /** The revision a change must send back. */
  readonly revision: number;
  /** What applies when nothing is assigned here. */
  readonly fallback: string;
  /** Set on a benchmark trial: its one model, which refuses overrides. */
  readonly pinned: { readonly provider: string; readonly model: string } | null;
}

export interface AssignmentsModel {
  readonly projectId: string;
  /** False when no provider can be offered. */
  readonly available: boolean;
  /** Says why nothing is offered. Null when providers are. */
  readonly statusText: string | null;
  readonly providers: readonly ProviderChoice[];
  readonly roles: readonly AssignmentTarget[];
}

const entryFor = (snapshot: ProjectViewSnapshot, scope: 'role' | 'task', key: string): ModelAssignmentView | undefined => snapshot.modelAssignments.find((a) => a.scope === scope && a.key === key);

const selectionOf = (e: ModelAssignmentView | undefined): AssignmentTarget['current'] => (e && e.provider !== null && e.model !== null ? { provider: e.provider, model: e.model } : null);

/** One task's override target, or null when the task can take no further attempt. */
export function taskTarget(t: TaskView, snapshot: ProjectViewSnapshot): AssignmentTarget | null {
  if (['verified', 'merged', 'cancelled', 'superseded'].includes(t.status)) return null;
  const entry = entryFor(snapshot, 'task', t.taskId);
  const pinned = snapshot.runs[t.runId]?.pinnedModel ?? null;
  return { scope: 'task', key: t.taskId, label: t.title ?? t.taskId, current: selectionOf(entry), revision: entry?.revision ?? 0, fallback: 'Using the assignment for its role', pinned };
}

const STATUS_TEXT: Readonly<Record<'none' | 'unknown', string>> = {
  none: 'No provider was detected on this machine, so no model can be assigned and no worker can start.',
  unknown: 'Which providers are available is not known yet, so nothing can be assigned.',
};

/** The Team view's assignment panel, built from the snapshot alone. Only what the adapter declares is offered; policy's view of each model is carried, never guessed. */
export function buildAssignments(snapshot: ProjectViewSnapshot): AssignmentsModel {
  const catalog = snapshot.modelCatalog;
  const providers: ProviderChoice[] = catalog.providers.map((p) => ({
    provider: p.provider, label: p.label,
    models: p.models.map((m) => ({ modelId: m.modelId, label: m.label, allowed: m.allowedByPolicy, refusal: m.allowedByPolicy ? null : m.policyReason === null || m.policyReason === 'model_not_allowed' ? `Policy does not allow ${m.label} for this project.` : `${m.label} cannot be used: ${explain(m.policyReason)}` })),
  }));
  const available = catalog.status === 'detected' && providers.length > 0;
  const statusText = available ? null : (catalog.detail ?? STATUS_TEXT[catalog.status === 'detected' ? 'unknown' : catalog.status]);
  const roleNames = [...new Set([...Object.values(snapshot.tasks).flatMap((t) => (t.role ? [t.role] : [])), ...snapshot.modelAssignments.filter((a) => a.scope === 'role').map((a) => a.key)])].sort();
  const roles = roleNames.map((role): AssignmentTarget => {
    const entry = entryFor(snapshot, 'role', role);
    return { scope: 'role', key: role, label: role, current: selectionOf(entry), revision: entry?.revision ?? 0, fallback: 'Using the project default', pinned: null };
  });
  return { projectId: snapshot.meta.projectId, available, statusText, providers, roles };
}
