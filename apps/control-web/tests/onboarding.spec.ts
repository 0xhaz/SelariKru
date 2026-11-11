import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { base, blueprint, configured, costPlan, failed, ready } from './onboarding-fixtures.ts';

const API = 'http://127.0.0.1:5174/mockapi';
const SHOT_DIR = process.env['T61_SHOT_DIR'];
const SIZES = [[1440, 900], [1024, 768], [768, 1024], [375, 812]] as const;

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

async function open(page: Page, view: unknown, hash: string, theme: 'dark' | 'light' = 'dark', signIn?: string): Promise<void> {
  await page.addInitScript(([url, t, si]) => {
    (window as unknown as { __scenario: unknown }).__scenario = { onboardingApi: { baseUrl: url, ...(si ? { signIn: si } : {}) } };
    window.localStorage.setItem('selarikru.theme', t!);
  }, [API, theme, signIn]);
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

  test('activating here opens the project: the header names it and the address keeps it', async ({ page }) => {
    await open(page, ready, '#/onboarding?id=proj_1');
    await page.route('**/mockapi/v1/onboarding/proj_1/activate', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...ready, state: 'activated', firstRunId: 'run_7f2' }) }));
    await expect(page.getByTestId('project-label')).toHaveText(/No project selected$/);
    await page.getByRole('button', { name: 'Start first run' }).click();
    await expect(page.getByRole('heading', { name: 'Your first run is accepted' })).toBeVisible();
    await expect(page.getByTestId('project-label')).toHaveText(/proj_1$/);
    expect(new URL(page.url()).searchParams.get('project')).toBe('proj_1');
    expect(new URL(page.url()).hash).toBe('#/onboarding?id=proj_1');
  });

  test('viewing a setup activated earlier does not switch the open project', async ({ page }) => {
    await open(page, { ...ready, state: 'activated', firstRunId: 'run_7f2' }, '#/onboarding?id=proj_1');
    await expect(page.getByRole('heading', { name: 'Your first run is accepted' })).toBeVisible();
    await expect(page.getByTestId('project-label')).toHaveText(/No project selected$/);
    expect(new URL(page.url()).searchParams.get('project')).toBeNull();
  });

  test('an expired sign-in says so and offers to sign in again', async ({ page }) => {
    await open(page, ready, '#/onboarding?id=proj_1');
    await page.route('**/mockapi/v1/onboarding/proj_1/activate', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_token', message: 'token is not valid' } }) }));
    await page.getByRole('button', { name: 'Start first run' }).click();
    await expect(page.getByText('Your sign-in has expired')).toBeVisible();
    await expect(page.getByText(/Could not reach/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign in again' }).click();
    await expect(page.getByText('keeps everything on this page')).toBeVisible();
    await expect(page.getByRole('form', { name: 'Confirm your SelariKru sign-in' })).toBeVisible();
    await page.getByLabel('Password for owner@example.test').fill('wrong');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('The sign-in did not work. Check the password')).toBeVisible();
    // An unreachable sign-in service is not a wrong password.
    await page.getByLabel('Password for owner@example.test').fill('offline');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByTestId('reauth-result')).toHaveText('Could not reach the sign-in service; try again.');
    await page.getByLabel('Password for owner@example.test').fill('right');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByTestId('signed-in-again')).toContainText('nothing on this page was lost');
    await expect(page.getByRole('heading', { name: 'Confirm the first run' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __calls: { api: { kind: string }[] } }).__calls.api.filter((c) => c.kind === 'sign-in'))).toHaveLength(3);
  });

  test('too many attempts is said as such, not as a wrong password', async ({ page }) => {
    await open(page, ready, '#/onboarding?id=proj_1');
    await page.route('**/mockapi/v1/onboarding/proj_1/activate', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_token', message: 'token is not valid' } }) }));
    await page.getByRole('button', { name: 'Start first run' }).click();
    await page.getByRole('button', { name: 'Sign in again' }).click();
    await page.getByLabel('Password for owner@example.test').fill('limit');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText(/Too many sign-in attempts/)).toBeVisible();
    await expect(page.getByText('Check the password and try again')).toHaveCount(0);
  });

  test('an account without a password is offered sign out with true copy, not a password form', async ({ page }) => {
    await open(page, ready, '#/onboarding?id=proj_1', 'dark', 'federated');
    await page.route('**/mockapi/v1/onboarding/proj_1/activate', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_token', message: 'token is not valid' } }) }));
    await page.getByRole('button', { name: 'Start first run' }).click();
    await expect(page.getByText('Your sign-in has expired')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByText(/does not sign in with a password/)).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { __calls: { api: { kind: string }[] } }).__calls.api.filter((c) => c.kind === 'sign-out'))).toHaveLength(1);
  });

  test('an account that is not the owner is told so, and is not offered a sign-in that cannot help', async ({ page }) => {
    await open(page, ready, '#/onboarding?id=proj_1');
    await page.route('**/mockapi/v1/onboarding/proj_1/activate', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_owner', message: 'not the owner' } }) }));
    await page.getByRole('button', { name: 'Start first run' }).click();
    await expect(page.getByText('This account is not the project owner')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
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

test('H7: where the assistant runs is disclosed progressively: the suggestion and one sentence first, the details behind Why?', async ({ page }) => {
  await open(page, { ...configured, execution: null, connection: null }, '#/onboarding?id=proj_1');
  await expect(page.getByRole('heading', { name: 'Where should work happen?' })).toBeVisible();
  await expect(page.getByTestId('inference-suggestion')).toHaveText('Suggested: Device preferred. Your text stays on this device while Gemini Nano is ready here.');
  const why = page.getByTestId('inference-why');
  await expect(why).not.toHaveAttribute('open');
  await expect(why.getByText('Restricted text never goes to the cloud', { exact: false })).toBeHidden();
  await why.getByText('Why?').click();
  await expect(why.getByText('Restricted text never goes to the cloud', { exact: false })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Device preferred' })).toBeVisible();
});
