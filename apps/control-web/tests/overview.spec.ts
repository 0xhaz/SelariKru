import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/?demo${query}#/overview`);
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
}
const fixture = (id: string): string => `&fixture=${id}`;
/** Below the width where the team panel sits beside the page, so the Fleet card lists each worker itself. */
const FULL_FLEET = { width: 1024, height: 900 };
const items = (page: Page) => page.getByTestId('attention-item');

async function expectNoAxeViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('attention sorted per design §4 order', async ({ page }) => {
  await open(page, fixture('policy-block'));
  await expect(items(page)).toHaveCount(2);
  await expect(items(page).nth(0)).toHaveAttribute('data-kind', 'policy_incident');
  await expect(items(page).nth(1)).toHaveAttribute('data-kind', 'decision');
  await expect(page.getByTestId('headline')).toHaveText(/2 items need you\.$/);
  await expect(page.getByTestId('attention-count')).toHaveText('2 need attention');
});

test('shows "n of m criteria verified", never a percentage', async ({ page }) => {
  await open(page, fixture('merge-flow'));
  await expect(page.getByTestId('criteria')).toHaveText('5 of 5 criteria verified');
  await expect(page.getByTestId('criteria-note')).toHaveCount(0);
  expect(await page.getByRole('main').innerText()).not.toMatch(/\d\s?%/);
});

test('when per-criterion evidence is missing it counts tasks and says so', async ({ page }) => {
  await open(page, fixture('long-build-stall'));
  await expect(page.getByTestId('criteria')).toHaveText('0 of 1 tasks verified');
  await expect(page.getByTestId('criteria-note')).toContainText('Per-criterion evidence is not connected');
});

test('zero verified never looks complete: only verified segments are filled', async ({ page }) => {
  await open(page, fixture('healthy-parallel-work'));
  await expect(page.getByTestId('segment')).toHaveCount(5);
  await expect(page.locator('[data-testid="segment"][data-filled="true"]')).toHaveCount(0);
});

test('heartbeat never increments verified criteria', async ({ page }) => {
  await page.setViewportSize(FULL_FLEET); // below the team panel's width, where this card lists every worker
  await open(page, fixture('healthy-parallel-work'));
  await expect(page.getByTestId('criteria')).toHaveText('0 of 5 criteria verified');
  await page.getByRole('button', { name: 'Advance 10 s' }).click();
  await expect(page.getByTestId('fleet-row').filter({ hasText: 'runner_cloud_1' })).toContainText('Heartbeat');
  await expect(page.getByTestId('criteria')).toHaveText('0 of 5 criteria verified');
});

