import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { RUNNER_RECENT_SECONDS, availableCatalog, readinessPassed, templateSupport, type BlueprintContent, type ExecutionChoice, type HarnessCatalog, type ReadinessCheck, type ReadinessCheckId, type ReadinessStatus } from '@selarikru/domain';
import { schema, type Executor } from '@selarikru/persistence';
import { evaluate, type Policy } from '@selarikru/policy';
import { loadRecentRunnerReports } from '@selarikru/workflow';
import { and, eq, inArray, isNull, gte } from 'drizzle-orm';

/**
 * The trusted half of onboarding: these checks run on this server against real state. A request cannot supply a result, and only an explicit pass counts.
 * With no probes wired, as on the demo stack, the repository and GitHub checks say unknown, so demo data can never reach `ready`.
 */
export interface GitFacts {
  readonly reachable: { readonly ok: boolean; readonly reason: string };
  readonly identity: { readonly status: ReadinessStatus; readonly reason: string };
  readonly base: { readonly sha: string | null; readonly reason: string };
}

export interface ReadinessProbes {
  /** The deployment's one source checkout (`SELARIKRU_SOURCE_REPO`). Null: none is configured. */
  readonly sourceCheckout: string | null;
  git(input: { readonly checkout: string; readonly repository: string; readonly branch: string }): Promise<GitFacts>;
  githubAuth(): Promise<{ readonly status: ReadinessStatus; readonly reason: string }>;
}

