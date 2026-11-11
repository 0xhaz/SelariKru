/**
 * H7 screenshot review: the app's main screens on demo data, at desktop (1440×900) and phone (390×844) size, with reduced motion and a fixed clock, written
 * to test-results/screens/ for a person or a reviewer to look at. They are not committed baselines and nothing here diffs pixels. Each screen checks that
 * its key landmark rendered, and at phone width that the page does not scroll sideways.
 *
 * Run alone with `pnpm --filter @selarikru/control-web screens`.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { benchmarkFile, completeAssistant, completeWorkers } from '../src/features/benchmark/testing.ts';

// Outside test-results/, which every Playwright run clears, so other specs never wipe the screenshots (H7 fix M8). Git-ignored.
const DIR = join(import.meta.dirname, '..', 'test-results-screens');
const FIXED = new Date('2026-11-11T02:00:00Z');
const SIZES = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }] as const;
const T = (local: string) => `feature-delivery.${local}`;

test.describe.configure({ mode: 'parallel' });
test.use({ reducedMotion: 'reduce' });

async function open(page: Page, hash: string, scenario: Record<string, unknown> = {}): Promise<void> {
  await page.clock.setFixedTime(FIXED);
  await page.route('**/benchmark-results.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(benchmarkFile({ records: [...completeWorkers('measured'), ...completeAssistant('measured')] })) }));
  await page.addInitScript((s) => { (window as unknown as { __scenario: unknown }).__scenario = s; }, { spiedFixture: 'feature-delivery', ...scenario });
  await page.goto(`/tests/harness/index.html${hash}`);
}

