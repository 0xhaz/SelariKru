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
  // The count is unknown too, never a stale "nobody", and the last confirmed count is labelled as such.
  const staleCount = panel(page).getByTestId('team-needs-you');
  await expect(staleCount).toHaveAttribute('data-unknown', '');
  await expect(staleCount.locator('[aria-hidden="true"]')).toHaveText(/^Needs you: unknown \(1 at \d/);
  await expect(staleCount.locator('.sr-only')).toContainText(/Who needs you is unknown while the connection is not live; 1 needed you when last confirmed at \d/);
  await expect(panel(page)).not.toContainText('nobody needs you');
  await shot(page, 'panel-stale-1440');
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByTestId('team-panel-toggle').getByTestId('team-needs-you')).toHaveAttribute('data-unknown', '');
  await expect(page.getByTestId('team-panel-toggle')).toHaveAccessibleName(/needs you unknown\s*;\s*1 when last confirmed/);
  await shot(page, 'panel-stale-375');
  await page.setViewportSize({ width: 1440, height: 900 });

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

/** The session is live, but the worker waiting on a person has health the server reports as unknown, and it was last confirmed as needing you. */
for (const [width, height] of [[1024, 768], [375, 800]] as const) {
  test(`at ${width}, an unknown worker is never summed up as nobody needing you`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await spied(page, { spiedFixture: 'human-wait', workerPatch: { runner_local_1: { health: 'unknown' } } }, 'overview');
    const toggle = page.getByTestId('team-panel-toggle');
    await expect(toggle).toBeVisible();
    if (width >= 1280) await expect(panel(page)).toHaveAttribute('data-variant', 'side');
    await expect(toggle).toHaveAccessibleName(/1 unknown \(last: needs you\)/);
    await expect(toggle).not.toContainText('nobody needs you');
    await expect(toggle.getByTestId('team-needs-you')).toHaveAttribute('data-has-unknown', '');
    if (width === 375) await expect(toggle.getByTestId('team-needs-you').locator('[aria-hidden="true"]')).toHaveText('? 1');
    else await expect(toggle.getByTestId('team-needs-you')).toBeVisible();
    await shot(page, `panel-unknown-${width}`);
    await showPanel(page);
    await expect(panelRow(page, 'runner_local_1')).toHaveAttribute('data-state', 'unknown');
    await expect(panel(page).getByTestId('team-fold-needs-you')).toContainText('1 unknown (last: needs you)');
    await expect(panel(page)).not.toContainText('nobody needs you');
  });
}

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
  await expect(drawer(page).getByRole('heading', { name: 'Cancel this task' })).toBeVisible();
  const stop = drawer(page).getByRole('button', { name: 'Cancel task' });
  await expect(stop).toBeEnabled();
  await stop.click();
  const confirm = page.getByRole('dialog', { name: 'Cancel "Empty states"?' });
  await expect(confirm).toContainText('The running attempt is stopped and the task is cancelled for good.');
  await expect(confirm).toContainText('It is not stopped until the runner confirms.');
  await confirm.getByRole('button', { name: 'Keep the task' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  expect((await commands(page)).filter((c) => c.method === 'execute')).toEqual([]);

  await stop.click();
  await page.getByRole('dialog', { name: /^Cancel/ }).getByRole('button', { name: 'Cancel task' }).click();
  await expect(drawer(page).getByTestId('settings-feedback')).toContainText('Cancel requested');
  const sent = (await commands(page)).filter((c) => c.method === 'execute');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.command).toMatchObject({ command: 'task.cancel', args: { taskId: 'human-wait.ui' } });

  // With the connection not live, Stop is off and says why.
  await page.goto('about:blank');
  await spied(page, { spiedFixture: 'human-wait', fault: 'reconnecting' }, 'overview');
  await panelRow(page, 'runner_cloud_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  await expect(drawer(page).getByRole('button', { name: 'Cancel task' })).toBeDisabled();
  await expect(drawer(page).getByTestId('stop-disabled-reason')).toContainText(/connection/i);
  await expect(drawer(page).getByRole('button', { name: 'Cancel task' })).toHaveAttribute('aria-describedby', /.+/);
});

