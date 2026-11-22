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
    // The step's heading takes focus once the screen it moved to has settled (H9 fix round 2: wait for that, not a moment).
    await expect(tour.getByRole('heading', { level: 2 })).toBeFocused();
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
  // H9 fix round 1 (M2): the PM is asked for a plan on demo data, through its own panel, and its plan offers Accept plan.
  await expect(page).toHaveURL(/#\/pm/);
  // P1: the step is on the PM panel, so it sends you to the Office to watch the PM robot walk; it does not claim the robot is on screen here.
  await expect(tour).toContainText('then open the Office to watch the PM walk to the plan board');
  await tour.getByRole('button', { name: 'Ask the PM for a plan' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('pm-accept-plan')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('tour-pm-status')).toHaveText(/plan is ready/);
  await expect(ring).toBeVisible();

  await next(6);
  await expect(page.getByTestId('ai-calls')).toBeVisible();
  // H9 fix round 1 (I1): the PM's plan from step 5 is there, with where it ran; and the step sent after reconnecting.
  await expect(page.getByTestId('ai-call-row').first()).toContainText('PM plan draft');
  await expect(page.getByTestId('ai-call-row').filter({ hasText: 'Sent after reconnecting' })).toHaveCount(1);
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

test('H9 fix round 1 (M3): when the offline step cannot run, the connection is restored and the tour says it failed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // A project without the tour's Cloud only task: the step cannot run.
  await page.goto('/?demo&fixture=healthy-parallel-work&tour=1#/office');
  const tour = page.getByTestId('tour');
  for (let n = 2; n <= 4; n++) { await tour.getByRole('button', { name: 'Next' }).click(); await expect(tour).toHaveAttribute('data-step', String(n)); }
  await tour.getByRole('button', { name: 'Go offline and run a Cloud only step' }).click();
  await expect(page.getByTestId('tour-offline-status')).toHaveText(/could not run.*connection is back/i);
  await expect(page.getByTestId('demo-network').getByRole('button', { name: 'Go offline' })).toBeVisible();
});

test('H9 fix round 2: when the PM cannot be asked (no run yet), step 5 says it failed and offers Try again; it never stays on Asking', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=no-data&tour=1#/office');
  const tour = page.getByTestId('tour');
  for (let n = 2; n <= 5; n++) { await tour.getByRole('button', { name: 'Next' }).click(); await expect(tour).toHaveAttribute('data-step', String(n)); }
  await tour.getByRole('button', { name: 'Ask the PM for a plan' }).click();
  await expect(page.getByTestId('tour-pm-status')).toHaveText(/could not be asked/i, { timeout: 30_000 });
  await expect(tour.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('H9 fix round 3: Try again while the earlier PM call is still running starts no second call, and the late answer still counts', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Every demo agent answer waits for the test, and the tour gives the PM 1 s (a development-only setting for this test).
  await page.addInitScript(() => {
    (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'feature-delivery', holdAgents: true };
    (window as unknown as { __selarikruTourPmTimeoutMs: number }).__selarikruTourPmTimeoutMs = 1_000;
  });
  await page.goto('/tests/harness/index.html?tour=1#/office');
  const tour = page.getByTestId('tour');
  for (let n = 2; n <= 5; n++) { await tour.getByRole('button', { name: 'Next' }).click(); await expect(tour).toHaveAttribute('data-step', String(n)); }
  await tour.getByRole('button', { name: 'Ask the PM for a plan' }).click();
  await expect(page.getByTestId('tour-pm-status')).toHaveText(/could not be asked/i, { timeout: 15_000 });
  const again = tour.getByRole('button', { name: 'Try again' });
  await expect(again).toBeDisabled();
  await expect(page.getByTestId('pm-turn-owner')).toHaveCount(1);
  await page.evaluate(() => window.__releaseAgents!());
  await expect(page.getByTestId('tour-pm-status')).toHaveText(/plan is ready/);
  await expect(page.getByTestId('pm-turn-owner')).toHaveCount(1);
});
