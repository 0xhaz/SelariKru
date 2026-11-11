/**
 * H12: the offline queue on demo data. Go offline (Debug › Go offline, demo only: the browser's own online state is not touched), a cloud step waits as a
 * checkpoint ("Waiting for connection", Paused AI work, the roof says Offline), go online, and it is re-validated and sent: "Sent after reconnecting", never a
 * fallback. The queue survives a reload: it is kept in this browser's IndexedDB and sent once the page is back.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const T = (local: string) => `feature-delivery.${local}`;

async function open(page: Page, hash: string): Promise<void> {
  await page.addInitScript((s) => { (window as unknown as { __scenario: unknown }).__scenario = s; }, { spiedFixture: 'feature-delivery' });
  await page.goto(`/tests/harness/index.html${hash}`);
}
const row = (page: Page, id: string) => page.locator(`[data-testid="pipeline-row"][data-task-id="${id}"]`);
const inspector = (page: Page) => page.getByTestId('task-inspector');
const action = (page: Page, kind: string) => inspector(page).locator(`[data-testid="agent-action"][data-kind="${kind}"]`);

async function network(page: Page, to: 'Go offline' | 'Go online'): Promise<void> {
  if (!(await page.getByTestId('demo-network').isVisible())) await page.getByRole('button', { name: 'Debug' }).click();
  await page.getByTestId('demo-network').getByRole('button', { name: to }).click();
}

test('offline, a cloud step waits as a checkpoint; online again, it is checked and sent after reconnecting', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pipeline');
  await network(page, 'Go offline');
  await expect(page.getByTestId('demo-network')).toContainText('Demo only: simulated offline');
  // The browser itself is still online: only the demo is.
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await row(page, T('contract')).getByRole('button', { name: 'Approve API contract' }).click();
  const criteria = action(page, 'criteria');
  await expect(criteria.getByTestId('agent-route')).toContainText('Cloud only');
  await criteria.getByRole('button', { name: 'Draft criteria' }).click();
  const result = criteria.getByTestId('agent-result');
  await expect(result).toHaveAttribute('data-status', 'waiting');
  await expect(result).toContainText('Waiting for connection');
  await expect(result.getByTestId('result-waiting')).toContainText('Saved as a checkpoint');
  // The office: the roof says Offline, and the step waits at the cloud deck.
  await expect(page.getByTestId('office-canvas')).toHaveAttribute('aria-label', /Offline\. 1 step waiting for connection at the cloud deck\./);
  // A device step still runs while offline (this call on this device).
  await action(page, 'breakdown').getByLabel('Use this device for this call').check();
  await action(page, 'breakdown').getByRole('button', { name: 'Break down' }).click();
  await expect(action(page, 'breakdown').getByTestId('agent-result')).toHaveAttribute('data-status', 'ok');

  await page.goto('/tests/harness/index.html#/actions');
  const paused = page.getByTestId('paused-work');
  await expect(paused).toBeVisible();
  await expect(paused.getByTestId('paused-headline')).toHaveText('Waiting for connection: Approve API contract · Draft criteria');
  await expect(paused).toContainText('Demo data');
  await expect(paused.getByTestId('paused-sends')).toContainText('labels: internal');
  await expect(paused.getByRole('button', { name: 'Resume' })).toBeDisabled();
  await expect(page.getByTestId('activity-feed')).toContainText('Approve API contract · Draft criteria: Paused: offline');
  const { violations } = await new AxeBuilder({ page }).include('[data-testid="paused-work"]').analyze();
  expect(violations.map((v) => v.id)).toEqual([]);

  await network(page, 'Go online');
  await expect(page.getByTestId('paused-work')).toHaveCount(0);
  await expect(page.getByTestId('activity-feed')).toContainText('Approve API contract · Draft criteria: Sent after reconnecting');
  await expect(page.getByTestId('office-canvas')).not.toHaveAttribute('aria-label', /Offline\./);
  await page.goto('/tests/harness/index.html#/pipeline');
  if (!(await inspector(page).isVisible())) await row(page, T('contract')).getByRole('button', { name: 'Approve API contract' }).click();
  await expect(action(page, 'criteria').getByTestId('result-resumed')).toContainText('Sent after reconnecting');
  await expect(action(page, 'criteria').getByTestId('agent-result')).toHaveAttribute('data-status', 'ok');
});

test('the offline queue survives a reload: kept in IndexedDB, sent once the page is back online', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pipeline');
  await network(page, 'Go offline');
  await row(page, T('contract')).getByRole('button', { name: 'Approve API contract' }).click();
  const criteria = action(page, 'criteria');
  await criteria.getByRole('button', { name: 'Draft criteria' }).click();
  await expect(criteria.getByTestId('agent-result')).toHaveAttribute('data-status', 'waiting');
  const stored = await page.evaluate(() => new Promise<number>((resolve) => {
    const req = indexedDB.open('selarikru-checkpoints');
    req.onsuccess = () => { const all = req.result.transaction('checkpoints').objectStore('checkpoints').getAll(); all.onsuccess = () => resolve((all.result as { checkpoint: { status: string } }[]).filter((r) => r.checkpoint.status === 'waiting').length); };
  }));
  expect(stored).toBe(1);
  await page.reload();
  await row(page, T('contract')).getByRole('button', { name: 'Approve API contract' }).click();
  // Back online after the reload (the demo's simulation does not persist): the step is read back from IndexedDB, checked again and sent.
  await expect(action(page, 'criteria').getByTestId('agent-result')).toHaveAttribute('data-status', 'ok', { timeout: 15_000 });
  await expect(action(page, 'criteria').getByTestId('result-resumed')).toContainText('Sent after reconnecting');
  await expect(action(page, 'criteria').getByTestId('agent-result')).not.toContainText('Fell back');
});