/** Rewrites the projection's snapshot in place, as a new server snapshot would. */
async function patchSnapshot(page: Page, patch: { task?: [string, Record<string, unknown>]; worker?: [string, Record<string, unknown>]; approvalScope?: string }): Promise<void> {
  await page.evaluate((p) => {
    const store = (window as unknown as { __projection: { getState(): { projection: { snapshot: Record<string, Record<string, Record<string, unknown>>> } }; setState(s: unknown): void } }).__projection;
    const projection = store.getState().projection;
    const snap = { ...projection.snapshot };
    if (p.task) snap['tasks'] = { ...snap['tasks'], [p.task[0]]: { ...snap['tasks']![p.task[0]], ...p.task[1] } };
    if (p.worker) snap['workers'] = { ...snap['workers'], [p.worker[0]]: { ...snap['workers']![p.worker[0]], ...p.worker[1] } };
    if (p.approvalScope) {
      const [id, a] = Object.entries(snap['approvals']!)[0]!;
      snap['approvals'] = { ...snap['approvals'], [id]: { ...a, scopeHash: p.approvalScope } };
    }
    store.setState({ projection: { ...projection, snapshot: snap } });
  }, patch);
}

async function openCancelConfirm(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, { spiedFixture: 'human-wait' }, 'overview');
  await panelRow(page, 'runner_cloud_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  await drawer(page).getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByRole('dialog', { name: 'Cancel "Empty states"?' })).toBeVisible();
}

test('a cancel confirmation is dropped unsent when the task moves to a newer revision under it', async ({ page }) => {
  await openCancelConfirm(page);
  const revision = await page.evaluate(() => (window as unknown as { __projection: { getState(): { projection: { snapshot: { tasks: Record<string, { aggregateRevision: number }> } } } } }).__projection.getState().projection.snapshot.tasks['human-wait.ui']!.aggregateRevision);
  await patchSnapshot(page, { task: ['human-wait.ui', { aggregateRevision: revision + 1 }] });
  await expect(page.getByRole('dialog', { name: /^Cancel/ })).toHaveCount(0);
  await expect(drawer(page).getByTestId('settings-feedback')).toContainText('Nothing was sent');
  expect((await commands(page)).filter((c) => c.method === 'execute')).toEqual([]);
});

test('a cancel confirmation is dropped unsent when the worker moves to another task under it', async ({ page }) => {
  await openCancelConfirm(page);
  await patchSnapshot(page, { worker: ['runner_cloud_1', { taskId: 'human-wait.migrate' }] });
  await expect(page.getByRole('dialog', { name: /^Cancel/ })).toHaveCount(0);
  await expect(drawer(page).getByTestId('settings-feedback')).toContainText('Nothing was sent');
  expect((await commands(page)).filter((c) => c.method === 'execute')).toEqual([]);
});

test('a decision that changes in the drawer is held until reviewed, as on the Decisions screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, { spiedFixture: 'human-wait' }, 'overview');
  await panelRow(page, 'runner_local_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  const card = drawer(page).getByTestId('settings-card');
  // The compact card carries what the full card does: what it is about, the worker's own words under their label, and why.
  await expect(card).toContainText('A worker wants to run a migration that destroys or rewrites data.');
  await expect(card.getByTestId('request-reason')).toHaveAttribute('data-source', 'worker');
  await expect(card.getByTestId('request-reason')).toContainText('worker-supplied');
  await expect(card.getByTestId('advisory')).toContainText('Recorded pause');
  const deny = card.getByRole('button', { name: 'Deny and block task' });
  await expect(deny).toBeEnabled();
  await patchSnapshot(page, { approvalScope: 'moved' });
  await expect(card.getByTestId('request-changed')).toContainText('This request changed');
  await expect(deny).toBeDisabled();
  await expect(card.getByTestId('disabled-reason')).toContainText('Review the update');
  await shot(page, 'drawer-card-held-1440');
  await card.getByRole('button', { name: 'I have reviewed the update' }).click();
  await expect(card.getByTestId('request-changed')).toHaveCount(0);
  await expect(deny).toBeEnabled();
  expect((await commands(page)).filter((c) => c.method === 'execute')).toEqual([]);
});

