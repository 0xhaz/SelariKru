import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:5174/mockapi';
const SHOT_DIR = process.env['T61_SHOT_DIR'];
const SIZES = [[1440, 900], [1024, 768], [768, 1024], [375, 812]] as const;

const goal = { name: 'Clinic queue', idea: 'Patients see their place in a clinic queue on their phone, with a live estimate of the wait.', audience: 'Small clinics and their patients', firstOutcome: 'A patient can see their position in the queue', classification: 'internal' };
const blueprint = (over: Record<string, unknown> = {}) => ({
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
const line = (id: string, label: string, payer: string, provenance: string, basis: string, amount: number | null, unit = 'usd', cadence = 'monthly', source: unknown = null) => ({ id, label, cadence, unit, payer, lowUsd: amount, baseUsd: amount, highUsd: amount, provenance, basis, source });
const noTotals = { knownLow: null, knownBase: null, knownHigh: null, unit: 'usd', cadence: 'monthly' };
const ledgers = {
  build_effort: { lines: [line('build_effort', 'Build effort for the first milestone', 'you', 'unknown', 'No estimate yet. Effort is engineering judgment on scoped tasks, and the agent budget is not an estimate of it.', null, 'hours', 'one_time')], totals: { ...noTotals, unit: 'hours', cadence: 'one_time', unknownLines: 1 } },
  production: { lines: [line('line_db', 'Database', 'your_accounts', 'unknown', 'Not chosen yet.', null), { ...line('line_host', 'Hosting', 'your_accounts', 'user_estimate', 'My current hosting bill for a similar app', 10), lowUsd: 5, highUsd: 20 }], totals: { knownLow: 5, knownBase: 10, knownHigh: 20, unit: 'usd', cadence: 'monthly', unknownLines: 1 } },
  agent_usage: { lines: [line('platform_access', 'Platform access', 'platform', 'unknown', 'No launch price is set. The figures in planning documents are test hypotheses, not prices.', null), line('managed_usage', 'Managed model or worker usage', 'platform', 'unknown', 'This local release meters nothing on your behalf, and no managed lane is enabled.', null), line('coding_model', 'Coding model usage', 'your_provider', 'unknown', 'Billed by your model provider. No usage has been observed yet.', null), line('local_hardware', 'Local hardware and electricity', 'your_hardware', 'unknown', 'Your own machine. This service cannot see those costs, and local is not the same as free.', null)], totals: { ...noTotals, unknownLines: 4 } },
};
const assumptions = { users: { value: '200 patients a day', confidence: 'low' }, traffic: { value: null, confidence: 'unknown' }, storage: { value: null, confidence: 'unknown' }, aiUsage: { value: null, confidence: 'unknown' } };
const checks = (over: Record<string, { status: string; reason: string; next?: string | null }> = {}) => [
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

const base = {
  projectId: 'proj_1', name: goal.name, state: 'draft', condition: null, revision: 3, goal, goalAssist: null, source: null, focus: null, blueprint: null, template: null, costPlan: null, execution: null, connection: null, readiness: null, firstRunId: null,
  deployment: { sourceCheckout: '/srv/source', servesRepository: null, checker: true },
};
const execution = { execution: 'local', inference: 'PREFER_ON_DEVICE' };
const costPlan = { agentBudgetUsd: 25, confirmed: true, ledgers, assumptions };
const snapshot = { blueprintVersion: 1, execution: 'local', inference: 'PREFER_ON_DEVICE', agentBudgetUsd: 25, repository: 'acme/clinic-queue', defaultBranch: 'main', baseSha: 'b'.repeat(40) };
const configured = { ...base, state: 'configuring', source: { kind: 'new' }, focus: { tracks: ['saas_web'] }, blueprint: blueprint({ accepted: true }), template: { executable: true, unsupported: [] }, costPlan, execution, connection: { repository: 'acme/clinic-queue', defaultBranch: 'main' } };
const failed = {
  ...configured, state: 'readiness_check', condition: { kind: 'blocked', reason: 'Not ready: Runner has this project, Repository reachable, Checkout matches repository.' },
  readiness: { blueprintVersion: 1, outcome: 'blocked', checkedAt: '2026-11-10T04:12:00.000Z', baseSha: 'b'.repeat(40), snapshot, checks: checks({
    repository_identity: { status: 'unknown', reason: 'The checkout has no origin remote, so it cannot be confirmed as this repository.', next: 'Point the checkout\'s origin at github.com/acme/clinic-queue.' },
    runner_has_project: { status: 'failed', reason: 'The runner has not been given a source checkout for this project, so it could not build it.', next: 'Restart the runner with `--repo proj_1=/srv/source`.' },
    repository_reachable: { status: 'failed', reason: 'The GitHub CLI is not signed in on this machine.', next: 'Run `gh auth login` on this machine with an account that can push to the repository.' },
  }) },
};
const ready = { ...configured, state: 'ready', readiness: { blueprintVersion: 1, outcome: 'ready', checkedAt: '2026-11-10T04:14:00.000Z', baseSha: 'b'.repeat(40), snapshot, checks: checks() } };

type Screen = { id: string; view: unknown; hash: string; heading: string; run?: (p: Page) => Promise<void> };
const go = (name: string) => async (p: Page) => { await p.getByRole('navigation', { name: 'Setup steps' }).getByRole('button', { name, exact: true }).click(); };
const SCREENS: readonly Screen[] = [
  { id: 'entry', view: null, hash: '#/onboarding', heading: 'Set up a project' },
  { id: 'goal', view: base, hash: '#/onboarding?id=proj_1', heading: 'What do you want to build, and who is it for?', run: go('Goal') },
  { id: 'source', view: { ...base }, hash: '#/onboarding?id=proj_1', heading: 'Is this a new project or an existing app?' },
  { id: 'focus', view: { ...base, source: { kind: 'new' } }, hash: '#/onboarding?id=proj_1', heading: 'What are you building first?' },
  { id: 'blueprint', view: { ...base, state: 'blueprint_ready', source: { kind: 'new' }, focus: { tracks: ['saas_web'] }, blueprint: blueprint(), template: { executable: true, unsupported: [] } }, hash: '#/onboarding?id=proj_1', heading: 'Review your blueprint' },
  { id: 'cost-plan', view: { ...configured, costPlan: null, execution: null, connection: null }, hash: '#/onboarding?id=proj_1', heading: 'What will it cost?' },
  { id: 'cost-plan-filled', view: { ...configured, execution: null, connection: null, costPlan: { ...costPlan, confirmed: false } }, hash: '#/onboarding?id=proj_1', heading: 'What will it cost?' },
  { id: 'execution', view: { ...configured, execution: null, connection: null }, hash: '#/onboarding?id=proj_1', heading: 'Where should work happen?' },
  { id: 'connections', view: { ...configured, connection: null }, hash: '#/onboarding?id=proj_1', heading: 'Connect the repository' },
  { id: 'readiness-failed', view: failed, hash: '#/onboarding?id=proj_1', heading: 'Is everything really ready?' },
  { id: 'readiness-passed', view: ready, hash: '#/onboarding?id=proj_1', heading: 'Is everything really ready?', run: go('Readiness') },
  { id: 'start', view: ready, hash: '#/onboarding?id=proj_1', heading: 'Confirm the first run' },
  { id: 'activated', view: { ...ready, state: 'activated', firstRunId: 'run_7f2' }, hash: '#/onboarding?id=proj_1', heading: 'Your first run is accepted' },
];

async function mockApi(page: Page, view: unknown, list: unknown = { items: [] }): Promise<{ posts: string[] }> {
  const calls = { posts: [] as string[] };
  await page.route('**/mockapi/v1/onboarding**', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') calls.posts.push(new URL(req.url()).pathname);
    const url = new URL(req.url());
    const json = url.pathname.endsWith('/v1/onboarding') ? (req.method() === 'GET' ? list : view) : view;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
  });
  return calls;
}

async function open(page: Page, view: unknown, hash: string, theme: 'dark' | 'light' = 'dark'): Promise<void> {
  await page.addInitScript(([url, t]) => {
    (window as unknown as { __scenario: unknown }).__scenario = { onboardingApi: { baseUrl: url } };
    window.localStorage.setItem('selarikru.theme', t!);
  }, [API, theme]);
  await mockApi(page, view);
  await page.goto(`/tests/harness/index.html${hash}`);
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.describe('screens', () => {
  for (const s of SCREENS) {
    for (const [width, height] of SIZES) {
      test(`${s.id} at ${width} reads and has no axe violations`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await open(page, s.view, s.hash);
        if (s.run) await s.run(page);
        await expect(page.getByRole('heading', { name: s.heading })).toBeVisible();
        await expect(page.locator('body')).not.toHaveClass(/error/);
        if (s.id !== 'entry') await expect(page.getByTestId('setup-name')).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, 'no horizontal page scroll').toBeLessThanOrEqual(0);
        await expectNoAxeViolations(page);
        if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${s.id}-${width}.png`, fullPage: true });
      });
    }
    test(`${s.id} in light theme has no axe violations`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, s.view, s.hash, 'light');
      if (s.run) await s.run(page);
      await expect(page.getByRole('heading', { name: s.heading })).toBeVisible();
      await expectNoAxeViolations(page);
      if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${s.id}-1440-light.png`, fullPage: true });
    });
  }
});

