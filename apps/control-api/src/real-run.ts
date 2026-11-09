import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { schema, withTx, type Db } from '@selarikru/persistence';
import { evaluate } from '@selarikru/policy';
import { loadDefaultPolicy } from '@selarikru/policy/load';
import { and, eq } from 'drizzle-orm';
import { ConfigError } from './config.ts';
import { PILOT_CRITERIA } from '@selarikru/domain';
import { DEMO } from './demo.ts';
import { writeEvent } from './store.ts';

/**
 * Setup for a rehearsal of a real run on the local stack (`pnpm dev:real`). Everything comes from the environment and the local checkout: no network call is
 * made here, and `dev:demo` is not involved. A plan accepted against this project builds on a real commit, and the verified candidate can open a real draft PR.
 */
export interface RealRunConfig {
  readonly tenantId: string;
  readonly ownerUid: string;
  readonly projectId: string;
  readonly runId: string;
  /** `owner/repo` on GitHub. */
  readonly repository: string;
  readonly defaultBranch: string;
  readonly baseSha: string;
  readonly allowedPaths: readonly string[];
  readonly budgetLimitUsd: number;
  /** `SELARIKRU_REAL_TERMINAL_CONTROL=1` lets a person take control of a running worker in this rehearsal. Off otherwise. */
  readonly terminalControl?: boolean;
}

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const POLICY_VERSION = 'real-run-local.1';

type Env = Readonly<Record<string, string | undefined>>;

function need(env: Env, name: string): string {
  const v = env[name]?.trim() ?? '';
  if (v === '') throw new ConfigError(`missing required configuration: ${name}`, [name]);
  return v;
}

/**
 * The owner's Auth Emulator account for a real run: the UID is the configured owner, so the emulator's sign-in token names the same person the API trusts.
 * The email and password live only in the emulator. The defaults are not secrets; the password is never printed.
 */
export function realOwnerAccount(env: Env): { readonly uid: string; readonly email: string; readonly password: string } {
  return {
    uid: need(env, 'SELARIKRU_OWNER_UID'),
    email: env['SELARIKRU_REAL_OWNER_EMAIL']?.trim() || 'owner@selarikru.invalid',
    password: env['SELARIKRU_REAL_OWNER_PASSWORD']?.trim() || 'real-run-local-only-password',
  };
}

