import {
  RUNNER_RECENT_SECONDS, RoutePolicyModeSchema, SETTING_ENFORCER, TaskSpecSchema, isCloudCapable, isReduction, policyRevokedReason, transition, workerNameProblem,
  type TaskSpec, type TaskStatus,
  type RunnerConfig, type RunnerConfigAck, type SettingChange, type SettingField, type SettingValue,
} from '@selarikru/domain';
import { schema, withTx, type Db, type Executor, type Tx } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import { RunCancelRequestSchema, SettingRequestSchema } from '@selarikru/protocol';
import { buildTaskState, closeHandovers, loadAttempts, lockBudget, lockPartsForClaims, PLACEMENT_MODES, releaseTaskClaims, remainingBudgetMicros, requestPolicyStop, stopForExhaustedBudget, type SchedulerContext } from '@selarikru/workflow';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from './app.ts';
import { AppError, staleRevision } from './errors.ts';
import { recordedBudgetCeiling } from './routes-onboarding.ts';
import { parseBody } from './routes-owner.ts';
import { loadTaskRoute, taskRouteLocks } from './route-policy.ts';
import { bumpStatus, fingerprint, idempotent, newId, requireProject, requireRun, writeEvent } from './store.ts';

/**
 * Settings the owner changes while work is live, and the acknowledgements that put them in force.
 *
 * A save stores the desired value at a new revision. Policy the server enforces itself (allowed paths, cloud eligibility, the budget) is in force when the
 * save commits: the server is its enforcer and acknowledges it in the same transaction. What a runner holds (pause, a worker's enabled state and slots, a
 * model assignment) is in force only once the runner acknowledges the config revision that carries it, on its next claim poll or heartbeat. The server gates
 * claims on the desired value from the moment of the save either way, so a revoke never waits for an acknowledgement.
 */

const TERMINAL_RUN: readonly string[] = ['merged', 'failed', 'cancelled'];
const ACTIVE_TASK: readonly string[] = ['planned', 'ready', 'running', 'awaiting_approval', 'blocked', 'verifying'];
const CLAIMABLE: readonly string[] = ['planned', 'ready'];
const SYSTEM_ACTOR = { kind: 'system', id: 'control-api' } as const;
const SCHEDULER_ACTOR = { kind: 'scheduler', id: 'control-api' } as const;