test.describe('behaviour', () => {
  const stepNav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Setup steps' }).getByRole('button', { name, exact: true });

  test('text marked restricted cannot be saved, and clearing the mark is deliberate', async ({ page }) => {
    await open(page, base, '#/onboarding?id=proj_1');
    await stepNav(page, 'Goal').click();
    const save = page.getByRole('button', { name: 'Save and continue' });
    await expect(save).toBeEnabled();
    await page.getByLabel('This text includes restricted material').click();
    await expect(save).toBeDisabled();
    await expect(page.getByText('This text is marked restricted, so it cannot be saved.')).toBeVisible();
    await page.getByRole('button', { name: 'I have removed the restricted material' }).click();
    await expect(save).toBeEnabled();
  });

  test('a ledger total follows the rows on screen', async ({ page }) => {
    await open(page, { ...configured, costPlan: { ...costPlan, confirmed: false }, execution: null, connection: null }, '#/onboarding?id=proj_1');
    await expect(page.getByTestId('ledger-total-production')).toHaveText('Known monthly: $5–$20');
    const ledger = page.getByTestId('ledger-production');
    await ledger.getByRole('button', { name: /Add a line/ }).click();
    await ledger.getByLabel('What is it').fill('Email');
    await ledger.getByLabel('Low, $/month').fill('1');
    await ledger.getByLabel('Base', { exact: true }).fill('2');
    await ledger.getByLabel('High', { exact: true }).fill('3');
    await ledger.getByLabel('What this is based on').fill('Provider price page');
    await ledger.getByRole('button', { name: 'Add line' }).click();
    await expect(page.getByTestId('ledger-total-production')).toHaveText('Known monthly: $6–$23');
  });

  test('build effort and the agent budget are kept apart', async ({ page }) => {
    await open(page, { ...configured, costPlan: { ...costPlan, confirmed: false }, execution: null, connection: null }, '#/onboarding?id=proj_1');
    await expect(page.getByTestId('cost-line-build_effort')).toContainText('Unknown');
    await expect(page.getByTestId('cost-line-build_effort')).toContainText('Paid by You');
    await expect(page.getByText('It is not an estimate of build effort', { exact: false })).toBeVisible();
  });

  test('the cost step shows what the budget allows each attempt on the pilot', async ({ page }) => {
    const split = blueprint({ accepted: true });
    (split.content as Record<string, unknown>)['rolePaths'] = { backend: ['server', 'migrations', 'tests/backend'], frontend: ['src', 'tests/frontend'] };
    await open(page, { ...configured, blueprint: split, costPlan: { ...costPlan, confirmed: false }, execution: null, connection: null, deployment: { sourceCheckout: '/srv/source', servesRepository: null, checker: true, maxAttempts: 3, attemptShares: { backend: 0.125, frontend: 0.2083333 } } }, '#/onboarding?id=proj_1');
    await expect(page.getByTestId('attempt-cap')).toContainText('backend $3.13');
    await expect(page.getByTestId('attempt-cap')).toContainText('frontend $5.21');
  });

  test('a pilot blueprint that no longer matches the suite offers a redraft', async ({ page }) => {
    await open(page, { ...base, state: 'blueprint_ready', source: { kind: 'new' }, focus: { tracks: ['saas_web'] }, blueprint: blueprint(), template: { executable: true, unsupported: [] } }, '#/onboarding?id=proj_1');
    await expect(page.getByText('This version needs redrafting')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Draft a new version' })).toBeVisible();
  });

  test('a choice that adds cost lines returns to the cost plan', async ({ page }) => {
    const before = { ...configured, execution: null, connection: null };
    const after = { ...before, execution: { execution: 'cloud', inference: 'PREFER_ON_DEVICE' }, costPlan: { ...costPlan, confirmed: false } };
    await page.addInitScript((url) => { (window as unknown as { __scenario: unknown }).__scenario = { onboardingApi: { baseUrl: url } }; }, API);
    await page.route('**/mockapi/v1/onboarding**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().method() === 'POST' ? after : before) }));
    await page.goto('/tests/harness/index.html#/onboarding?id=proj_1');
    await page.getByLabel(/Cloud sandbox/).check();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByRole('heading', { name: 'What will it cost?' })).toBeVisible();
    await expect(page.getByText('added cloud worker time')).toBeVisible();
  });

  test('after activation setup is read-only and the next action is planning', async ({ page }) => {
    await open(page, { ...ready, state: 'activated', firstRunId: 'run_7f2' }, '#/onboarding?id=proj_1');
    await expect(page.getByRole('link', { name: 'Plan the run' })).toHaveAttribute('href', /#\/assistant\?run=run_7f2/);
    await stepNav(page, 'Blueprint').click();
    await expect(page.getByText('so its setup can no longer change')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit blueprint' })).toHaveCount(0);
    await stepNav(page, 'Connections').click();
    await expect(page.getByLabel('GitHub repository')).toBeDisabled();
  });

  test('after activation the header names the activated project, and the address keeps it', async ({ page }) => {
    await open(page, { ...ready, state: 'activated', firstRunId: 'run_7f2' }, '#/onboarding?id=proj_1');
    await expect(page.getByRole('heading', { name: 'Your first run is accepted' })).toBeVisible();
    await expect(page.getByTestId('project-label')).toHaveText(/proj_1$/);
    await expect(page.getByTestId('project-label')).not.toContainText('No project selected');
    expect(new URL(page.url()).searchParams.get('project')).toBe('proj_1');
    expect(new URL(page.url()).hash).toBe('#/onboarding?id=proj_1');
  });

  test('before activation the header still says no project is selected', async ({ page }) => {
    await open(page, ready, '#/onboarding?id=proj_1');
    await expect(page.getByTestId('project-label')).toHaveText(/No project selected$/);
    expect(new URL(page.url()).searchParams.get('project')).toBeNull();
  });

  test('a hint and an error are tied to their control', async ({ page }) => {
    await page.addInitScript((url) => { (window as unknown as { __scenario: unknown }).__scenario = { onboardingApi: { baseUrl: url } }; }, API);
    await page.route('**/mockapi/v1/onboarding**', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'credential_in_input', message: 'x', details: { paths: ['goal.idea'] } } }) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(base) }));
    await page.goto('/tests/harness/index.html#/onboarding?id=proj_1');
    await stepNav(page, 'Goal').click();
    await page.getByRole('button', { name: 'Save and continue' }).click();
    const idea = page.getByLabel('Your idea');
    await expect(idea).toHaveAttribute('aria-invalid', 'true');
    await expect(idea).toHaveAttribute('aria-describedby', 'goal-idea-hint goal-idea-error');
    await stepNav(page, 'Starting point').click();
    await expect(page.getByText('That did not work')).toHaveCount(0);
  });

  test('first-time setup does not say the data is unavailable', async ({ page }) => {
    await open(page, null, '#/onboarding');
    await expect(page.getByRole('heading', { name: 'What you will go through' })).toBeVisible();
    await expect(page.getByTestId('freshness')).toHaveCount(0);
  });

  test('a double click submits the goal once', async ({ page }) => {
    await page.addInitScript((url) => { (window as unknown as { __scenario: unknown }).__scenario = { onboardingApi: { baseUrl: url } }; }, API);
    const calls = await mockApi(page, base);
    await page.goto('/tests/harness/index.html#/onboarding');
    await page.getByRole('button', { name: 'Start a new project' }).click();
    await page.getByLabel('Project name').fill('Clinic queue');
    await page.getByLabel('Your idea').fill('An idea');
    await page.getByLabel('Who it is for').fill('Clinics');
    await page.getByLabel('First useful outcome').fill('An outcome');
    await page.getByRole('button', { name: 'Save and continue' }).dblclick();
    await expect(page.getByRole('heading', { name: 'Is this a new project or an existing app?' })).toBeVisible();
    expect(calls.posts.filter((p) => p.endsWith('/v1/onboarding'))).toHaveLength(1);
  });

  test('a failed check says why and what to do next, with no pass implied', async ({ page }) => {
    await open(page, failed, '#/onboarding?id=proj_1');
    const runner = page.getByTestId('check-runner_has_project');
    await expect(runner).toHaveAttribute('data-status', 'failed');
    await expect(runner).toContainText('Failed');
    await expect(runner).toContainText('has not been given a source checkout');
    await expect(runner).toContainText('Next:');
    await expect(runner.locator('code')).toHaveText('--repo proj_1=/srv/source');
    await expect(page.getByTestId('readiness-checks')).not.toContainText('`');
    await expect(page.getByTestId('check-repository_identity')).toContainText('Unknown');
    await expect(page.getByTestId('setup-state')).toContainText('Blocked');
  });

  test('start is refused in the page until readiness has passed', async ({ page }) => {
    await open(page, { ...failed, state: 'readiness_check' }, '#/onboarding?id=proj_1');
    await expect(page.getByRole('button', { name: 'Run checks again' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Setup steps' }).getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start first run' })).toHaveCount(0);
  });

  test('an unsupported template is labelled plan only and the blueprint says a run is refused', async ({ page }) => {
    const planOnly = { ...base, state: 'blueprint_ready', source: { kind: 'new' }, focus: { tracks: ['mobile'] }, blueprint: { ...blueprint(), content: { ...blueprint().content, tracks: ['mobile'] } }, template: { executable: false, unsupported: [{ track: 'mobile', reason: 'Mobile builds need a platform toolchain and device or emulator access this service cannot verify yet.' }] } };
    await open(page, planOnly, '#/onboarding?id=proj_1');
    await expect(page.getByText('Plan only')).toBeVisible();
    await expect(page.getByText(/a run is refused/)).toBeVisible();
  });

  test('the assistant proposal is labelled unsaved and needs a human action', async ({ page }) => {
    await open(page, base, '#/onboarding?id=proj_1');
    await page.getByRole('navigation', { name: 'Setup steps' }).getByRole('button', { name: 'Goal', exact: true }).click();
    await page.getByText('Draft this with the assistant').click();
    await expect(page.getByTestId('assist-route-text')).toContainText('Device preferred');
    await expect(page.getByRole('button', { name: 'Draft a suggestion' })).toBeEnabled();
  });

  test('demo data can never pass readiness', async ({ page }) => {
    await page.goto('/?demo#/onboarding');
    await expect(page.getByRole('heading', { name: 'Set up a project' })).toBeVisible();
    await expect(page.getByText('Demo progress can never pass readiness', { exact: false }).first()).toBeVisible();
  });

  test('editing the blueprint offers a new version and warns about readiness', async ({ page }) => {
    await open(page, { ...base, state: 'blueprint_ready', source: { kind: 'new' }, focus: { tracks: ['saas_web'] }, blueprint: blueprint(), template: { executable: true, unsupported: [] } }, '#/onboarding?id=proj_1');
    await expect(page.getByText(/Editing makes a new version/)).toBeVisible();
    await page.getByRole('button', { name: 'Edit blueprint' }).click();
    await expect(page.getByRole('button', { name: 'Save as version 2' })).toBeVisible();
  });

  test('an unknown cost is written out and never shown as zero', async ({ page }) => {
    await open(page, { ...configured, costPlan: { ...costPlan, confirmed: false }, execution: null, connection: null }, '#/onboarding?id=proj_1');
    const line_ = page.getByTestId('cost-line-coding_model');
    await expect(line_).toContainText('Unknown');
    await expect(line_).not.toContainText('$0');
    await expect(page.getByText('not counted as zero').first()).toBeVisible();
  });
});
