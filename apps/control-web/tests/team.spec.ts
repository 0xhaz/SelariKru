import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function openTeam(page: Page, query = ''): Promise<void> {
  await page.goto(`/?demo${query}#/team`);
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
}
const fixture = (id: string): string => `&fixture=${id}`;
const rows = (page: Page) => page.getByTestId('fleet-row');
const rowOf = (page: Page, id: string) => page.locator(`[data-testid="fleet-row"][data-worker-id="${id}"]`);
const drawer = (page: Page) => page.getByTestId('worker-drawer');

async function openWorker(page: Page, id: string): Promise<void> {
  await rowOf(page, id).locator(`[data-open-worker="${id}"]`).click();
  await expect(drawer(page)).toBeVisible();
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('the Team nav item is a real link and the page is titled', async ({ page }) => {
  await page.goto('/?demo');
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Team' }).click();
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
  await expect(page).toHaveTitle('Team · SelariKru');
  await expect(page.locator('#main')).toBeFocused();
});

test('activity, health and results render separately', async ({ page }) => {
  await openTeam(page, fixture('failed-ci'));
  const row = rows(page).first();
  await expect(row.getByTestId('signal-activity')).toContainText('Idle');
  await expect(row.getByTestId('signal-health')).toContainText('No active attempt');
  await expect(row.getByTestId('signal-results')).toContainText('Failed');
  await expect(row.getByTestId('signal-results')).toContainText('3 of 41 tests failed');
  // A failed check does not turn into a health problem, and idle is not a result.
  await expect(row.getByTestId('signal-health')).not.toContainText('Failed');
  await expect(row.getByTestId('signal-results')).not.toContainText('Idle');
});

test('null activity renders exactly once, muted, and is never guessed', async ({ page }) => {
  await openTeam(page, fixture('long-build-stall'));
  const activity = rowOf(page, 'runner_local_1').getByTestId('signal-activity');
  await expect(activity).toHaveText('Activity not reported');
  await expect(activity.locator('.text-muted')).toHaveCount(1);
  await expect(rows(page).first().getByText('Activity not reported')).toHaveCount(1);
});

test('runtime and inference badges independent, including local worker with cloud model', async ({ page }) => {
  await openTeam(page, fixture('healthy-parallel-work'));
  const local = rowOf(page, 'runner_local_1');
  await expect(local).toContainText('Local sandbox');
  await expect(local).toContainText('Model in cloud');
  const cloud = rowOf(page, 'runner_cloud_1');
  await expect(cloud).toContainText('Cloud sandbox');
  await expect(cloud).toContainText('Model in cloud');
  await openWorker(page, 'runner_local_1');
  await expect(drawer(page)).toContainText('Local sandbox');
  await expect(drawer(page)).toContainText('Model in cloud');
});

test('disconnected keeps last-confirmed state with stale label', async ({ page }) => {
  await openTeam(page, fixture('runner-loss'));
  const row = rowOf(page, 'runner_local_1');
  await expect(row).toContainText('Connection lost');
  await expect(row.getByTestId('stale-label')).toContainText('Stale');
  await expect(row).toContainText('State last confirmed');
  await expect(row).toContainText('Feedback API');
  await expect(row).toContainText('Local sandbox');
  // Nothing invented: the last tool it reported, no result, and not shown healthy.
  await expect(row.getByTestId('signal-activity')).toHaveText(/Last tool: /);
  await expect(row).not.toContainText('Healthy');
  await openWorker(page, 'runner_local_1');
  await expect(drawer(page).getByTestId('drawer-summary')).toContainText('Connection lost');
  await expect(drawer(page).getByTestId('drawer-confirmed')).toContainText('2026');
});

test('a stale session labels every worker and claims no health', async ({ page }) => {
  await openTeam(page, `${fixture('human-wait')}&fault=reconnecting`);
  await expect(page.getByTestId('connection-banner')).toContainText('Reconnecting');
  await expect(page.getByTestId('team-summary')).toContainText('Last confirmed');
  const count = await rows(page).count();
  expect(count).toBeGreaterThan(0);
  await expect(page.getByTestId('stale-label')).toHaveCount(count);
  for (let i = 0; i < count; i += 1) await expect(rows(page).nth(i).getByTestId('signal-health')).toContainText('Health unknown');
  await expect(page.getByRole('main')).not.toContainText('Healthy');
});

test('a dead session offers a restart and keeps workers labelled', async ({ page }) => {
  await openTeam(page, '&fault=dead');
  await expect(page.getByTestId('connection-banner')).toContainText('The event stream stopped');
  await expect(rows(page).first()).toContainText('Health unknown');
  await page.getByRole('button', { name: 'Restart session' }).click();
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  await expect(page.getByTestId('stale-label')).toHaveCount(0);
});

test('unknown inference never shows Device', async ({ page }) => {
  await openTeam(page, fixture('unknown-costs'));
  const row = rowOf(page, 'runner_cloud_1');
  await expect(row).toContainText('Model route unknown');
  await expect(row).not.toContainText(/device/i);
  await openWorker(page, 'runner_cloud_1');
  await expect(drawer(page)).toContainText('Model route unknown');
  await expect(drawer(page)).not.toContainText(/device/i);
});

test('drawer opens to Task, focus returns on close', async ({ page }) => {
  await openTeam(page, fixture('human-wait'));
  const opener = rowOf(page, 'runner_local_1').locator('[data-open-worker="runner_local_1"]');
  await opener.focus();
  await page.keyboard.press('Enter');
  const taskTab = drawer(page).getByRole('tab', { name: 'Task' });
  await expect(taskTab).toHaveAttribute('aria-selected', 'true');
  await expect(taskTab).toBeFocused();
  await expect(drawer(page).getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'false');
  await expect(drawer(page).getByTestId('drawer-panel')).toContainText('Add feedback table');

  // Focus stays within the drawer: nothing behind it can be reached.
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    const outside = await page.evaluate(() => {
      const active = document.activeElement;
      const dialog = document.querySelector('dialog');
      return active !== null && active !== document.body && dialog !== null && !dialog.contains(active);
    });
    expect(outside).toBe(false);
  }

  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(opener).toBeFocused();

  // And by the Close button.
  await opener.click();
  await drawer(page).getByRole('button', { name: 'Close' }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('tabs follow the arrow keys and show exact times', async ({ page }) => {
  await openTeam(page, fixture('failed-ci'));
  await openWorker(page, 'runner_local_1');
  await page.keyboard.press('ArrowRight');
  const timeline = drawer(page).getByRole('tab', { name: 'Timeline' });
  await expect(timeline).toBeFocused();
  await expect(timeline).toHaveAttribute('aria-selected', 'true');
  await expect(drawer(page).getByTestId('drawer-panel')).toContainText('Check failed');
  await expect(drawer(page).getByTestId('drawer-panel').locator('time').first()).toContainText('2026');
  await page.keyboard.press('End');
  await expect(drawer(page).getByRole('tab', { name: 'Usage' })).toBeFocused();
  await expect(drawer(page).getByTestId('drawer-panel')).toContainText('Estimated');
});

test('opening a worker is read-only', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'human-wait' };
  });
  await page.goto('/tests/harness/index.html#/team');
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
  const commands = (): Promise<unknown[]> => page.evaluate(() => (window as unknown as { __calls: { commands: unknown[] } }).__calls.commands);

  const count = await rows(page).count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    await rows(page).nth(i).locator('[data-open-worker]').click();
    for (const tab of ['Task', 'Timeline', 'Checks', 'Artifacts', 'Permissions', 'Sandbox', 'Usage']) await drawer(page).getByRole('tab', { name: tab }).click();
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
  }
  expect(await commands()).toEqual([]);

  // The spy works: a real command through the same source is recorded.
  await page.evaluate(async () => {
    const w = window as unknown as { __spiedSource: { execute(c: unknown): Promise<unknown> } };
    await w.__spiedSource.execute({ command: 'task.cancel', expectedRevision: 0, idempotencyKey: 'control', args: { taskId: 'missing' } }).catch(() => undefined);
  });
  expect(await commands()).toHaveLength(1);
});