test('empty project shows next action and no fake agents', async ({ page }) => {
  await open(page, fixture('no-data'));
  await expect(page.getByText('No run in this project yet')).toBeVisible();
  // Under demo data the assistant is off, so the next action must not lead there.
  await expect(page.getByRole('link', { name: 'Leave demo mode' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the Assistant' })).toHaveCount(0);
  await expect(page.getByTestId('fleet-row')).toHaveCount(0);
  await expect(page.getByTestId('criteria')).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText('$0');
});

test('Demo data badge persists in mock mode', async ({ page }) => {
  await open(page, fixture('human-wait'));
  const badge = page.getByTestId('demo-badge');
  await expect(badge).toContainText('Demo data');
  await expect(badge.getByRole('button')).toHaveCount(0);

  await page.getByLabel('Fixture').selectOption({ label: 'Runner loss' });
  await expect(badge).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(badge).toBeInViewport();
  await page.getByTestId('top-bar-more').click();
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await expect(badge).toBeVisible();
});

test('under demo data the live assistant is not mounted and Firebase is not contacted', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:5174/') && !r.url().startsWith('data:')) external.push(r.url());
  });
  await open(page);
  await page.getByTestId('top-bar-more').click();
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await expect(page.getByRole('heading', { name: 'The assistant is off in demo mode' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate draft' })).toHaveCount(0);
  expect(external).toEqual([]);
});

test('execution and inference are separately labeled for each worker', async ({ page }) => {
  await page.setViewportSize(FULL_FLEET); // below the team panel's width, where this card lists every worker
  await open(page, fixture('healthy-parallel-work'));
  const local = page.getByTestId('fleet-row').filter({ hasText: 'runner_local_1' });
  await expect(local).toContainText('Execution');
  await expect(local).toContainText('Local sandbox');
  await expect(local).toContainText('Inference');
  await expect(local).toContainText('Model in cloud');
});

test('a runner loss shows the last confirmed time and offers inspection', async ({ page }) => {
  await page.setViewportSize(FULL_FLEET); // below the team panel's width, where this card lists every worker
  await open(page, fixture('runner-loss'));
  await expect(items(page).first()).toHaveAttribute('data-kind', 'worker_lost');
  await expect(items(page).first()).toContainText('Inspect the attempt before relaunching anything');
  await expect(page.getByTestId('fleet-row').first()).toContainText('Connection lost; state last confirmed');
});

test('unknown costs read as unknown, never zero', async ({ page }) => {
  await open(page, fixture('unknown-costs'));
  const resources = page.getByRole('region', { name: 'Resources and usage' });
  await expect(resources).toContainText('Unavailable');
  await expect(resources).toContainText('At least $3.74 known; 1 of 3 figures missing');
  await expect(resources).not.toContainText('Unknown');
});

test('reconnecting keeps the last confirmed state and stops claiming health', async ({ page }) => {
  await page.setViewportSize(FULL_FLEET); // below the team panel's width, where this card lists every worker
  await open(page, '&fault=reconnecting');
  await expect(page.getByTestId('freshness')).toContainText('Reconnecting');
  await expect(page.getByTestId('connection-banner')).toContainText('last confirmed state');
  await expect(page.getByTestId('fleet-row').first()).toContainText('Health unknown');
});

test('a runner loss stays visible over stale data, labelled as of the last confirmed state', async ({ page }) => {
  await open(page, `${fixture('runner-loss')}&fault=reconnecting`);
  await expect(page.getByTestId('connection-banner')).toBeVisible();
  await expect(items(page).first()).toHaveAttribute('data-kind', 'worker_lost');
  await expect(items(page).first()).toContainText('As of last confirmed state');
  await expect(page.getByTestId('headline')).toContainText('at the last confirmed state');
  await expect(page.getByTestId('attention-count')).toHaveText('1 item at last confirmed state');
  await expect(page.getByRole('region', { name: 'Fleet' })).toContainText('1 lost');
});

test('a view that fails to render is contained: shell and badge stay, and the other tab works', async ({ page }) => {
  await page.goto('/?demo&fault=corrupt#/overview');
  await expect(page.getByRole('heading', { name: 'This view could not load' })).toBeVisible();
  await expect(page.getByTestId('demo-badge')).toBeVisible();
  await page.getByTestId('top-bar-more').click();
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await expect(page.getByRole('heading', { name: 'The assistant is off in demo mode' })).toBeVisible();
  await page.getByRole('link', { name: /^Mission Control/ }).click();
});

test('a failed Overview recovers once the failure clears', async ({ page }) => {
  await page.goto('/?demo&fault=corrupt#/overview');
  await expect(page.getByRole('heading', { name: 'This view could not load' })).toBeVisible();
  await page.getByRole('button', { name: 'Restart projection' }).click();
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
  await expect(page.getByTestId('criteria')).toBeVisible();
});

test('changing route moves focus to the main content, and first load does not', async ({ page }) => {
  await open(page);
  await expect(page.locator('#main')).not.toBeFocused();
  await page.getByTestId('top-bar-more').click();
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await expect(page.locator('#main')).toBeFocused();
});

test('exact time appears on keyboard focus', async ({ page }) => {
  await open(page, fixture('human-wait'));
  const time = items(page).first().locator('time').first();
  const before = await items(page).first().boundingBox();
  await time.focus();
  await expect(items(page).first().locator('span[aria-hidden="true"]', { hasText: '2026' }).first()).toBeVisible();
  expect(await items(page).first().boundingBox()).toEqual(before); // a positioned tooltip does not reflow the line
});

test('a long payload wraps instead of overflowing at 375', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page, fixture('failed-ci'));
  await page.evaluate(() => {
    const long = 'x'.repeat(240);
    document.querySelectorAll('[data-testid="fleet-row"] span, [data-testid="attention-item"] p').forEach((el) => {
      if (el.children.length === 0) el.textContent = long;
    });
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the 375 header stays on two rows, with the count on the Overview tab', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const query of [fixture('policy-block'), fixture('healthy-parallel-work'), '&fault=dead']) {
    await open(page, query);
    const header = await page.locator('.sticky').first().boundingBox();
    expect(header!.height).toBeLessThanOrEqual(92);
  }
  await open(page, fixture('policy-block'));
  await expect(page.getByTestId('attention-badge')).toHaveText('2');
  await expect(page.getByTestId('attention-badge')).toHaveAttribute('aria-label', '2 need attention');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a calm screen says it once', async ({ page }) => {
  await open(page, fixture('healthy-parallel-work'));
  await expect(page.getByText('No decisions waiting.')).toBeVisible();
  await expect(page.getByTestId('headline')).toHaveCount(0);
  await expect(page.getByTestId('attention-count')).toHaveCount(0);
});

test('a budget stop asks for a decision but is not the top blocker, and its criteria stay in the total', async ({ page }) => {
  await open(page, fixture('unknown-costs'));
  await expect(page.getByTestId('criteria')).toHaveText('2 of 7 criteria verified');
  await expect(page.getByTestId('headline')).toHaveText(/1 item needs you\.$/);
  await expect(items(page).first()).toContainText('Stopped');
  await expect(page.getByTestId('top-blocker')).toContainText('none right now');
});

test('a light-theme preference is applied before any app code runs', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('selarikru.theme', 'light'));
  await page.route('**/src/main.tsx*', (route) => route.abort());
  await page.goto('/?demo');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('an unavailable source says so and shows no data', async ({ page }) => {
  await open(page, '&fault=unavailable');
  await expect(page.getByText('Project data is unavailable')).toBeVisible();
  await expect(page.getByTestId('freshness')).toContainText('Unavailable');
  await expect(page.getByTestId('criteria')).toHaveCount(0);
});

test('a dead session offers a restart and recovers through a new projection', async ({ page }) => {
  await open(page, '&fault=dead');
  await expect(page.getByTestId('freshness')).toContainText('Stream stopped');
  await expect(page.getByTestId('headline')).toHaveText('Worker connections are unknown. Showing the last confirmed state.');
  await expect(page.getByTestId('attention-count')).toHaveText('Attention unknown');
  await expect(page.getByRole('main')).not.toContainText('Nothing');
  await page.getByRole('button', { name: 'Restart session' }).click();
  await expect(page.getByTestId('freshness')).toContainText('Live');
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
});

for (const id of ['healthy-parallel-work', 'human-wait', 'policy-block', 'runner-loss', 'long-build-stall', 'contract-change', 'failed-ci', 'expired-approval', 'unknown-costs', 'no-data', 'merge-flow']) {
  test(`axe pass: ${id}`, async ({ page }) => {
    await open(page, fixture(id));
    await expectNoAxeViolations(page);
  });
}

for (const fault of ['reconnecting', 'unavailable', 'dead']) {
  test(`axe pass: ${fault} connection`, async ({ page }) => {
    await open(page, `&fault=${fault}`);
    await expect(page.getByTestId('freshness')).not.toContainText('Connecting');
    await expectNoAxeViolations(page);
  });
}

test('axe pass: the one theme', async ({ page }) => {
  await open(page, fixture('policy-block'));
  // One theme since T5.12 round 2 (the reference's cream and ink): there is no toggle, and the page reports the theme in use.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectNoAxeViolations(page);
});

test('axe pass: 375 wide with details open', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page, fixture('human-wait'));
  await items(page).first().getByText('Details').click();
  await expectNoAxeViolations(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('with no live source the shell is honest and the assistant still works', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __scenario: unknown }).__scenario = { shell: true };
  });
  await page.goto('/tests/harness/index.html#/overview');
  await expect(page.getByText('Project data is unavailable')).toBeVisible();
  await expect(page.getByTestId('demo-badge')).toHaveCount(0);
  await expect(page.getByTestId('criteria')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open the Assistant' })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByTestId('top-bar-more').click();
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await expect(page.getByRole('heading', { name: 'Assistant', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Generate draft' }).click();
  const output = page.getByRole('region', { name: 'Draft output' });
  await expect(output.getByTestId('output-list')).toBeVisible();

  // Moving between tabs does not discard the draft.
  await page.getByRole('link', { name: /^Mission Control/ }).click();
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
  await page.getByTestId('top-bar-more').click();
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await expect(output.getByTestId('output-list')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  // Axe on the assistant inside the shell.
  await expectNoAxeViolations(page);
  // One theme since T5.12 round 2 (the reference's cream and ink): there is no toggle, and the page reports the theme in use.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectNoAxeViolations(page);
});

for (const failure of ['render', 'chunk']) {
  test(`an assistant ${failure} failure is contained by the route boundary`, async ({ page }) => {
    await page.addInitScript((f) => {
      (window as unknown as { __scenario: unknown }).__scenario = { shell: true, assistantFails: f };
    }, failure);
    await page.goto('/tests/harness/index.html');
    await page.getByTestId('top-bar-more').click();
  await page.getByRole('link', { name: 'Assistant' }).first().click();
    await expect(page.getByRole('heading', { name: 'This view could not load' })).toBeVisible();
    await page.getByRole('link', { name: /^Mission Control/ }).click();
    await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
  });
}

test('beside the team panel the Fleet card keeps to one line, and each worker is in the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, fixture('healthy-parallel-work'));
  await expect(page.getByTestId('fleet-summary')).toContainText('2 workers: 2 assigned · 0 waiting · 0 idle.');
  await expect(page.getByTestId('fleet-summary')).toContainText('Each is listed in the Team panel.');
  await expect(page.getByTestId('fleet-row')).toHaveCount(0);
  await expect(page.getByTestId('team-panel-row')).toHaveCount(2);
});

test('below the panel width the header does not repeat the count the Team toggle carries', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await open(page, fixture('human-wait'));
  await expect(page.getByTestId('team-panel-toggle')).toContainText('1 needs you');
  await expect(page.getByTestId('attention-count')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('attention-count')).toBeVisible();
});
