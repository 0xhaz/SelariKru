import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env['T511_SHOTS'];
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

const panel = (page: Page) => page.getByTestId('team-panel');
const panelRow = (page: Page, id: string) => page.locator(`[data-testid="team-panel-row"][data-panel-worker="${id}"]`);
const drawer = (page: Page) => page.getByTestId('worker-drawer');
const commands = (page: Page) => page.evaluate(() => window.__calls.commands as { method: string; command?: { command: string; args: Record<string, unknown> } }[]);

async function spied(page: Page, scenario: Record<string, unknown>, route: string): Promise<void> {
  await page.addInitScript((s) => { (window as unknown as { __scenario: unknown }).__scenario = s; }, scenario);
  await page.goto(`/tests/harness/index.html#/${route}`);
}

/** Opens the folded panel, at widths too narrow for it to sit beside the content. */
async function showPanel(page: Page): Promise<void> {
  const toggle = page.getByTestId('team-panel-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

const VIEWS = [['overview', 'Mission Control'], ['team', 'Team'], ['pipeline', 'Pipeline'], ['decisions', 'Decisions'], ['evidence', 'Evidence'], ['benchmark', 'Benchmark']] as const;

test('team panel shows each worker\'s live state on every view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [route, title] of VIEWS) {
    await page.goto(`/?demo&fixture=human-wait#/${route}`);
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-variant', 'side');
    await expect(page.getByRole('complementary', { name: 'Team' })).toBeVisible();
    await expect(panel(page).getByTestId('team-panel-summary')).toContainText('2 workers');
    await expect(panel(page).getByTestId('team-needs-you')).toHaveText(/1 needs you$/);
    const waiting = panelRow(page, 'runner_local_1');
    await expect(waiting).toHaveAttribute('data-state', 'needs_you');
    await expect(waiting.getByTestId('team-panel-state')).toContainText('Needs you');
    await expect(waiting.getByTestId('team-panel-task')).toContainText('Add feedback table');
    await expect(waiting.getByTestId('team-panel-model')).toContainText('claude-sonnet-5-5');
    await expect(waiting.getByTestId('team-panel-since')).toHaveText(/^for \d+/);
    await expect(waiting).toContainText('Backend');
    await expect(panelRow(page, 'runner_cloud_1')).toHaveAttribute('data-state', 'working');
  }

  // A lost worker is lost, an idle one idle, and a stale session claims nothing: every state is shown as unknown, with when it was last confirmed.
  await page.goto('/?demo&fixture=runner-loss#/pipeline');
  await expect(panelRow(page, 'runner_local_1')).toHaveAttribute('data-state', 'lost');
  await expect(panelRow(page, 'runner_local_1').getByTestId('team-panel-state')).toContainText('Lost');
  await expect(panelRow(page, 'runner_local_1').getByTestId('team-panel-since')).toHaveText(/ago$/);
  await page.goto('/?demo&fixture=failed-ci#/decisions');
  await expect(panelRow(page, 'runner_local_1')).toHaveAttribute('data-state', 'idle');
  await expect(panelRow(page, 'runner_local_1').getByTestId('team-panel-task')).toContainText('Last: Feedback API');
  await page.goto('/?demo&fixture=human-wait&fault=reconnecting#/evidence');
  await expect(panel(page).getByTestId('team-panel-stale')).toBeVisible();
  for (const id of ['runner_local_1', 'runner_cloud_1']) await expect(panelRow(page, id)).toHaveAttribute('data-state', 'unknown');
  await expect(panel(page)).not.toContainText('Working');

  // Folded at narrow widths, and the "needs you" count stays on screen while folded.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/?demo&fixture=human-wait#/pipeline');
  await expect(panel(page)).toHaveAttribute('data-variant', 'fold');
  // At phone width the folded count is the glyph and number, and the words are still read out.
  await expect(page.getByTestId('team-needs-you')).toBeVisible();
  await expect(page.getByTestId('team-needs-you')).toHaveText(/1 needs you/);
  await expect(page.getByTestId('team-needs-you')).toContainText('▲ 1');
  await expect(page.getByRole('button', { name: /Team.*1 needs you/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(panelRow(page, 'runner_local_1')).toBeHidden();
  await showPanel(page);
  await expect(panelRow(page, 'runner_local_1')).toBeVisible();
  await expect(panelRow(page, 'runner_local_1')).toHaveAttribute('data-state', 'needs_you');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('selecting a worker opens the drawer without navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=human-wait#/pipeline?view=table');
  await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await panelRow(page, 'runner_local_1').click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByRole('heading', { name: 'Backend worker' })).toBeVisible();
  // The view underneath is still the one the person was on, with its own query kept, and nothing was pushed to history.
  expect(new URL(page.url()).hash).toMatch(/^#\/pipeline\?(.+&)?worker=runner_local_1$/);
  await expect(page.locator('#main').getByRole('heading', { name: 'Pipeline', level: 1 })).toBeAttached();
  expect(await page.evaluate(() => history.length)).toBe(before);

  // The link opens the same drawer, on the tab it names.
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  expect(new URL(page.url()).hash).toContain('wtab=settings');
  await page.reload();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeAttached();

  await drawer(page).getByRole('button', { name: 'Close' }).click();
  await expect(drawer(page)).toHaveCount(0);
  expect(new URL(page.url()).hash).toMatch(/^#\/pipeline/);
  expect(new URL(page.url()).hash).not.toContain('worker=');

  // Opened from the Team view's fleet too, the same drawer and the same link.
  await page.goto('/?demo&fixture=human-wait#/team');
  await page.locator('[data-testid="fleet-row"][data-worker-id="runner_cloud_1"] [data-open-worker]').click();
  await expect(drawer(page)).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/team?worker=runner_cloud_1');
});

test('changing a model in the drawer applies to the next attempt', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, { spiedFixture: 'healthy-parallel-work' }, 'overview');
  await panelRow(page, 'runner_local_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  const settings = drawer(page).getByTestId('worker-settings');
  await expect(settings.getByTestId('settings-model')).toContainText('The attempt running now keeps the model it was started with: anthropic / claude-sonnet-5-5');
  await settings.getByLabel('Model for Feedback API').selectOption('claude-haiku-5-5');
  await settings.getByRole('button', { name: 'Save for Feedback API' }).click();
  await expect(settings.getByTestId('assignment-feedback')).toContainText('Applies to the next attempt. Work already running keeps its model.');
  const sent = (await commands(page)).filter((c) => c.method === 'execute');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.command).toMatchObject({ command: 'assignment.set', expectedRevision: 0, args: { scope: 'task', selection: { provider: 'anthropic', model: 'claude-haiku-5-5' } } });
  // What the running attempt was recorded with does not change: the badge and the panel still say the model it started on.
  await expect(drawer(page).getByTestId('inference-model')).toHaveText('claude-sonnet-5-5');
  await expect(settings.getByRole('region', { name: 'Model for this task' }).getByTestId('assignment-current')).toContainText('claude-haiku-5-5');
  await page.keyboard.press('Escape');
  await expect(panelRow(page, 'runner_local_1').getByTestId('team-panel-model')).toHaveText(/claude-sonnet-5-5/);
});

test('stop in the drawer asks for confirmation and is disabled when not live', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, { spiedFixture: 'human-wait' }, 'decisions');
  await panelRow(page, 'runner_cloud_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  const stop = drawer(page).getByRole('button', { name: 'Stop and cancel this task' });
  await expect(stop).toBeEnabled();
  await stop.click();
  const confirm = page.getByRole('dialog', { name: 'Stop and cancel "Empty states"?' });
  await expect(confirm).toContainText('The running attempt is stopped and the task is cancelled for good.');
  await expect(confirm).toContainText('It is not stopped until the runner confirms.');
  await confirm.getByRole('button', { name: 'Keep it running' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  expect((await commands(page)).filter((c) => c.method === 'execute')).toEqual([]);

  await stop.click();
  await page.getByRole('dialog', { name: /Stop and cancel/ }).getByRole('button', { name: 'Stop and cancel this task' }).click();
  await expect(drawer(page).getByTestId('settings-feedback')).toContainText('Cancel requested');
  const sent = (await commands(page)).filter((c) => c.method === 'execute');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.command).toMatchObject({ command: 'task.cancel', args: { taskId: expect.any(String) } });

  // With the connection not live, Stop is off and says why.
  await page.goto('about:blank');
  await spied(page, { spiedFixture: 'human-wait', fault: 'reconnecting' }, 'overview');
  await panelRow(page, 'runner_cloud_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  await expect(drawer(page).getByRole('button', { name: 'Stop and cancel this task' })).toBeDisabled();
  await expect(drawer(page).getByTestId('stop-disabled-reason')).toContainText(/connection/i);
  await expect(drawer(page).getByRole('button', { name: 'Stop and cancel this task' })).toHaveAttribute('aria-describedby', /.+/);
});

test('drawer keeps focus order and closes on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=human-wait#/overview');
  const opener = panelRow(page, 'runner_local_1');
  await opener.focus();
  await page.keyboard.press('Enter');
  const task = drawer(page).getByRole('tab', { name: 'Task' });
  await expect(task).toBeFocused();
  // Forward from the tabs: the panel, then the drawer's own controls, never anything behind it.
  await page.keyboard.press('Tab');
  await expect(drawer(page).getByTestId('drawer-panel')).toBeFocused();
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => { const a = document.activeElement; const d = document.querySelector('[data-testid="worker-drawer"]'); return a === document.body || (d !== null && d.contains(a)); })).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(new URL(page.url()).hash).toBe('#/overview');

  // Folded: the worker is chosen from the fold, and Escape returns focus to the fold's toggle.
  await page.setViewportSize({ width: 375, height: 800 });
  await showPanel(page);
  await panelRow(page, 'runner_local_1').click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByRole('tab', { name: 'Task' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.getByTestId('team-panel-toggle')).toBeFocused();
  // Escape in the open fold folds it, and focus stays on its toggle.
  await page.keyboard.press('Enter');
  await expect(panelRow(page, 'runner_local_1')).toBeVisible();
  await panelRow(page, 'runner_local_1').focus();
  await page.keyboard.press('Escape');
  await expect(panelRow(page, 'runner_local_1')).toBeHidden();
  await expect(page.getByTestId('team-panel-toggle')).toBeFocused();
});

