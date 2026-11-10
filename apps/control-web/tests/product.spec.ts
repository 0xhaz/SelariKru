import { expect, test, type Page } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:5174';

async function open(page: Page, width = 1440): Promise<string[]> {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'merge-flow' }; });
  await page.goto('/tests/harness/index.html#/product');
  await expect(page.getByRole('heading', { level: 1, name: 'Product' })).toBeVisible();
  return requests;
}
const traceRow = (page: Page, id: string) => page.locator(`[data-testid="trace-row"][data-requirement="${id}"]`);
const traceLink = (page: Page, id: string, kind: string) => traceRow(page, id).locator(`[data-testid="trace-link"][data-kind="${kind}"]`);
const notice = (page: Page) => page.getByTestId('product-notice');

test('confirm the brief, add an outcome plan with an unknown baseline, see the trace, record a release, see Awaiting observations', async ({ page }) => {
  const requests = await open(page);
  await expect(page.getByTestId('product-demo-badge')).toHaveText(/Demo data/);
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Product' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(/authorizes no customer outreach and no connection to production data/)).toBeVisible();

  // Before anything is recorded, every product link says it is missing; the evidence the run already has is present.
  await expect(traceLink(page, 'FB-03', 'problem_brief')).toHaveAttribute('data-state', 'Missing');
  await expect(traceLink(page, 'FB-03', 'outcome_plan')).toHaveAttribute('data-state', 'Missing');
  await expect(traceLink(page, 'FB-03', 'verification')).toHaveAttribute('data-state', 'Present');
  await expect(traceLink(page, 'FB-03', 'merge')).toHaveAttribute('data-state', 'Missing');

  // The brief starts from the onboarding brief; a person confirms it.
  await expect(page.getByLabel('Target user or workflow')).toHaveValue(/Team leads/);
  await page.getByRole('button', { name: 'Confirm brief' }).click();
  await expect(notice(page)).toContainText('Confirmed the brief');
  await expect(page.getByTestId('product-brief-state')).toContainText('Confirmed, revision 1');
  await expect(traceLink(page, 'FB-03', 'problem_brief')).toHaveAttribute('data-state', 'Present');

  // An outcome plan with the baseline left blank: unknown, never zero.
  await page.getByRole('checkbox', { name: 'FB-03' }).check();
  await page.getByLabel('Metric definition').fill('Minutes from submission to first triage');
  await page.getByLabel('Learning question').fill('Do leads triage sooner when the newest is first?');
  await page.getByRole('button', { name: 'Add outcome plan' }).click();
  await expect(notice(page)).toContainText('Baseline: Unknown');
  await expect(page.getByTestId('product-plan-baseline')).toHaveText('Unknown');
  await expect(page.getByTestId('product-plan')).not.toContainText(/Baseline\s*0\b/);
  await expect(traceLink(page, 'FB-03', 'outcome_plan')).toHaveAttribute('data-state', 'Present');
  await expect(traceRow(page, 'FB-03').getByTestId('trace-outcome')).toHaveAttribute('data-outcome', 'Not released');
  await expect(traceLink(page, 'FB-01', 'outcome_plan')).toContainText('No outcome plan names FB-01');

  // The run merges on GitHub. A merge alone is not a release.
  await expect(page.getByTestId('product-no-merged-run')).toBeVisible();
  await page.evaluate(() => window.__advance!(40_000));
  await page.getByRole('button', { name: 'Read again' }).click();
  await expect(traceLink(page, 'FB-03', 'merge')).toHaveAttribute('data-state', 'Present');
  await expect(traceRow(page, 'FB-03').getByTestId('trace-outcome')).toHaveAttribute('data-outcome', 'Not released');
  await expect(traceLink(page, 'FB-03', 'release')).toContainText('a merge alone is not a release');

  // A person records the release: the outcome now waits for observations.
  await page.getByLabel('Environment').fill('production');
  await page.getByRole('button', { name: 'Record release note' }).click();
  await expect(notice(page)).toContainText('Recorded the release');
  await expect(traceRow(page, 'FB-03').getByTestId('trace-outcome')).toHaveAttribute('data-outcome', 'Awaiting observations');
  await expect(page.getByTestId('product-release')).toContainText('Released');
  await expect(page.getByTestId('product-milestone').first()).toContainText('Awaiting observations (1)');

  // Demo data makes no network call.
  expect(requests.filter((u) => !u.startsWith(ORIGIN))).toEqual([]);
});

test('an outcome review records a decision and its follow-up is a proposal on Decisions, not a task', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Confirm brief' }).click();
  await page.getByRole('checkbox', { name: 'FB-03' }).check();
  await page.getByLabel('Metric definition').fill('Minutes to first triage');
  await page.getByLabel('Learning question').fill('Sooner?');
  await page.getByRole('button', { name: 'Add outcome plan' }).click();
  await expect(page.getByTestId('product-plan')).toBeVisible();
  await page.evaluate(() => window.__advance!(40_000));
  await page.getByRole('button', { name: 'Read again' }).click();
  await page.getByRole('button', { name: 'Record release note' }).click();
  await expect(page.getByTestId('product-release')).toBeVisible();

  await page.getByLabel('What was observed').fill('Too few triages in the window to say.');
  await page.getByLabel('Decision').selectOption('iterate');
  await page.getByLabel('Follow-up task title').fill('Show a triage age on each item');
  await page.getByLabel('Why the follow-up').fill('Leads could not tell what was new');
  await page.getByRole('button', { name: 'Record outcome review' }).click();
  await expect(notice(page)).toContainText('The follow-up is a proposal');
  await expect(traceRow(page, 'FB-03').getByTestId('trace-outcome')).toHaveAttribute('data-outcome', 'Insufficient data');
  await expect(page.getByTestId('product-review')).toContainText('Result Unknown');

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Decisions' }).click();
  const card = page.getByTestId('product-follow-up');
  await expect(card).toContainText('Show a triage age on each item');
  await expect(card).toContainText('It is not in any plan');
  await expect(card.getByRole('button')).toHaveCount(0);
});

test('390 px: the product view fits, by keyboard', async ({ page }) => {
  await open(page, 390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Confirm brief' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('product-brief-state')).toContainText('Confirmed');
});
