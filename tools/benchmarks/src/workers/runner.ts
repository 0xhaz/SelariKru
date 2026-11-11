import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalDiskArtifactStore } from '@selarikru/artifacts';
import { PILOT_ROLE_PATHS } from '@selarikru/domain';
import { HttpRunnerApi, RunnerLoop, type SweepingRuntime } from '@selarikru/local-runner';
import type { HarnessCatalog, RunnerHarnessReport } from '@selarikru/protocol';
import { redactSecrets } from '@selarikru/protocol';
import { sql } from '@selarikru/persistence';
import type { Policy } from '@selarikru/policy';
import { classifyClaimReason } from '@selarikru/workflow';
import { allCriteriaPassed, FEEDBACK_CRITERIA } from '@selarikru/view-protocol';
import type { VerifierRunner } from '../../../../services/verifier/src/service.ts';
import { monotonicDateClock, performanceClock, type Monotonic } from '../clock.ts';
import { BENCH_CODING_WORKERS, type Manifest, type Slot } from '../manifest.ts';
import type { RawRecord } from '../report.ts';
import { assertLive, LiveRefusedError, NO_COST, NO_HUMAN_MINUTES, NO_OPERATIONS, NO_RESOURCES, NO_TIMINGS, plannedTrials, type LiveAuthorization, type PlannedTrial } from '../trials.ts';
import { collectTrial, type TrialEvidence } from './collect.ts';
import { freshStarterRepo, git, repoState } from './isolation.ts';
import { openStack, type Stack } from './stack.ts';

/**
 * Track B: worker delivery across L1, C1 and H2, driving the real product. Each trial gets a fresh clone of the
 * Feedback Board starter at the pinned SHA, a fresh database schema, a fresh project, run and runner enrolment, and a
 * fresh sandbox runtime with its own agent home, so no implementation, memory or session carries from one trial to
 * the next. Setup is timed separately. The deadline is the manifest's attempt timeout from coordinator acceptance.
 * Delivery timings come from the trial's server events on its monotonic clock; usage, cost provenance and the
 * verification outcome come from the trial's own ledger and verifier record.
 *
 * C1 and H2 need cloud capacity. Until it exists they are recorded `not_run` with `cloud_unavailable` and never
 * faked. The T6.7 cloud-location runner is a process on this machine, so it does not count as cloud here.
 *
 * A dry run (no `live`) is `simulated` data and never evidence. A live run requires the explicit live authorization:
 * a passing preflight for the workers track and its start recorded under this manifest.
 */

export const CLOUD_UNAVAILABLE = 'cloud_unavailable';
export const CLOUD_UNAVAILABLE_NOTE = 'No cloud capacity yet (waits for the coupon, D3 and D4). The T6.7 cloud-location runner is a local process, so it does not count as cloud for this benchmark; this mode is Not measured.';
const CLOUD_MODES: ReadonlySet<string> = new Set(['C1', 'H2', 'C2']);

export interface TrialStartState {
  readonly trialId: string;
  readonly schemaName: string;
  readonly repo: { readonly head: string; readonly refs: readonly string[]; readonly clean: boolean };
  /** Files in the worker's agent home before the trial's worker ran. */
  readonly agentHomeEntries: readonly string[];
  /** Rows of earlier runs visible in this trial's schema. */
  readonly priorRows: { readonly tasks: number; readonly events: number; readonly attempts: number; readonly runs: number };
}

export interface WorkerEnvironment {
  readonly databaseUrl: string;
  /** The pristine starter repository holding `repository.starterSha`. Trials clone it and never write to it. */
  readonly starterRepo: string;
  /** Where each trial's directory is made and then removed. */
  readonly workRoot: string;
  readonly catalog: HarnessCatalog;
  readonly runnerReport: readonly RunnerHarnessReport[];
  readonly policy: Policy;
  readonly verifierRunner: VerifierRunner;
  readonly verifierHost: string;
  /** A fresh sandbox runtime for one trial, with its own agent home and attempts root. */
  /**
   * `scope` is the trial's own sandbox owner scope: the runtime must name its sandboxes under it, so the trial's sweeps never touch the
   * owner's live sandboxes or another runner's on this machine.
   */
  runtime(o: { readonly home: string; readonly attemptsRoot: string; readonly trialId: string; readonly scope: string }): SweepingRuntime;
  /** Kept evidence per trial (verification record and candidate diff). Absent: none kept. */
  readonly evidenceDir?: string;
  readonly driverIntervalMs: number;
  readonly pollMs: number;
  readonly heartbeatMs: number;
  /** Tests only: scales the attempt timeout and deadline. A scaled run says so in its confounders. */
  readonly timeScale?: number;
  readonly onTrialStart?: (state: TrialStartState) => void;
  readonly log?: (line: string) => void;
  /**
   * I1: a trial with no start once `startWindowMs` has passed, whose claims were refused at least this many times for a non-transient
   * per-candidate reason, ends as a replaceable denied start naming that reason. Transient refusals only wait for the deadline. Defaults 5 and 3 minutes.
   */
  readonly maxStartRefusals?: number;
  readonly startWindowMs?: number;
  /** I4: reads the worker agent's state for a trial's scope, before and after it. Absent (the dry run): not checked. */
  readonly agentState?: (scope: string) => Promise<AgentState>;
  /** Tests only: wraps the runner's HTTP client (for example to answer claims with scripted refusals). */
  readonly wrapRunnerFetch?: (f: typeof fetch) => typeof fetch;
}

