import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, scenario: Record<string, unknown>): Promise<void> {
  await page.addInitScript((s) => { (window as unknown as { __scenario: unknown }).__scenario = s; }, scenario);
  await page.goto('/tests/harness/index.html#/actions');
  await expect(page.getByRole('heading', { name: 'Action items', level: 1 })).toBeVisible();
  await expandRows(page);
}
/** "Also waiting on you" shows each decision as a compact row; its full card, with every action, opens from Details. Open them all. */
async function expandRows(page: Page): Promise<void> {
  const closed = page.locator('[data-testid="action-row"] button[aria-expanded="false"]');
  while (await closed.count() > 0) await closed.first().click();
}
const commands = (page: Page) => page.evaluate(() => (window as unknown as { __calls: { commands: unknown[] } }).__calls.commands);
const cards = (page: Page) => page.getByTestId('decision-card');
const card = (page: Page, kind: string) => page.locator(`[data-testid="decision-card"][data-kind="${kind}"]`);
async function axe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('buttons name the outcome, no bare Continue', async ({ page }) => {
  await open(page, { spiedFixture: 'decision-queue' });
  await expect(cards(page)).toHaveCount(3);
  const names = (await page.getByRole('main').getByRole('button').allInnerTexts()).map((t) => t.trim());
  expect(names).toContain('Grant cloud start');
  expect(names).toContain('Deny and block task');
  for (const name of names) expect(name).not.toMatch(/^(continue|ok|okay|approve|yes|confirm|submit|accept)$/i);
  await axe(page);
});

test('changed revision → "This request changed", stays pending', async ({ page }) => {
  await open(page, { spiedFixture: 'changed-request' });
  const c = card(page, 'approval');
  await expect(c).toHaveAttribute('data-state', 'changed');
  await expect(c.getByTestId('request-changed')).toContainText('This request changed');
  await expect(c.getByRole('button', { name: /Record approval/ })).toBeDisabled();
  await expect(c.getByRole('button', { name: 'Deny and block task' })).toBeDisabled();
  await expect(c.getByTestId('disabled-reason')).toContainText('This request changed');
  expect(await commands(page)).toEqual([]);
});

test('a refused grant shows "This request changed", keeps the request pending and needs another look', async ({ page }) => {
  await open(page, { spiedFixture: 'decision-queue', rejectWith: 'stale_revision' });
  const c = card(page, 'approval').filter({ hasText: 'cloud sandbox' });
  await c.getByRole('button', { name: 'Grant cloud start' }).click();
  await expect(c.getByTestId('request-changed')).toContainText('This request changed');
  await expect(c.getByTestId('card-feedback')).toContainText('review the updated details');
  expect(await commands(page)).toHaveLength(1);
  await expect(c.getByRole('button', { name: 'Grant cloud start' })).toBeDisabled();
  await c.getByRole('button', { name: 'I have reviewed the update' }).click();
  await expect(c.getByRole('button', { name: 'Grant cloud start' })).toBeEnabled();
});

test('denied policy shows no approve button', async ({ page }) => {
  await open(page, { spiedFixture: 'policy-block' });
  const c = card(page, 'policy_deny').first();
  await expect(c).toContainText('denied by policy');
  await expect(c).toContainText('No approval can override');
  await expect(c.getByRole('button', { name: /approve|grant|allow/i })).toHaveCount(0);
  await axe(page);
});

test('disabled while disconnected', async ({ page }) => {
  await open(page, { spiedFixture: 'decision-queue', fault: 'reconnecting' });
  const c = card(page, 'approval').first();
  await expect(c.getByRole('button', { name: 'Grant cloud start' })).toBeDisabled();
  await expect(c.getByRole('button', { name: 'Deny and block task' })).toBeDisabled();
  await expect(c.getByTestId('disabled-reason')).toContainText('Nothing is queued');
  await expect(page.getByTestId('connection-banner')).toBeVisible();
  expect(await commands(page)).toEqual([]);
  await axe(page);
});

