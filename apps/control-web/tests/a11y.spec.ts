/**
 * H9: a WCAG 2.2 AA pass with axe on the main views, on demo data: the office, Action items (with Paused AI work), Settings, the PM panel, the AI calls view and
 * the tour. Every serious and critical issue fails the run.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
async function check(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
}
const open = async (page: Page, hash: string) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The first-visit tour offer is checked on its own below.
  await page.addInitScript(() => { try { localStorage.setItem('selarikru.tour.offered', '1'); } catch { /* none */ } });
  await page.goto(`/?demo&fixture=feature-delivery${hash}`);
};

test('office', async ({ page }) => {
  await open(page, '#/office');
  await expect(page.getByTestId('team-panel-row').first()).toBeVisible();
  expect(await check(page)).toEqual([]);
});

test('Action items, with Paused AI work (a Cloud only step run offline from the tour)', async ({ page }) => {
  await open(page, '&tour=1#/office');
  const tour = page.getByTestId('tour');
  for (let n = 2; n <= 4; n++) { await tour.getByRole('button', { name: 'Next' }).click(); await expect(tour).toHaveAttribute('data-step', String(n)); }
  await tour.getByRole('button', { name: 'Go offline and run a Cloud only step' }).click();
  await expect(page.getByTestId('paused-work')).toBeVisible();
  expect(await check(page)).toEqual([]);
});

test('Settings', async ({ page }) => {
  await open(page, '#/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  expect(await check(page)).toEqual([]);
});

test('PM panel', async ({ page }) => {
  await open(page, '#/pm');
  await expect(page.getByTestId('pm-question')).toBeVisible();
  expect(await check(page)).toEqual([]);
});

test('AI calls', async ({ page }) => {
  await open(page, '#/calls');
  await expect(page.getByTestId('ai-call-row').first()).toBeVisible();
  expect(await check(page)).toEqual([]);
});

test('the tour, and its first-visit offer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=feature-delivery#/office');
  await expect(page.getByTestId('tour-offer')).toBeVisible();
  expect(await check(page)).toEqual([]);
  await page.goto('/?demo&fixture=feature-delivery&tour=1#/office');
  await expect(page.getByTestId('tour')).toBeVisible();
  expect(await check(page)).toEqual([]);
});