test('timestamps in rows are not tab stops; the exact time is in the drawer', async ({ page }) => {
  await openTeam(page, fixture('runner-loss'));
  await expect(rows(page).first().locator('time').first()).toBeVisible();
  await expect(rows(page).first().locator('[tabindex]')).toHaveCount(0);
  await openWorker(page, 'runner_local_1');
  await expect(drawer(page).getByTestId('drawer-confirmed').locator('time')).toContainText('2026');
});

test('unknown costs read as unknown and never zero', async ({ page }) => {
  await openTeam(page, fixture('unknown-costs'));
  await expect(rowOf(page, 'runner_cloud_1').getByTestId('row-spend')).toContainText('Unavailable');
  await expect(rowOf(page, 'runner_cloud_1')).not.toContainText('$0');
  await expect(rowOf(page, 'runner_local_1').getByTestId('row-spend')).toContainText('estimated');
  await openWorker(page, 'runner_cloud_1');
  await drawer(page).getByRole('tab', { name: 'Usage' }).click();
  await expect(drawer(page).getByTestId('drawer-panel')).toContainText('Unavailable');
  await expect(drawer(page).getByTestId('drawer-panel')).not.toContainText('$0');
});

test('sorting and filtering reorder and narrow the fleet, and say what is hidden', async ({ page }) => {
  await openTeam(page, fixture('unknown-costs'));
  await expect(rows(page)).toHaveCount(3);
  await page.getByLabel('Runtime').selectOption('cloud');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId('filter-count')).toHaveText('Showing 1 of 3');
  await page.getByLabel('Role').selectOption('backend');
  await expect(page.getByText('No workers match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows(page)).toHaveCount(3);
  await page.getByLabel('Sort by').selectOption('role');
  await expect(page.locator('th[aria-sort="ascending"]')).toHaveText('Worker and task');
});

test('the run filter lists the runs seen and keeps their workers', async ({ page }) => {
  await openTeam(page, fixture('unknown-costs'));
  const select = page.getByLabel('Run', { exact: true });
  await expect(select.locator('option')).toHaveText(['All runs', 'unknown-costs.run']);
  await select.selectOption('unknown-costs.run');
  await expect(rows(page)).toHaveCount(3);
});

test('spend is labelled as the task\'s, not the worker\'s own', async ({ page }) => {
  await openTeam(page, fixture('healthy-parallel-work'));
  await expect(rowOf(page, 'runner_local_1').getByTestId('row-spend')).toContainText('Task spend');
});

test('selecting text in a row does not open the drawer, and a plain click still does', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTeam(page, fixture('healthy-parallel-work'));
  const text = rowOf(page, 'runner_local_1').getByText('Feedback API');
  const box = (await text.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString().length)).toBeGreaterThan(0);
  await expect(drawer(page)).toHaveCount(0);
  await rowOf(page, 'runner_local_1').getByTestId('signal-health').click();
  await expect(drawer(page)).toBeVisible();
});