/** Reads the settings, and the base commit from the checkout. Fails on anything missing rather than inventing a default. */
export function readRealRunConfig(env: Env): RealRunConfig {
  const repository = need(env, 'SELARIKRU_REAL_REPOSITORY');
  if (!REPOSITORY.test(repository)) throw new ConfigError('invalid configuration: SELARIKRU_REAL_REPOSITORY must be owner/repo', [], ['SELARIKRU_REAL_REPOSITORY']);
  const source = need(env, 'SELARIKRU_SOURCE_REPO');
  if (!isAbsolute(source) || !existsSync(source)) throw new ConfigError('invalid configuration: SELARIKRU_SOURCE_REPO must be an absolute path to an existing git repository', [], ['SELARIKRU_SOURCE_REPO']);
  const defaultBranch = env['SELARIKRU_REAL_BASE_BRANCH']?.trim() || 'main';
  if (!SAFE_BRANCH.test(defaultBranch) || defaultBranch.includes('..')) throw new ConfigError('invalid configuration: SELARIKRU_REAL_BASE_BRANCH is not a usable branch name', [], ['SELARIKRU_REAL_BASE_BRANCH']);
  let baseSha: string;
  try {
    baseSha = execFileSync('git', ['-C', source, 'rev-parse', '--verify', '--quiet', `refs/heads/${defaultBranch}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new ConfigError(`invalid configuration: branch ${defaultBranch} does not exist in SELARIKRU_SOURCE_REPO`, [], ['SELARIKRU_REAL_BASE_BRANCH']);
  }
  if (!FULL_SHA.test(baseSha)) throw new ConfigError('invalid configuration: the base commit is not a full SHA', [], ['SELARIKRU_REAL_BASE_BRANCH']);
  const allowedPaths = need(env, 'SELARIKRU_REAL_ALLOWED_PATHS').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowedPaths.length === 0) throw new ConfigError('missing required configuration: SELARIKRU_REAL_ALLOWED_PATHS', ['SELARIKRU_REAL_ALLOWED_PATHS']);
  const budgetLimitUsd = Number(need(env, 'SELARIKRU_REAL_BUDGET_LIMIT_USD'));
  if (!Number.isFinite(budgetLimitUsd) || budgetLimitUsd <= 0) throw new ConfigError('invalid configuration: SELARIKRU_REAL_BUDGET_LIMIT_USD must be a number above 0', [], ['SELARIKRU_REAL_BUDGET_LIMIT_USD']);
  const projectId = env['SELARIKRU_REAL_PROJECT_ID']?.trim() || 'proj_real_local';
  const runId = env['SELARIKRU_REAL_RUN_ID']?.trim() || 'run_real_local';
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(runId)) throw new ConfigError('invalid configuration: the real-run project and run ids must be plain identifiers', [], ['SELARIKRU_REAL_PROJECT_ID']);
  return { tenantId: need(env, 'SELARIKRU_TENANT_ID'), ownerUid: need(env, 'SELARIKRU_OWNER_UID'), projectId, runId, repository, defaultBranch, baseSha, allowedPaths, budgetLimitUsd, terminalControl: env['SELARIKRU_REAL_TERMINAL_CONTROL'] === '1' };
}

/** Inserts the project and its run when absent. A project already pointed elsewhere is refused, never rewritten. Safe to repeat. */
export async function seedRealRun(db: Db, cfg: RealRunConfig): Promise<{ created: boolean }> {
  return withTx(db, async (tx) => {
    await tx.insert(schema.projects).values({ tenantId: cfg.tenantId, projectId: cfg.projectId, repository: cfg.repository, defaultBranch: cfg.defaultBranch, classification: 'internal' }).onConflictDoNothing();
    const project = (await tx.select().from(schema.projects).where(and(eq(schema.projects.tenantId, cfg.tenantId), eq(schema.projects.projectId, cfg.projectId))))[0]!;
    if (project.repository !== cfg.repository || project.defaultBranch !== cfg.defaultBranch) throw new Error(`project ${cfg.projectId} already targets ${project.repository} (${project.defaultBranch})`);
    const existing = await tx.select().from(schema.runs).where(and(eq(schema.runs.tenantId, cfg.tenantId), eq(schema.runs.projectId, cfg.projectId), eq(schema.runs.runId, cfg.runId)));
    if (existing.length > 0) return { created: false };
    await tx.insert(schema.runs).values({ tenantId: cfg.tenantId, projectId: cfg.projectId, runId: cfg.runId, lifecycle: 'planning', budget: { limitUsd: cfg.budgetLimitUsd } });
    await writeEvent(tx, new Date(), {
      projectId: cfg.projectId, runId: cfg.runId, taskId: cfg.runId, aggregateRevision: 1, type: 'run.created', actor: { kind: 'human', id: cfg.ownerUid },
      payload: { title: 'Real run', budget: { status: 'set', limitUsd: cfg.budgetLimitUsd } },
    });
    return { created: true };
  });
}

/** The policy (the shipped one, which allows `create_draft_pr`) and the plan settings with the real base commit, in `dir`. */
export function writeRealRunFiles(dir: string, cfg: RealRunConfig): { planConfigFile: string; policyFile: string } {
  mkdirSync(dir, { recursive: true });
  const base = loadDefaultPolicy();
  const timeoutSeconds = base.limits?.attemptTimeoutSeconds;
  if (timeoutSeconds === undefined) throw new Error('policies/default.json has no attemptTimeoutSeconds');
  if (evaluate({ kind: 'create_draft_pr' }, base).decision !== 'allow') throw new Error('policies/default.json does not allow create_draft_pr');
  // Control mode stays off unless the operator opts in: it opens a shell, so a real-run rehearsal does not grant it by default.
  const policyVersion = cfg.terminalControl ? `${POLICY_VERSION}+terminal-control` : POLICY_VERSION;
  const policy = { ...base, policyVersion, operations: { ...base.operations, terminal_control: cfg.terminalControl ? 'allow' : 'deny' } };
  const planConfig = {
    projects: {
      [cfg.projectId]: {
        boardId: 'feedback-board', role: 'backend', baseSha: cfg.baseSha, allowedPaths: [...cfg.allowedPaths],
        classification: 'internal', policyVersion, execution: 'local', inferencePolicyId: 'real-run-local',
        limits: { maxAttempts: 3, timeoutSeconds, maxCostUsd: 1 },
        allowedRequirementIds: [...DEMO.requirementIds],
        requirementText: Object.fromEntries(PILOT_CRITERIA.map((c) => [c.id, c.text])),
        forbiddenMandatoryScope: ['login', 'voting', 'payments', 'email'],
      },
    },
  };
  const planConfigFile = join(dir, 'plan-config.json');
  const policyFile = join(dir, 'policy.json');
  writeFileSync(planConfigFile, `${JSON.stringify(planConfig, null, 2)}\n`);
  writeFileSync(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  return { planConfigFile, policyFile };
}