/** What `agentState` reports. Names only; never a credential or account detail. */
export interface AgentState {
  /** Sandboxes in the trial's own scope. Empty before a trial starts and after it ends, or state could carry over. */
  readonly scopedSandboxes: readonly string[];
  /** sbx's `kit.shortcuts.claude` setting: a machine-wide image override for every Claude sandbox. Null when unset. */
  readonly kitShortcut: string | null;
  /** Whether sbx holds a global `anthropic` service secret, the path by which the owner's login reaches every sandbox. Null when unknown. */
  readonly sandboxSecret: boolean | null;
}

export const SHARED_AGENT_STATE = 'shared_agent_state';

/** How the credential reaches the worker's sandbox, as recorded on every live trial. Never the credential. */
function credentialPathOf(m: Manifest, state: AgentState | null): string {
  if (state === null) return `declared credential mode ${m.credentials.mode}: not checked (dry run: no credential reaches the scripted worker)`;
  const via = state.sandboxSecret === true ? 'sbx global anthropic service secret present (type not verified), injected by the sbx proxy; nothing is copied into the sandbox and no home directory is mounted'
    : state.sandboxSecret === false ? 'no sbx global anthropic service secret listed, so the sandbox has no credential' : 'unknown: `sbx secret ls --json` could not be read';
  return `declared credential mode ${m.credentials.mode}: ${via}`;
}

const describeState = (s: AgentState | null): string => (s === null ? 'not checked'
  : `${s.scopedSandboxes.length === 0 ? 'no sandbox in scope' : `${s.scopedSandboxes.length} sandbox(es) in scope`}${s.kitShortcut ? `, kit.shortcuts.claude=${s.kitShortcut}` : ''}`);

export interface WorkerCohortOptions {
  readonly manifest: Manifest;
  readonly env: WorkerEnvironment;
  /** Records already written for this cohort: the run continues after them. */
  readonly prior?: readonly RawRecord[];
  /** Null: a dry run, recorded as simulated. */
  readonly live: LiveAuthorization | null;
  /** The variable spend ceiling for this track. Default: the manifest's coding, planning and verification budget plus cloud runtime. */
  readonly budgetUsd?: number;
  /** Spend already charged to this ceiling by earlier invocations of the same cohort (the CLI keeps it in its budget ledger). */
  readonly spentUsd?: number;
  /** An earlier invocation could not meter its spend: the budget is not a cap, so nothing more runs. */
  readonly unmetered?: boolean;
  /** Aborted by the operator: the trial in progress is cancelled and the rest are recorded not run. */
  readonly signal?: AbortSignal;
  /** Called with each record as its trial ends, so a crash loses nothing already finished. */
  readonly onRecord?: (record: RawRecord) => void;
  readonly mono?: Monotonic;
}

export interface WorkerCohortResult {
  readonly records: readonly RawRecord[];
  /** Including `spentUsd` passed in. */
  readonly spentUsd: number;
  readonly unmetered: boolean;
  readonly budgetUsd: number;
}

const notRunCriteria = (): RawRecord['quality']['criteria'] => FEEDBACK_CRITERIA.map((id) => ({ id, status: 'not_run' as const, evidenceReferences: [] }));

/** D6: every worker record names how the harness authenticated and the account tier, as the manifest pins them. */
const accountOf = (m: Manifest) => ({ credentialMode: m.credentials.mode, accountTier: m.environment.accountTier, credentialPath: null, agentState: null });

function notRunRecord(m: Manifest, p: PlannedTrial, dataKind: RawRecord['dataKind'], category: string, detail: string | null, confounders: readonly string[] = []): RawRecord {
  const slot = p.slot as Extract<Slot, { track: 'workers' }>;
  return {
    dataKind, status: 'not_run', track: 'workers', trialId: p.trialId, mode: slot.mode, blockId: slot.block, attemptId: p.trialId, slotId: slot.id, slotAttempt: p.slotAttempt,
    configuration: { candidateSha: null, inferenceDestination: null, providerAccountReference: null, ...accountOf(m), cacheCondition: null, localHost: null, cloudHost: null },
    assistant: null, timings: NO_TIMINGS, resources: NO_RESOURCES, cost: NO_COST, humanMinutes: NO_HUMAN_MINUTES,
    quality: { allRequiredChecksPassed: null, criteria: notRunCriteria(), withinDeclaredLimits: null }, operations: NO_OPERATIONS,
    failures: [{ category, detail }], confounders: [...confounders], artifactReferences: [],
  };
}

