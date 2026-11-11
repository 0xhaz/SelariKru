/**
 * H11: Talk to the Project Manager on demo data (the real adapter over the stand-in SDK: no model and no network). A reply says where it ran and that it is a proposal;
 * the PM's assignments apply on their own inside the accepted plan, and the office shows the PM's envelopes going to the workers' desks.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, hash: string): Promise<void> {
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'feature-delivery' }; });
  await page.goto(`/tests/harness/index.html${hash}`);
}
type Live = { recentEvents: { kind: string; agentId?: string }[]; world: { pm: { name: string } } };

test('the PM answers on demo data as a labelled proposal, from the Boards menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/office');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: /^Boards/ }).click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Talk to the PM' }).click();
  await expect(page.getByRole('heading', { name: 'Talk to the Project Manager', level: 1 })).toBeVisible();
  await page.getByTestId('pm-question').fill('What blocks the list screen?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const reply = page.getByTestId('pm-turn-reply').first();
  await expect(reply.getByTestId('pm-attribution')).toContainText('Simulated in the demo; no model ran.');
  await expect(reply.getByTestId('pm-attribution')).toContainText('A person accepts every proposal');
  await expect(reply).toContainText('Ran on this device');
  await expect(reply.getByTestId('pm-answer')).toContainText('Demo answer');
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});

test('web research is refused for a locked task, in plain words', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pm');
  await page.getByTestId('pm-subject').selectOption('feature-delivery.e2e');
  await page.getByTestId('pm-question').fill('How do others test this?');
  await expect(page.getByRole('button', { name: 'Research the web' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Research the web' })).toHaveAttribute('title', 'Web research is never used for restricted work.');
});

test('the PM proposes assignments, they apply inside the accepted plan, and the office shows the envelopes to the workers\' desks', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pm');
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __selarikruOffice?: Live }).__selarikruOffice?.world))).toBe(true);
  await page.getByTestId('pm-question').fill('Who should take the open tasks?');
  await page.getByRole('button', { name: 'Propose assignments' }).click();
  const reply = page.getByTestId('pm-turn-reply').first();
  await expect(reply.getByTestId('pm-delegation')).toBeVisible();
  await expect(reply.getByTestId('pm-applied').first()).toContainText('assigned by the Project Manager under your accepted plan rev');
  // The office (behind the drawer) saw the delegation: the PM sends an envelope to the worker's desk.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __selarikruOffice: Live }).__selarikruOffice.recentEvents.map((e) => e.kind))).toContain('delegated');
});

test('Settings › Workflow turns auto-delegate off, and then the PM\'s assignments wait for you', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/settings?section=workflow');
  const panel = page.getByTestId('auto-delegate');
  await expect(panel).toHaveAttribute('data-on', 'true');
  await panel.getByRole('button', { name: 'Turn off auto-delegate' }).click();
  await expect(panel).toHaveAttribute('data-on', 'false');
  await page.goto('/tests/harness/index.html#/pm');
  await page.getByTestId('pm-question').fill('Who should take the open tasks?');
  await page.getByRole('button', { name: 'Propose assignments' }).click();
  const reply = page.getByTestId('pm-turn-reply').first();
  await expect(reply.getByTestId('pm-needs-you').first()).toContainText('Auto-delegation is off in Settings › Workflow');
  await expect(reply.getByTestId('pm-applied')).toHaveCount(0);
});

test('a worker is renamed in its drawer and shown as "Name · Role"', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/office?worker=runner_local_1');
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('tab', { name: 'Settings' }).click();
  await drawer.getByTestId('worker-name-input').fill('Nurul');
  await drawer.getByRole('button', { name: 'Save name' }).click();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(/^Nurul · /);
});
