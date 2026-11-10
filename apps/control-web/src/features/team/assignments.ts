import type { ModelAssignmentView, ProjectViewSnapshot, SettingState, TaskView } from '@selarikru/view-protocol';
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
  /** The model that applies when nothing is assigned here. Null: none does. */
  readonly inherited: { readonly provider: string; readonly model: string } | null;
  /** Set on a benchmark trial: its one model, which refuses overrides. */
  readonly pinned: { readonly provider: string; readonly model: string } | null;
  /** Whether the runners have acknowledged the saved assignment. Null: nothing saved here. */
  readonly state: SettingState | 'unknown' | null;
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

function modelLabel(snapshot: ProjectViewSnapshot, s: { readonly provider: string; readonly model: string }): string {
  return snapshot.modelCatalog.providers.find((p) => p.provider === s.provider)?.models.find((m) => m.modelId === s.model)?.label ?? s.model;
}

/** One task's override target, or null when the task can take no further attempt. */
export function taskTarget(t: TaskView, snapshot: ProjectViewSnapshot): AssignmentTarget | null {
  if (['verified', 'merged', 'cancelled', 'superseded'].includes(t.status)) return null;
  const entry = entryFor(snapshot, 'task', t.taskId);
  const pinned = snapshot.runs[t.runId]?.pinnedModel ?? null;
  const role = t.role ? selectionOf(entryFor(snapshot, 'role', t.role)) : null;
  const inherited = role ?? snapshot.modelCatalog.projectDefault;
  return { scope: 'task', key: t.taskId, label: t.title ?? t.taskId, current: selectionOf(entry), revision: entry?.revision ?? 0, fallback: inherited ? `Using ${role ? 'its role\'s model' : 'the project default'}: ${modelLabel(snapshot, inherited)}` : 'No model is assigned, and this project has no default', inherited, pinned, state: entry ? entry.state ?? 'unknown' : null };
}

const STATUS_TEXT: Readonly<Record<'none' | 'unknown', string>> = {
  none: 'No runner has reported an installed harness, so no model can be assigned and no worker can start.',
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
    const inherited = catalog.projectDefault;
    return { scope: 'role', key: role, label: role, current: selectionOf(entry), revision: entry?.revision ?? 0, fallback: inherited ? `Using the project default: ${modelLabel(snapshot, inherited)}` : 'No model is assigned, and this project has no default', inherited, pinned: null, state: entry ? entry.state ?? 'unknown' : null };
  });
  return { projectId: snapshot.meta.projectId, available, statusText, providers, roles };
}