test('if the opened worker vanishes the drawer closes and focus lands on the main content', async ({ page }) => {
  await openTeam(page, fixture('human-wait'));
  await openWorker(page, 'runner_local_1');
  // The page behind a modal is inert, so a person cannot do this; a new project replacing the snapshot can.
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('#demo-fixture')!;
    select.value = 'expired-approval';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(rowOf(page, 'runner_cloud_1')).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator('#main')).toBeFocused();
});

test('the drawer resizes by pointer, and a cancelled drag stops following the pointer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTeam(page, fixture('human-wait'));
  await openWorker(page, 'runner_local_1');
  const separator = drawer(page).getByRole('separator', { name: 'Drawer width' });
  const width = async (): Promise<number> => (await drawer(page).boundingBox())!.width;
  const startDrag = async (): Promise<number> => {
    const box = (await separator.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, 450);
    await page.mouse.down();
    return box.x + box.width / 2;
  };

  const before = await width();
  const x = await startDrag();
  await page.mouse.move(x - 120, 450, { steps: 4 });
  await page.mouse.up();
  await expect.poll(width).toBeGreaterThan(before + 100);

  for (const event of ['pointercancel', 'lostpointercapture']) {
    const settled = await width();
    const from = await startDrag();
    await separator.dispatchEvent(event);
    await page.mouse.move(from - 200, 450, { steps: 4 });
    await page.mouse.up();
    expect(await width()).toBe(settled);
  }
});