test('with the panel beside the page, choosing another worker switches the open drawer to it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=human-wait#/pipeline');
  await panelRow(page, 'runner_local_1').click();
  await expect(drawer(page)).toHaveAttribute('data-modal', 'false');
  await expect(drawer(page).getByRole('heading', { name: 'Backend worker' })).toBeVisible();
  await expect(panelRow(page, 'runner_local_1')).toHaveAttribute('aria-current', 'true');
  await panelRow(page, 'runner_cloud_1').click();
  await expect(drawer(page)).toHaveCount(1);
  await expect(drawer(page).getByRole('heading', { name: 'Frontend worker' })).toBeVisible();
  await expect(drawer(page).getByRole('tab', { name: 'Task' })).toBeFocused();
  await expect(panelRow(page, 'runner_cloud_1')).toHaveAttribute('aria-current', 'true');
  expect(new URL(page.url()).hash).toBe('#/pipeline?worker=runner_cloud_1');
  await shot(page, 'drawer-switched-1440');
  // Escape still closes it, and focus goes back to the worker last chosen.
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(panelRow(page, 'runner_cloud_1')).toBeFocused();

  // Narrower, the drawer covers the page and is modal.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByTestId('team-panel-toggle').click();
  await panelRow(page, 'runner_local_1').click();
  await expect(drawer(page)).toHaveAttribute('data-modal', 'true');
});

for (const [width, height] of [[1440, 900], [1280, 800]] as const) {
  test(`beside the panel at ${width}, keyboard focus never lands on anything under the drawer, and Escape closes it from the panel`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/?demo&fixture=human-wait#/overview');
    await panelRow(page, 'runner_local_1').click();
    await expect(drawer(page)).toHaveAttribute('data-modal', 'false');
    // The drawer starts below the header, so no header control is under it.
    const top = await drawer(page).evaluate((d) => d.getBoundingClientRect().top);
    const headerBottom = await page.locator('header').first().evaluate((h) => h.getBoundingClientRect().bottom);
    expect(top).toBeGreaterThanOrEqual(headerBottom - 1);
    const covered = (): Promise<string | null> => page.evaluate(() => {
      const d = document.querySelector('[data-testid="worker-drawer"]')!;
      const a = document.activeElement;
      if (!(a instanceof HTMLElement) || a === document.body || d.contains(a)) return null;
      const r = a.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const name = `${a.tagName} ${a.textContent?.trim().slice(0, 40)}`;
      // Nothing under the point means focus is on something not visible, which is no better than one hidden under the drawer.
      if (hit === null) return `not visible: ${name}`;
      return d.contains(hit) ? name : null;
    });
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 0; i < 45; i += 1) {
        await page.keyboard.press(key);
        expect(await covered(), `${key} ${i}`).toBeNull();
      }
    }
    // The page under the drawer is inert; the panel and the nav are not.
    expect(await page.getByTestId('page-content').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
    // The panel is reachable by the keyboard alone: from the drawer's first control, Shift+Tab arrives at a panel row without any call to focus().
    await drawer(page).getByRole('tab', { name: 'Task' }).focus();
    let onRow = false;
    for (let i = 0; i < 12 && !onRow; i += 1) {
      await page.keyboard.press('Shift+Tab');
      onRow = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'team-panel-row');
    }
    expect(onRow, 'Shift+Tab from the drawer reaches a panel row').toBe(true);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    expect(await page.getByTestId('page-content').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  });
}

test('the folded toggle never says nobody needs you while the team is unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/?demo&fixture=human-wait&fault=unavailable#/pipeline');
  const toggle = page.getByTestId('team-panel-toggle');
  await expect(toggle).toBeVisible();
  const count = toggle.getByTestId('team-needs-you');
  await expect(count).toHaveAttribute('data-status', 'unavailable');
  await expect(toggle).not.toContainText('nobody needs you');
  await expect(count.locator('[aria-hidden="true"]')).toHaveText('?');
  await expect(toggle).toHaveAccessibleName(/^Team\s*unavailable$/);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(count).toBeVisible();
  await expect(count).toContainText('unavailable');
  await expect(toggle).not.toContainText(/\b0\b/);
});

