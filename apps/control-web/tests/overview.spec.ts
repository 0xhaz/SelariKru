import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/?demo${query}`);
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
}
const fixture = (id: string): string => `&fixture=${id}`;
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
  await expect(page.getByTestId('headline')).toContainText('2 items need you. Start with Export restricted feedback: blocked by policy');
});

test('shows "n of m criteria verified", never a percentage', async ({ page }) => {
  await open(page, fixture('merge-flow'));
  await expect(page.getByTestId('criteria')).toHaveText('2 of 2 criteria verified');
  expect(await page.getByRole('main').innerText()).not.toMatch(/\d\s?%/);
});

test('heartbeat never increments verified criteria', async ({ page }) => {
  await open(page, fixture('long-build-stall'));
  await expect(page.getByTestId('criteria')).toHaveText('0 of 1 criteria verified');
  // The silence ends at 100 s, so these steps deliver fresh heartbeats and no verdict.
  await page.getByRole('button', { name: 'Advance 10 s' }).click();
  await expect(page.getByTestId('fleet-row').first()).toContainText('Healthy');
  await expect(page.getByTestId('criteria')).toHaveText('0 of 1 criteria verified');
});

test('empty project shows next action and no fake agents', async ({ page }) => {
  await open(page, fixture('no-data'));
  await expect(page.getByText('No run in this project yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the Assistant' })).toBeVisible();
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
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await expect(badge).toBeVisible();
});

test('under demo data the live assistant is not mounted and Firebase is not contacted', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:5174/') && !r.url().startsWith('data:')) external.push(r.url());
  });
  await open(page);
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await expect(page.getByRole('heading', { name: 'The assistant is off in demo mode' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate draft' })).toHaveCount(0);
  expect(external).toEqual([]);
});

test('execution and inference are separately labeled for each worker', async ({ page }) => {
  await open(page, fixture('healthy-parallel-work'));
  const local = page.getByTestId('fleet-row').filter({ hasText: 'runner_local_1' });
  await expect(local).toContainText('Execution');
  await expect(local).toContainText('Local sandbox');
  await expect(local).toContainText('Inference');
  await expect(local).toContainText('Model in cloud');
});

test('a runner loss shows the last confirmed time and offers inspection', async ({ page }) => {
  await open(page, fixture('runner-loss'));
  await expect(items(page).first()).toHaveAttribute('data-kind', 'worker_lost');
  await expect(items(page).first()).toContainText('Inspect the attempt before relaunching anything');
  await expect(page.getByTestId('fleet-row').first()).toContainText('Connection lost; state last confirmed');
});

test('unknown costs read as unknown, never zero', async ({ page }) => {
  await open(page, fixture('unknown-costs'));
  const resources = page.getByRole('region', { name: 'Resources and usage' });
  await expect(resources).toContainText('Unknown');
  await expect(resources).toContainText('At least $3.74 known; 1 of 3 figures unavailable');
});

test('reconnecting keeps the last confirmed state and stops claiming health', async ({ page }) => {
  await open(page, '&fault=reconnecting');
  await expect(page.getByTestId('freshness')).toContainText('Reconnecting');
  await expect(page.getByTestId('connection-banner')).toContainText('last confirmed state');
  await expect(page.getByTestId('fleet-row').first()).toContainText('Health unknown');
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
  await expect(page.getByTestId('headline')).toHaveText('Nothing was waiting at the last confirmed state.');
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

test('axe pass: light theme', async ({ page }) => {
  await open(page, fixture('policy-block'));
  await page.getByRole('button', { name: 'Light theme' }).click();
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
  await page.goto('/tests/harness/index.html');
  await expect(page.getByText('Project data is unavailable')).toBeVisible();
  await expect(page.getByTestId('demo-badge')).toHaveCount(0);
  await expect(page.getByTestId('criteria')).toHaveCount(0);
  await expectNoAxeViolations(page);

  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await expect(page.getByRole('heading', { name: 'Assistant', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Generate draft' }).click();
  const output = page.getByRole('region', { name: 'Draft output' });
  await expect(output.getByTestId('output-list')).toBeVisible();

  // Moving between tabs does not discard the draft.
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Assistant' }).first().click();
  await expect(output.getByTestId('output-list')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});
