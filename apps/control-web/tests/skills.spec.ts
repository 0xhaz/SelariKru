import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:5174';

async function open(page: Page, width = 1440): Promise<string[]> {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'healthy-parallel-work' }; });
  await page.goto('/tests/harness/index.html#/settings?section=skills');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Knowledge and skills' })).toBeVisible();
  return requests;
}
const row = (page: Page, prefix: string) => page.locator(`[data-testid="skill-row"][data-version^="${prefix}"]`);
const notice = (page: Page) => page.getByTestId('skills-notice');

test('review a staged pack, bind it, and see it with its digest in the worker drawer', async ({ page }) => {
  const requests = await open(page);
  await expect(page.getByTestId('skills-demo-badge')).toHaveText(/Demo data/);
  await expect(page.getByRole('link', { name: 'Knowledge and skills' })).toHaveAttribute('aria-current', 'page');

  // The curated library: first party, reviewed, pinned, not tested here, not bound.
  const conventions = row(page, 'feedback-board-conventions@');
  await expect(conventions.getByTestId('skill-states')).toHaveAttribute('data-states', 'reviewed');
  await expect(conventions).toContainText('First party · platform library');
  await expect(conventions).toContainText('Not bound to this project');

  // Stage a pack from a local path: it is scanned, Available, and cannot be bound yet.
  await page.getByLabel('Local pack directory').fill('/home/me/packs/team-notes');
  await page.getByRole('button', { name: 'Stage pack' }).click();
  const staged = row(page, 'tp-team-review-notes@');
  await expect(staged).toBeVisible();
  await expect(staged.getByTestId('skill-states')).toHaveAttribute('data-states', 'available');
  await expect(staged.getByTestId('skill-scan')).toContainText('mentions example.com');
  await expect(staged.getByTestId('skill-finding')).toContainText('A pack grants no network access');
  await expect(staged.getByRole('button', { name: /^Bind / })).toHaveCount(0);

  // Review needs the findings acknowledged, then binds.
  const review = staged.getByRole('button', { name: 'Mark team-review-notes 0.3.0 reviewed' });
  await expect(review).toBeDisabled();
  await staged.getByRole('checkbox', { name: /I have read the 1 finding/ }).check();
  await review.click();
  await expect(staged.getByTestId('skill-states')).toHaveAttribute('data-states', 'reviewed');
  await expect(notice(page)).toContainText('Marked team-review-notes 0.3.0 reviewed');
  // A third-party pack needs a role or a path before it can be bound.
  const bindStaged = staged.getByRole('button', { name: 'Bind team-review-notes 0.3.0' });
  await expect(bindStaged).toBeDisabled();
  for (const box of await staged.getByRole('checkbox', { name: /role for team-review-notes/ }).all()) await box.check();
  await bindStaged.click();
  await expect(staged.getByTestId('skill-binding')).toContainText('Bound at revision 1, only for roles');
  await expect(page.getByTestId('skills-history-row').first()).toContainText('Bound tp-team-review-notes@0.3.0');
  await expect(page.getByTestId('skills-history-row')).toHaveCount(3);
  await expect(notice(page)).toContainText('In force now');

  // The worker drawer: the attempt's packs, each with the digest it was checked against. Settings is modal, so it is closed first.
  await page.getByRole('link', { name: 'Close settings' }).click();
  await page.locator('[data-testid="team-panel-row"]').first().click();
  const drawer = page.getByTestId('worker-drawer');
  await drawer.getByRole('tab', { name: 'Context' }).click();
  const pack = drawer.locator('[data-testid="drawer-skill"][data-version^="tp-team-review-notes@0.3.0+"]');
  await expect(pack).toBeVisible();
  await expect(pack).toContainText('Enabled for this task');
  await expect(drawer.getByTestId('drawer-skills-delivery')).toContainText('confirmed each digest');
  await expect(pack).toContainText(/sha256 [0-9a-f]{64}/);
  await expect(pack).toContainText('.claude/skills/tp-team-review-notes');

  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  // Demo data: nothing left the page.
  expect(requests.filter((u) => !u.startsWith(ORIGIN))).toEqual([]);
});

test('a pack with a setup script is Blocked and offers no review', async ({ page }) => {
  await open(page);
  await page.getByLabel('Local pack directory').fill('/tmp/quick-setup');
  await page.getByRole('button', { name: 'Stage pack' }).click();
  const blocked = row(page, 'tp-quick-setup@');
  await expect(blocked.getByTestId('skill-states')).toHaveAttribute('data-states', 'blocked');
  await expect(blocked.getByTestId('skill-finding').filter({ hasText: 'Executable content' })).toContainText('Blocks');
  await expect(blocked.getByRole('button', { name: /reviewed$/ })).toHaveCount(0);
  await expect(blocked.getByRole('button', { name: /^Bind / })).toHaveCount(0);
});

test('a revoked pack says so, and keyboard reaches every action', async ({ page }) => {
  await open(page);
  const pack = row(page, 'vitest-testing-practices@');
  await pack.getByLabel('Reason to revoke Vitest testing practices 1.0.0').focus();
  await page.keyboard.type('Advice out of date');
  await page.keyboard.press('Tab');
  await expect(pack.getByRole('button', { name: 'Revoke Vitest testing practices 1.0.0' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pack.getByTestId('skill-states')).toHaveAttribute('data-states', 'revoked');
  await expect(pack).toContainText('an attempt already running keeps it');
  await expect(pack.getByRole('button', { name: /^Bind / })).toHaveCount(0);
});

test('a reviewed binding shows on the stack entry its triggers name, in place of No reviewed skills', async ({ page }) => {
  await open(page);
  await row(page, 'express-api-routes@').getByRole('button', { name: 'Bind Express routes and tests 1.0.0' }).click();
  await expect(row(page, 'express-api-routes@').getByTestId('skill-binding')).toContainText('Bound at revision 1');
  await page.getByRole('link', { name: 'Stack', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Stack' })).toBeVisible();
  const express = page.locator('[data-testid="stack-detection"][data-detection="det:.:express"]');
  await express.getByRole('button', { name: /Confirm Express/ }).click();
  const item = page.locator('[data-testid="stack-item"][data-item="express"]');
  await expect(item).toContainText('Reviewed: Express routes and tests 1.0.0');
  await page.locator('[data-testid="stack-detection"][data-detection="det:.:react"]').getByRole('button', { name: /Confirm React/ }).click();
  await expect(page.locator('[data-testid="stack-item"][data-item="react"]')).toContainText('No reviewed skills');
});
