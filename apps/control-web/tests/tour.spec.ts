/** H9 item 4: the first-visit guided demo story, end to end under ?demo, by keyboard only. */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const serious = async (page: Page, include: string) => (await new AxeBuilder({ page }).include(include).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);

test('offered once on a first visit; Not now is remembered in this browser', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo#/office');
  const offer = page.getByTestId('tour-offer');
  await expect(offer).toBeVisible();
  expect(await serious(page, '[data-testid="tour-offer"]')).toEqual([]);
  await offer.getByRole('button', { name: 'Not now' }).click();
  await expect(offer).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('team-panel-row').first()).toBeVisible();
  await expect(offer).toHaveCount(0);
  // Still there whenever it is wanted.
  await expect(page.getByTestId('start-tour')).toBeVisible();
});

test('the tour runs end to end on demo data, by keyboard, each step on the real element it is about', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=human-wait#/team');
  await page.getByTestId('start-tour').focus();
  await page.keyboard.press('Enter');
  // It moves to the demo project that uses every route, and opens on the office.
  await expect(page).toHaveURL(/fixture=feature-delivery/);
  const tour = page.getByTestId('tour');
  const ring = page.getByTestId('tour-ring');
  const next = async (n: number) => {
    await tour.getByRole('button', { name: 'Next' }).focus();
    await page.keyboard.press('Enter');
    await expect(tour).toHaveAttribute('data-step', String(n));
  };
  await expect(tour).toHaveAttribute('data-step', '1');
  await expect(tour.getByRole('heading', { name: 'Drafted on this device' })).toBeFocused();
  await expect(ring).toBeVisible();
  await expect(page.getByTestId('office-summary')).toContainText('on this device');
  expect(await serious(page, '[data-testid="tour"]')).toEqual([]);

  await next(2);
  await expect(page).toHaveURL(/#\/pipeline\?task=feature-delivery\.api/);
  await expect(ring).toBeVisible();
  const row = (id: string) => page.locator(`[data-testid="pipeline-row"][data-task-id="feature-delivery.${id}"]`);
  await expect(row('api').getByTestId('runs-on')).toContainText('Cloud first');

  await next(3);
  await expect(row('e2e').getByTestId('route-lock')).toHaveText('Restricted data stays on this device');

  await next(4);
  await expect(page).toHaveURL(/#\/actions/);
  await tour.getByRole('button', { name: 'Go offline and run a Cloud only step' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tour-offline-status')).toHaveText(/Waiting in Paused AI work/);
  await expect(page.getByTestId('paused-work')).toContainText('Waiting for connection');
  await expect(ring).toBeVisible();
  await tour.getByRole('button', { name: 'Reconnect' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tour-offline-status')).toHaveText('Sent after reconnecting.');

  await next(5);
  await expect(page.getByTestId('ai-calls')).toBeVisible();
  // The step just sent is there, recorded as sent after reconnecting.
  await expect(page.getByTestId('ai-call-row').first()).toContainText('Sent after reconnecting');

  await next(6);
  await expect(page.getByTestId('pm-question')).toBeVisible();
  await expect(ring).toBeVisible();
  await tour.getByRole('button', { name: 'Finish' }).focus();
  await page.keyboard.press('Enter');
  await expect(tour).toHaveCount(0);
  await expect(ring).toHaveCount(0);
  await expect(page).not.toHaveURL(/tour=1/);
});

test('Escape closes the tour, and Back goes back a step', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=feature-delivery&tour=1#/office');
  const tour = page.getByTestId('tour');
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toHaveAttribute('data-step', '2');
  await tour.getByRole('button', { name: 'Back' }).click();
  await expect(tour).toHaveAttribute('data-step', '1');
  await page.keyboard.press('Escape');
  await expect(tour).toHaveCount(0);
});
