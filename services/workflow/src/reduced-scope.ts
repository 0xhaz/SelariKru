import { createHash } from 'node:crypto';
import { TaskSpecSchema } from '@selarikru/domain';
import { schema, type Executor } from '@selarikru/persistence';
import { and, eq } from 'drizzle-orm';
import type { RunScope } from './reserve.ts';

export const reducedScopeContext = (runId: string): string => `reduced_scope:${runId}`;
const BUDGET_STOP_REASON = 'budget_exhausted';

export interface NotDeliveredTask {
  readonly taskId: string;
  readonly revision: number;
  readonly status: string;
  /** True when the budget stop ended this task. False for work that never ran or did not finish: still not delivered. */
  readonly budgetStopped: boolean;
}

export interface ReducedScope {
  /** Every current task of the run that is not verified, merged or superseded, and everything those tasks carry. Never counted as verified. */
  readonly notDelivered: { readonly tasks: readonly NotDeliveredTask[]; readonly requirementIds: readonly string[]; readonly acceptanceCheckIds: readonly string[] };
  /** Carried by a verified or merged task and by no task in `notDelivered`. */
  readonly deliveredRequirementIds: readonly string[];
}

export interface AcceptedReducedScope extends ReducedScope {
  readonly decisionId: string;
  readonly runId: string;
  readonly planRevision: number;
  readonly acceptedAt: string;
  readonly acceptedBy: string;
}

export interface RunScopeAssessment extends ReducedScope {
  /** Tasks the budget stop ended. */
  readonly stopped: readonly { readonly taskId: string; readonly revision: number }[];
  /** Tasks with a budget stop still in flight. */
  readonly stopping: readonly string[];
}

/** A stable digest of a not-delivered list: what the owner was shown, compared with what is true at the moment of acceptance. */
export function notDeliveredHash(notDelivered: ReducedScope['notDelivered']): string {
  const tasks = [...notDelivered.tasks].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)).map((t) => [t.taskId, t.revision, t.status, t.budgetStopped]);
  return createHash('sha256').update(JSON.stringify({ tasks, requirementIds: [...notDelivered.requirementIds].sort(), acceptanceCheckIds: [...notDelivered.acceptanceCheckIds].sort() })).digest('hex');
}

const NOT_OWED: readonly string[] = ['verified', 'merged', 'superseded'];
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Reads where a run stands against its plan: what the budget stopped, and what is and is not delivered. */
export async function assessRunScope(q: Executor, scope: RunScope): Promise<RunScopeAssessment> {
  const tasks = await q
    .select({ taskId: schema.taskStatus.taskId, revision: schema.taskStatus.currentRevision, status: schema.taskStatus.status, spec: schema.taskRevisions.spec })
    .from(schema.taskStatus)
    .innerJoin(schema.taskRevisions, and(
      eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId),
      eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision)))
    .where(and(eq(schema.taskStatus.tenantId, scope.tenantId), eq(schema.taskStatus.projectId, scope.projectId), eq(schema.taskRevisions.runId, scope.runId)));
  const commands = (await q.select().from(schema.taskCommands).where(and(
    eq(schema.taskCommands.tenantId, scope.tenantId), eq(schema.taskCommands.projectId, scope.projectId), eq(schema.taskCommands.command, 'cancel'))))
    .filter((c) => c.detail['reason'] === BUDGET_STOP_REASON);
  const stopCommand = (t: { taskId: string; revision: number }, state: string) => commands.some((c) => c.state === state && c.taskId === t.taskId && c.revision === t.revision);

  const parsed = tasks.map((t) => ({ ...t, spec: TaskSpecSchema.parse(t.spec) })).sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
  const owed = parsed.filter((t) => !NOT_OWED.includes(t.status));
  const requirementIds = sorted(owed.flatMap((t) => t.spec.requirementIds));
  const stopped = parsed.filter((t) => t.status === 'cancelled' && stopCommand(t, 'cancelled'));
  return {
    stopped: stopped.map((t) => ({ taskId: t.taskId, revision: t.revision })),
    stopping: parsed.filter((t) => t.status === 'running' && stopCommand(t, 'cancel_requested')).map((t) => t.taskId),
    notDelivered: {
      tasks: owed.map((t) => ({ taskId: t.taskId, revision: t.revision, status: t.status, budgetStopped: t.status === 'cancelled' && stopCommand(t, 'cancelled') })),
      requirementIds,
      acceptanceCheckIds: sorted(owed.flatMap((t) => t.spec.acceptanceCheckIds)),
    },
    deliveredRequirementIds: sorted(parsed.filter((t) => t.status === 'verified' || t.status === 'merged').flatMap((t) => t.spec.requirementIds)).filter((id) => !requirementIds.includes(id)),
  };
}

/** The latest acceptance recorded for a run, or null. */
export async function loadAcceptedReducedScope(q: Executor, scope: RunScope): Promise<AcceptedReducedScope | null> {
  const rows = await q.select().from(schema.decisions).where(and(
    eq(schema.decisions.tenantId, scope.tenantId), eq(schema.decisions.projectId, scope.projectId), eq(schema.decisions.context, reducedScopeContext(scope.runId))));
  const latest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return (latest?.affected[0] as AcceptedReducedScope | undefined) ?? null;
}

/** True when the acceptance names every task the budget stopped, at the revision it was stopped at. */
export function acceptanceCovers(accepted: AcceptedReducedScope | null, stopped: RunScopeAssessment['stopped']): boolean {
  return accepted !== null && stopped.every((s) => accepted.notDelivered.tasks.some((t) => t.taskId === s.taskId && t.revision === s.revision));
}