/**
 * Spend so far against the ceiling. Each trial is charged what it is known to have cost; an attempt whose cost was not
 * reported is charged its worst-case hold, which the product reserved before the attempt started and which bounds what
 * it could spend. Only when not even that is known is the budget unmetered, and an unmetered budget is never a cap.
 */
class Budget {
  spent = 0;
  unmetered = false;
  constructor(readonly ceiling: number) {}
  get remaining(): number { return Math.max(0, this.ceiling - this.spent); }
  blocker(): string | null {
    if (this.unmetered) return 'budget_unmetered';
    return this.remaining < 0.01 ? 'budget_exhausted' : null;
  }
  charge(usd: number | null): void {
    if (usd === null) this.unmetered = true;
    else this.spent += usd;
  }
}

/** A trial's sandbox owner scope. Null when the cohort has no identity to scope by, and then nothing runs live. */
export function sandboxScopeFor(m: Manifest, trialId: string, suffix: string): string | null {
  return m.cohortId === null ? null : `bench:${m.cohortId}:${trialId}:${suffix}`;
}

export async function runWorkerCohort(o: WorkerCohortOptions): Promise<WorkerCohortResult> {
  const { manifest: m, env } = o;
  if (o.live !== null) {
    // Without its own scope a trial could only sweep machine-wide: refused before any trial, and no sandbox is touched.
    if (sandboxScopeFor(m, 'probe', 'probe') === null) throw new LiveRefusedError(['sandbox_scope_unavailable']);
    assertLive(m, 'workers', o.live);
  }
  const dataKind: RawRecord['dataKind'] = o.live === null ? 'simulated' : 'measured';
  const prior = (o.prior ?? []).filter((r) => r.track === 'workers' && r.dataKind === dataKind);
  // A cloud mode whose last record says cloud was unavailable stays recorded as such while it still is.
  const trials = plannedTrials(m, 'workers', prior, (slot, last) => CLOUD_MODES.has(slot.mode) && last.failures.some((f) => f.category === CLOUD_UNAVAILABLE));
  const budget = new Budget(o.budgetUsd ?? m.proposedVariableBudgetUsd.codingPlanningVerificationModelsAndTools + m.proposedVariableBudgetUsd.cloudRuntime);
  // Each runnable trial may spend at most its share of the ceiling, so the cohort as planned fits inside it.
  budget.spent = o.spentUsd ?? 0;
  budget.unmetered = o.unmetered ?? false;
  const runnable = trials.filter((p) => !CLOUD_MODES.has((p.slot as Extract<Slot, { track: 'workers' }>).mode)).length;
  const share = runnable === 0 ? 0 : budget.ceiling / runnable;
  const records: RawRecord[] = [];
  const emit = (r: RawRecord, spentUsd: number | null = 0): void => { records.push(r); budget.charge(spentUsd); o.onRecord?.(r); };
  for (const trial of trials) {
    const mode = (trial.slot as Extract<Slot, { track: 'workers' }>).mode;
    if (CLOUD_MODES.has(mode)) { emit(notRunRecord(m, trial, dataKind, CLOUD_UNAVAILABLE, CLOUD_UNAVAILABLE_NOTE, [CLOUD_UNAVAILABLE_NOTE])); continue; }
    if (o.signal?.aborted) { emit(notRunRecord(m, trial, dataKind, 'cohort_stopped', 'the operator stopped the cohort before this trial')); continue; }
    const blocked = budget.blocker();
    if (blocked !== null) {
      emit(notRunRecord(m, trial, dataKind, blocked, blocked === 'budget_exhausted' ? `the $${budget.ceiling} ceiling is spent` : 'an earlier trial\'s spend is unknown, so the remaining budget cannot be enforced'));
      continue;
    }
    const ran = await runLocalTrial({ trial, manifest: m, env, dataKind, budgetUsd: Math.min(budget.remaining, share), signal: o.signal, mono: o.mono ?? performanceClock });
    emit(ran.record, ran.spentUsd);
  }
  return { records, spentUsd: budget.spent, unmetered: budget.unmetered, budgetUsd: budget.ceiling };
}

interface TrialInput {
  readonly trial: PlannedTrial;
  readonly manifest: Manifest;
  readonly env: WorkerEnvironment;
  readonly dataKind: RawRecord['dataKind'];
  readonly budgetUsd: number;
  readonly signal: AbortSignal | undefined;
  readonly mono: Monotonic;
}

