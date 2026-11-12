/** H9 item 2: Boards › AI calls, one view of every AI call, from the route records only. */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('Boards › AI calls lists every recorded call: requested route, where it actually ran, unknown as unknown, restricted rows redacted, each linking to its task', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=feature-delivery#/office');
  await page.getByTestId('top-bar-boards').click();
  await page.getByRole('link', { name: 'AI calls' }).click();
  await expect(page).toHaveTitle('AI calls · SelariKru');
  const view = page.getByTestId('ai-calls');
  await expect(view.getByRole('heading', { name: 'AI calls', level: 1 })).toBeVisible();
  const rows = view.getByTestId('ai-call-row');
  await expect(rows).toHaveCount(6);
  await expect(view.getByTestId('ai-calls-summary')).toHaveText('6 calls: 2 on this device, 3 in the cloud, 1 unknown, 0 stopped before running.');
  // The integration's last source was not shown: Unknown, never counted as either side.
  const unknown = rows.filter({ hasText: 'Review change' });
  await expect(unknown.getByTestId('ai-call-ran')).toHaveText(/Unknown/);
  await expect(unknown.getByTestId('ai-call-how')).toHaveText('Unknown');
  await expect(unknown).toContainText('Local only (ONLY_ON_DEVICE)');
  // The end-to-end checks read restricted data: labels only.
  const restricted = view.locator('[data-testid="ai-call-row"][data-restricted="true"]');
  await expect(restricted).toHaveCount(1);
  await expect(restricted).toContainText('Locked: restricted data stays on this device');
  await expect(restricted.getByTestId('ai-call-how')).toHaveText('Not shown (restricted)');
  // A cloud call says which model; the requested route has its label and mode.
  await expect(rows.filter({ hasText: 'Cloud only (ONLY_IN_CLOUD)' }).getByTestId('ai-call-ran')).toContainText('Cloud');
  const { violations } = await new AxeBuilder({ page }).include('[data-testid="view-drawer"]').analyze();
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  // Each row links to its task.
  await unknown.getByRole('link').click();
  await expect(page).toHaveURL(/#\/pipeline\?task=/);
});

test('a call made now appears in AI calls with where it ran', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=feature-delivery#/calls');
  const rows = page.getByTestId('ai-call-row');
  await expect(rows).toHaveCount(6);
  // Run one step on the search task (Local first, nothing recorded yet) from the pipeline, without reloading the demo.
  await page.evaluate(() => { window.location.hash = '#/pipeline'; });
  await page.locator('[data-testid="pipeline-row"][data-task-id="feature-delivery.search"]').getByRole('button', { name: 'Search index' }).click();
  const criteria = page.getByTestId('task-inspector').locator('[data-testid="agent-action"][data-kind="criteria"]');
  await criteria.getByRole('button', { name: 'Draft criteria' }).click();
  await expect(criteria.getByTestId('agent-result')).toContainText('Ran on this device');
  await page.evaluate(() => { window.location.hash = '#/calls'; });
  await expect(rows).toHaveCount(7);
  await expect(rows.first()).toContainText('Draft criteria');
  await expect(rows.first()).toContainText('Search index');
  await expect(rows.first().getByTestId('ai-call-ran')).toHaveText(/On this device/);
});