test('an empty project shows no invented workers', async ({ page }) => {
  await openTeam(page, fixture('no-data'));
  await expect(page.getByText('No workers have started')).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('team-summary')).toHaveCount(0);
});

test('with no live source the Team view is honest and shows no roster', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __scenario: unknown }).__scenario = { shell: true };
  });
  await page.goto('/tests/harness/index.html#/team');
  await expect(page.getByText('Project data is unavailable')).toBeVisible();
  await expect(page.getByTestId('demo-badge')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('a view that fails to render is contained and recovers', async ({ page }) => {
  await page.goto('/?demo&fault=corrupt#/team');
  await expect(page.getByRole('heading', { name: 'This view could not load' })).toBeVisible();
  await expect(page.getByTestId('demo-badge')).toBeVisible();
  await page.getByRole('button', { name: 'Restart projection' }).click();
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
});

test('the drawer carries the Demo data label even when it covers the page', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openTeam(page, fixture('human-wait'));
  await openWorker(page, 'runner_local_1');
  await expect(drawer(page).getByTestId('drawer-demo-badge')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the drawer can be maximized and resized by keyboard at desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTeam(page, fixture('human-wait'));
  await openWorker(page, 'runner_local_1');
  const before = (await drawer(page).boundingBox())!.width;
  await drawer(page).getByRole('separator', { name: 'Drawer width' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await drawer(page).boundingBox())!.width).toBeGreaterThan(before);
  await drawer(page).getByRole('button', { name: 'Maximize' }).click();
  await expect.poll(async () => (await drawer(page).boundingBox())!.width).toBe(1440);
  await expect(drawer(page).getByRole('separator')).toHaveCount(0);
});

test('a long worker id and task title wrap at 375', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openTeam(page, fixture('failed-ci'));
  await page.evaluate(() => {
    const long = 'x'.repeat(240);
    document.querySelectorAll('[data-testid="fleet-row"] span, [data-testid="fleet-row"] p').forEach((el) => {
      if (el.children.length === 0) el.textContent = long;
    });
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const id of ['healthy-parallel-work', 'human-wait', 'policy-block', 'runner-loss', 'long-build-stall', 'contract-change', 'failed-ci', 'expired-approval', 'unknown-costs', 'no-data', 'merge-flow']) {
  test(`axe pass: team ${id}`, async ({ page }) => {
    await openTeam(page, fixture(id));
    await expectNoAxeViolations(page);
  });
}

for (const id of ['human-wait', 'runner-loss', 'unknown-costs']) {
  test(`axe pass: open drawer ${id}`, async ({ page }) => {
    await openTeam(page, fixture(id));
    await rows(page).first().locator('[data-open-worker]').click();
    await expect(drawer(page)).toBeVisible();
    await expectNoAxeViolations(page);
  });
}

test('axe pass: drawer light theme and every tab', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('selarikru.theme', 'light'));
  await openTeam(page, fixture('failed-ci'));
  await rows(page).first().locator('[data-open-worker]').click();
  for (const tab of ['Task', 'Timeline', 'Checks', 'Artifacts', 'Permissions', 'Sandbox', 'Usage']) {
    await drawer(page).getByRole('tab', { name: tab }).click();
    await expectNoAxeViolations(page);
  }
});

test('opening a worker opens no terminal channel', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'human-wait' }; });
  await page.goto('/tests/harness/index.html#/team');
  await rows(page).first().locator('[data-open-worker]').click();
  await expect(drawer(page).getByRole('tab', { name: 'Task' })).toHaveAttribute('aria-selected', 'true');
  for (const tab of ['Timeline', 'Checks', 'Artifacts', 'Permissions', 'Sandbox', 'Usage', 'Task']) await drawer(page).getByRole('tab', { name: tab }).click();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  expect(await terminalCalls(page)).toEqual({ opened: 0, closed: 0 });
});

