import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { RUNNER_RECENT_SECONDS, availableCatalog, readinessPassed, templateSupport, type BlueprintContent, type ExecutionChoice, type HarnessCatalog, type ReadinessCheck, type ReadinessCheckId, type ReadinessStatus, type RunnerHarnessReport } from '@selarikru/domain';
import { schema, type Executor } from '@selarikru/persistence';
import { evaluate, type Policy } from '@selarikru/policy';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';

/**
 * The trusted half of onboarding: these checks run on this server against real state. A request cannot supply a result, and only an explicit pass counts.
 * With no probes wired, as on the demo stack, the repository and GitHub checks say unknown, so demo data can never reach `ready`.
 */
type Fact = { readonly status: ReadinessStatus; readonly reason: string };

export interface GitFacts {
  readonly checkout: { readonly ok: boolean; readonly reason: string };
  readonly identity: Fact;
  readonly base: { readonly sha: string | null; readonly reason: string };
  /** Whether the base commit carries the frozen contract the verifier was built for. */
  readonly stack: Fact;
}

export interface ReadinessProbes {
  /** The deployment's one source checkout (`SELARIKRU_SOURCE_REPO`). Null: none is configured. */
  readonly sourceCheckout: string | null;
  git(input: { readonly checkout: string; readonly repository: string; readonly branch: string }): Promise<GitFacts>;
  /** Whether GitHub says this machine can push to the repository. */
  githubAccess(repository: string): Promise<Fact>;
}

/** Whether the background drivers run in this process. */
export interface PipelineDrivers { readonly assembly: boolean; readonly verification: boolean }