for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [375, 812]] as const) {
  test(`axe at ${width}: Mission Control with the panel, and the drawer on Task, Settings and Terminal`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/?demo&fixture=human-wait#/overview');
    await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
    await expect(width >= 1280 ? panelRow(page, 'runner_local_1') : page.getByTestId('team-panel-toggle')).toBeVisible();
    await shot(page, `mission-control-${width}`);
    await expectNoAxeViolations(page);
    if (width < 1280) {
      await shot(page, `panel-collapsed-${width}`);
      await showPanel(page);
      await shot(page, `panel-open-${width}`);
      await expectNoAxeViolations(page);
    }
    await panelRow(page, 'runner_local_1').click();
    await expect(drawer(page)).toBeVisible();
    await shot(page, `drawer-task-${width}`);
    await expectNoAxeViolations(page);
    for (const tab of ['Settings', 'Terminal'] as const) {
      await drawer(page).getByRole('tab', { name: tab }).click();
      if (tab === 'Terminal') await expect(drawer(page).getByTestId('terminal-panel')).toBeVisible();
      await shot(page, `drawer-${tab.toLowerCase()}-${width}`);
      await expectNoAxeViolations(page);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('axe in the light theme at 1440: the panel and the drawer on Task, Settings and Terminal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('selarikru.theme', 'light'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=human-wait#/overview');
  await expect(panelRow(page, 'runner_local_1')).toBeVisible();
  await shot(page, 'mission-control-1440-light');
  await expectNoAxeViolations(page);
  await panelRow(page, 'runner_local_1').click();
  for (const tab of ['Task', 'Settings', 'Terminal'] as const) {
    await drawer(page).getByRole('tab', { name: tab }).click();
    await shot(page, `drawer-${tab.toLowerCase()}-1440-light`);
    await expectNoAxeViolations(page);
  }
});

test('the drawer\'s Settings offer the decision on this worker\'s task, and send it through the same confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, { spiedFixture: 'human-wait' }, 'overview');
  await panelRow(page, 'runner_local_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  const card = drawer(page).getByTestId('settings-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('link', { name: 'See the full card in Decisions' })).toBeVisible();
  const deny = card.getByRole('button', { name: /^Deny/ });
  await deny.click();
  await expect(page.getByRole('dialog', { name: /Deny/ })).toBeVisible();
  await page.getByRole('dialog', { name: /Deny/ }).getByRole('button', { name: 'Keep pending' }).click();
  expect((await commands(page)).filter((c) => c.method === 'execute')).toEqual([]);
});
