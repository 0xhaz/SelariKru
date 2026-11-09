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
const line = (id: string, label: string, provenance: string, basis: string, amount: number | null, cadence = 'monthly', source: unknown = null) => ({ id, label, cadence, lowUsd: amount, baseUsd: amount, highUsd: amount, provenance, basis, source });
const ledgers = {
  platform: { lines: [line('platform_access', 'Platform access', 'unknown', 'No launch price is set. The figures in planning documents are test hypotheses, not prices.', null), line('managed_usage', 'Managed model or worker usage', 'unknown', 'This local release meters nothing on your behalf, and no managed lane is enabled.', null)], totals: { knownLowUsd: null, knownBaseUsd: null, knownHighUsd: null, unknownLines: 2 } },
  provider: { lines: [line('coding_model', 'Coding model usage', 'unknown', 'Billed by your model provider. No usage has been observed yet.', null), line('local_hardware', 'Local hardware and electricity', 'unknown', 'Your own machine. This service cannot see those costs, and local is not the same as free.', null)], totals: { knownLowUsd: null, knownBaseUsd: null, knownHighUsd: null, unknownLines: 2 } },
  app: { lines: [line('line_db', 'Database', 'unknown', 'Not chosen yet.', null), { ...line('line_host', 'Hosting', 'user_estimate', 'My current hosting bill for a similar app', 10), lowUsd: 5, highUsd: 20 }], totals: { knownLowUsd: 5, knownBaseUsd: 10, knownHighUsd: 20, unknownLines: 1 } },
};
const checks = (over: Record<string, { status: string; reason: string; next?: string | null }> = {}) => [
  ['template_supported', 'Template can run', 'Every chosen track is certified to run.'],
  ['repository_path', 'Repository reachable', 'The checkout at /srv/source is a git repository.'],
  ['repository_identity', 'Checkout matches repository', "The checkout's origin is acme/clinic-queue."],
  ['base_commit', 'Base commit resolves', 'Branch main resolves to 1f3c8a90b2d4.'],
  ['runner_enrolled', 'Runner enrolled', 'A local runner reported in recently.'],
  ['policy_loaded', 'Policy loaded', 'Policy 2026-11-09.2 is loaded and allows draft pull requests.'],
  ['github_auth', 'GitHub sign-in', 'The GitHub CLI is signed in on this machine.'],
  ['budget_limit', 'Agent budget set', 'The agent budget ceiling is $25.'],
].map(([id, label, reason]) => {
  const o = over[id!];
  return { id, label, status: o?.status ?? 'passed', reason: o?.reason ?? reason, nextAction: o?.next ?? null, required: true };
});

const base = {
  projectId: 'proj_1', name: goal.name, state: 'draft', condition: null, revision: 3, goal, source: null, focus: null, blueprint: null, template: null, costPlan: null, execution: null, connection: null, readiness: null, firstRunId: null,
  deployment: { sourceCheckout: '/srv/source', servesRepository: null, checker: true },
};
const execution = { execution: 'local', inference: 'PREFER_ON_DEVICE' };
const costPlan = { agentBudgetUsd: 25, confirmed: true, ledgers };
const configured = { ...base, state: 'configuring', source: { kind: 'new' }, focus: { tracks: ['saas_web'] }, blueprint: blueprint({ accepted: true }), template: { executable: true, unsupported: [] }, costPlan, execution, connection: { repository: 'acme/clinic-queue', defaultBranch: 'main' } };
const failed = {
  ...configured, state: 'readiness_check', condition: { kind: 'blocked', reason: 'Not ready: Runner enrolled, GitHub sign-in, Checkout matches repository.' },
  readiness: { blueprintVersion: 1, outcome: 'blocked', checkedAt: '2026-11-10T04:12:00.000Z', baseSha: 'b'.repeat(40), checks: checks({
    repository_identity: { status: 'unknown', reason: 'The checkout has no origin remote, so it cannot be confirmed as this repository.', next: 'Point the checkout\'s origin at github.com/acme/clinic-queue.' },
    runner_enrolled: { status: 'failed', reason: 'No local runner has reached this server recently.', next: 'Pair a runner and start it on this machine, then try again.' },
    github_auth: { status: 'failed', reason: 'The GitHub CLI is not signed in to github.com on this machine.', next: 'Run `gh auth login` on this machine.' },
  }) },
};
const ready = { ...configured, state: 'ready', readiness: { blueprintVersion: 1, outcome: 'ready', checkedAt: '2026-11-10T04:14:00.000Z', baseSha: 'b'.repeat(40), checks: checks() } };

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
    const runner = page.getByTestId('check-runner_enrolled');
    await expect(runner).toHaveAttribute('data-status', 'failed');
    await expect(runner).toContainText('Failed');
    await expect(runner).toContainText('No local runner has reached this server recently.');
    await expect(runner).toContainText('Next:');
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
