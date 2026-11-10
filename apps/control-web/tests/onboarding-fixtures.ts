/** Onboarding views the specs serve from the mocked API: one project, "Clinic queue", at each step of its setup. */
export const goal = { name: 'Clinic queue', idea: 'Patients see their place in a clinic queue on their phone, with a live estimate of the wait.', audience: 'Small clinics and their patients', firstOutcome: 'A patient can see their position in the queue', classification: 'internal' };
export const blueprint = (over: Record<string, unknown> = {}) => ({
  version: 1, accepted: false, origin: 'controller', contentSha256: 'a'.repeat(64), createdAt: '2026-11-10T04:00:00.000Z',
  content: {
    schemaVersion: 1, goals: { idea: goal.idea, audience: goal.audience, firstOutcome: goal.firstOutcome }, tracks: ['saas_web'],
    stack: [], allowedPaths: ['src', 'tests'],
    acceptanceCriteria: [{ id: 'AC-1', text: 'A patient can see their position in the queue' }, { id: 'AC-2', text: 'Position updates without a page reload' }],
    roles: [{ role: 'Lead', reason: 'Keeps the plan to one small vertical slice' }, { role: 'Frontend', reason: 'Builds the screen the first outcome needs' }, { role: 'Backend', reason: 'Builds the API and storage behind it' }, { role: 'QA', reason: 'Checks the acceptance criteria independently' }],
    requiredConnections: ['GitHub repository'], nonGoals: ['Payments', 'SMS reminders'], assumptions: ['You will create an empty repository and connect it.'],
    firstMilestone: { title: 'One vertical slice with passing acceptance checks', tasks: [{ id: 'T1', title: 'Deliver: A patient can see their position in the queue', dependsOn: [] }] },
    pendingDecisions: [],
  },
  ...over,
});
export const line = (id: string, label: string, payer: string, provenance: string, basis: string, amount: number | null, unit = 'usd', cadence = 'monthly', source: unknown = null) => ({ id, label, cadence, unit, payer, lowUsd: amount, baseUsd: amount, highUsd: amount, provenance, basis, source });
export const noTotals = { knownLow: null, knownBase: null, knownHigh: null, unit: 'usd', cadence: 'monthly' };
export const ledgers = {
  build_effort: { lines: [line('build_effort', 'Build effort for the first milestone', 'you', 'unknown', 'No estimate yet. Effort is engineering judgment on scoped tasks, and the agent budget is not an estimate of it.', null, 'hours', 'one_time')], totals: { ...noTotals, unit: 'hours', cadence: 'one_time', unknownLines: 1 } },
  production: { lines: [line('line_db', 'Database', 'your_accounts', 'unknown', 'Not chosen yet.', null), { ...line('line_host', 'Hosting', 'your_accounts', 'user_estimate', 'My current hosting bill for a similar app', 10), lowUsd: 5, highUsd: 20 }], totals: { knownLow: 5, knownBase: 10, knownHigh: 20, unit: 'usd', cadence: 'monthly', unknownLines: 1 } },
  agent_usage: { lines: [line('platform_access', 'Platform access', 'platform', 'unknown', 'No launch price is set. The figures in planning documents are test hypotheses, not prices.', null), line('managed_usage', 'Managed model or worker usage', 'platform', 'unknown', 'This local release meters nothing on your behalf, and no managed lane is enabled.', null), line('coding_model', 'Coding model usage', 'your_provider', 'unknown', 'Billed by your model provider. No usage has been observed yet.', null), line('local_hardware', 'Local hardware and electricity', 'your_hardware', 'unknown', 'Your own machine. This service cannot see those costs, and local is not the same as free.', null)], totals: { ...noTotals, unknownLines: 4 } },
};
export const assumptions = { users: { value: '200 patients a day', confidence: 'low' }, traffic: { value: null, confidence: 'unknown' }, storage: { value: null, confidence: 'unknown' }, aiUsage: { value: null, confidence: 'unknown' } };
export const checks = (over: Record<string, { status: string; reason: string; next?: string | null }> = {}) => [
  ['template_supported', 'Template can run', 'This is the pilot stack (Feedback Board), the only one the verifier can judge.'],
  ['stack_certified', 'Checkout is the pilot stack', 'The base commit carries the frozen Feedback Board contract.'],
  ['checkout_present', 'Checkout present', 'The checkout at /srv/source is a git repository.'],
  ['repository_identity', 'Checkout matches repository', "The checkout's origin is acme/clinic-queue."],
  ['repository_reachable', 'Repository reachable', 'This account can push to acme/clinic-queue.'],
  ['base_commit', 'Base commit resolves', 'Branch main resolves to 1f3c8a90b2d4.'],
  ['runner_enrolled', 'Runner enrolled', 'A local runner reported in recently, with a model it can launch.'],
  ['runner_has_project', 'Runner has this project', 'The runner reports a source checkout for this project.'],
  ['pipeline_drivers', 'Build and verification running', 'The assembly and verification drivers are running in this server.'],
  ['policy_loaded', 'Policy loaded', 'Policy 2026-11-09.2 is loaded and allows draft pull requests.'],
  ['budget_limit', 'Agent budget set', 'The agent budget ceiling is $25.'],
].map(([id, label, reason]) => {
  const o = over[id!];
  return { id, label, status: o?.status ?? 'passed', reason: o?.reason ?? reason, nextAction: o?.next ?? null, required: true };
});