type Ending = 'delivered' | 'failed' | 'timed_out' | 'cancelled' | 'denied';

/** I1: what the runner's claims answered before the trial's first start. Only non-transient refusals count. */
interface ClaimWatch { nonTransient: number; lastReason: string | null; leased: boolean }

/**
 * m2: reads one claim answer. Null when it leased. Otherwise the refusal that matters: the first non-transient per-candidate reason, else the
 * first transient one, else the summary reason, which is used only when no candidate was considered.
 */
export function refusalOf(body: { lease: unknown; reason?: string | null; skipped?: readonly { taskId: string; reason: string }[] }): { transient: boolean; reason: string } | null {
  if (body.lease) return null;
  // The table is the workflow's own (claim-reasons.ts): a reason it does not know is treated as not clearing by itself.
  const transient = (r: string): boolean => classifyClaimReason(r).transient;
  const reasons = (body.skipped ?? []).map((s) => s.reason);
  const hard = reasons.find((r) => !transient(r));
  if (hard !== undefined) return { transient: false, reason: hard };
  if (reasons.length > 0) return { transient: true, reason: reasons[0]! };
  const summary = body.reason ?? 'unknown';
  return { transient: transient(summary), reason: summary };
}

/** Watches the claim answers on the runner's own HTTP client: the per-candidate reasons the client itself does not keep. */
function watchClaims(fetchImpl: typeof fetch, watch: ClaimWatch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetchImpl(input, init);
    if (new URL(input instanceof Request ? input.url : String(input)).pathname === '/v1/runners/claim' && res.ok) {
      try {
        const refusal = refusalOf((await res.clone().json()) as Parameters<typeof refusalOf>[0]);
        if (refusal === null) { watch.leased = true; watch.nonTransient = 0; }
        else if (!refusal.transient) { watch.nonTransient += 1; watch.lastReason = refusal.reason; }
        else if (watch.lastReason === null) watch.lastReason = refusal.reason;
      } catch { /* an unreadable answer is the runner's to handle */ }
    }
    return res;
  }) as typeof fetch;
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');
const until = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done(): void { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

/** L1: both pilot roles on one local coding slot, as the product schedules them. */
function tasksFor(m: Manifest, stack: Stack, runId: string, starterSha: string, timeoutSeconds: number, maxCostUsd: number, policy: Policy, suffix: string) {
  const maxAttempts = 1 + (policy.limits?.repairAttempts ?? 2);
  return (['backend', 'frontend'] as const).map((role) => ({
    schemaVersion: 1, tenantId: stack.tenantId, projectId: stack.projectId, runId, taskId: `t_${role}_${suffix}`, boardId: 'feedback-board', revision: 1, role,
    title: `Feedback Board ${role}`, baseSha: starterSha, requirementIds: [...m.requirementIds], dependencies: [], contractRefs: [], allowedPaths: [...PILOT_ROLE_PATHS[role]],
    resourceClaims: [], acceptanceCheckIds: [], classification: 'internal', policyVersion: policy.policyVersion, execution: 'local', inferencePolicyId: 'benchmark',
    limits: { maxAttempts, timeoutSeconds, maxCostUsd },
  }));
}

async function runLocalTrial(t: TrialInput): Promise<{ record: RawRecord; spentUsd: number | null }> {
  const { trial, manifest: m, env, dataKind, mono } = t;
  const slot = trial.slot as Extract<Slot, { track: 'workers' }>;
  const log = (line: string) => env.log?.(redactSecrets(`[${trial.trialId}] ${line}`));
  const scale = env.timeScale ?? 1;
  const deadlineMs = m.workers.attemptTimeoutSeconds * 1000 * scale;
  const taskTimeoutSeconds = Math.max(1, Math.round(m.workers.attemptTimeoutSeconds * scale));
  const confounders: string[] = [];
  if (scale !== 1) confounders.push(`time-compressed: the ${m.workers.attemptTimeoutSeconds} s deadline was scaled by ${scale} (test configuration)`);
  if (dataKind === 'simulated') confounders.push('dry run: scripted worker in a fake sandbox and a scripted verifier; not evidence');
  const starterSha = m.repository.starterSha;
  const base: Omit<RawRecord, 'status' | 'timings' | 'resources' | 'cost' | 'humanMinutes' | 'quality' | 'operations' | 'failures' | 'confounders' | 'artifactReferences'> = {
    dataKind, track: 'workers', trialId: trial.trialId, mode: slot.mode, blockId: slot.block, attemptId: trial.trialId, slotId: slot.id, slotAttempt: trial.slotAttempt,
    configuration: { candidateSha: null, inferenceDestination: null, providerAccountReference: null, ...accountOf(m), cacheCondition: 'warm', localHost: m.environment.localHost, cloudHost: null },
    assistant: null,
  };
  const now = monotonicDateClock(mono);
  // Trial-unique: the sandbox scope and the task ids, so nothing this trial names can collide with another trial or the owner's runs.
  const trialSuffix = randomBytes(4).toString('hex');
  const scope = sandboxScopeFor(m, trial.trialId, trialSuffix)!;
  const trialRoot = join(env.workRoot, `${safe(trial.trialId)}-${trialSuffix}`);
  const repoPath = join(trialRoot, 'source');
  const agentHome = join(trialRoot, 'agent-home');
  const artifactDir = join(trialRoot, 'artifacts');
  const setupStart = mono();
  let stack: Stack | null = null;
  let runtime: SweepingRuntime | null = null;
  const abandoned = (category: string, detail: string): RawRecord => ({
    ...base, status: 'abandoned', timings: { ...NO_TIMINGS, clockDomain: 'server-monotonic', initialSetupMs: Math.round(mono() - setupStart) }, resources: NO_RESOURCES, cost: NO_COST, humanMinutes: NO_HUMAN_MINUTES,
    quality: { allRequiredChecksPassed: null, criteria: notRunCriteria(), withinDeclaredLimits: null }, operations: NO_OPERATIONS,
    failures: [{ category, detail: redactSecrets(detail).slice(0, 300) }], confounders, artifactReferences: [],
  });

  let runId: string;
  let runnerToken: string;
  let stateBefore: AgentState | null = null;
  try {
    if (starterSha === null) throw new Error('the manifest names no starter commit');
    freshStarterRepo(env.starterRepo, starterSha, repoPath);
    mkdirSync(agentHome, { recursive: true });
    stack = await openStack({
      databaseUrl: env.databaseUrl, repoPath, artifactDir, integrationDir: join(trialRoot, 'integrate'), verificationDir: join(trialRoot, 'verify'), now,
      catalog: env.catalog, policy: env.policy, verifierRunner: env.verifierRunner, verifierHost: env.verifierHost,
      repository: repositoryOf(m), attemptTimeoutSeconds: taskTimeoutSeconds, driverIntervalMs: env.driverIntervalMs,
    });
    const prior = await stack.db.execute(sql`SELECT (SELECT count(*) FROM task_status) AS tasks, (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM attempts) AS attempts, (SELECT count(*) FROM runs) AS runs`);
    const p = prior[0]!;
    env.onTrialStart?.({
      trialId: trial.trialId, schemaName: stack.schemaName, repo: repoState(repoPath), agentHomeEntries: readdirSync(agentHome),
      priorRows: { tasks: Number(p['tasks']), events: Number(p['events']), attempts: Number(p['attempts']), runs: Number(p['runs']) },
    });
    runnerToken = await stack.enrolRunner('local', env.runnerReport);
    const codingModel = m.environment.codingModel;
    const run = await stack.owner('POST', `/v1/projects/${stack.projectId}/runs`, {
      idempotencyKey: `bench-${safe(trial.trialId)}`, title: `Benchmark ${trial.trialId}`, budgetLimitUsd: Math.floor(t.budgetUsd * 100) / 100, trial: true,
      ...(codingModel ? { pinnedModel: { provider: m.environment.inferenceProvider ?? 'anthropic', model: codingModel } } : {}),
    });
    if (run.status !== 201) throw new Error(`the run was refused (${run.status} ${String(run.body?.error?.code ?? '')})`);
    runId = String(run.body.runId);
    runtime = env.runtime({ home: agentHome, attemptsRoot: join(trialRoot, 'runner', 'attempts'), trialId: trial.trialId, scope });
    stateBefore = env.agentState ? await env.agentState(scope) : null;
  } catch (e) {
    log(`setup failed: ${e instanceof Error ? e.message : String(e)}`);
    await stack?.close().catch(() => undefined);
    rmSync(trialRoot, { recursive: true, force: true });
    return { record: abandoned('setup_failed', e instanceof Error ? e.message : String(e)), spentUsd: 0 };
  }
  const initialSetupMs = Math.round(mono() - setupStart);

  // Coordinator acceptance: the end-to-end timer starts at the server's plan.accepted event. Holds stay at their worst case, so every attempt the
  // repair policy allows (two roles, each 1 + repairs) must fit in the trial's budget.
  const maxAttempts = 1 + (env.policy.limits?.repairAttempts ?? 2);
  const perTaskCap = Math.max(0.01, Math.floor((t.budgetUsd / (2 * maxAttempts)) * 100) / 100);
  const accepted = await stack.owner('POST', `/v1/runs/${runId}/plan-revisions`, { expectedRevision: 0, tasks: tasksFor(m, stack, runId, starterSha!, taskTimeoutSeconds, perTaskCap, env.policy, trialSuffix) });
  const acceptedMono = mono();
  const loopAbort = new AbortController();
  let ending: Ending = 'failed';
  let loop: Promise<void> = Promise.resolve();
  const failures: { category: string; detail: string | null }[] = [];
  const watch: ClaimWatch = { nonTransient: 0, lastReason: null, leased: false };
  if (accepted.status !== 201) {
    // M6: the run never got a plan to start from: an infrastructure outcome, so the slot may be retried.
    ending = 'denied';
    failures.push({ category: 'plan_refused', detail: String(accepted.body?.error?.code ?? accepted.status) });
  } else {
    stack.startDrivers();
    const api = new HttpRunnerApi(stack.apiBase, runnerToken, watchClaims(env.wrapRunnerFetch ? env.wrapRunnerFetch(stack.fetch) : stack.fetch, watch));
    const runner = new RunnerLoop({
      api, runtime: runtime!, pollMs: env.pollMs, slots: 1, log: (l) => log(l), projects: [stack.projectId],
      harnessReport: async () => env.runnerReport,
      attempt: {
        api, runtime: runtime!, artifacts: new LocalDiskArtifactStore(artifactDir), workRoot: join(trialRoot, 'runner'), repos: { [stack.projectId]: repoPath },
        codingWorkers: BENCH_CODING_WORKERS, heartbeatMs: env.heartbeatMs, maxMissedHeartbeats: 6, cpus: 2, memoryMiB: 4096, log: (l) => log(l), timeoutScale: 1,
      },
    });
    loop = runner.run(loopAbort.signal).catch((e) => log(`runner loop ended with an error: ${e instanceof Error ? e.message : String(e)}`));
    ending = await waitForEnding(stack, runId, {
      acceptedMono, deadlineMs, mono, pollMs: env.pollMs, signal: t.signal, watch, maxRefusals: env.maxStartRefusals ?? 5, startWindowMs: env.startWindowMs ?? 180_000,
    });
    if (ending === 'denied') failures.push({ category: 'start_denied', detail: watch.lastReason ?? 'no attempt started within the start window' });
    if (ending !== 'delivered' && ending !== 'failed') await cancelOpenTasks(stack, ending);
  }
  // Stop the worker side, bounded: the runner stops its agent and destroys its sandbox on abort.
  loopAbort.abort();
  await Promise.race([loop, new Promise((r) => setTimeout(r, 30_000))]);

  let evidence: TrialEvidence | null = null;
  try {
    evidence = await collectTrial(stack.db, new LocalDiskArtifactStore(artifactDir), { tenantId: stack.tenantId, projectId: stack.projectId, runId });
    if (env.evidenceDir && evidence.candidateSha) keepEvidence(env.evidenceDir, trial.trialId, repoPath, starterSha!, evidence);
  } catch (e) {
    failures.push({ category: 'evidence_unreadable', detail: e instanceof Error ? redactSecrets(e.message).slice(0, 200) : null });
  }
  const leftover = await runtime!.sweepOrphans(new Set()).catch(() => ['unknown']);
  const stateAfter = env.agentState ? await env.agentState(scope).catch(() => null) : null;
  const shared = [stateBefore, stateAfter].some((s) => s !== null && (s.kitShortcut !== null || s.scopedSandboxes.length > 0))
    || (env.agentState !== undefined && stateAfter === null);
  if (shared) confounders.push(`${SHARED_AGENT_STATE}: before: ${describeState(stateBefore)}; after: ${describeState(stateAfter)}`);
  await stack.close().catch((e) => failures.push({ category: 'teardown_failed', detail: e instanceof Error ? redactSecrets(e.message).slice(0, 200) : null }));
  rmSync(trialRoot, { recursive: true, force: true });
  const cleanupConfirmed = leftover.length === 0 && !existsSync(trialRoot) && !failures.some((f) => f.category === 'teardown_failed');
  if (evidence !== null && evidence.unreportedAttempts > 0) {
    confounders.push(`${evidence.unreportedAttempts} attempt(s) reported no cost; the budget was charged their worst-case hold`);
  }
  const withState = { ...base, configuration: { ...base.configuration, credentialPath: credentialPathOf(m, stateBefore), agentState: env.agentState ? `before: ${describeState(stateBefore)}; after: ${describeState(stateAfter)}` : null } };
  const record = toRecord({ base: withState, evidence, ending, failures, confounders, lastRefusal: watch.lastReason, initialSetupMs, cleanupConfirmed, deadlineMs, repairAttempts: env.policy.limits?.repairAttempts ?? 2, now });
  return { record, spentUsd: evidence === null ? null : evidence.spendBoundUsd };
}

/** The coding model's inference destination, from the attempts' recorded routes. Unknown or mixed stays null. */
function destinationOf(e: TrialEvidence | null): 'device' | 'cloud' | null {
  const routes = new Set((e?.attempts ?? []).filter((a) => a.startedAt !== null).map((a) => a.modelRoute));
  if (routes.size !== 1) return null;
  const [route] = routes;
  return route === 'device' || route === 'cloud' ? route : null;
}

function repositoryOf(m: Manifest): string {
  const match = /github\.com\/([^/]+\/[^/.]+)/.exec(m.repository.url ?? '');
  return match?.[1] ?? 'benchmark/feedback-board';
}

const TERMINAL_TASK: ReadonlySet<string> = new Set(['failed', 'blocked', 'cancelled']);

/** Waits on the run's own state, never a fixed sleep: delivered, a task that cannot finish, the deadline, or the operator. */
async function waitForEnding(stack: Stack, runId: string, w: {
  acceptedMono: number; deadlineMs: number; mono: Monotonic; pollMs: number; signal: AbortSignal | undefined; watch: ClaimWatch; maxRefusals: number; startWindowMs: number;
}): Promise<Ending> {
  const tick = new AbortController();
  const onAbort = () => tick.abort();
  w.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (w.signal?.aborted) return 'cancelled';
      const [run] = await stack.db.execute(sql`SELECT lifecycle FROM runs WHERE tenant_id = ${stack.tenantId} AND project_id = ${stack.projectId} AND run_id = ${runId}`);
      if (run?.['lifecycle'] === 'ready_for_review') return 'delivered';
      const tasks = await stack.db.execute(sql`SELECT status FROM task_status WHERE tenant_id = ${stack.tenantId} AND project_id = ${stack.projectId}`);
      if (tasks.some((r) => TERMINAL_TASK.has(String(r['status'])))) return 'failed';
      // m2: a start denied for good is one refused for a non-transient reason, repeatedly, and still unstarted once the window has passed.
      if (!w.watch.leased && w.watch.nonTransient >= w.maxRefusals && w.mono() - w.acceptedMono >= w.startWindowMs) return 'denied';
      const left = w.deadlineMs - (w.mono() - w.acceptedMono);
      if (left <= 0) return 'timed_out';
      await until(Math.min(w.pollMs, left), tick.signal);
    }
  } finally {
    w.signal?.removeEventListener('abort', onAbort);
  }
}