test('the page beside an open drawer is dimmed and says why it does not respond', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=human-wait#/overview');
  const content = page.getByTestId('page-content');
  await expect(content).not.toHaveAttribute('data-paused', 'true');
  await expect(page.getByTestId('page-paused-hint')).toHaveCount(0);
  await panelRow(page, 'runner_local_1').click();
  await expect(drawer(page)).toHaveAttribute('data-modal', 'false');
  await expect(content).toHaveAttribute('data-paused', 'true');
  await expect(page.getByTestId('page-paused-hint')).toContainText('Close the worker to use the page');
  // Dimmed: a scrim covers the page; the pointer there is the default arrow, not a link hand.
  const veil = await content.evaluate((el) => { const a = getComputedStyle(el, '::after'); return { content: a.content, bg: a.backgroundColor }; });
  expect(veil.content).not.toBe('none');
  expect(veil.bg).not.toBe('rgba(0, 0, 0, 0)');
  const box = (await content.boundingBox())!;
  const cursor = await page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x!, y!)!).cursor, [box.x + 40, box.y + 300]);
  expect(cursor).toBe('default');
  await shot(page, 'drawer-paused-page-1440');
  await expect(page.getByTestId('page-paused-hint')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(content).not.toHaveAttribute('data-paused', 'true');

  // The hint sits on the scrim: opening the drawer moves nothing on the page under it, even scrolled.
  const main = page.locator('#main');
  const before = (await main.boundingBox())!;
  await panelRow(page, 'runner_local_1').click();
  await expect(page.getByTestId('page-paused-hint')).toBeVisible();
  expect((await main.boundingBox())!.y).toBe(before.y);
  const hint = (await page.getByTestId('page-paused-hint').boundingBox())!;
  const area = (await content.boundingBox())!;
  expect(hint.x).toBeGreaterThanOrEqual(area.x);
  expect(hint.y).toBeGreaterThanOrEqual(area.y);
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(page.getByTestId('page-paused-hint')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(content).not.toHaveAttribute('data-paused', 'true');
  await expect(page.getByTestId('page-paused-hint')).toHaveCount(0);
});

test('crossing the panel width with the drawer open keeps what is in Settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=healthy-parallel-work#/overview');
  await panelRow(page, 'runner_local_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  const model = drawer(page).getByRole('region', { name: 'Model for this task' }).getByLabel('Model for Feedback API');
  await model.selectOption('claude-haiku-5-5');
  await expect(drawer(page)).toHaveAttribute('data-modal', 'false');
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(drawer(page)).toHaveAttribute('data-modal', 'true');
  await expect(model).toHaveValue('claude-haiku-5-5');
  await expect(drawer(page).getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(drawer(page)).toHaveAttribute('data-modal', 'false');
  await expect(model).toHaveValue('claude-haiku-5-5');
});

test('a card held in the drawer stays held on the Decisions screen through its link', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, { spiedFixture: 'human-wait' }, 'overview');
  await panelRow(page, 'runner_local_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  await patchSnapshot(page, { approvalScope: 'moved' });
  const card = drawer(page).getByTestId('settings-card');
  await expect(card.getByTestId('request-changed')).toBeVisible();
  await card.getByRole('link', { name: 'See the full card in Decisions' }).click();
  await expect(drawer(page)).toHaveCount(0);
  const full = page.getByTestId('decision-card').first();
  await expect(full.getByTestId('request-changed')).toContainText('This request changed');
  await expect(full.getByRole('button', { name: 'Deny and block task' })).toBeDisabled();
  await full.getByRole('button', { name: 'I have reviewed the update' }).click();
  await expect(full.getByRole('button', { name: 'Deny and block task' })).toBeEnabled();
  // Reviewed there, it is released in the drawer too.
  await panelRow(page, 'runner_local_1').click();
  await drawer(page).getByRole('tab', { name: 'Settings' }).click();
  await expect(drawer(page).getByTestId('settings-card').getByTestId('request-changed')).toHaveCount(0);
});

/** Tabs through every control in the drawer once, from its first tab, and fails if focus leaves it or lands on nothing. */
async function tabThroughDrawer(page: Page): Promise<void> {
  const count = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="worker-drawer"]')!;
    const tabbable = [...d.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getClientRects().length > 0);
    tabbable[0]!.focus();
    return tabbable.length;
  });
  expect(count).toBeGreaterThan(3);
  for (let i = 0; i < count - 1; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => { const a = document.activeElement; const d = document.querySelector('[data-testid="worker-drawer"]'); return a !== null && a !== document.body && d !== null && d.contains(a); })).toBe(true);
  }
}

test('drawer keeps focus order and closes on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=human-wait#/overview');
  const opener = panelRow(page, 'runner_local_1');
  await opener.focus();
  await page.keyboard.press('Enter');
  const task = drawer(page).getByRole('tab', { name: 'Task' });
  await expect(task).toBeFocused();
  // Forward from the tabs: the panel, then the drawer's own controls in order.
  await page.keyboard.press('Tab');
  await expect(drawer(page).getByTestId('drawer-panel')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(task).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(new URL(page.url()).hash).toBe('#/overview');

  // Modal at narrower widths: focus stays inside, on a real control, the whole way round.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByTestId('team-panel-toggle').click();
  await panelRow(page, 'runner_local_1').click();
  await expect(drawer(page)).toHaveAttribute('data-modal', 'true');
  await tabThroughDrawer(page);
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);

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

for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [375, 812]] as const) {
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