const schedulerLock = (tx: Tx, tenantId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`selarikru.scheduler:${tenantId}`}, 0))`);

/** The tenant's runner config revision, raised by one. Every runner-acknowledged change carries the revision it was saved at. */
export async function bumpConfigRevision(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx.execute(sql`
    INSERT INTO runner_config (tenant_id, revision) VALUES (${tenantId}, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET revision = runner_config.revision + 1 RETURNING revision`);
  return Number(row!['revision']);
}

export async function currentConfigRevision(db: Executor, tenantId: string): Promise<number> {
  const [row] = await db.select({ revision: schema.runnerConfig.revision }).from(schema.runnerConfig).where(eq(schema.runnerConfig.tenantId, tenantId));
  return row?.revision ?? 0;
}

/**
 * Runners that called recently: the ones whose acknowledgement a project-wide change waits for. One that went quiet cannot claim, so it is not waited on;
 * one only just enrolled has never called (`last_polled_at` is null), so it is not waited on either until its first poll.
 */
async function recentRunners(db: Executor, tenantId: string, now: Date) {
  return db.select({ runnerId: schema.runners.runnerId, ack: schema.runners.configAckRevision }).from(schema.runners)
    .where(and(eq(schema.runners.tenantId, tenantId), isNull(schema.runners.revokedAt), gte(schema.runners.lastPolledAt, new Date(now.getTime() - RUNNER_RECENT_SECONDS * 1000))));
}

type Row = { desired: unknown; desiredRevision: number; effective: unknown; effectiveRevision: number };
/** What is in force now: the desired value once acknowledged, otherwise what was in force before it was saved. */
const inForce = (row: Row): unknown => (row.effectiveRevision >= row.desiredRevision ? row.desired : row.effective);

/** Plan paths of the run's current tasks: the widest an `allowed_paths` setting may be. */
async function planPaths(db: Executor, tenantId: string, projectId: string, runId: string): Promise<string[]> {
  const rows = await runTasks(db, tenantId, projectId, runId);
  return [...new Set(rows.flatMap((r) => r.spec?.allowedPaths ?? []))].sort();
}

async function runTasks(db: Executor, tenantId: string, projectId: string, runId: string) {
  const rows = await db.select({ taskId: schema.taskStatus.taskId, status: schema.taskStatus.status, revision: schema.taskStatus.currentRevision, rowRevision: schema.taskStatus.rowRevision, placementBlock: schema.taskStatus.placementBlock, spec: schema.taskRevisions.spec })
    .from(schema.taskStatus)
    .innerJoin(schema.taskRevisions, and(eq(schema.taskRevisions.tenantId, schema.taskStatus.tenantId), eq(schema.taskRevisions.projectId, schema.taskStatus.projectId), eq(schema.taskRevisions.taskId, schema.taskStatus.taskId), eq(schema.taskRevisions.revision, schema.taskStatus.currentRevision)))
    .where(and(eq(schema.taskStatus.tenantId, tenantId), eq(schema.taskStatus.projectId, projectId), eq(schema.taskRevisions.runId, runId)))
    .orderBy(asc(schema.taskStatus.taskId));
  return rows.map((r) => { const p = TaskSpecSchema.safeParse(r.spec); return { ...r, spec: p.success ? p.data : null }; });
}

/**
 * The run's tasks as they stand once their status rows are locked: the ids are read first, every row is locked in task order (with the claim lock after them
 * when claims will change), then each row is read again. Anything decided from a row is decided from the locked one, never from the read before the lock.
 */
async function lockedRunTasks(tx: Tx, tenantId: string, projectId: string, runId: string, claims: boolean) {
  const ids = (await runTasks(tx, tenantId, projectId, runId)).map((t) => t.taskId);
  if (claims) await lockPartsForClaims(tx, { tenantId, projectId }, ids);
  else if (ids.length > 0) await tx.select({ taskId: schema.taskStatus.taskId }).from(schema.taskStatus).where(and(eq(schema.taskStatus.tenantId, tenantId), eq(schema.taskStatus.projectId, projectId), inArray(schema.taskStatus.taskId, ids))).orderBy(asc(schema.taskStatus.taskId)).for('update');
  return runTasks(tx, tenantId, projectId, runId);
}

const cloudSlotsOf = (placement: { mode: string } | null): number => {
  const mode = placement && Object.hasOwn(PLACEMENT_MODES, placement.mode) ? PLACEMENT_MODES[placement.mode as keyof typeof PLACEMENT_MODES] : null;
  return mode?.cloudSlots ?? 0;
};

/** What a field is when nobody has saved it: the configured value the setting would narrow. */
async function configuredValue(tx: Executor, tenantId: string, projectId: string, run: typeof schema.runs.$inferSelect | null, field: SettingField): Promise<SettingValue | null> {
  switch (field) {
    case 'paused': return false;
    case 'enabled': return true;
    case 'slots': return null;
    case 'budget_limit_usd': { const v = run?.budget['limitUsd']; return typeof v === 'number' ? v : null; }
    case 'allowed_paths': return run ? await planPaths(tx, tenantId, projectId, run.runId) : null;
    case 'cloud_eligible': return run ? cloudSlotsOf(run.placement ?? null) > 0 : false;
    // The choice recorded at onboarding seeds the run default; a task has no override until one is saved.
    case 'route_policy': { const seeded = RoutePolicyModeSchema.safeParse(run?.setupSnapshot?.['inference']); return seeded.success ? seeded.data : null; }
    case 'route_override': return null;
    // H11: no name means the role label shows; no role means the worker claims as before; the Project Manager's auto-delegation is on by default (owner).
    case 'display_name': return null;
    case 'role': return null;
    case 'auto_delegate': return true;
  }
}

export interface SettingSaveResult {
  readonly scope: 'run' | 'runner' | 'task';
  readonly key: string;
  readonly field: SettingField;
  readonly desiredRevision: number;
  readonly effectiveRevision: number;
  /** `applied`: the server enforces it and did, in this save. `applying`: a runner must acknowledge it first. */
  readonly state: 'applied' | 'applying';
  readonly configRevision: number | null;
}

const runnerOwnerOf = (req: FastifyRequest): string => {
  if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
  return req.principal.uid;
};

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const auth = { onRequest: [ctx.owner] };
  const schedulerCtx = (): SchedulerContext => ({ db, now, policy: ctx.policy, catalog: ctx.catalog, codingWorkers: config.codingWorkers });

  app.post('/v1/projects/:id/settings', auth, async (req, reply) => {
    const uid = runnerOwnerOf(req);
    const projectId = (req.params as { id: string }).id;
    const body = parseBody(SettingRequestSchema, req.body);
    await requireProject(db, config.tenantId, projectId);
    const at = now();
    // Filled in the transaction and acted on after it commits: a rollback must not have closed anyone's session.
    let stopped: string[] = [];
    const result = await withTx(db, async (tx) => {
      // The scheduler lock first: a claim in flight finishes before this save, and every claim after it reads it. Then the run row, the setting row, the runner
      // config row, the run's task status rows in task order, and the event sequence (see the lock order in services/workflow/src/verification.ts).
      await schedulerLock(tx, config.tenantId);
      return idempotent(tx, { tenantId: config.tenantId, projectId, key: `setting:${body.change.scope}:${body.key}:${body.change.field}:${body.idempotencyKey}` }, fingerprint(body), async () => {
        const change = body.change;
        let run: typeof schema.runs.$inferSelect | null = null;
        let eventRunId: string;
        if (change.scope === 'run' || change.scope === 'task') {
          // A task setting is recorded against the task's current run, and changes only while that run is open.
          const task = change.scope === 'task' ? await loadTaskRoute(tx, config.tenantId, projectId, body.key, config.nanoInputBudgetChars) : null;
          if (change.scope === 'task' && !task) throw new AppError(404, 'task_not_found', 'no such task');
          run = await requireRun(tx, config.tenantId, task ? task.runId : body.key, true);
          if (run.projectId !== projectId) throw new AppError(404, 'run_not_found', 'no such run');
          if (TERMINAL_RUN.includes(run.lifecycle) || run.cancelRequestedAt !== null) throw new AppError(409, 'run_closed', `this run is ${run.cancelRequestedAt !== null ? 'being cancelled' : run.lifecycle}, so its settings no longer change`, { lifecycle: run.lifecycle });
          eventRunId = run.runId;
          // The data lock: restricted or secret data keeps a task's AI steps on the device. A cloud-capable override is refused; device only, or clearing it, is not.
          if (change.field === 'route_override' && task?.lock && change.value !== null && isCloudCapable(change.value)) {
            throw new AppError(409, 'route_locked_restricted', task.lock.reason, { label: task.lock.label, reason: task.lock.reason, requested: change.value });
          }
        } else {
          const [runner] = await tx.select().from(schema.runners).where(and(eq(schema.runners.tenantId, config.tenantId), eq(schema.runners.runnerId, body.key), isNull(schema.runners.revokedAt)));
          if (!runner) throw new AppError(404, 'runner_not_found', 'no such worker');
          const [latest] = await tx.select({ runId: schema.runs.runId }).from(schema.runs).where(and(eq(schema.runs.tenantId, config.tenantId), eq(schema.runs.projectId, projectId))).orderBy(desc(schema.runs.createdAt)).limit(1);
          if (!latest) throw new AppError(409, 'no_run', 'this project has no run to record the change against');
          eventRunId = latest.runId;
        }
        const table = change.scope === 'run' ? schema.runSettings : change.scope === 'task' ? schema.taskSettings : schema.runnerSettings;
        const where = change.scope === 'run'
          ? and(eq(schema.runSettings.tenantId, config.tenantId), eq(schema.runSettings.projectId, projectId), eq(schema.runSettings.runId, body.key), eq(schema.runSettings.field, change.field))
          : change.scope === 'task'
            ? and(eq(schema.taskSettings.tenantId, config.tenantId), eq(schema.taskSettings.projectId, projectId), eq(schema.taskSettings.taskId, body.key), eq(schema.taskSettings.field, change.field))
            : and(eq(schema.runnerSettings.tenantId, config.tenantId), eq(schema.runnerSettings.runnerId, body.key), eq(schema.runnerSettings.field, change.field));
        const [row] = await tx.select().from(table as typeof schema.runSettings).where(where).for('update');
        const current = row?.desiredRevision ?? 0;
        if (body.expectedRevision !== current) throw staleRevision(current, 'this setting');
        const before = (row ? row.desired : await configuredValue(tx, config.tenantId, projectId, run, change.field)) as SettingValue | null;
        await validate(tx, change, run, before, at, body.key);

        const enforcer = SETTING_ENFORCER[change.field];
        const revision = current + 1;
        const configRevision = enforcer === 'runner' ? await bumpConfigRevision(tx, config.tenantId) : null;
        const server = enforcer === 'server';
        const values = {
          field: change.field, desired: change.value, desiredRevision: revision,
          effective: server ? change.value : row ? inForce(row) : null, effectiveRevision: server ? revision : row?.effectiveRevision ?? 0,
          enforcer, configRevision, updatedBy: uid, updatedAt: at, appliedAt: server ? at : row?.appliedAt ?? null,
        };
        if (change.scope === 'run') {
          await tx.insert(schema.runSettings).values({ tenantId: config.tenantId, projectId, runId: body.key, ...values })
            .onConflictDoUpdate({ target: [schema.runSettings.tenantId, schema.runSettings.projectId, schema.runSettings.runId, schema.runSettings.field], set: values });
        } else if (change.scope === 'task') {
          // A cleared override is stored as JSON null: `desired` is never SQL NULL.
          const json = (v: unknown) => (v === null ? sql`'null'::jsonb` : v);
          const stored = { ...values, desired: json(values.desired), effective: json(values.effective), runId: eventRunId };
          await tx.insert(schema.taskSettings).values({ tenantId: config.tenantId, projectId, taskId: body.key, ...stored })
            .onConflictDoUpdate({ target: [schema.taskSettings.tenantId, schema.taskSettings.projectId, schema.taskSettings.taskId, schema.taskSettings.field], set: stored });
        } else {
          await tx.insert(schema.runnerSettings).values({ tenantId: config.tenantId, runnerId: body.key, ...values, eventProjectId: projectId, eventRunId })
            .onConflictDoUpdate({ target: [schema.runnerSettings.tenantId, schema.runnerSettings.runnerId, schema.runnerSettings.field], set: { ...values, eventProjectId: projectId, eventRunId } });
        }

        // What the change does to work already queued or running, on the server, before this transaction ends.
        const effects = run ? await applyServerEffects(tx, { tenantId: config.tenantId, projectId, run, uid, at }, change, before) : { blocked: [], unblocked: [], stopping: [], stoppingAttempts: [] };
        stopped = [...effects.stoppingAttempts];
        if (change.field === 'budget_limit_usd') {
          const budget = { ...run!.budget, limitUsd: change.value, ...(run!.budget['createdLimitUsd'] === undefined ? { createdLimitUsd: run!.budget['limitUsd'] ?? null } : {}) };
          await tx.update(schema.runs).set({ budget }).where(and(eq(schema.runs.tenantId, config.tenantId), eq(schema.runs.projectId, projectId), eq(schema.runs.runId, run!.runId)));

        }

        await writeEvent(tx, at, {
          projectId, runId: eventRunId, taskId: eventRunId, aggregateRevision: revision, type: 'settings.changed', actor: { kind: 'human', id: uid },
          payload: {
            scope: change.scope, key: body.key, field: change.field, from: before, to: change.value, revision, enforcer,
            ...(configRevision !== null ? { configRevision } : {}), reduction: isReduction(change.field, before, change.value),
            ...(effects.blocked.length > 0 ? { blocked: effects.blocked } : {}), ...(effects.stopping.length > 0 ? { stopping: effects.stopping } : {}), ...(effects.unblocked.length > 0 ? { unblocked: effects.unblocked } : {}),
          },
        });
        return { scope: change.scope, key: body.key, field: change.field, desiredRevision: revision, effectiveRevision: values.effectiveRevision, state: server ? 'applied' : 'applying', configRevision } satisfies SettingSaveResult;
      });
    });
    // A budget lowered below what is already committed stops running work through the existing budget stop, in its own transactions. It runs after every
    // accepted budget save, a replay included, so a retry still stops work a lost first pass did not; the stop itself acts only past the limit and only once.
    // The save is committed whatever happens here: a failed stop is logged, and a retry of the same save runs it again.
    if (body.change.field === 'budget_limit_usd') {
      try {
        await stopForExhaustedBudget(schedulerCtx(), { tenantId: config.tenantId, projectId, runId: body.key });
      } catch (err) {
        app.log.warn({ err, runId: body.key }, 'stopping work after a lower budget failed; retrying the save runs it again');
      }
    }
    for (const attemptId of stopped) ctx.control.endForAttempt(attemptId, 'attempt_fenced');
    return reply.code(200).send(result);
  });

  /** Checks a change against what the owner authorised and, for a resume, revalidates budget, policy and leases. Throws; writes nothing. */
  async function validate(tx: Tx, change: SettingChange, run: typeof schema.runs.$inferSelect | null, before: SettingValue | null, at: Date, key: string): Promise<void> {
    switch (change.field) {
      case 'allowed_paths': {
        const plan = await planPaths(tx, config.tenantId, run!.projectId, run!.runId);
        const outside = change.value.filter((p) => !plan.includes(p));
        if (outside.length > 0) throw new AppError(422, 'outside_plan_scope', 'A setting can only narrow the paths the accepted plan lists; a new path needs a plan revision.', { outside: outside.slice(0, 20) });
        return;
      }
      case 'cloud_eligible':
        if (change.value && cloudSlotsOf(run!.placement ?? null) === 0) throw new AppError(422, 'outside_recorded_limits', 'This run was not placed with cloud capacity, so cloud cannot be turned on here.');
        return;
      case 'budget_limit_usd': {
        const created = typeof run!.budget['createdLimitUsd'] === 'number' ? run!.budget['createdLimitUsd'] as number : typeof run!.budget['limitUsd'] === 'number' ? run!.budget['limitUsd'] as number : null;
        const ceiling = (await recordedBudgetCeiling(tx, config.tenantId, run!.projectId)) ?? created;
        if (ceiling === null || change.value > ceiling) throw new AppError(422, 'outside_recorded_limits', ceiling === null ? 'This run has no recorded budget to stay within, so it cannot be raised here.' : `A budget above $${ceiling} needs a scoped request: it is the most recorded for this run.`, { ceilingUsd: ceiling });
        return;
      }
      case 'slots':
        if (change.value > (config.caps.maxConcurrentTotal ?? 0)) throw new AppError(422, 'outside_recorded_limits', `A worker can hold at most ${config.caps.maxConcurrentTotal ?? 0} attempts: the total limit.`, { maxConcurrentTotal: config.caps.maxConcurrentTotal ?? null });
        return;
      case 'paused':
        if (change.value === false && before === true) {
          // Resume grants nothing until the run could actually take a claim: a policy loaded, budget left, and no lease still waiting to be reconciled.
          if (!ctx.policy) throw resumeRefused('policy_missing');
          const position = await lockBudget(tx, { tenantId: config.tenantId, projectId: run!.projectId, runId: run!.runId });
          if (position.limitMicros === null) throw resumeRefused('budget:missing_limit');
          const left = remainingBudgetMicros(position);
          if (left === null) throw resumeRefused('budget:unknown_cost');
          if (left <= 0) throw resumeRefused('budget:exhausted');
          const lapsed = await tx.select({ attemptId: schema.attempts.attemptId }).from(schema.attempts)
            .innerJoin(schema.taskRevisions, and(eq(schema.taskRevisions.tenantId, schema.attempts.tenantId), eq(schema.taskRevisions.projectId, schema.attempts.projectId), eq(schema.taskRevisions.taskId, schema.attempts.taskId), eq(schema.taskRevisions.revision, schema.attempts.revision)))
            .where(and(eq(schema.attempts.tenantId, config.tenantId), eq(schema.attempts.projectId, run!.projectId), eq(schema.taskRevisions.runId, run!.runId), isNull(schema.attempts.endedAt), isNotNull(schema.attempts.leaseToken), lte(schema.attempts.leaseExpiresAt, at))).limit(1);
          if (lapsed.length > 0) throw resumeRefused('lease_unreconciled');
        }
        return;
      case 'enabled':
        return;
      // Any mode is a valid run default: a locked task stays on the device whatever it says. The lock on a task override is checked with the task, above.
      case 'route_policy':
      case 'route_override':
        return;
      // H11: a worker's name is owner text: 1-24 characters in any script, no secret shapes, unique among this tenant's workers (ignoring case).
      case 'display_name': {
        if (change.value === null) return;
        const others = await tx.select({ runnerId: schema.runnerSettings.runnerId, desired: schema.runnerSettings.desired }).from(schema.runnerSettings)
          .where(and(eq(schema.runnerSettings.tenantId, config.tenantId), eq(schema.runnerSettings.field, 'display_name')));
        const taken = others.filter((r) => r.runnerId !== key && typeof r.desired === 'string').map((r) => r.desired as string);
        const problem = workerNameProblem(change.value, taken);
        if (problem) throw new AppError(422, problem, problem === 'name_taken' ? 'Another worker already has this name.' : 'This name cannot be used.');
        return;
      }
      // A role takes effect from the worker's next claim; a running attempt keeps the role it was claimed under.
      case 'role':
      case 'auto_delegate':
        return;
    }
  }

  // ---- cancel run ---------------------------------------------------------------------------------------------
  app.post('/v1/runs/:id/cancel', auth, async (req, reply) => {
    const uid = runnerOwnerOf(req);
    const runId = (req.params as { id: string }).id;
    const body = parseBody(RunCancelRequestSchema, req.body);
    const at = now();
    let stopping: string[] = [];
    const result = await withTx(db, async (tx) => {
      // Scheduler lock, run row, the run's status rows in task order, the claim lock, then the event sequence.
      await schedulerLock(tx, config.tenantId);
      const run = await requireRun(tx, config.tenantId, runId, true);
      return idempotent(tx, { tenantId: config.tenantId, projectId: run.projectId, key: `run.cancel:${runId}:${body.idempotencyKey}` }, fingerprint(body), async () => {
        if (body.expectedPlanRevision !== (run.planRevision ?? 0)) throw staleRevision(run.planRevision ?? 0, 'the run');
        if (TERMINAL_RUN.includes(run.lifecycle)) throw new AppError(409, 'run_closed', `this run is ${run.lifecycle}`, { lifecycle: run.lifecycle });
        if (run.cancelRequestedAt !== null) throw new AppError(409, 'cancel_pending', 'a cancel is already requested for this run');
        const operationId = newId('op');
        const tasks = (await lockedRunTasks(tx, config.tenantId, run.projectId, runId, true)).filter((t) => ACTIVE_TASK.includes(t.status));
        const stoppingTasks: string[] = [];
        const cancelled: string[] = [];
        const skipped: { taskId: string; reason: string }[] = [];
        for (const t of tasks) {
          const key = { tenantId: config.tenantId, projectId: run.projectId, taskId: t.taskId };
          const scope = { projectId: run.projectId, runId, taskId: t.taskId };
          if (t.status === 'running') {
            const open = await tx.select({ attemptId: schema.attempts.attemptId }).from(schema.attempts).where(and(eq(schema.attempts.tenantId, key.tenantId), eq(schema.attempts.projectId, key.projectId), eq(schema.attempts.taskId, key.taskId), isNull(schema.attempts.endedAt)));
            const pending = await tx.select({ id: schema.taskCommands.operationId }).from(schema.taskCommands).where(and(eq(schema.taskCommands.tenantId, key.tenantId), eq(schema.taskCommands.projectId, key.projectId), eq(schema.taskCommands.taskId, key.taskId), eq(schema.taskCommands.command, 'cancel'), eq(schema.taskCommands.state, 'cancel_requested'), eq(schema.taskCommands.revision, t.revision)));
            if (pending.length === 0) {
              await tx.insert(schema.taskCommands).values({ ...key, operationId: newId('op'), revision: t.revision, command: 'cancel', state: 'cancel_requested', requestedBy: uid, requestedAt: at, detail: { reason: 'run_cancelled', attemptIds: open.map((a) => a.attemptId) } });
              const rev = await bumpStatus(tx, key, t.rowRevision, t.status, at);
              await writeEvent(tx, at, { ...scope, aggregateRevision: rev, type: 'task.cancel_requested', actor: { kind: 'human', id: uid }, payload: { operationId, attemptIds: open.map((a) => a.attemptId), runCancelled: true } });
            }
            stopping.push(...open.map((a) => a.attemptId));
            stoppingTasks.push(t.taskId);
            continue;
          }
          const why = await closeTask(tx, key, scope, t, uid, operationId, at);
          if (why === null) cancelled.push(t.taskId);
          else skipped.push({ taskId: t.taskId, reason: why });
        }
        // A grant nobody used would release work that is no longer wanted: it expires now. The record of who granted it stays.
        const revoked = await tx.update(schema.approvals).set({ expiresAt: at }).where(and(
          eq(schema.approvals.tenantId, config.tenantId), eq(schema.approvals.projectId, run.projectId), eq(schema.approvals.runId, runId), eq(schema.approvals.outcome, 'granted'),
          isNull(schema.approvals.consumedAt), or(isNull(schema.approvals.expiresAt), sql`${schema.approvals.expiresAt} > ${at.toISOString()}::timestamptz`))).returning({ approvalId: schema.approvals.approvalId });
        await tx.update(schema.approvals).set({ outcome: 'superseded', resolvedAt: at }).where(and(eq(schema.approvals.tenantId, config.tenantId), eq(schema.approvals.projectId, run.projectId), eq(schema.approvals.runId, runId), eq(schema.approvals.outcome, 'pending')));
        await tx.update(schema.runs).set({ cancelRequestedAt: at, cancelRequestedBy: uid }).where(and(eq(schema.runs.tenantId, config.tenantId), eq(schema.runs.projectId, run.projectId), eq(schema.runs.runId, runId)));
        const revokedGrants = revoked.map((r) => r.approvalId).sort();
        await writeEvent(tx, at, { projectId: run.projectId, runId, taskId: runId, aggregateRevision: run.planRevision ?? 0, type: 'run.cancel_requested', actor: { kind: 'human', id: uid }, payload: { operationId, stopping: stoppingTasks, cancelled, revokedGrants, ...(skipped.length > 0 ? { skipped } : {}) } });
        if (stoppingTasks.length === 0) {
          await closeHandovers(tx, { tenantId: config.tenantId, projectId: run.projectId, runId }, 'run_cancelled', at);
          await markCancelled(tx, { tenantId: config.tenantId, projectId: run.projectId, runId }, run.planRevision ?? 0, operationId, at);
          return { operationId, state: 'applied' as const, stopping: stoppingTasks, cancelled, revokedGrants, skipped };
        }
        return { operationId, state: 'cancel_requested' as const, stopping: stoppingTasks, cancelled, revokedGrants, skipped };
      });
    });
    for (const attemptId of stopping) ctx.control.endForAttempt(attemptId, 'attempt_fenced');
    return reply.code(202).send(result);
  });
}

const resumeRefused = (reason: string): AppError => new AppError(409, 'resume_refused', 'Scheduling stays paused: the run cannot take work until this is resolved.', { reason });

/** Cancels a task that holds no live attempt: its status, its open requests and its claims, with the owner named. Status row and claim lock already held. */
async function closeTask(tx: Tx, key: { tenantId: string; projectId: string; taskId: string }, scope: { projectId: string; runId: string; taskId: string }, t: { status: string; revision: number; rowRevision: number; spec: TaskSpec | null }, by: string, operationId: string, at: Date): Promise<string | null> {
  // Through the domain's own transition, from the locked status: a status this cannot leave fails here rather than being overwritten.
  // A task that cannot be is skipped with a reason the server writes, so one bad row never stops the rest of the run from being cancelled.
  if (!t.spec) return 'spec_unreadable';
  const state = buildTaskState(t.spec, t.status as TaskStatus, await loadAttempts(tx, key, t.revision));
  if (!state) return 'spec_unreadable';
  const moved = transition(state, { type: 'cancel' });
  if (!moved.ok) return `cancel_not_allowed:${t.status}`;
  const rev = await bumpStatus(tx, key, t.rowRevision, moved.value.status, at);
  await tx.update(schema.approvals).set({ outcome: 'superseded', resolvedAt: at }).where(and(eq(schema.approvals.tenantId, key.tenantId), eq(schema.approvals.projectId, key.projectId), eq(schema.approvals.taskId, key.taskId), eq(schema.approvals.outcome, 'pending')));
  await releaseTaskClaims(tx, key, t.revision, at);
  await tx.update(schema.taskCommands).set({ state: 'cancelled' }).where(and(eq(schema.taskCommands.tenantId, key.tenantId), eq(schema.taskCommands.projectId, key.projectId), eq(schema.taskCommands.taskId, key.taskId), eq(schema.taskCommands.command, 'cancel'), eq(schema.taskCommands.state, 'cancel_requested')));
  await tx.insert(schema.taskCommands).values({ ...key, operationId: newId('op'), revision: t.revision, command: 'cancel', state: 'applied', requestedBy: by, requestedAt: at, detail: { reason: 'run_cancelled' } });
  const actor = by === SYSTEM_ACTOR.id ? SYSTEM_ACTOR : { kind: 'human' as const, id: by };
  await writeEvent(tx, at, { ...scope, aggregateRevision: rev, type: 'task.cancelled', actor, payload: { operationId, reason: 'cancel_requested', runCancelled: true } });
  return null;
}

async function markCancelled(tx: Tx, scope: { tenantId: string; projectId: string; runId: string }, revision: number, operationId: string | null, at: Date, skipped: readonly { taskId: string; reason: string }[] = []): Promise<void> {
  await tx.update(schema.runs).set({ lifecycle: 'cancelled' }).where(and(eq(schema.runs.tenantId, scope.tenantId), eq(schema.runs.projectId, scope.projectId), eq(schema.runs.runId, scope.runId)));
  // A hold whose attempt is gone is released; one an ended attempt settled stays, because that spend may have happened.
  await tx.execute(sql`UPDATE budget_reservations b SET state = 'released' WHERE b.tenant_id = ${scope.tenantId} AND b.project_id = ${scope.projectId} AND b.run_id = ${scope.runId} AND b.state = 'reserved'
    AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.tenant_id = b.tenant_id AND a.project_id = b.project_id AND 'res_' || a.attempt_id = b.reservation_id AND a.ended_at IS NULL)`);
  await writeEvent(tx, at, { projectId: scope.projectId, runId: scope.runId, taskId: scope.runId, aggregateRevision: revision, type: 'run.cancelled', actor: SYSTEM_ACTOR, payload: { ...(operationId ? { operationId } : {}), lifecycle: 'cancelled', ...(skipped.length > 0 ? { skipped } : {}) } });
}

/**
 * Finishes every requested run cancel whose active attempts have all ended or had their lease expire: any task still open is cancelled, holds with no
 * attempt are released, and the run becomes `cancelled`. Artifacts, attempts and events are kept. Called by the lease-expiry pass and after a runner's result.
 * Lock order: scheduler lock, run row, status rows, claim lock, event sequence.
 */
export async function finishCancelledRuns(deps: { db: Db; tenantId: string; now: () => Date }, only?: { projectId: string; runId: string }): Promise<string[]> {
  const pending = await deps.db.select({ projectId: schema.runs.projectId, runId: schema.runs.runId }).from(schema.runs)
    .where(and(eq(schema.runs.tenantId, deps.tenantId), isNotNull(schema.runs.cancelRequestedAt), sql`${schema.runs.lifecycle} NOT IN ('merged', 'failed', 'cancelled')`, ...(only ? [eq(schema.runs.projectId, only.projectId), eq(schema.runs.runId, only.runId)] : [])));
  const done: string[] = [];
  for (const p of pending) {
    const finished = await withTx(deps.db, async (tx) => {
      await schedulerLock(tx, deps.tenantId);
      const run = await requireRun(tx, deps.tenantId, p.runId, true);
      if (run.cancelRequestedAt === null || TERMINAL_RUN.includes(run.lifecycle)) return false;
      const tasks = await runTasks(tx, deps.tenantId, p.projectId, p.runId);
      const open = await tx.select({ attemptId: schema.attempts.attemptId }).from(schema.attempts)
        .where(and(eq(schema.attempts.tenantId, deps.tenantId), eq(schema.attempts.projectId, p.projectId), inArray(schema.attempts.taskId, tasks.length > 0 ? tasks.map((t) => t.taskId) : ['']), isNull(schema.attempts.endedAt))).limit(1);
      if (open.length > 0) return false;
      const at = deps.now();
      const left = (await lockedRunTasks(tx, deps.tenantId, p.projectId, p.runId, true)).filter((t) => ACTIVE_TASK.includes(t.status));
      const skipped: { taskId: string; reason: string }[] = [];
      for (const t of left) {
        const why = await closeTask(tx, { tenantId: deps.tenantId, projectId: p.projectId, taskId: t.taskId }, { projectId: p.projectId, runId: p.runId, taskId: t.taskId }, t, SYSTEM_ACTOR.id, newId('op'), at);
        if (why !== null) skipped.push({ taskId: t.taskId, reason: why });
      }
      // The run's handovers end with it: closed, with why, after the status rows `lockedRunTasks` took.
      await closeHandovers(tx, { tenantId: deps.tenantId, projectId: p.projectId, runId: p.runId }, 'run_cancelled', at);
      await markCancelled(tx, { tenantId: deps.tenantId, projectId: p.projectId, runId: p.runId }, run.planRevision ?? 0, null, at, skipped);
      return true;
    });
    if (finished) done.push(p.runId);
  }
  return done;
}

/** Sets a task's placement block at the revision it was locked at, and moves that revision. Leaves `updated_at`, which orders the queue, alone. */
async function setBlock(tx: Tx, key: { tenantId: string; projectId: string; taskId: string }, rowRevision: number, reason: string | null): Promise<number> {
  const moved = await tx.update(schema.taskStatus).set({ placementBlock: reason, rowRevision: rowRevision + 1 })
    .where(and(eq(schema.taskStatus.tenantId, key.tenantId), eq(schema.taskStatus.projectId, key.projectId), eq(schema.taskStatus.taskId, key.taskId), eq(schema.taskStatus.rowRevision, rowRevision)))
    .returning({ rowRevision: schema.taskStatus.rowRevision });
  if (moved.length === 0) throw staleRevision(rowRevision, `task ${key.taskId}`);
  return rowRevision + 1;
}

interface EffectScope { readonly tenantId: string; readonly projectId: string; readonly run: typeof schema.runs.$inferSelect; readonly uid: string; readonly at: Date }

/**
 * What a server-enforced change does at once. A narrowing blocks every queued task it now forbids (visibly, with `placement.blocked`) and asks every
 * running attempt it forbids to stop; the stopped task is blocked by policy, not cancelled. A widening clears the blocks it had caused. Status rows are
 * locked in task order.
 */
async function applyServerEffects(tx: Tx, s: EffectScope, change: SettingChange, before: SettingValue | null): Promise<{ blocked: string[]; unblocked: string[]; stopping: string[]; stoppingAttempts: string[] }> {
  const out = { blocked: [] as string[], unblocked: [] as string[], stopping: [] as string[], stoppingAttempts: [] as string[] };
  if (change.field !== 'allowed_paths' && change.field !== 'cloud_eligible') return out;
  const reason = policyRevokedReason(change.field);
  const tasks = (await lockedRunTasks(tx, s.tenantId, s.projectId, s.run.runId, false)).filter((t) => ACTIVE_TASK.includes(t.status));
  if (tasks.length === 0) return out;
  const reduction = isReduction(change.field, before, change.value);
  for (const t of tasks) {
    const key = { tenantId: s.tenantId, projectId: s.projectId, taskId: t.taskId };
    const forbidden = change.field === 'allowed_paths'
      ? (t.spec?.allowedPaths ?? []).some((p) => !(change.value as string[]).includes(p))
      : change.value === false;
    if (!forbidden) {
      if (t.placementBlock === reason) {
        // Given back: the block goes, the task's revision moves so a reader following events learns of it, and the event says who and why.
        const rev = await setBlock(tx, key, t.rowRevision, null);
        await writeEvent(tx, s.at, { projectId: s.projectId, runId: s.run.runId, taskId: t.taskId, aggregateRevision: rev, type: 'placement.cleared', actor: SCHEDULER_ACTOR, payload: { reason, cause: 'grant_restored', clearedBy: s.uid } });
        out.unblocked.push(t.taskId);
      }
      continue;
    }
    if (!reduction) continue;
    if (t.status === 'running') {
      // Cloud taken away stops only the attempts actually running in the cloud; a local attempt is untouched.
      const open = await tx.select({ attemptId: schema.attempts.attemptId, location: sql<string | null>`${schema.attempts.detail} ->> 'location'` }).from(schema.attempts)
        .where(and(eq(schema.attempts.tenantId, s.tenantId), eq(schema.attempts.projectId, s.projectId), eq(schema.attempts.taskId, t.taskId), isNull(schema.attempts.endedAt)));
      if (change.field === 'cloud_eligible' && !open.some((a) => a.location === 'cloud')) continue;
      if (await requestPolicyStop(tx, key, reason, s.uid, s.at)) {
        out.stopping.push(t.taskId);
        out.stoppingAttempts.push(...open.map((a) => a.attemptId));
      }
      continue;
    }
    // Cloud taken away leaves a queued task free to run locally; the claim decides that. A path taken away forbids it anywhere.
    if (change.field === 'allowed_paths' && CLAIMABLE.includes(t.status) && t.placementBlock !== reason) {
      const rev = await setBlock(tx, key, t.rowRevision, reason);
      await writeEvent(tx, s.at, { projectId: s.projectId, runId: s.run.runId, taskId: t.taskId, aggregateRevision: rev, type: 'placement.blocked', actor: SCHEDULER_ACTOR, payload: { reason, mode: null } });
      out.blocked.push(t.taskId);
    }
  }
  return out;
}

// ---- runner config -----------------------------------------------------------------------------------------------

/** What a runner is sent on every claim and heartbeat. */
export async function runnerConfigFor(db: Executor, tenantId: string, runnerId: string): Promise<RunnerConfig> {
  const revision = await currentConfigRevision(db, tenantId);
  const own = await db.select({ field: schema.runnerSettings.field, desired: schema.runnerSettings.desired }).from(schema.runnerSettings).where(and(eq(schema.runnerSettings.tenantId, tenantId), eq(schema.runnerSettings.runnerId, runnerId)));
  const enabled = own.find((r) => r.field === 'enabled');
  const slots = own.find((r) => r.field === 'slots');
  const paused = await db.select({ runId: schema.runSettings.runId }).from(schema.runSettings)
    .innerJoin(schema.runs, and(eq(schema.runs.tenantId, schema.runSettings.tenantId), eq(schema.runs.projectId, schema.runSettings.projectId), eq(schema.runs.runId, schema.runSettings.runId)))
    .where(and(eq(schema.runSettings.tenantId, tenantId), eq(schema.runSettings.field, 'paused'), sql`${schema.runSettings.desired} = 'true'::jsonb`, sql`${schema.runs.lifecycle} NOT IN ('merged', 'failed', 'cancelled')`))
    .orderBy(asc(schema.runSettings.runId)).limit(500);
  return {
    revision,
    enabled: enabled === undefined ? true : enabled.desired === true,
    slots: slots !== undefined && typeof slots.desired === 'number' ? slots.desired : null,
    pausedRunIds: paused.map((p) => p.runId),
  };
}

/**
 * Records what a runner says it has applied and puts in force every change that was waiting for it: this runner's own settings once it has acknowledged
 * their revision, and a run's pause or a model assignment once every recently seen runner has. A runner cannot acknowledge a revision that does not exist
 * yet. The project-wide check runs on every acknowledgement, whether or not this runner's own row moved, so a runner that falls out of the recent window
 * stops holding a change back as soon as anyone acknowledges again (and on the periodic pass, `settlePendingSettings`).
 *
 * Lock order: the runner row, then this runner's waiting settings rows by field, the waiting run settings rows by project, run and field, the waiting
 * assignment rows by project, scope and revision, all before the first event, then the event sequence. No scheduler lock, run row or status row is taken.
 */
export async function acknowledgeRunnerConfig(db: Db, tenantId: string, runnerId: string, ack: RunnerConfigAck, now: Date): Promise<number> {
  return withTx(db, async (tx) => {
    const latest = await currentConfigRevision(tx, tenantId);
    if (ack.revision > latest) return 0;
    await tx.update(schema.runners).set({ configAckRevision: ack.revision, configAckSlots: ack.slots, configAckAt: now })
      .where(and(eq(schema.runners.tenantId, tenantId), eq(schema.runners.runnerId, runnerId), sql`(${schema.runners.configAckRevision} IS NULL OR ${schema.runners.configAckRevision} < ${ack.revision} OR ${schema.runners.configAckSlots} IS DISTINCT FROM ${ack.slots})`));
    return settle(tx, tenantId, now, { runnerId, ack });
  });
}

/** The periodic pass: puts in force whatever every recent runner has already acknowledged, so a runner going quiet is enough to release a change. */
export async function settlePendingSettings(deps: { db: Db; tenantId: string; now: () => Date }): Promise<number> {
  return withTx(deps.db, (tx) => settle(tx, deps.tenantId, deps.now(), null));
}

async function settle(tx: Tx, tenantId: string, now: Date, own: { readonly runnerId: string; readonly ack: RunnerConfigAck } | null): Promise<number> {
  // Every row this may put in force is locked, in a fixed order, before the first event is written: a save holds its setting row while it waits for the
  // event sequence, so taking the sequence and then a setting row here could close a cycle with it.
  const mine = own === null ? [] : await tx.select().from(schema.runnerSettings)
    .where(and(eq(schema.runnerSettings.tenantId, tenantId), eq(schema.runnerSettings.runnerId, own.runnerId), sql`${schema.runnerSettings.effectiveRevision} < ${schema.runnerSettings.desiredRevision}`, lte(schema.runnerSettings.configRevision, own.ack.revision)))
    .orderBy(asc(schema.runnerSettings.field)).for('update');
  const recent = await recentRunners(tx, tenantId, now);
  // A recent runner that has never acknowledged runs a build that cannot: it is not counted as having acknowledged anything, so nothing waits on it as applied.
  const everyone = recent.length === 0 || recent.some((r) => r.ack === null) ? null : Math.min(...recent.map((r) => r.ack!));
  const runRows = everyone === null ? [] : await tx.select().from(schema.runSettings)
    .where(and(eq(schema.runSettings.tenantId, tenantId), eq(schema.runSettings.enforcer, 'runner'), sql`${schema.runSettings.effectiveRevision} < ${schema.runSettings.desiredRevision}`, lte(schema.runSettings.configRevision, everyone)))
    .orderBy(asc(schema.runSettings.projectId), asc(schema.runSettings.runId), asc(schema.runSettings.field)).for('update');
  const assignments = everyone === null ? [] : await tx.select().from(schema.modelAssignments)
    .where(and(eq(schema.modelAssignments.tenantId, tenantId), isNull(schema.modelAssignments.appliedAt), isNotNull(schema.modelAssignments.configRevision), lte(schema.modelAssignments.configRevision, everyone)))
    .orderBy(asc(schema.modelAssignments.projectId), asc(schema.modelAssignments.scopeKind), asc(schema.modelAssignments.scopeKey), asc(schema.modelAssignments.revision)).for('update');
  const by = recent.map((x) => x.runnerId).sort();
  let applied = 0;
  for (const r of mine) {
    // Slots in force are what the runner says it runs: it may have been started with fewer than the owner allowed.
    const value = r.field === 'slots' ? Math.min(Number(r.desired), own!.ack.slots) : r.desired;
    await tx.update(schema.runnerSettings).set({ effective: value, effectiveRevision: r.desiredRevision, appliedAt: now }).where(and(eq(schema.runnerSettings.tenantId, tenantId), eq(schema.runnerSettings.runnerId, own!.runnerId), eq(schema.runnerSettings.field, r.field)));
    await writeEvent(tx, now, { projectId: r.eventProjectId, runId: r.eventRunId, taskId: r.eventRunId, aggregateRevision: r.desiredRevision, type: 'settings.applied', actor: SYSTEM_ACTOR, payload: { scope: 'runner', key: own!.runnerId, field: r.field, value, revision: r.desiredRevision, acknowledgedBy: [own!.runnerId], configRevision: own!.ack.revision } });
    applied += 1;
  }
  for (const r of runRows) {
    await tx.update(schema.runSettings).set({ effective: r.desired, effectiveRevision: r.desiredRevision, appliedAt: now }).where(and(eq(schema.runSettings.tenantId, tenantId), eq(schema.runSettings.projectId, r.projectId), eq(schema.runSettings.runId, r.runId), eq(schema.runSettings.field, r.field)));
    await writeEvent(tx, now, { projectId: r.projectId, runId: r.runId, taskId: r.runId, aggregateRevision: r.desiredRevision, type: 'settings.applied', actor: SYSTEM_ACTOR, payload: { scope: 'run', key: r.runId, field: r.field, value: r.desired, revision: r.desiredRevision, acknowledgedBy: by, configRevision: everyone } });
    applied += 1;
  }
  for (const a of assignments) {
    await tx.update(schema.modelAssignments).set({ appliedAt: now }).where(and(eq(schema.modelAssignments.tenantId, tenantId), eq(schema.modelAssignments.projectId, a.projectId), eq(schema.modelAssignments.scopeKind, a.scopeKind), eq(schema.modelAssignments.scopeKey, a.scopeKey), eq(schema.modelAssignments.revision, a.revision)));
    const runId = await eventRunFor(tx, tenantId, a.projectId, a.scopeKind === 'task' ? a.scopeKey : null);
    if (runId !== null) await writeEvent(tx, now, { projectId: a.projectId, runId, taskId: runId, aggregateRevision: a.revision, type: 'settings.applied', actor: SYSTEM_ACTOR, payload: { scope: 'assignment', key: `${a.scopeKind}:${a.scopeKey}`, value: a.provider !== null ? { provider: a.provider, model: a.model } : null, revision: a.revision, acknowledgedBy: by, configRevision: everyone } });
    applied += 1;
  }
  return applied;
}

/** The run an assignment change is recorded against: the task's own run, or the project's newest run still in play, or its newest. Null: the project has no run. */
export async function eventRunFor(tx: Executor, tenantId: string, projectId: string, taskId: string | null): Promise<string | null> {
  if (taskId !== null) {
    const [row] = await tx.select({ runId: schema.taskRevisions.runId }).from(schema.taskRevisions).where(and(eq(schema.taskRevisions.tenantId, tenantId), eq(schema.taskRevisions.projectId, projectId), eq(schema.taskRevisions.taskId, taskId))).orderBy(desc(schema.taskRevisions.revision)).limit(1);
    if (row) return row.runId;
  }
  const runs = await tx.select({ runId: schema.runs.runId, lifecycle: schema.runs.lifecycle }).from(schema.runs).where(and(eq(schema.runs.tenantId, tenantId), eq(schema.runs.projectId, projectId))).orderBy(desc(schema.runs.createdAt));
  return (runs.find((r) => !TERMINAL_RUN.includes(r.lifecycle)) ?? runs[0])?.runId ?? null;
}

// ---- snapshot ----------------------------------------------------------------------------------------------------

export type SettingState = 'applied' | 'applying' | 'waiting_for_runner' | 'waiting_for_runner_update' | 'locked';

export interface SettingView {
  readonly scope: 'run' | 'runner' | 'task';
  readonly key: string;
  readonly field: SettingField;
  readonly desired: unknown;
  /** What is in force now. Null: nothing saved has been acknowledged yet, so the configured value still applies. */
  readonly effective: unknown;
  readonly desiredRevision: number;
  readonly effectiveRevision: number;
  readonly enforcer: 'server' | 'runner';
  readonly state: SettingState;
  /** The recent runners a `waiting_for_runner_update` change waits on: they run a build that does not acknowledge. */
  readonly waitingOn?: readonly string[];
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly appliedAt: string | null;
}

/** Who a pending change waits on, as the screen should name it. */
export interface Pending { readonly state: SettingState; readonly waitingOn?: readonly string[] }

/**
 * Where a change waiting on every recent runner stands: no runner seen (`waiting_for_runner`), a recent runner on a build that never acknowledges
 * (`waiting_for_runner_update`, naming it), or acknowledgements still due (`applying`).
 */
export function pendingOnEveryone(recent: readonly { runnerId: string; ack: number | null }[]): Pending {
  if (recent.length === 0) return { state: 'waiting_for_runner' };
  const old = recent.filter((r) => r.ack === null).map((r) => r.runnerId).sort();
  return old.length > 0 ? { state: 'waiting_for_runner_update', waitingOn: old } : { state: 'applying' };
}

/** The project's run settings and every worker's settings, each with whether it is in force. */
export async function loadSettingsView(tx: Executor, tenantId: string, projectId: string, now: Date): Promise<{ settings: SettingView[]; everyone: Pending }> {
  const recentRows = await recentRunners(tx, tenantId, now);
  const everyone = pendingOnEveryone(recentRows);
  const runRows = await tx.select().from(schema.runSettings).where(and(eq(schema.runSettings.tenantId, tenantId), eq(schema.runSettings.projectId, projectId))).orderBy(asc(schema.runSettings.runId), asc(schema.runSettings.field));
  const runnerRows = await tx.select().from(schema.runnerSettings).where(eq(schema.runnerSettings.tenantId, tenantId)).orderBy(asc(schema.runnerSettings.runnerId), asc(schema.runnerSettings.field));
  const taskRows = await tx.select().from(schema.taskSettings).where(and(eq(schema.taskSettings.tenantId, tenantId), eq(schema.taskSettings.projectId, projectId))).orderBy(asc(schema.taskSettings.taskId), asc(schema.taskSettings.field));
  const locks = await taskRouteLocks(tx, tenantId, projectId, taskRows.map((r) => r.taskId));
  const ofRunner = (runnerId: string): Pending => {
    const r = recentRows.find((x) => x.runnerId === runnerId);
    return !r ? { state: 'waiting_for_runner' } : r.ack === null ? { state: 'waiting_for_runner_update', waitingOn: [runnerId] } : { state: 'applying' };
  };
  const view = (scope: 'run' | 'runner' | 'task', key: string, r: typeof runRows[number] | typeof runnerRows[number] | typeof taskRows[number], pending: Pending): SettingView => {
    const p: Pending = r.effectiveRevision >= r.desiredRevision ? { state: 'applied' } : r.enforcer === 'runner' ? pending : { state: 'applying' };
    return {
      scope, key, field: r.field as SettingField, desired: r.desired, effective: inForce(r), desiredRevision: r.desiredRevision, effectiveRevision: r.effectiveRevision,
      enforcer: r.enforcer === 'runner' ? 'runner' : 'server', state: p.state, ...(p.waitingOn ? { waitingOn: [...p.waitingOn] } : {}),
      updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString(), appliedAt: r.appliedAt?.toISOString() ?? null,
    };
  };
  return {
    settings: [
      ...runRows.map((r) => view('run', r.runId, r, everyone)),
      ...runnerRows.map((r) => view('runner', r.runnerId, r, ofRunner(r.runnerId))),
      // A route override the data lock overrides is shown as such: in force as ONLY_ON_DEVICE, the same as the task's route. A saved ONLY_ON_DEVICE is not overridden.
      ...taskRows.map((r) => {
        const v = view('task', r.taskId, r, everyone);
        return r.field === 'route_override' && locks.get(r.taskId) && r.desired !== 'ONLY_ON_DEVICE' ? { ...v, effective: 'ONLY_ON_DEVICE', state: 'locked' as const } : v;
      }),
    ],
    everyone,
  };
}

/** A model assignment's place in the same rule: applied once every recent runner acknowledged it. One saved before acknowledgements existed has long been in force. */
export const assignmentState = (a: { configRevision: number | null; appliedAt: Date | null }, everyone: Pending): Pending =>
  a.configRevision === null || a.appliedAt !== null ? { state: 'applied' } : everyone;

export type PolicyBasis = 'configured' | 'recommended' | 'unresolved';
export interface PolicyValue<T> { readonly value: T | null; readonly basis: PolicyBasis }

/**
 * The run's effective policy, from the server's own rows: what the run may change, where it may run, how many workers and repairs it gets, what it may spend,
 * and how it merges. `configured`: set and in force. `recommended`: a value on record that was not applied, shown so the owner can choose it. `unresolved`:
 * missing, which blocks what depends on it; missing is never unlimited.
 */
export function boundedAutonomy(input: {
  readonly run: typeof schema.runs.$inferSelect;
  readonly planPaths: readonly string[];
  readonly settings: readonly SettingView[];
  readonly policy: Policy | undefined;
  readonly caps: { readonly maxConcurrentTotal?: number | null; readonly attemptTimeoutSeconds?: number | null };
  readonly recordedCeilingUsd: number | null | undefined;
}) {
  const { run, settings, policy, caps } = input;
  const own = (field: SettingField) => settings.find((s) => s.scope === 'run' && s.key === run.runId && s.field === field);
  const narrowed = own('allowed_paths');
  const paths = narrowed ? (Array.isArray(narrowed.effective) ? narrowed.effective as string[] : null) : input.planPaths.length > 0 ? [...input.planPaths] : null;
  const cloudSlots = cloudSlotsOf(run.placement ?? null);
  const cloudSetting = own('cloud_eligible');
  const cloudDestination = run.placement?.cloudDestination ?? null;
  const cloud: PolicyValue<boolean> = cloudSlots === 0 ? { value: false, basis: 'configured' }
    : cloudSetting?.effective === false ? { value: false, basis: 'configured' }
    : cloudDestination === null ? { value: null, basis: 'unresolved' } : { value: true, basis: 'configured' };
  const limit = run.budget['limitUsd'];
  const budget: PolicyValue<number> = typeof limit === 'number' ? { value: limit, basis: 'configured' }
    : typeof input.recordedCeilingUsd === 'number' ? { value: input.recordedCeilingUsd, basis: 'recommended' } : { value: null, basis: 'unresolved' };
  const repairs = policy?.limits?.repairAttempts;
  const paused = own('paused');
  return {
    allowedPaths: { value: paths, basis: paths === null ? 'unresolved' : 'configured' } satisfies PolicyValue<string[]>,
    planPaths: [...input.planPaths],
    cloudEligible: cloud,
    cloudDestination: { value: cloudDestination, basis: cloudSlots === 0 ? 'configured' : cloudDestination === null ? 'unresolved' : 'configured' } satisfies PolicyValue<string>,
    destinations: { value: policy ? (policy.destinations ?? []).map((d) => ({ destination: d.destination, purpose: d.purpose })) : null, basis: policy ? 'configured' : 'unresolved' } satisfies PolicyValue<{ destination: string; purpose: string }[]>,
    maxConcurrentWorkers: { value: caps.maxConcurrentTotal ?? null, basis: typeof caps.maxConcurrentTotal === 'number' ? 'configured' : 'unresolved' } satisfies PolicyValue<number>,
    repairAttempts: { value: typeof repairs === 'number' ? repairs : null, basis: typeof repairs === 'number' ? 'configured' : 'unresolved' } satisfies PolicyValue<number>,
    attemptTimeoutSeconds: { value: caps.attemptTimeoutSeconds ?? null, basis: typeof caps.attemptTimeoutSeconds === 'number' ? 'configured' : 'unresolved' } satisfies PolicyValue<number>,
    budgetLimitUsd: budget,
    // Agents never merge. This is not a setting: there is no other value.
    merge: { value: 'human', basis: 'configured' } satisfies PolicyValue<'human'>,
    schedulingPaused: { value: paused ? paused.desired === true : false, basis: 'configured' } satisfies PolicyValue<boolean>,
  };
}

export { planPaths as runPlanPaths };