/** The landmark is visible, the page does not scroll sideways at phone width, and the picture is saved. */
async function shot(page: Page, name: string, size: (typeof SIZES)[number], landmark: Locator): Promise<void> {
  await expect(landmark.first()).toBeVisible();
  if (size.width <= 390) expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name}: sideways scroll`).toBeLessThanOrEqual(390);
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: join(DIR, `${name}-${size.name}.png`), animations: 'disabled' });
}

const inspector = (page: Page) => page.getByTestId('task-inspector');
const row = (page: Page, id: string) => page.locator(`[data-testid="pipeline-row"][data-task-id="${id}"]`);

/** Opens a task's inspector from Pipeline: its row's title button on wide screens, the card on narrow ones. */
async function openTask(page: Page, id: string, title: string): Promise<void> {
  await open(page, `#/pipeline?task=${id}`);
  if (await inspector(page).count() === 0) await row(page, id).getByRole('button', { name: title }).first().click();
  await expect(inspector(page)).toBeVisible();
}

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}×${size.height}`, () => {
    // Desktop at 2x, like the Retina screen the demo is recorded on; the office then lands on its 1.5x zoom step.
    test.use({ deviceScaleFactor: size.name === 'desktop' ? 2 : 1 });
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: size.width, height: size.height }); });

    test('office', async ({ page }) => {
      await open(page, '#/office');
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __selarikruOffice?: { world: unknown } }).__selarikruOffice?.world))).toBe(true);
      await shot(page, '01-office', size, page.getByTestId('top-bar'));
      await expect(page.getByTestId('office-canvas')).toBeVisible();
    });

    test('top bar menus open', async ({ page }) => {
      await open(page, '#/office');
      const nav = page.getByRole('navigation', { name: 'Primary' });
      await nav.getByRole('button', { name: /^Boards/ }).click();
      await shot(page, '02-top-bar-boards-menu', size, nav.getByRole('link', { name: 'Pipeline' }));
    });

    test('Action items drawer', async ({ page }) => {
      await open(page, '#/actions', { spiedFixture: 'human-wait' });
      await shot(page, '03-action-items', size, page.getByRole('heading', { name: /Action items/, level: 1 }));
    });

    test('worker drawer, each tab', async ({ page }) => {
      await open(page, '#/office');
      const id = await page.evaluate(() => (window as unknown as { __selarikruOffice: { world: { agents: { id: string }[] } } }).__selarikruOffice.world.agents[0]!.id)
        .catch(() => null) ?? await page.getByTestId('team-panel-row').first().getAttribute('data-panel-worker');
      await open(page, `#/office?worker=${encodeURIComponent(id!)}`);
      const drawer = page.getByTestId('worker-drawer');
      const hashes = new Set<string>();
      // Each tab is chosen by clicking it, and is the selected tab before its capture (H7 fix I4).
      for (const [tab, name] of [['terminal', 'Terminal'], ['shell', 'Shell'], ['task', 'Task'], ['sandbox', 'Sandbox'], ['messages', 'Messages'], ['settings', 'Settings']] as const) {
        await drawer.getByRole('tab', { name, exact: true }).click();
        await expect(drawer.getByRole('tab', { name, exact: true, selected: true })).toBeVisible();
        await shot(page, `04-worker-${tab}`, size, drawer.getByRole('tabpanel'));
        hashes.add(createHash('sha256').update(readFileSync(join(DIR, `04-worker-${tab}-${size.name}.png`))).digest('hex'));
      }
      expect(hashes.size, 'the six worker tab captures differ').toBe(6);
    });

    test('Pipeline with a task\'s Runs on control', async ({ page }) => {
      await open(page, '#/pipeline');
      await shot(page, '05-pipeline-runs-on', size, page.getByTestId('runs-on').getByLabel('Runs on'));
    });

    test('a locked task', async ({ page }) => {
      await openTask(page, T('e2e'), 'End-to-end checks');
      await shot(page, '06-locked-task', size, inspector(page).getByTestId('route-lock'));
    });

    test('an agent proposal on the device and in the cloud', async ({ page }) => {
      await openTask(page, T('search'), 'Search index');
      const criteria = inspector(page).locator('[data-testid="agent-action"][data-kind="criteria"]');
      await criteria.getByRole('button', { name: 'Draft criteria' }).click();
      await expect(criteria.getByTestId('agent-result')).toHaveAttribute('data-status', 'ok');
      await criteria.getByTestId('agent-result').scrollIntoViewIfNeeded();
      await shot(page, '07-proposal-device', size, criteria.getByTestId('proposal-attribution'));
      const breakdown = inspector(page).locator('[data-testid="agent-action"][data-kind="breakdown"]');
      await breakdown.getByLabel('Use cloud for this call').check();
      await breakdown.getByRole('button', { name: 'Break down' }).click();
      await expect(breakdown.getByTestId('agent-result')).toHaveAttribute('data-status', 'ok');
      await breakdown.getByTestId('agent-result').scrollIntoViewIfNeeded();
      await shot(page, '08-proposal-cloud', size, breakdown.getByTestId('proposal-attribution'));
    });

    test('a fallback', async ({ page }) => {
      await open(page, '#/office');
      await shot(page, '09-fallback-activity', size, page.getByTestId('activity-fallback'));
      await openTask(page, T('web'), 'Feedback list UI');
      await shot(page, '10-fallback-task', size, inspector(page).getByTestId('runs-on-observed'));
    });

    test('Evidence and PR', async ({ page }) => {
      await open(page, '#/evidence', { spiedFixture: 'merge-flow' });
      await shot(page, '11-evidence', size, page.getByRole('heading', { level: 1 }));
    });

    test('Settings › Workflow with the run default', async ({ page }) => {
      await open(page, '#/settings?section=workflow');
      await shot(page, '12-settings-workflow', size, page.getByLabel('New tasks run on'));
    });

    test('Benchmark panel', async ({ page }) => {
      await open(page, '#/benchmark');
      await shot(page, '13-benchmark', size, page.getByRole('heading', { name: 'Benchmark', level: 1 }));
    });

    test('onboarding', async ({ page }) => {
      // The demo app's own onboarding (demo data, no network), as a first-time owner sees it.
      await page.clock.setFixedTime(FIXED);
      await page.goto('/?demo#/onboarding');
      await shot(page, '14-onboarding', size, page.getByRole('heading', { name: 'Set up a project' }));
    });
  });
}