test('selecting Terminal connects and closing disconnects', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'human-wait' }; });
  await page.goto('/tests/harness/index.html#/team');
  await rows(page).first().locator('[data-open-worker]').click();
  expect(await terminalCalls(page)).toEqual({ opened: 0, closed: 0 });

  // Connects, and the channel lands in a state (StrictMode in the harness opens one and discards it, so count the difference).
  await drawer(page).getByRole('tab', { name: 'Terminal' }).click();
  await expect(drawer(page).getByTestId('terminal-panel')).toHaveAttribute('data-status', /live|ended/);
  let calls = await terminalCalls(page);
  expect(calls.opened - calls.closed).toBe(1);

  // Leaving the tab disconnects.
  await drawer(page).getByRole('tab', { name: 'Task' }).click();
  await expect.poll(() => terminalCalls(page).then((c) => c.opened - c.closed)).toBe(0);

  // Back, and then closing the drawer disconnects.
  await drawer(page).getByRole('tab', { name: 'Terminal' }).click();
  await expect(drawer(page).getByTestId('terminal-panel')).toHaveAttribute('data-status', /live|ended/);
  calls = await terminalCalls(page);
  expect(calls.opened - calls.closed).toBe(1);
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => terminalCalls(page).then((c) => c.opened - c.closed)).toBe(0);
});

test('the Terminal tab is read-only and shows the mock as simulated', async ({ page }) => {
  await openTeam(page, fixture('human-wait'));
  await openWorker(page, 'runner_local_1');
  await drawer(page).getByRole('tab', { name: 'Terminal' }).click();
  const panel = drawer(page).getByTestId('terminal-panel');
  await expect(panel).toContainText('Simulated');
  await expect(panel).toContainText('[demo]');
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expect(panel.locator('input, textarea')).toHaveCount(0);
  await expect(panel).toContainText('Read-only');
  await expectNoAxeViolations(page);
});

async function terminalPage(page: Page, terminal: Record<string, unknown>, theme?: 'light'): Promise<void> {
  await page.addInitScript(({ t, l }) => {
    if (l) localStorage.setItem('selarikru.theme', 'light');
    (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'human-wait', terminal: t };
  }, { t: terminal, l: theme === 'light' });
  await page.goto('/tests/harness/index.html#/team');
  await rows(page).first().locator('[data-open-worker]').click();
  await drawer(page).getByRole('tab', { name: 'Terminal' }).click();
  await expect(drawer(page).getByTestId('terminal-panel')).toHaveAttribute('data-status', String(terminal['status']));
}

const LAST_LINE = '2026-11-09T10:15:30.000Z';
const OUTPUT = ['> Bash npm test', 'Running the suite', '[ok]', '3 passed, 0 failed', '[REDACTED] token was in this line'];

for (const [state, terminal, expected] of [
  ['live', { status: 'live', lastLineAt: LAST_LINE, lines: OUTPUT }, 'Live'],
  ['no output', { status: 'live', lines: [] }, 'No output yet'],
  ['ended', { status: 'ended', lastLineAt: LAST_LINE, lines: OUTPUT }, 'Ended'],
  ['disconnected', { status: 'disconnected', reason: 'connection_lost', lastLineAt: LAST_LINE, lines: OUTPUT }, 'Disconnected'],
  ['unavailable', { status: 'unavailable', reason: 'no_channel', lines: [] }, 'no live output to show'],
  ['restricted', { status: 'unavailable', reason: 'restricted', lines: [] }, 'not streamed for restricted'],
] as const) {
  test(`terminal state: ${state}`, async ({ page }) => {
    await terminalPage(page, terminal);
    const panel = drawer(page).getByTestId('terminal-panel');
    await expect(panel).toContainText(expected);
    await expectNoAxeViolations(page);
  });
}