/** The owner's cancel, through the real route, for every task still open. */
async function cancelOpenTasks(stack: Stack, why: Ending): Promise<void> {
  const rows = await stack.db.execute(sql`SELECT task_id, row_revision, status FROM task_status WHERE tenant_id = ${stack.tenantId} AND project_id = ${stack.projectId}`);
  for (const r of rows) {
    if (['verified', 'merged', 'failed', 'cancelled', 'superseded'].includes(String(r['status']))) continue;
    await stack.owner('POST', `/v1/tasks/${String(r['task_id'])}/commands`, { command: 'cancel', expectedRevision: Number(r['row_revision']), idempotencyKey: `bench-${why}-${String(r['task_id'])}` }).catch(() => undefined);
  }
}

function keepEvidence(dir: string, trialId: string, repo: string, starterSha: string, e: TrialEvidence): void {
  const out = join(dir, safe(trialId));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'criteria.json'), `${JSON.stringify({ candidateSha: e.candidateSha, verdict: e.verdict?.outcome ?? null, criteria: e.criteria }, null, 2)}\n`);
  try {
    writeFileSync(join(out, 'candidate.diff'), git(repo, 'diff', '--binary', starterSha, e.candidateSha!));
  } catch { /* the candidate ref is gone; the criteria file stands alone */ }
}

