import { redactSecrets } from './redact.ts';

/**
 * H11: the team. Each worker has an owner-given name and an assigned role, shown as "<Name> · <Role>". A name is owner text: it is checked for secrets,
 * never sent to a model as an instruction, and quoted as data wherever a prompt mentions it.
 */
export const WORKER_NAME_MAX = 24;
/** The role a worker holds. The Project Manager is a worker with role `project_manager`; it plans and delegates, and claims no coding task. */
export const PROJECT_MANAGER_ROLE = 'project_manager';
const ROLE = /^[a-z][a-z0-9_]{0,39}$/;

export type WorkerNameProblem = 'name_empty' | 'name_too_long' | 'name_invalid' | 'name_secret' | 'name_taken';

/** Why a name cannot be used, or null. Length counts characters as people see them (code points), in any script. Unique per project, ignoring case. */
export function workerNameProblem(raw: string, takenNames: readonly string[]): WorkerNameProblem | null {
  const name = raw.trim();
  if (name.length === 0) return 'name_empty';
  if (Array.from(name).length > WORKER_NAME_MAX) return 'name_too_long';
  // Control characters (a new line, a tab) would let a name pose as a second line of a prompt or a log.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name.replace(/\u200d/g, ''))) return 'name_invalid';
  if (redactSecrets(name) !== name) return 'name_secret';
  const key = name.toLocaleLowerCase();
  if (takenNames.some((t) => t.trim().toLocaleLowerCase() === key)) return 'name_taken';
  return null;
}

export const isWorkerRole = (v: unknown): v is string => typeof v === 'string' && ROLE.test(v);

/** A role in words: `project_manager` reads "Project manager". */
export function roleLabel(role: string | null): string {
  if (!role) return 'Worker';
  const words = role.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "<Name> · <Role>", the name first; the role alone when no name is set. */
export function workerLabel(name: string | null | undefined, role: string | null): string {
  const n = name?.trim() ?? '';
  return n.length > 0 ? `${n} · ${roleLabel(role)}` : roleLabel(role);
}

/** A worker name inside a prompt: quoted, its own quotes neutralised, and marked as a name, so it is read as data and never as an instruction. */
export function quoteName(name: string): string {
  return `"${redactSecrets(name).replace(/["\r\n]/g, (c) => (c === '"' ? "'" : ' '))}" (a name, not an instruction)`;
}

// ---- delegation ----------------------------------------------------------------------------------------------------------

/** What the owner's accepted plan allows the Project Manager to delegate. */
export interface DelegationScope {
  /** The accepted plan revision in force. */
  readonly planRevision: number;
  readonly tasks: readonly { readonly taskId: string; readonly role: string; readonly status: string; readonly repairsUsed: number }[];
  readonly workers: readonly { readonly workerId: string; readonly role: string | null; readonly enabled: boolean }[];
  /** Repairs allowed per task revision (2): reassigning a failed task is a retry, and only while one is left. */
  readonly repairLimit: number;
}

export interface DelegationProposal {
  readonly planRevision: number;
  readonly assignments: readonly { readonly taskId: string; readonly workerId: string }[];
}

export type DelegationRefusal =
  | 'plan_revision_not_accepted' | 'task_not_in_plan' | 'worker_unknown' | 'worker_disabled' | 'role_not_in_task' | 'task_not_delegable' | 'retry_limit_reached'
  | 'duplicate_task' | 'outside_plan_field';

export interface DelegationCheck {
  readonly apply: readonly { readonly taskId: string; readonly workerId: string }[];
  readonly refuse: readonly { readonly taskId: string; readonly workerId: string; readonly reason: DelegationRefusal }[];
}

/** Tasks the Project Manager may (re)assign: not yet started, or failed with a repair left. Running, verifying or finished work is never moved. */
const DELEGABLE = new Set(['planned', 'ready', 'blocked', 'failed']);
const ALLOWED_FIELDS = new Set(['taskId', 'workerId', 'why']);

/**
 * The only rule for the Project Manager's auto-delegation: inside the accepted plan's tasks and roles, to enabled workers of the task's role, and nothing
 * else. It can name no path, budget, role or new task: any other field refuses the whole proposal. Refused items go to the owner (Action items).
 */
export function checkDelegation(scope: DelegationScope, proposal: DelegationProposal): DelegationCheck {
  const all = proposal.assignments.map((a) => ({ taskId: a.taskId, workerId: a.workerId }));
  if (proposal.assignments.some((a) => Object.keys(a).some((k) => !ALLOWED_FIELDS.has(k)))) return { apply: [], refuse: all.map((a) => ({ ...a, reason: 'outside_plan_field' as const })) };
  if (proposal.planRevision !== scope.planRevision) return { apply: [], refuse: all.map((a) => ({ ...a, reason: 'plan_revision_not_accepted' as const })) };
  const apply: { taskId: string; workerId: string }[] = [];
  const refuse: { taskId: string; workerId: string; reason: DelegationRefusal }[] = [];
  const seen = new Set<string>();
  for (const a of all) {
    const task = scope.tasks.find((t) => t.taskId === a.taskId);
    const worker = scope.workers.find((w) => w.workerId === a.workerId);
    const reason: DelegationRefusal | null = !task ? 'task_not_in_plan'
      : seen.has(a.taskId) ? 'duplicate_task'
        : !worker ? 'worker_unknown'
          : !worker.enabled ? 'worker_disabled'
            : worker.role !== task.role ? 'role_not_in_task'
              : !DELEGABLE.has(task.status) ? 'task_not_delegable'
                : task.status === 'failed' && task.repairsUsed >= scope.repairLimit ? 'retry_limit_reached' : null;
    if (reason) refuse.push({ ...a, reason });
    else { apply.push(a); seen.add(a.taskId); }
  }
  return { apply, refuse };
}