test('terminal: an attempt that is disconnected says when the last line arrived, and a reconnect opens a new channel', async ({ page }) => {
  await terminalPage(page, { status: 'disconnected', reason: 'connection_lost', lastLineAt: LAST_LINE, lines: OUTPUT });
  const panel = drawer(page).getByTestId('terminal-panel');
  await expect(panel.getByTestId('terminal-last-line')).toContainText('2026');
  const before = (await terminalCalls(page)).opened;
  await panel.getByRole('button', { name: 'Reconnect' }).click();
  await expect.poll(async () => (await terminalCalls(page)).opened).toBeGreaterThan(before);
});

test('terminal: worker text is shown as text and never interpreted', async ({ page }) => {
  await terminalPage(page, { status: 'live', lastLineAt: LAST_LINE, lines: ['<img src=x onerror=alert(1)>', '\u001b[31mred\u001b[0m', 'a\u202eb'] });
  const panel = drawer(page).getByTestId('terminal-panel');
  await expect(panel.getByTestId('terminal-line').first()).toHaveText('<img src=x onerror=alert(1)>');
  await expect(panel.locator('img')).toHaveCount(0);
  await expect(panel.getByTestId('terminal-line').nth(1)).toHaveText('red');
  await expect(panel.getByTestId('terminal-line').nth(2)).toHaveText('ab');
  await expect(panel.getByTestId('terminal-output')).toHaveAttribute('aria-live', 'off');
});

test('terminal: dropped lines are shown, and long output keeps the page at 375', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await terminalPage(page, { status: 'live', lastLineAt: LAST_LINE, dropped: 42, lines: ['x'.repeat(900), ...OUTPUT] });
  await expect(drawer(page).getByTestId('terminal-dropped')).toContainText('42 lines were dropped');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoAxeViolations(page);
});

test('terminal: says known formats are hidden, and that older lines were dropped from view', async ({ page }) => {
  await terminalPage(page, { status: 'live', lastLineAt: LAST_LINE, lines: Array.from({ length: 230 }, (_, i) => `line ${i}`) });
  const panel = drawer(page).getByTestId('terminal-panel');
  await expect(panel.getByTestId('terminal-caveat')).toHaveText('Known secret formats are hidden. Other sensitive values may still appear.');
  await expect(panel.getByTestId('terminal-line')).toHaveCount(200);
  await expect(panel.getByTestId('terminal-older-hidden')).toContainText('Showing the latest 200');
  await expectNoAxeViolations(page);
});

test('terminal: new lines do not move the text under someone reading back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await terminalPage(page, { status: 'live', lastLineAt: LAST_LINE, lines: Array.from({ length: 200 }, (_, i) => `line ${i}`) });
  const panel = drawer(page).getByTestId('terminal-panel');
  const output = panel.getByTestId('terminal-output');
  await expect(panel.getByTestId('terminal-line')).toHaveCount(200);
  await output.evaluate((el) => { el.scrollTop = 100; el.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => output.evaluate((el) => el.scrollTop)).toBe(100);
  const firstBefore = await panel.getByTestId('terminal-line').first().textContent();
  await page.evaluate(() => { const w = window as unknown as { __terminalPush: (l: string) => void }; w.__terminalPush('fresh one'); w.__terminalPush('fresh two'); });
  await expect(panel.getByTestId('terminal-held')).toHaveText('Show 2 new lines');
  expect(await panel.getByTestId('terminal-line').first().textContent()).toBe(firstBefore);
  expect(await output.evaluate((el) => el.scrollTop)).toBe(100);
  await panel.getByTestId('terminal-held').click();
  await expect(panel.getByTestId('terminal-line').last()).toHaveText('fresh two');
  await expect(panel.getByTestId('terminal-held')).toHaveCount(0);
});