const execFileP = promisify(execFile);
const GIT_ENV = { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const ORIGIN_SLUG = /github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i;

async function gitOut(checkout: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', checkout, ...args], { env: GIT_ENV, timeout: 15_000, encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Reads real facts with `git`, argument arrays only. Branch and repository were validated by the request schema. */
export function createGitProbes(options: { sourceCheckout: string | null; githubAuth: ReadinessProbes['githubAuth'] }): ReadinessProbes {
  return {
    sourceCheckout: options.sourceCheckout,
    githubAuth: options.githubAuth,
    async git({ checkout, repository, branch }) {
      const unreadable = 'The checkout could not be read, so this could not be confirmed.';
      if (!isAbsolute(checkout) || !existsSync(checkout)) return { reachable: { ok: false, reason: `The configured checkout does not exist on this machine: ${checkout}` }, identity: { status: 'unknown', reason: unreadable }, base: { sha: null, reason: unreadable } };
      if ((await gitOut(checkout, ['rev-parse', '--git-dir'])) === null) return { reachable: { ok: false, reason: `The configured checkout is not a git repository: ${checkout}` }, identity: { status: 'unknown', reason: unreadable }, base: { sha: null, reason: unreadable } };
      const url = await gitOut(checkout, ['remote', 'get-url', 'origin']);
      const slug = url === null ? null : (ORIGIN_SLUG.exec(url)?.[1] ?? null);
      const identity = url === null
        ? { status: 'unknown' as const, reason: 'The checkout has no origin remote, so it cannot be confirmed as this repository.' }
        : slug === null
          ? { status: 'unknown' as const, reason: 'The checkout has an origin remote, but it is not a GitHub repository.' }
          : slug.toLowerCase() === repository.toLowerCase()
            ? { status: 'passed' as const, reason: `The checkout's origin is ${slug}.` }
            : { status: 'failed' as const, reason: `The checkout's origin is ${slug}, not ${repository}.` };
      const sha = await gitOut(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
      const base = sha !== null && /^[0-9a-f]{40}$/.test(sha)
        ? { sha, reason: `Branch ${branch} resolves to ${sha.slice(0, 12)}.` }
        : { sha: null, reason: `Branch ${branch} does not exist in the checkout.` };
      return { reachable: { ok: true, reason: `The checkout at ${checkout} is a git repository.` }, identity, base };
    },
  };
}

/** `gh auth status`, on this machine. A missing `gh` is unknown, not a pass. */
export async function ghAuthStatus(): Promise<{ status: ReadinessStatus; reason: string }> {
  try {
    await execFileP('gh', ['auth', 'status', '--hostname', 'github.com'], { env: { ...process.env, GH_PROMPT_DISABLED: '1' }, timeout: 20_000, encoding: 'utf8' });
    return { status: 'passed', reason: 'The GitHub CLI is signed in on this machine.' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unknown', reason: 'The GitHub CLI is not installed on this machine, so its sign-in cannot be confirmed.' };
    return { status: 'failed', reason: 'The GitHub CLI is not signed in to github.com on this machine.' };
  }
}

export interface ReadinessInput {
  readonly db: Executor;
  readonly tenantId: string;
  readonly projectId: string;
  readonly now: Date;
  readonly probes: ReadinessProbes | undefined;
  readonly policy: Policy | undefined;
  readonly catalog: HarnessCatalog;
  readonly pullRequestsEnabled: boolean;
  readonly blueprint: BlueprintContent;
  readonly connection: { readonly repository: string; readonly defaultBranch: string } | null;
  readonly execution: ExecutionChoice | null;
  readonly agentBudgetUsd: number | null;
  readonly costPlanConfirmed: boolean;
}

export interface ReadinessResult {
  readonly checks: readonly ReadinessCheck[];
  readonly baseSha: string | null;
  readonly passed: boolean;
}

const NO_CHECKER = 'This server has no trusted checker for this, so it could not be confirmed. Demo data never counts as a pass.';

/** Performs every check. Never throws for a broken fact: a probe that fails says unknown, with a reason that cannot quote a secret. */
export async function performReadiness(input: ReadinessInput): Promise<ReadinessResult> {
  const check = (id: ReadinessCheckId, label: string, status: ReadinessStatus, reason: string, nextAction: string | null): ReadinessCheck => ({ id, label, status, reason, nextAction: status === 'passed' ? null : nextAction, required: true });
  const checks: ReadinessCheck[] = [];
  let baseSha: string | null = null;

  const support = templateSupport(input.blueprint.tracks);
  checks.push(check('template_supported', 'Template can run', support.executable ? 'passed' : 'failed',
    support.executable ? 'Every chosen track is certified to run.' : support.unsupported.map((u) => u.reason).join(' '),
    'Change the focus to a supported track, or keep this as a plan only.'));

  const { probes, connection } = input;
  const repoLabel = 'Repository reachable', identityLabel = 'Checkout matches repository', baseLabel = 'Base commit resolves';
  if (!probes) {
    checks.push(check('repository_path', repoLabel, 'unknown', NO_CHECKER, 'Run this on a real stack, with `pnpm dev:real`.'));
    checks.push(check('repository_identity', identityLabel, 'unknown', NO_CHECKER, null));
    checks.push(check('base_commit', baseLabel, 'unknown', NO_CHECKER, null));
  } else if (probes.sourceCheckout === null) {
    const reason = 'This deployment has no source checkout configured (SELARIKRU_SOURCE_REPO).';
    checks.push(check('repository_path', repoLabel, 'failed', reason, 'Set SELARIKRU_SOURCE_REPO to an absolute path and restart the API.'));
    checks.push(check('repository_identity', identityLabel, 'unknown', reason, null));
    checks.push(check('base_commit', baseLabel, 'unknown', reason, null));
  } else if (!connection) {
    const reason = 'No repository is connected yet.';
    checks.push(check('repository_path', repoLabel, 'failed', reason, 'Connect a repository in the previous step.'));
    checks.push(check('repository_identity', identityLabel, 'unknown', reason, null));
    checks.push(check('base_commit', baseLabel, 'unknown', reason, null));
  } else {
    try {
      const facts = await probes.git({ checkout: probes.sourceCheckout, repository: connection.repository, branch: connection.defaultBranch });
      checks.push(check('repository_path', repoLabel, facts.reachable.ok ? 'passed' : 'failed', facts.reachable.reason, 'Fix the path in SELARIKRU_SOURCE_REPO and restart the API.'));
      checks.push(check('repository_identity', identityLabel, facts.identity.status, facts.identity.reason, `Point the checkout's origin at github.com/${connection.repository}.`));
      checks.push(check('base_commit', baseLabel, facts.base.sha ? 'passed' : 'failed', facts.base.reason, `Fetch or create ${connection.defaultBranch} in the checkout.`));
      baseSha = facts.base.sha;
    } catch {
      const reason = 'The checkout could not be read, so this could not be confirmed.';
      checks.push(check('repository_path', repoLabel, 'unknown', reason, 'Check the checkout on this machine and try again.'));
      checks.push(check('repository_identity', identityLabel, 'unknown', reason, null));
      checks.push(check('base_commit', baseLabel, 'unknown', reason, null));
    }
  }

  // Enrolment and health come from what the runner itself last did, seen by this server.
  const label = 'Runner enrolled';
  const locations = input.execution === 'hybrid' ? ['local', 'cloud'] : input.execution ? [input.execution] : [];
  if (locations.length === 0) {
    checks.push(check('runner_enrolled', label, 'failed', 'Execution has not been chosen yet.', 'Choose where workers run.'));
  } else {
    const since = new Date(input.now.getTime() - RUNNER_RECENT_SECONDS * 1000);
    const seen = await input.db.select({ location: schema.runners.location, report: schema.runners.harnessReport }).from(schema.runners)
      .where(and(eq(schema.runners.tenantId, input.tenantId), isNull(schema.runners.revokedAt), inArray(schema.runners.location, locations), gte(schema.runners.lastSeenAt, since)));
    const missing = locations.filter((l) => !seen.some((r) => r.location === l));
    const canLaunch = availableCatalog(input.catalog, await loadRecentRunnerReports(input.db, input.tenantId, input.now)).providers.some((p) => p.models.length > 0);
    if (missing.length > 0) checks.push(check('runner_enrolled', label, 'failed', `No ${missing.join(' or ')} runner has reached this server recently.`, `Pair a runner with \`selarikru-runner pair\`, then start it with \`--repo ${input.projectId}=${input.probes?.sourceCheckout ?? '<checkout>'}\` so it can build this project.`));
    else if (!canLaunch) checks.push(check('runner_enrolled', label, 'failed', 'A runner is connected, but it reports no model this build can launch.', 'Install a supported harness on the runner.'));
    else checks.push(check('runner_enrolled', label, 'passed', `A ${locations.join(' and a ')} runner reported in recently.`, null));
  }

  const policyGate = input.policy ? evaluate({ kind: 'create_draft_pr' }, input.policy) : null;
  checks.push(check('policy_loaded', 'Policy loaded', policyGate?.decision === 'allow' ? 'passed' : 'failed',
    !input.policy ? 'No policy is loaded on this server.' : policyGate!.decision === 'allow' ? `Policy ${input.policy.policyVersion} is loaded and allows draft pull requests.` : 'The loaded policy does not allow draft pull requests.',
    'Load a policy that allows draft pull requests, and restart the API.'));

  if (!input.pullRequestsEnabled) {
    checks.push(check('github_auth', 'GitHub sign-in', 'failed', 'Draft pull requests are off on this server.', 'Set SELARIKRU_GITHUB_ENABLED=1 and restart the API.'));
  } else if (!probes) {
    checks.push(check('github_auth', 'GitHub sign-in', 'unknown', NO_CHECKER, null));
  } else {
    try {
      const auth = await probes.githubAuth();
      checks.push(check('github_auth', 'GitHub sign-in', auth.status, auth.reason, 'Run `gh auth login` on this machine.'));
    } catch {
      checks.push(check('github_auth', 'GitHub sign-in', 'unknown', 'The GitHub CLI could not be checked.', 'Run `gh auth status` on this machine.'));
    }
  }

  checks.push(check('budget_limit', 'Agent budget set', input.agentBudgetUsd !== null && input.costPlanConfirmed ? 'passed' : 'failed',
    input.agentBudgetUsd === null ? 'No agent budget ceiling is set. A missing limit blocks work; it is never unlimited.' : input.costPlanConfirmed ? `The agent budget ceiling is $${input.agentBudgetUsd}.` : 'The cost plan was confirmed for an older blueprint.',
    'Set and confirm the agent budget in the cost plan.'));

  return { checks, baseSha, passed: readinessPassed(checks) };
}