test("inspecting doesn't resolve", async ({ page }) => {
  await open(page, { spiedFixture: 'decision-queue' });
  const c = card(page, 'approval').filter({ hasText: 'Destructive' });
  await c.getByText('Technical details').click();
  await c.getByRole('button', { name: 'Deny and block task' }).click();
  await expect(page.getByRole('dialog')).toContainText('moves to blocked');
  await axe(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(c.getByRole('button', { name: 'Deny and block task' })).toBeFocused();
  await c.getByRole('button', { name: 'Deny and block task' }).click();
  await page.getByRole('button', { name: 'Keep pending' }).click();
  expect(await commands(page)).toEqual([]);
  await expect(cards(page)).toHaveCount(3);
});

test('merge card links to GitHub and offers no merge action', async ({ page }) => {
  await open(page, { spiedFixture: 'merge-flow', observed: true });
  const c = card(page, 'merge_review');
  const link = c.getByRole('link', { name: /Open pull request #12 on GitHub/ });
  await expect(link).toHaveAttribute('href', /^https:\/\/github\.com\/.+\/pull\/12$/);
  await expect(page.getByRole('main').getByRole('button', { name: /merge/i })).toHaveCount(0);
  await expect(c).toContainText('Merging is a human action on GitHub');
  await axe(page);
});

test('a confirmed denial records one command, keeps its key, and moves focus to the next card', async ({ page }) => {
  await open(page, { spiedFixture: 'decision-queue' });
  await expect(cards(page)).toHaveCount(3);
  const first = cards(page).first();
  const title = await first.getByRole('heading', { level: 2 }).innerText();
  await first.getByRole('button', { name: 'Deny and block task' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deny and block task' }).click();
  await expect(page.getByTestId('decision-status')).toHaveText('Denial recorded for Start "Search index" in a cloud sandbox.');
  await expect(page.getByTestId('history-entry')).toContainText(['Denied']);
  await expect(page.locator(':focus')).toHaveRole('heading');
  expect(await page.locator(':focus').innerText()).not.toEqual(title);
  // The denied task is now blocked and asks for a replan or a cancel: a new card, not the same one.
  await expandRows(page);
  await expect(card(page, 'blocked')).toContainText('approval was denied');
  const [cmd] = await commands(page) as [{ command: { command: string; idempotencyKey: string } }];
  expect(cmd.command.command).toBe('approval.deny');
  expect(cmd.command.idempotencyKey).toMatch(/^decision-/);
});

test('budget stop lists what was not delivered, and accepting it stops it counting', async ({ page }) => {
  await open(page, { spiedFixture: 'budget-stop' });
  const c = card(page, 'budget_stop');
  await expect(c.getByTestId('not-delivered')).toContainText('Search index');
  await expect(c.getByTestId('not-delivered')).toContainText('FB-03');
  await c.getByRole('button', { name: 'Accept reduced scope' }).click();
  await expect(page.getByRole('dialog')).toContainText('not delivered');
  await page.getByRole('dialog').getByRole('button', { name: 'Accept reduced scope' }).click();
  await expect(card(page, 'budget_stop')).toHaveCount(0);
  await expect(page.getByTestId('history-entry').first()).toContainText('Accepted reduced scope');
  await expect(page.getByTestId('action-items')).not.toContainText(/\d/);
});

test('expired approval can be denied and offers no grant', async ({ page }) => {
  await open(page, { spiedFixture: 'expired-approval' });
  const c = card(page, 'approval');
  await expect(c).toHaveAttribute('data-state', 'expired');
  await expect(c.getByRole('button', { name: /grant|allow|record approval/i })).toHaveCount(0);
  await expect(c.getByRole('button', { name: 'Deny and block task' })).toBeEnabled();
});

test('merged-SHA mismatch and blocked verification get their own cards and real actions', async ({ page }) => {
  await open(page, { spiedFixture: 'merged-sha-mismatch' });
  await expect(card(page, 'reconciliation')).toContainText('does not match what was verified');
  await page.close();
  const next = await page.context().newPage();
  await next.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'integration-blocked' }; });
  await next.goto('/tests/harness/index.html#/actions');
  await expect(next.getByRole('heading', { name: 'Action items', level: 1 })).toBeVisible();
  await expandRows(next);
  await expect(card(next, 'reverify').getByRole('button', { name: 'Re-verify the run' })).toBeVisible();
  await expect(card(next, 'blocked').getByRole('button', { name: 'Cancel task' })).toBeVisible();
});

test('a deep link from a worker\'s request lands on its card in the Action items drawer', async ({ page }) => {
  await page.addInitScript((s) => { (window as unknown as { __scenario: unknown }).__scenario = s; }, { spiedFixture: 'expired-approval' });
  await page.goto('/tests/harness/index.html#/office');
  // The worker drawer's Messages tab links each of its requests to its card.
  await page.getByTestId('team-panel-row').first().click();
  await page.getByTestId('worker-drawer').getByRole('tab', { name: 'Messages' }).click();
  await page.getByTestId('worker-drawer').getByRole('link', { name: 'Open in Action items' }).first().click();
  await expect(page.getByRole('heading', { name: 'Action items', level: 1 })).toBeVisible();
  await expect(page.locator(':focus')).toContainText('Vendor');
});

async function openDeny(page: Page): Promise<void> {
  await card(page, 'approval').first().getByRole('button', { name: 'Deny and block task' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('a confirm dialog closes and says so when the request changes under it, and sends nothing', async ({ page }) => {
  await open(page, { spiedFixture: 'decision-queue' });
  await openDeny(page);
  await page.evaluate(() => {
    const store = (window as unknown as { __projection: { getState(): { projection: { snapshot: { approvals: Record<string, { scopeHash: string }> } } }; setState(s: unknown): void } }).__projection;
    const p = store.getState().projection;
    const [id, a] = Object.entries(p.snapshot.approvals)[0]!;
    store.setState({ projection: { ...p, snapshot: { ...p.snapshot, approvals: { ...p.snapshot.approvals, [id]: { ...a, scopeHash: 'moved' } } } } });
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('request-changed').first()).toContainText('This request changed');
  await expect(page.getByTestId('card-feedback').first()).toContainText('Nothing was sent');
  expect(await commands(page)).toEqual([]);
});

test('a confirm dialog closes when the session stops being live, with not-sent copy', async ({ page }) => {
  await open(page, { spiedFixture: 'decision-queue' });
  await openDeny(page);
  await page.evaluate(() => (window as unknown as { __projection: { setState(s: unknown): void } }).__projection.setState({ status: 'reconnecting' }));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('card-feedback').first()).toContainText('Not sent');
  await expect(page.getByTestId('card-feedback').first()).not.toContainText('cannot say');
  expect(await commands(page)).toEqual([]);
});

test('a busy decision shows it is sending', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'decision-queue', holdExecute: true }; });
  await page.goto('/tests/harness/index.html#/actions');
  const c = card(page, 'approval').first();
  await c.getByRole('button', { name: 'Grant cloud start' }).click();
  await expect(c.getByRole('button', { name: /Grant cloud start/ })).toHaveAttribute('data-busy', 'true');
  await expect(c).toContainText('Sending');
});

test('history keeps a decision after a resync', async ({ page }) => {
  await open(page, { spiedFixture: 'decision-queue' });
  await card(page, 'approval').first().getByRole('button', { name: 'Deny and block task' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deny and block task' }).click();
  const entry = page.getByTestId('history-entry');
  await expect(entry.first()).toContainText('Denied');
  await page.evaluate(() => (window as unknown as { __projection: { getState(): { resync(): void } } }).__projection.getState().resync());
  await expect(entry.first()).toContainText('Denied');
  await expect(entry.first()).toContainText('By demo-operator');
  await expect(page.getByRole('region', { name: 'Decision history' })).toContainText('A grant is a record');
});

test('what a worker asks without a decision card of its own is in the same drawer, and the counts agree', async ({ page }) => {
  await open(page, { spiedFixture: 'policy-block' });
  await expect(page.getByTestId('attention-count')).toHaveText('2 need attention');
  await expect(page.getByTestId('decisions-count')).toContainText('1');
  // The ask with no card sits under From workers; the total waiting counts both.
  await expect(page.getByTestId('from-workers').getByTestId('attention-item')).toHaveCount(1);
  await expect(page.getByTestId('view-drawer-aside')).toHaveText('2 waiting on you');
  await expect(page.getByTestId('action-items')).toContainText('· 2');
});

test('two stops sharing one decision say why the counts differ', async ({ page }) => {
  await open(page, { spiedFixture: 'budget-stop' });
  await expect(page.getByTestId('attention-count')).toHaveText('2 need attention');
  await expect(page.getByTestId('decisions-count')).toContainText('1');
  await expect(page.getByTestId('decisions-grouped')).toContainText('Some items share one decision here');
});

test('the replan banner clears when the link no longer names a run', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { shell: true }; });
  await page.goto('/tests/harness/index.html#/assistant?run=run-42&task=task-7');
  await expect(page.getByTestId('replan-context')).toContainText('task-7');
  await page.evaluate(() => { window.location.hash = '#/assistant'; });
  await expect(page.getByTestId('replan-context')).toHaveCount(0);
});

test('a policy-denied card does not read as queued', async ({ page }) => {
  await open(page, { spiedFixture: 'policy-block' });
  await expect(card(page, 'policy_deny').first()).toContainText('Held by policy');
  await expect(card(page, 'policy_deny').first()).not.toContainText('Queued');
});

test('replan opens the Assistant with the run and task filled in', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { shell: true }; });
  await page.goto('/tests/harness/index.html#/assistant?run=run-42&task=task-7');
  await expect(page.getByTestId('replan-context')).toContainText('task-7');
  await expect(page.getByLabel('Run ID', { exact: false })).toHaveValue('run-42');
});
