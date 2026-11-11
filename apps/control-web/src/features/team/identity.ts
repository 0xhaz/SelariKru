import { roleLabel, workerLabel } from '@selarikru/domain';
import type { ProjectViewSnapshot } from '@selarikru/view-protocol';

/**
 * A worker's identity as the owner gave it (H11): its name and role from its settings, shown as "<Name> · <Role>". Without a name the role label shows; without a
 * role setting, the role of the task it holds. A role change is shown as in force only once effective (the server applies it at the worker's next claim); the saved
 * one is `pendingRole` until then.
 */
export interface WorkerIdentity {
  readonly name: string | null;
  readonly role: string | null;
  readonly label: string;
  readonly roleLabel: string;
  readonly pendingRole?: string;
}

export function workerIdentity(snapshot: ProjectViewSnapshot, workerId: string, taskRole: string | null): WorkerIdentity {
  const find = (field: string) => snapshot.settings.find((s) => s.scope === 'runner' && s.key === workerId && s.field === field);
  const n = find('display_name');
  const name = typeof n?.effective === 'string' && n.effective.trim() ? n.effective.trim() : null;
  const r = find('role');
  const inForce = typeof r?.effective === 'string' ? r.effective : null;
  const role = inForce ?? taskRole;
  const pending = typeof r?.desired === 'string' && r.desired !== inForce ? r.desired : null;
  return { name, role, label: workerLabel(name, role), roleLabel: roleLabel(role), ...(pending ? { pendingRole: pending } : {}) };
}
