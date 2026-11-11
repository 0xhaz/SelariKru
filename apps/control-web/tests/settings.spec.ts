import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const panelRow = (page: Page, id: string) => page.locator(`[data-testid="team-panel-row"][data-panel-worker="${id}"]`);
const drawer = (page: Page) => page.getByTestId('worker-drawer');
const autonomy = (page: Page) => page.getByTestId('bounded-autonomy');
const commands = (page: Page) => page.evaluate(() => (window.__calls.commands as { method: string; command?: { command: string; args: Record<string, unknown> } }[]).filter((c) => c.method === 'execute'));
/** One simulated heartbeat: the mock's runner acknowledges what was saved. */
const heartbeat = (page: Page) => page.evaluate(() => window.__advance!(10_000));

async function spied(page: Page, route: string): Promise<void> {
  await page.addInitScript((s) => { (window as unknown as { __scenario: unknown }).__scenario = s; }, { spiedFixture: 'healthy-parallel-work' });
  await page.goto(`/tests/harness/index.html#/${route}`);
}

test('changing a worker\'s model reads as saved and applying until the runner acknowledges it, then applied', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'summary');
  await panelRow(page, 'runner_local_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  const settings = drawer(page).getByTestId('worker-settings');
  const role = settings.getByRole('region', { name: /Model for every/ });
  await role.getByRole('combobox', { name: /Model for/ }).selectOption('claude-haiku-5-5');
  await role.getByRole('button', { name: /Save for/ }).click();
  const status = role.getByTestId('assignment-status');
  await expect(status).toContainText('Saved · applies on next start');
  await expect(status).toHaveAttribute('data-in-force', 'false');
  expect((await commands(page))[0]!.command).toMatchObject({ command: 'assignment.set', args: { scope: 'role' } });
  await heartbeat(page);
  await expect(status).toContainText('Applied · used from the next attempt');
  await expect(status).toHaveAttribute('data-in-force', 'true');
});

test('pause scheduling reads as requested until the runner acknowledges it, then paused; resume goes back the same way', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'summary');
  const panel = autonomy(page);
  await expect(panel.getByTestId('policy-row').filter({ hasText: 'Merge' })).toContainText('Human merge on GitHub. Agents never merge.');
  await expect(panel.getByTestId('policy-row').filter({ hasText: 'Approved scope' })).toContainText('Configured');
  await panel.getByRole('button', { name: 'Pause scheduling' }).click();
  const status = panel.getByTestId('pause-status');
  await expect(status).toContainText('Pause requested');
  await expect(status).toContainText('attempts already running continue');
  await expect(panel.getByTestId('setting-feedback')).toContainText('Not in force until the runner confirms it');
  expect((await commands(page))[0]!.command).toMatchObject({ command: 'setting.set', args: { change: { scope: 'run', field: 'paused', value: true } } });
  await heartbeat(page);
  await expect(status).toContainText('Paused');
  await expect(status).not.toContainText('requested');
  await panel.getByRole('button', { name: 'Resume scheduling' }).click();
  await expect(status).toContainText('Resume requested');
  await heartbeat(page);
  await expect(status).toContainText('Scheduling');
});

test('a worker can be disabled in its drawer, and it reads as applying until its runner confirms it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'summary');
  await panelRow(page, 'runner_local_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  const worker = drawer(page).getByTestId('settings-worker');
  await worker.getByRole('button', { name: 'Disable worker' }).click();
  await expect(worker.getByTestId('worker-enabled').getByTestId('setting-status')).toContainText('Applying');
  await heartbeat(page);
  await expect(worker.getByTestId('worker-enabled').getByTestId('setting-status')).toContainText('Applied');
  await expect(worker.getByRole('button', { name: 'Enable worker' })).toBeVisible();
});

test('cancel run asks first, then reads as cancel requested until its attempts end', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'summary');
  const panel = autonomy(page);
  await panel.getByRole('button', { name: 'Cancel run' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel this run?' });
  await expect(dialog).toContainText('Artifacts and history are kept');
  await dialog.getByRole('button', { name: 'Cancel run' }).click();
  await expect(panel.getByTestId('cancel-status')).toContainText('Cancel requested');
  await page.evaluate(() => window.__advance!(2_000));
  await expect(panel.getByTestId('cancel-status')).toContainText('Cancelled');
});

test('the Bounded autonomy panel passes axe and fits a 390 px screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await spied(page, 'summary');
  await expect(autonomy(page)).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).include('[data-testid="bounded-autonomy"]').analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await autonomy(page).getByRole('button', { name: 'Pause scheduling' }).focus();
  await page.keyboard.press('Enter');
  await expect(autonomy(page).getByTestId('pause-status')).toContainText('Pause requested');
});