test('axe pass: terminal light theme', async ({ page }) => {
  await terminalPage(page, { status: 'live', lastLineAt: LAST_LINE, lines: OUTPUT }, 'light');
  await expectNoAxeViolations(page);
});

test('axe pass: reconnecting team', async ({ page }) => {
  await openTeam(page, '&fault=reconnecting');
  await expect(page.getByTestId('connection-banner')).toBeVisible();
  await expectNoAxeViolations(page);
});

const terminalCalls = async (page: Page): Promise<{ opened: number; closed: number }> => {
  const calls = await page.evaluate(() => (window as unknown as { __calls: { commands: { method?: string }[] } }).__calls.commands);
  return { opened: calls.filter((c) => c.method === 'openTerminal').length, closed: calls.filter((c) => c.method === 'terminalClose').length };
};

const SHOTS = process.env['SHOTS_DIR'];
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
const assignmentRow = (page: Page, role: string) => page.locator(`[data-testid="assignment-row"][data-assignment-key="${role}"]`);

test.describe('model assignment', () => {
  test('assignment is recorded on the attempt and shown on the inference badge', async ({ page }) => {
    await openTeam(page, fixture('healthy-parallel-work'));
    const local = rowOf(page, 'runner_local_1');
    await expect(local).toContainText('Local sandbox');
    await expect(local).toContainText('Model in cloud');
    await expect(local.getByTestId('inference-model')).toHaveText('claude-sonnet-5-5');
    await openWorker(page, 'runner_local_1');
    await expect(drawer(page).getByTestId('inference-model')).toHaveText('claude-sonnet-5-5');
  });

  test('a role assignment saves through the command and says it applies to the next attempt', async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'healthy-parallel-work' }; });
    await page.goto('/tests/harness/index.html#/team');
    await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
    const row = assignmentRow(page, 'backend');
    await expect(row.getByTestId('assignment-current')).toHaveText('Using the project default: Sonnet 5.5');
    await expect(row.getByRole('button', { name: 'Save for Backend' })).toBeDisabled();
    await page.getByLabel('Model for Backend').selectOption('claude-haiku-5-5');
    await row.getByRole('button', { name: 'Save for Backend' }).click();
    await expect(row.getByTestId('assignment-feedback')).toContainText('Applies to the next attempt');
    await expect(row.getByTestId('assignment-current')).toContainText('claude-haiku-5-5');
    await row.getByRole('button', { name: 'Use project default' }).click();
    await expect(row.getByTestId('assignment-current')).toHaveText('Using the project default: Sonnet 5.5');
    await expect(page.getByLabel('Model for Backend')).toHaveValue('claude-sonnet-5-5');
    const commands = await page.evaluate(() => (window as unknown as { __calls: { commands: { command: { command: string; args: unknown } }[] } }).__calls.commands);
    expect(commands).toHaveLength(2);
    expect(commands[0]!.command).toMatchObject({ command: 'assignment.set', expectedRevision: 0, args: { scope: 'role', key: 'backend', selection: { provider: 'anthropic', model: 'claude-haiku-5-5' } } });
  });

  test('an unsupported choice is explained and cannot be saved', async ({ page }) => {
    await openTeam(page, fixture('healthy-parallel-work'));
    const row = assignmentRow(page, 'backend');
    await page.getByLabel('Model for Backend').selectOption('claude-opus-5-5');
    await expect(row.getByTestId('assignment-refusal')).toContainText('Policy does not allow');
    await expect(row.getByRole('button', { name: 'Save for Backend' })).toBeDisabled();
    await page.getByLabel('Model for Backend').selectOption('claude-sonnet-5-5');
    await expect(row.getByTestId('assignment-refusal')).toHaveCount(0);
  });

  test('a server refusal is visible and typed', async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'healthy-parallel-work', rejectWith: 'model_not_allowed' }; });
    await page.goto('/tests/harness/index.html#/team');
    await page.getByLabel('Model for Backend').selectOption('claude-haiku-5-5');
    await assignmentRow(page, 'backend').getByRole('button', { name: 'Save for Backend' }).click();
    await expect(assignmentRow(page, 'backend').getByTestId('assignment-feedback')).toContainText('Policy does not allow');
  });

  test('restricted work blocked on a cloud model says so plainly', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'healthy-parallel-work', taskPatch: { 'healthy-parallel-work.api': { placementBlock: 'restricted_requires_device_model:anthropic/claude-sonnet-5-5' } } };
    });
    await page.goto('/tests/harness/index.html#/team');
    await rowOf(page, 'runner_local_1').locator('[data-open-worker="runner_local_1"]').click();
    await expect(drawer(page).getByLabel('Blockers')).toContainText('Only cloud models are available now, so this task cannot run.');
  });

  test('offers no provider that is not installed', async ({ page }) => {
    await openTeam(page, fixture('healthy-parallel-work'));
    await expect(page.getByLabel('Provider for Backend').locator('option')).toHaveText(['Claude']);
    await expect(page.locator('body')).not.toContainText(/codex/i);
  });

  test('says so when no provider is detected', async ({ page }) => {
    await openTeam(page, fixture('no-data'));
    await expect(page.getByTestId('assignment-unavailable')).toContainText('No runner has reported');
    await expect(page.getByLabel(/Model for/)).toHaveCount(0);
  });

  test('the drawer offers a per-task override, and a trial shows its pin', async ({ page }) => {
    await openTeam(page, fixture('healthy-parallel-work'));
    await openWorker(page, 'runner_local_1');
    await expect(drawer(page).getByRole('heading', { name: 'Model override for this task' })).toBeVisible();
    await page.keyboard.press('Escape');
    await openTeam(page, fixture('benchmark-trial'));
    await rows(page).first().locator('[data-open-worker]').click();
    await expect(drawer(page).getByTestId('trial-pin')).toContainText('claude-sonnet-5-5');
    await expect(drawer(page).getByTestId('trial-pin')).toContainText('Overrides are refused');
  });

  test('the provider filter narrows the fleet and keeps unrecorded workers apart', async ({ page }) => {
    await openTeam(page, fixture('unknown-costs'));
    await expect(rows(page)).toHaveCount(3);
    await page.getByLabel('Provider', { exact: true }).selectOption('unknown');
    await expect(rows(page)).toHaveCount(1);
    await expect(rowOf(page, 'runner_cloud_1')).toContainText('Model route unknown');
    await expect(rowOf(page, 'runner_cloud_1')).not.toContainText(/device/i);
    await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByTestId('filter-count')).toHaveText('Showing 2 of 3');
  });

  for (const [width, height] of [[1440, 900], [375, 800]] as const) {
    test(`axe pass and screenshots at ${width}: control, refusal, filter`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openTeam(page, fixture('healthy-parallel-work'));
      await expect(assignmentRow(page, 'backend')).toBeVisible();
      await shot(page, `assignment-control-${width}`);
      await expectNoAxeViolations(page);
      await page.getByLabel('Model for Backend').selectOption('claude-opus-5-5');
      await expect(assignmentRow(page, 'backend').getByTestId('assignment-refusal')).toBeVisible();
      await shot(page, `unsupported-choice-${width}`);
      await expectNoAxeViolations(page);
      await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
      await shot(page, `provider-filter-${width}`);
      await expectNoAxeViolations(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }

  test('axe pass and screenshots in light theme at 1440', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('selarikru.theme', 'light'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTeam(page, fixture('healthy-parallel-work'));
    await expect(assignmentRow(page, 'backend')).toBeVisible();
    await shot(page, 'assignment-control-1440-light');
    await expectNoAxeViolations(page);
    await page.getByLabel('Model for Backend').selectOption('claude-opus-5-5');
    await shot(page, 'unsupported-choice-1440-light');
    await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
    await shot(page, 'provider-filter-1440-light');
    await expectNoAxeViolations(page);
  });

  test('axe pass: drawer with the override control', async ({ page }) => {
    await openTeam(page, fixture('healthy-parallel-work'));
    await openWorker(page, 'runner_local_1');
    await expectNoAxeViolations(page);
  });
});