interface RecordInput {
  /** The last claim refusal seen before any start (I1), for a deadline reached with nothing started. */
  readonly lastRefusal: string | null;
  readonly base: Omit<RawRecord, 'status' | 'timings' | 'resources' | 'cost' | 'humanMinutes' | 'quality' | 'operations' | 'failures' | 'confounders' | 'artifactReferences'>;
  readonly evidence: TrialEvidence | null;
  readonly ending: Ending;
  readonly failures: readonly { category: string; detail: string | null }[];
  readonly confounders: readonly string[];
  readonly initialSetupMs: number;
  readonly cleanupConfirmed: boolean;
  readonly deadlineMs: number;
  readonly repairAttempts: number;
  readonly now: () => Date;
}

function toRecord(r: RecordInput): RawRecord {
  const e = r.evidence;
  const failures = [...r.failures];
  let status: RawRecord['status'];
  const neverStarted = e !== null && e.attempts.every((a) => a.startedAt === null);
  // I1 ruling: a deadline reached with no attempt ever started is a start that was denied (replaceable), whatever the refusals were.
  if (r.ending === 'timed_out' && neverStarted) { status = 'denied_start'; failures.push({ category: 'start_denied', detail: r.lastRefusal ?? 'no attempt started before the deadline' }); }
  else if (r.ending === 'timed_out') { status = 'timed_out'; failures.push({ category: 'attempt_deadline', detail: `the ${r.deadlineMs / 1000} s deadline from coordinator acceptance ran out` }); }
  else if (r.ending === 'cancelled') { status = 'cancelled'; failures.push({ category: 'operator_cancelled', detail: null }); }
  else if (r.ending === 'denied') status = 'denied_start';
  else if (e?.verdict) status = 'completed';
  else if (e !== null && e.attempts.every((a) => a.startedAt === null) && failures.length === 0) {
    status = 'denied_start';
    for (const s of e.taskStatuses) if (s.status === 'blocked') failures.push({ category: 'start_denied', detail: s.blockedReason });
  } else {
    status = 'failed';
    for (const s of e?.taskStatuses ?? []) if (TERMINAL_TASK.has(s.status)) failures.push({ category: `task_${s.status}`, detail: s.blockedReason ?? e?.attempts.filter((a) => a.taskId === s.taskId).at(-1)?.exitReason ?? null });
    if (failures.length === 0) failures.push({ category: 'no_verdict', detail: null });
  }
  if (e !== null && !e.clockConsistent) failures.push({ category: 'server_clock_inconsistent', detail: 'event order and event times disagree; timings withheld' });

  const perTask = new Map<string, number>();
  for (const a of e?.attempts ?? []) if (a.startedAt !== null) perTask.set(a.taskId, (perTask.get(a.taskId) ?? 0) + 1);
  const repairCount = e === null ? null : [...perTask.values()].reduce((s, n) => s + Math.max(0, n - 1), 0);
  const criteria = e?.criteria ?? notRunCriteria();
  const candidateSha = e?.candidateSha ?? null;
  const reachedVerification = status === 'completed' || criteria.some((c) => c.status !== 'not_run');
  const quality: RawRecord['quality'] = {
    allRequiredChecksPassed: e?.verdict ? allCriteriaPassed({ quality: { criteria } } as never) : null, criteria,
    withinDeclaredLimits: status === 'completed' ? (e!.timings.endToEndVerifiedMs ?? Infinity) <= r.deadlineMs && (repairCount ?? 0) <= r.repairAttempts : null,
  };
  const hours = e?.workerHours;
  const cost = e?.cost;
  return {
    ...r.base, status,
    configuration: { ...r.base.configuration, candidateSha: reachedVerification || candidateSha !== null ? candidateSha : null, inferenceDestination: destinationOf(e) },
    timings: {
      ...NO_TIMINGS, clockDomain: 'server-monotonic',
      startedAtUtc: e?.acceptedAt != null ? new Date(e.acceptedAt).toISOString() : null, endedAtUtc: r.now().toISOString(),
      ...(e?.timings ?? {}), endToEndVerifiedMs: status === 'completed' ? e!.timings.endToEndVerifiedMs : null, initialSetupMs: r.initialSetupMs,
    },
    resources: {
      ...NO_RESOURCES, localWorkerHours: hours?.local ?? null, cloudWorkerHours: hours?.cloud ?? null, integrationAndVerificationHours: hours?.integrationAndVerification ?? null,
      workerHoursProvenance: hours && (hours.local !== null || hours.cloud !== null) ? hours.provenance : 'unavailable',
      workerHoursSource: hours && (hours.local !== null || hours.cloud !== null) ? 'control API usage ledger (controller clock)' : null,
      requestedVcpus: 2, requestedMemoryGib: 4, providerUsageByRole: [...(e?.usage ?? [])], usageCoverage: e?.usageCoverage ?? 'unknown',
    },
    cost: {
      ...NO_COST, platformPaidActual: cost?.actual ?? null, platformPaidEstimated: cost?.estimated ?? null, rateCardVersion: cost?.rateCardVersion ?? null,
      settlementStatus: cost?.actual != null ? 'pending' : 'unavailable', exclusions: ['local hardware and energy', 'fixed subscriptions'],
    },
    humanMinutes: NO_HUMAN_MINUTES,
    quality,
    operations: {
      repairCount, deniedActionCount: e?.deniedActions ?? null, cleanupConfirmed: r.cleanupConfirmed, externalPrUrl: null,
      humanIntervened: e?.humanIntervened ?? null,
      // The runner takes no human action: an approval the run raised stays unresolved and ends the trial.
      permittedHumanActions: e === null ? null : 0,
    },
    failures, confounders: [...r.confounders],
    artifactReferences: reachedVerification && candidateSha ? [`#/evidence?candidate=${candidateSha}`] : [],
  };
}