export const base = {
  projectId: 'proj_1', name: goal.name, state: 'draft', condition: null, revision: 3, goal, goalAssist: null, source: null, focus: null, blueprint: null, template: null, costPlan: null, execution: null, connection: null, readiness: null, firstRunId: null,
  deployment: { sourceCheckout: '/srv/source', servesRepository: null, checker: true },
};
export const execution = { execution: 'local', inference: 'PREFER_ON_DEVICE' };
export const costPlan = { agentBudgetUsd: 25, confirmed: true, ledgers, assumptions };
export const snapshot = { blueprintVersion: 1, execution: 'local', inference: 'PREFER_ON_DEVICE', agentBudgetUsd: 25, repository: 'acme/clinic-queue', defaultBranch: 'main', baseSha: 'b'.repeat(40) };
export const configured = { ...base, state: 'configuring', source: { kind: 'new' }, focus: { tracks: ['saas_web'] }, blueprint: blueprint({ accepted: true }), template: { executable: true, unsupported: [] }, costPlan, execution, connection: { repository: 'acme/clinic-queue', defaultBranch: 'main' } };
export const failed = {
  ...configured, state: 'readiness_check', condition: { kind: 'blocked', reason: 'Not ready: Runner has this project, Repository reachable, Checkout matches repository.' },
  readiness: { blueprintVersion: 1, outcome: 'blocked', checkedAt: '2026-11-10T04:12:00.000Z', baseSha: 'b'.repeat(40), snapshot, checks: checks({
    repository_identity: { status: 'unknown', reason: 'The checkout has no origin remote, so it cannot be confirmed as this repository.', next: 'Point the checkout\'s origin at github.com/acme/clinic-queue.' },
    runner_has_project: { status: 'failed', reason: 'The runner has not been given a source checkout for this project, so it could not build it.', next: 'Restart the runner with `--repo proj_1=/srv/source`.' },
    repository_reachable: { status: 'failed', reason: 'The GitHub CLI is not signed in on this machine.', next: 'Run `gh auth login` on this machine with an account that can push to the repository.' },
  }) },
};
export const ready = { ...configured, state: 'ready', readiness: { blueprintVersion: 1, outcome: 'ready', checkedAt: '2026-11-10T04:14:00.000Z', baseSha: 'b'.repeat(40), snapshot, checks: checks() } };
