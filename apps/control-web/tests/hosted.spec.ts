/** H9 items 1 and 3, as the shell shows them: the hosted demo's cloud call cap and its one debug control, and the calm Gemini Nano banner. */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, scenario: Record<string, unknown>, hash = '#/office'): Promise<void> {
  await page.addInitScript((s) => { (window as unknown as { __scenario: unknown }).__scenario = s; }, { spiedFixture: 'feature-delivery', ...scenario });
  await page.goto(`/tests/harness/index.html${hash}`);
}

test('Nano unavailable: one calm banner says what each route does, naming the tasks, with the Chrome instructions; no error styling', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, { nano: 'unavailable' });
  const banner = page.getByTestId('nano-banner');
  await expect(banner.getByRole('heading', { name: 'Gemini Nano is not available in this browser' })).toBeVisible();
  const lines = banner.getByTestId('nano-banner-line');
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0)).toHaveText(/^Runs in the cloud instead, labelled as a fallback: .*Search index/);
  await expect(lines.nth(1)).toHaveText(/^Run in the cloud as usual: .*API contract/);
  await expect(lines.nth(2)).toHaveText(/^Blocked until Gemini Nano is available, never sent to the cloud: .*\(restricted\)/);
  await expect(banner.getByRole('link', { name: /How to get Gemini Nano in Chrome/ })).toHaveAttribute('href', /developer\.chrome\.com/);
  // An expected state: no alert role, no danger colour.
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await banner.evaluate((el) => el.className)).not.toMatch(/danger|warning/);
  const { violations } = await new AxeBuilder({ page }).include('[data-testid="nano-banner"]').analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  await banner.getByRole('button', { name: 'Got it' }).click();
  await expect(banner).toHaveCount(0);
});

test('Nano available, or not checked (?demo): no banner', async ({ page }) => {
  await open(page, { nano: 'available' });
  await expect(page.getByTestId('team-panel-row').first()).toBeVisible();
  await expect(page.getByTestId('nano-banner')).toHaveCount(0);
  await page.goto('/?demo#/office');
  await expect(page.getByTestId('team-panel-row').first()).toBeVisible();
  await expect(page.getByTestId('nano-banner')).toHaveCount(0);
});

test('hosted demo: the top bar shows the cloud calls left, and Debug offers only Go offline', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, { hostedQuota: { limit: 40, used: 3 } });
  await expect(page.getByTestId('cloud-quota')).toHaveText('Cloud calls left in this demo: 37');
  await expect(page.getByTestId('demo-badge')).toHaveText('Demo data');
  await page.getByRole('button', { name: 'Debug' }).click();
  const panel = page.getByTestId('debug-panel');
  await expect(panel.getByRole('heading', { name: 'Demo controls' })).toBeVisible();
  await expect(panel.getByRole('button')).toHaveText(['✕', 'Go offline']);
  await panel.getByRole('button', { name: 'Go offline' }).click();
  await expect(panel.getByRole('button', { name: 'Go online' })).toBeVisible();
  await panel.getByRole('button', { name: 'Go online' }).click();
});

test('hosted demo: Run locally opens a dialog with the clone, install and start commands; Esc closes it and focus returns', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, { hostedQuota: { limit: 40, used: 0 } });
  // Wide screens: under the team header, not in the top bar.
  await expect(page.getByTestId('run-locally-card').getByTestId('run-locally')).toBeVisible();
  await expect(page.locator('nav[aria-label="Primary"]').getByTestId('run-locally')).toHaveCount(0);
  await page.getByTestId('run-locally').click();
  const dialog = page.getByRole('dialog', { name: 'Run SelariKru on your computer' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('run-locally-commands')).toHaveText('git clone https://github.com/0xhaz/SelariKru.git\ncd SelariKru\npnpm install\npnpm start');
  await expect(dialog.getByRole('link', { name: 'Full steps in TESTING.md' })).toHaveAttribute('href', 'https://github.com/0xhaz/SelariKru/blob/main/TESTING.md');
  const { violations } = await new AxeBuilder({ page }).include('[data-testid="run-locally-dialog"]').analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('run-locally')).toBeFocused();
});

test('hosted demo, narrow window: Run locally is in the top bar (no side team panel)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await open(page, { hostedQuota: { limit: 40, used: 0 } });
  await expect(page.locator('nav[aria-label="Primary"]').getByTestId('run-locally')).toBeVisible();
  await expect(page.getByTestId('run-locally-card')).toHaveCount(0);
});

test('hosted demo at 1920 px: the Plan wall label stays on one line, clear of the cloud-calls chip', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await open(page, { hostedQuota: { limit: 40, used: 0 } });
  const label = page.getByText('Plan wall', { exact: true });
  await expect(label).toBeVisible();
  const [chip, text] = [await page.getByTestId('cloud-quota').boundingBox(), await label.boundingBox()];
  expect(text!.height).toBeLessThan(24);
  expect(text!.x).toBeGreaterThanOrEqual(chip!.x + chip!.width);
});

test('not the hosted demo (?demo): no Run locally button', async ({ page }) => {
  await page.goto('/?demo#/office');
  await expect(page.getByTestId('team-panel-row').first()).toBeVisible();
  await expect(page.getByTestId('run-locally')).toHaveCount(0);
});

test('H9 fix round 1 (I3): in dev with no Firebase config, a visible notice says AI calls will fail and what to add', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, { devConfigMissing: true });
  await expect(page.getByTestId('dev-config-missing')).toHaveText('Firebase config missing: AI calls will fail. Add VITE_FIREBASE_* to apps/control-web/.env.local');
});