const execFileP = promisify(execFile);
const GIT_ENV = { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
/** The host is anchored, so `notgithub.com` or a path containing `github.com` is not GitHub. */
const ORIGIN_SLUG = /^(?:https?:\/\/(?:[^@/\s]+@)?|ssh:\/\/(?:[^@/\s]+@)?|git@)github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i;

async function gitOut(checkout: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', checkout, ...args], { env: GIT_ENV, timeout: 15_000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** `hashTree` from the verifier, over the commit instead of a directory, so an edited working tree cannot pass. */
async function contractHashAt(checkout: string, sha: string): Promise<string | null> {
  const listing = await gitOut(checkout, ['ls-tree', '-r', '--name-only', '--full-tree', sha, '--', 'contract']);
  if (listing === null || listing === '') return null;
  const lines: string[] = [];
  for (const path of listing.split('\n').sort()) {
    try {
      const { stdout } = await execFileP('git', ['-C', checkout, 'cat-file', 'blob', `${sha}:${path}`], { env: GIT_ENV, timeout: 15_000, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
      lines.push(`${path.replace(/^contract\//, '')}\0${createHash('sha256').update(stdout).digest('hex')}\n`);
    } catch {
      return null;
    }
  }
  return createHash('sha256').update(lines.join('')).digest('hex');
}

/** Reads real facts with `git`, argument arrays only. Branch and repository were validated by the request schema. */
export function createGitProbes(options: { sourceCheckout: string | null; githubAccess: ReadinessProbes['githubAccess']; certifiedContractSha256?: string | null | undefined }): ReadinessProbes {
  return {
    sourceCheckout: options.sourceCheckout,
    githubAccess: options.githubAccess,
    async git({ checkout, repository, branch }) {
      const unreadable = 'The checkout could not be read, so this could not be confirmed.';
      const nothing = { identity: { status: 'unknown' as const, reason: unreadable }, base: { sha: null, reason: unreadable }, stack: { status: 'unknown' as const, reason: unreadable } };
      if (!isAbsolute(checkout) || !existsSync(checkout)) return { checkout: { ok: false, reason: `The configured checkout does not exist on this machine: ${checkout}` }, ...nothing };
      if ((await gitOut(checkout, ['rev-parse', '--git-dir'])) === null) return { checkout: { ok: false, reason: `The configured checkout is not a git repository: ${checkout}` }, ...nothing };
      const url = await gitOut(checkout, ['remote', 'get-url', 'origin']);
      const slug = url === null ? null : (ORIGIN_SLUG.exec(url)?.[1] ?? null);
      const identity: Fact = url === null
        ? { status: 'unknown', reason: 'The checkout has no origin remote, so it cannot be confirmed as this repository.' }
        : slug === null
          ? { status: 'unknown', reason: 'The checkout has an origin remote, but it is not a GitHub repository.' }
          : slug.toLowerCase() === repository.toLowerCase()
            ? { status: 'passed', reason: `The checkout's origin is ${slug}.` }
            : { status: 'failed', reason: `The checkout's origin is ${slug}, not ${repository}.` };
      const sha = await gitOut(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
      const resolved = sha !== null && /^[0-9a-f]{40}$/.test(sha);
      const base = resolved ? { sha, reason: `Branch ${branch} resolves to ${sha.slice(0, 12)}.` } : { sha: null, reason: `Branch ${branch} does not exist in the checkout.` };
      let stack: Fact;
      if (!resolved) stack = { status: 'unknown', reason: 'There is no base commit to inspect.' };
      else if (!options.certifiedContractSha256) stack = { status: 'unknown', reason: 'This server could not read the hash of the verifier\'s contract, so the stack cannot be confirmed.' };
      else {
        const hash = await contractHashAt(checkout, sha!);
        stack = hash === null
          ? { status: 'failed', reason: 'The base commit has no contract directory, so it is not the Feedback Board starter the verifier can judge.' }
          : hash === options.certifiedContractSha256
            ? { status: 'passed', reason: 'The base commit carries the frozen Feedback Board contract.' }
            : { status: 'failed', reason: 'The base commit\'s contract differs from the frozen Feedback Board contract the verifier was built for.' };
      }
      return { checkout: { ok: true, reason: `The checkout at ${checkout} is a git repository.` }, identity, base, stack };
    },
  };
}

export type GhExec = (args: readonly string[]) => Promise<string>;
const realGh: GhExec = async (args) => (await execFileP('gh', [...args], { env: { ...process.env, GH_PROMPT_DISABLED: '1' }, timeout: 20_000, encoding: 'utf8' })).stdout;
const WRITE_ACCESS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/** `gh repo view`, on this machine. Requires write access. What `gh` printed is matched and never quoted. */
export async function ghRepoAccess(repository: string, exec: GhExec = realGh): Promise<Fact> {
  let out: string;
  try {
    out = await exec(['repo', 'view', repository, '--json', 'viewerPermission']);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unknown', reason: 'The GitHub CLI is not installed on this machine, so access to the repository cannot be confirmed.' };
    const said = `${(e as { stderr?: unknown }).stderr ?? ''}`;
    if (/gh auth login|not logged in|authentication/i.test(said)) return { status: 'failed', reason: 'The GitHub CLI is not signed in on this machine.' };
    if (/could not resolve to a repository|not found|http 404/i.test(said)) return { status: 'failed', reason: `GitHub says ${repository} does not exist, or this account cannot see it.` };
    return { status: 'unknown', reason: 'GitHub could not be reached, so access to the repository cannot be confirmed.' };
  }
  let permission: unknown;
  try {
    permission = (JSON.parse(out) as { viewerPermission?: unknown }).viewerPermission;
  } catch {
    return { status: 'unknown', reason: 'GitHub gave an answer that could not be read.' };
  }
  if (typeof permission !== 'string' || permission === '') return { status: 'unknown', reason: 'GitHub did not say what access this account has.' };
  return WRITE_ACCESS.has(permission)
    ? { status: 'passed', reason: `This account can push to ${repository}.` }
    : { status: 'failed', reason: `This account has ${permission.toLowerCase()} access to ${repository}. Opening a pull request needs write access.` };
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
  /** Absent: this process cannot say whether the drivers run. */
  readonly drivers: PipelineDrivers | undefined;
  readonly blueprint: BlueprintContent;
  readonly connection: { readonly repository: string; readonly defaultBranch: string } | null;
  readonly execution: ExecutionChoice | null;
  readonly classification: 'public' | 'internal';
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
    support.executable ? 'This is the pilot stack (Feedback Board), the only one the verifier can judge.' : support.unsupported.map((u) => u.reason).join(' '),
    'Change the focus to the pilot stack, or keep this as a plan only.'));

  const { probes, connection } = input;
  const CHECKOUT = 'Checkout present', IDENTITY = 'Checkout matches repository', BASE = 'Base commit resolves', STACK = 'Checkout is the pilot stack';
  const noFacts = (reason: string, checkoutStatus: ReadinessStatus, next: string | null): void => {
    checks.push(check('checkout_present', CHECKOUT, checkoutStatus, reason, next));
    checks.push(check('repository_identity', IDENTITY, 'unknown', reason, null));
    checks.push(check('base_commit', BASE, 'unknown', reason, null));
    checks.push(check('stack_certified', STACK, 'unknown', reason, null));
  };
  if (!probes) noFacts(NO_CHECKER, 'unknown', 'Run this on a real stack, with `pnpm dev:real`.');
  else if (probes.sourceCheckout === null) noFacts('This deployment has no source checkout configured (SELARIKRU_SOURCE_REPO).', 'failed', 'Set SELARIKRU_SOURCE_REPO to an absolute path and restart the API.');
  else if (!connection) noFacts('No repository is connected yet.', 'failed', 'Connect a repository in the previous step.');
  else {
    try {
      const facts = await probes.git({ checkout: probes.sourceCheckout, repository: connection.repository, branch: connection.defaultBranch });
      checks.push(check('checkout_present', CHECKOUT, facts.checkout.ok ? 'passed' : 'failed', facts.checkout.reason, 'Fix the path in SELARIKRU_SOURCE_REPO and restart the API.'));
      checks.push(check('repository_identity', IDENTITY, facts.identity.status, facts.identity.reason, `Point the checkout's origin at github.com/${connection.repository}.`));
      checks.push(check('base_commit', BASE, facts.base.sha ? 'passed' : 'failed', facts.base.reason, `Fetch or create ${connection.defaultBranch} in the checkout.`));
      checks.push(check('stack_certified', STACK, facts.stack.status, facts.stack.reason, 'Start from the Feedback Board starter in `examples/feedback-board-starter`.'));
      baseSha = facts.base.sha;
    } catch {
      noFacts('The checkout could not be read, so this could not be confirmed.', 'unknown', 'Check the checkout on this machine and try again.');
    }
  }

  const REACHABLE = 'Repository reachable';
  if (!input.pullRequestsEnabled) checks.push(check('repository_reachable', REACHABLE, 'failed', 'Draft pull requests are off on this server.', 'Set SELARIKRU_GITHUB_ENABLED=1 and restart the API.'));
  else if (!probes) checks.push(check('repository_reachable', REACHABLE, 'unknown', NO_CHECKER, null));
  else if (!connection) checks.push(check('repository_reachable', REACHABLE, 'unknown', 'No repository is connected yet.', null));
  else {
    try {
      const access = await probes.githubAccess(connection.repository);
      checks.push(check('repository_reachable', REACHABLE, access.status, access.reason, 'Run `gh auth login` on this machine with an account that can push to the repository.'));
    } catch {
      checks.push(check('repository_reachable', REACHABLE, 'unknown', 'GitHub could not be checked.', 'Run `gh repo view` for this repository on this machine.'));
    }
  }

  // Enrolment, models and project checkouts come from what each runner last said, seen by this server, and are judged for every location in scope.
  const locations = input.execution === 'hybrid' ? ['local', 'cloud'] : input.execution ? [input.execution] : [];
  const ENROLLED = 'Runner enrolled', HAS_PROJECT = 'Runner has this project';
  const runCommand = `--repo ${input.projectId}=${probes?.sourceCheckout ?? '<checkout>'}`;
  if (locations.length === 0) {
    checks.push(check('runner_enrolled', ENROLLED, 'failed', 'Execution has not been chosen yet.', 'Choose where workers run.'));
    checks.push(check('runner_has_project', HAS_PROJECT, 'unknown', 'Execution has not been chosen yet.', null));
  } else {
    const since = new Date(input.now.getTime() - RUNNER_RECENT_SECONDS * 1000);
    const seen = await input.db.select({ runnerId: schema.runners.runnerId, label: schema.runners.label, location: schema.runners.location, report: schema.runners.harnessReport, projects: schema.runners.configuredProjects }).from(schema.runners)
      .where(and(eq(schema.runners.tenantId, input.tenantId), isNull(schema.runners.revokedAt), inArray(schema.runners.location, locations), gte(schema.runners.lastSeenAt, since)));
    const at = (l: string) => seen.filter((r) => r.location === l);
    const missing = locations.filter((l) => at(l).length === 0);
    const noModel = locations.filter((l) => at(l).length > 0 && !availableCatalog(input.catalog, at(l).flatMap((r) => (r.report ?? []) as RunnerHarnessReport[])).providers.some((p) => p.models.length > 0));
    if (missing.length > 0) checks.push(check('runner_enrolled', ENROLLED, 'failed', `No ${missing.join(' or ')} runner has reached this server recently.`, `Pair a runner with \`selarikru-runner pair\`, then start it with \`${runCommand}\`.`));
    else if (noModel.length > 0) checks.push(check('runner_enrolled', ENROLLED, 'failed', `The ${noModel.join(' and ')} runner reports no model this build can launch.`, 'Install a supported harness on that runner.'));
    else checks.push(check('runner_enrolled', ENROLLED, 'passed', `A ${locations.join(' and a ')} runner reported in recently, with a model it can launch.`, null));

    // The scheduler does not filter claims by project, so any recent runner at a location may be handed this work: one without the checkout fails the attempt.
    const lacking = seen.filter((r) => r.projects !== null && !r.projects.includes(input.projectId)).map((r) => r.label ?? r.runnerId);
    const verdicts = locations.map((l) => {
      const here = at(l);
      if (here.length > 0 && here.every((r) => r.projects?.includes(input.projectId))) return 'has';
      return here.some((r) => r.projects !== null && !r.projects.includes(input.projectId)) ? 'lacks' : 'unsaid';
    });
    const next = `Restart the runner with \`${runCommand}\`.`;
    if (verdicts.every((v) => v === 'has')) checks.push(check('runner_has_project', HAS_PROJECT, 'passed', 'Every recent runner reports a source checkout for this project.', null));
    else if (verdicts.includes('lacks')) checks.push(check('runner_has_project', HAS_PROJECT, 'failed', `${lacking.join(', ')} ${lacking.length === 1 ? 'has' : 'have'} no source checkout for this project, and the scheduler can hand this work to any runner at that location, so its attempts would fail.`, next));
    else checks.push(check('runner_has_project', HAS_PROJECT, 'unknown', 'No runner has said which projects it has a checkout for.', next));
  }

  // Judged the way a cloud start is judged at claim, so this cannot pass where the scheduler would refuse.
  if (input.execution === 'cloud' || input.execution === 'hybrid') {
    const label = 'Cloud destination granted';
    const destination = input.policy?.destinations?.find((d) => d.purpose === 'execution')?.destination;
    if (!destination) checks.push(check('cloud_destination', label, 'failed', 'The loaded policy grants no destination for cloud execution.', 'Add an execution destination to the policy, or choose a local sandbox.'));
    else {
      const verdict = evaluate({ kind: 'start_cloud_worker', destination, sources: [{ id: `repo:${input.projectId}`, classification: input.classification }], totalRunning: 0, estimatedCost: 0, remainingBudget: input.agentBudgetUsd ?? 0 }, input.policy);
      checks.push(check('cloud_destination', label, verdict.decision === 'allow' ? 'passed' : 'failed',
        verdict.decision === 'allow' ? `The policy allows this project to run in ${destination}.` : verdict.decision === 'require_approval' ? 'The policy requires an approval for each cloud start.' : `The policy would refuse a cloud start: ${verdict.reason.replace(/[_:]/g, ' ')}.`,
        'Grant this repository as a source for the destination in the policy, or choose a local sandbox.'));
    }
  }

  const DRIVERS = 'Build and verification running';
  if (!input.drivers) checks.push(check('pipeline_drivers', DRIVERS, 'unknown', 'This server cannot say whether the assembly and verification drivers are running.', null));
  else {
    const off = [...(input.drivers.assembly ? [] : ['assembly']), ...(input.drivers.verification ? [] : ['verification'])];
    checks.push(check('pipeline_drivers', DRIVERS, off.length === 0 ? 'passed' : 'failed', off.length === 0 ? 'The assembly and verification drivers are running in this server.' : `The ${off.join(' and ')} driver is not running, so finished work would never be built or checked.`, 'Set SELARIKRU_ASSEMBLY_POLL_INTERVAL_MS and SELARIKRU_VERIFICATION_POLL_INTERVAL_MS, and restart the API.'));
  }

  const policyGate = input.policy ? evaluate({ kind: 'create_draft_pr' }, input.policy) : null;
  checks.push(check('policy_loaded', 'Policy loaded', policyGate?.decision === 'allow' ? 'passed' : 'failed',
    !input.policy ? 'No policy is loaded on this server.' : policyGate!.decision === 'allow' ? `Policy ${input.policy.policyVersion} is loaded and allows draft pull requests.` : 'The loaded policy does not allow draft pull requests.',
    'Load a policy that allows draft pull requests, and restart the API.'));

  checks.push(check('budget_limit', 'Agent budget set', input.agentBudgetUsd !== null && input.costPlanConfirmed ? 'passed' : 'failed',
    input.agentBudgetUsd === null ? 'No agent budget ceiling is set. A missing limit blocks work; it is never unlimited.' : input.costPlanConfirmed ? `The agent budget ceiling is $${input.agentBudgetUsd}.` : 'The cost plan has changed since you last confirmed it.',
    'Set and confirm the agent budget in the cost plan.'));

  return { checks, baseSha, passed: readinessPassed(checks) };
}
