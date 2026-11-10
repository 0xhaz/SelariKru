import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** Checkpoint continuation on demo data: the confirmation, the handover's states in words, a restart offer on Decisions. No network, no runtime. */

const row = (page: Page, taskId: string) => page.locator(`[data-testid="pipeline-row"][data-task-id="${taskId}"]`);

async function openPipeline(page: Page, fixture: string, width = 1440): Promise<string[]> {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/?demo&fixture=${fixture}#/pipeline`);
  await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();
  return requests;
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('continue a running local task in cloud: the confirmation says what is carried and what it costs, then each step reads in words', async ({ page }) => {
  const requests = await openPipeline(page, 'unknown-costs');
  const api = row(page, 'unknown-costs.api');
  const action = api.getByRole('button', { name: /^Continue in cloud: / });
  await expect(action).toBeEnabled();
  await action.click();
  const dialog = page.getByTestId('handover-confirm');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Continue in cloud?' })).toBeVisible();
  await expect(dialog.getByTestId('handover-base')).toHaveText(/^[0-9a-f]{40}$/);
  await expect(dialog.getByTestId('handover-excludes')).toContainText('.env files');
  await expect(dialog.getByTestId('handover-cost')).toContainText('(estimated, at most)');
  await expect(dialog).toContainText('not a migration of the running session');
  await expectNoAxeViolations(page);

  // Escape keeps the task where it is.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(action).toBeFocused();

  await action.click();
  await page.getByTestId('handover-confirm').getByRole('button', { name: 'Continue in cloud' }).click();
  await expect(api.getByTestId('handover-state')).toContainText('Stopping local attempt');
  await page.getByRole('button', { name: 'Advance 10 s' }).click();
  // The prior attempt is fenced and its checkpoint waits for review: nothing starts on its own.
  await expect(api.getByTestId('handover-state')).toContainText('Checkpoint ready for review');
  await page.getByRole('button', { name: 'Advance 10 s' }).click();
  await expect(api.getByTestId('handover-state')).toContainText('Checkpoint ready for review');

  // The review is on Decisions: the files with their size, hash and change, a diff on request, what was not carried, and the estimated cost.
  await page.getByRole('link', { name: 'Decisions' }).first().click();
  const card = page.getByTestId('handover-decision').filter({ has: page.getByTestId('handover-review') });
  await expect(card).toHaveCount(1);
  const reviewed = card.getByTestId('handover-review-file');
  await expect(reviewed).toHaveCount(1);
  await expect(reviewed).toContainText('+2 −0');
  await reviewed.getByRole('button', { name: 'View diff' }).click();
  await expect(card.getByTestId('handover-diff')).toContainText('handoverDemo');
  await expect(card.getByTestId('handover-exclusions')).toContainText('secret-bearing file');
  await expect(card.getByTestId('handover-review')).toContainText('(estimated, at most)');
  await expectNoAxeViolations(page);
  await card.getByRole('button', { name: 'Release to a cloud runner' }).click();
  await expect(page.getByTestId('handover-decision')).toHaveCount(0);
  await page.getByRole('link', { name: 'Pipeline' }).first().click();
  await expect(api.getByTestId('handover-state')).toContainText('Fenced');
  await page.getByRole('button', { name: 'Advance 10 s' }).click();
  await expect(api.getByTestId('handover-state')).toContainText('Running');
  // No request left this page for a runtime or provider: demo data only.
  expect(requests.filter((u) => !u.startsWith('http://127.0.0.1:5174'))).toEqual([]);
});

test('the worker drawer offers it with its eligibility, and shows the steps once asked', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=unknown-costs#/team');
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
  await page.locator('[data-testid="fleet-row"][data-worker-id="runner_local_1"]').locator('[data-open-worker="runner_local_1"]').click();
  const drawer = page.getByTestId('worker-drawer');
  await expect(drawer).toBeVisible();
  const section = drawer.getByTestId('drawer-handover');
  await expect(section).toContainText('Demo data');
  await section.getByRole('button', { name: 'Continue in cloud' }).click();
  await page.getByTestId('handover-confirm').getByRole('button', { name: 'Continue in cloud' }).click();
  await expect(section.getByTestId('handover-steps').locator('[aria-current="step"]')).toHaveText(/Stopping local attempt/);
  // Nothing is shown as carried until the attempt has stopped and its checkpoint is checked.
  await expect(section.getByTestId('handover-patch')).toHaveCount(0);
});

test('a checkpoint that cannot be carried whole is a restart offer on Decisions with its estimated cost, and the restart goes through the same fence', async ({ page }) => {
  await openPipeline(page, 'policy-block');
  await row(page, 'policy-block.lint').getByRole('button', { name: /^Continue in cloud: / }).click();
  await page.getByTestId('handover-confirm').getByRole('button', { name: 'Continue in cloud' }).click();
  await page.getByRole('button', { name: 'Advance 10 s' }).click();
  await page.getByRole('link', { name: 'Decisions' }).first().click();
  const card = page.getByTestId('handover-decision');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('handover-refusal')).toContainText('had to be excluded');
  await expect(card.getByTestId('handover-restart-cost')).toContainText('(estimated, at most)');
  await expect(card.getByTestId('handover-exclusions')).toContainText('secret-bearing file');
  await expectNoAxeViolations(page);
  await card.getByRole('button', { name: 'Restart from persisted input' }).click();
  await expect(card.getByTestId('handover-state')).toContainText('Fenced');
  await page.getByRole('button', { name: 'Advance 10 s' }).click();
  await expect(page.getByTestId('handover-decision').getByTestId('handover-state')).toContainText('Running');
});

test('at 390 px the row action and the confirmation fit without a horizontal scroll', async ({ page }) => {
  await openPipeline(page, 'unknown-costs', 390);
  const api = row(page, 'unknown-costs.api');
  await api.getByRole('button', { name: /^Continue in cloud: / }).click();
  await expect(page.getByTestId('handover-confirm')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
