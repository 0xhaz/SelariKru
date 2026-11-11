/**
 * T5.12: the office layout. The office canvas is the centre and the default screen, robots are our workers, every screen opens in a drawer
 * over the office from the top bar, Settings has the reference's tab set, and the shortcuts never take a key from text entry.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type Scene = { robotOnScreen(id: string): { x: number; y: number } | null; camera: { zoom: number } };

async function spied(page: Page, fixture = 'human-wait', hash = ''): Promise<void> {
  await page.addInitScript((f) => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: f }; }, fixture);
  await page.goto(`/tests/harness/index.html${hash}`);
}

const drawer = (page: Page) => page.getByTestId('worker-drawer');
const zoom = (page: Page) => page.evaluate(() => (window as unknown as { __selarikruOffice: Scene }).__selarikruOffice.camera.zoom);

test('the office is the default screen: a labelled picture of the team, with its words beside it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page);
  await expect(page.getByRole('heading', { name: 'Office', level: 1 })).toBeVisible();
  await expect(page).toHaveTitle('Office · SelariKru');
  // No drawer is open: the office is the whole screen, with the top bar, the team cards and the activity feed floating over it.
  await expect(page.getByTestId('view-drawer')).toHaveCount(0);
  await expect(page.getByRole('img', { name: /^Office for .*: 2 workers\. 1 needs input, 1 working\./ })).toBeVisible();
  await expect(page.getByTestId('office-summary')).toContainText('1 needs input, 1 working');
  // Each robot's colour has its word beside it, on the worker's card.
  await expect(page.locator('[data-testid="team-panel-row"][data-state="needs_you"]')).toContainText('Needs input');
  await expect(page.locator('[data-testid="team-panel-row"][data-state="working"]')).toContainText('Working');
  await expect(page.getByTestId('activity-item').first()).toBeVisible();
  // The reference's floating layout: the top bar and the team column sit over the office, not beside it.
  const bar = (await page.getByTestId('top-bar').boundingBox())!;
  expect([Math.round(bar.x), Math.round(bar.y), Math.round(bar.height)]).toEqual([16, 10, 50]);
  const team = (await page.getByTestId('team-panel').boundingBox())!;
  expect([Math.round(team.x), Math.round(team.y), Math.round(team.width)]).toEqual([16, 74, 280]);
  const feed = (await page.getByTestId('activity-feed').boundingBox())!;
  expect([Math.round(feed.width), Math.round(feed.height)]).toEqual([280, 220]);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});

test('clicking a robot opens that worker\'s drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page);
  const at = await expect.poll(() => page.evaluate(() => (window as unknown as { __selarikruOffice?: Scene }).__selarikruOffice?.robotOnScreen('runner_cloud_1') ?? null)).not.toBeNull().then(() =>
    page.evaluate(() => (window as unknown as { __selarikruOffice: Scene }).__selarikruOffice.robotOnScreen('runner_cloud_1')!));
  await page.mouse.click(at.x, at.y);
  await expect(drawer(page)).toBeVisible();
  await expect(page).toHaveURL(/worker=runner_cloud_1/);
  await expect(drawer(page).getByRole('tab', { name: 'Terminal' })).toBeVisible();
});

test('1 to 9 open the worker at that place in the team panel; Escape closes it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page);
  const first = await page.getByTestId('team-panel-row').first().getAttribute('data-panel-worker');
  // Ready once the office has drawn its first world: the shell's key handling is in place before that.
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __selarikruOffice?: { world: unknown } }).__selarikruOffice?.world))).toBe(true);
  await page.keyboard.press('1');
  await expect(drawer(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`worker=${first}`));
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  // With a drawer open the digits belong to it: 2 does not swap workers under the person.
  await page.keyboard.press('2');
  await expect(drawer(page)).toBeVisible();
  const second = await page.getByTestId('team-panel-row').nth(1).getAttribute('data-panel-worker');
  await expect(page).toHaveURL(new RegExp(`worker=${second}`));
  await page.keyboard.press('1');
  await expect(page).toHaveURL(new RegExp(`worker=${second}`));
});

test('+ and - zoom the office, and only on the office', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page);
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __selarikruOffice?: Scene }).__selarikruOffice))).toBe(true);
  const before = await zoom(page);
  await page.keyboard.press('+');
  await expect.poll(() => zoom(page)).toBeGreaterThan(before);
  await page.keyboard.press('-');
  await expect.poll(() => zoom(page)).toBe(before);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(() => zoom(page)).toBeGreaterThan(before);
  await page.getByTestId('top-bar-boards').click();
  await page.getByRole('link', { name: 'Pipeline' }).click();
  await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible();
  const onPipeline = await zoom(page);
  await page.keyboard.press('-');
  await page.keyboard.press('1');
  await expect(drawer(page)).toBeVisible();
  expect(await zoom(page)).toBe(onPipeline);
});

test('no shortcut takes a key typed into a field', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'healthy-parallel-work', '#/settings?section=stack');
  const search = page.locator('#main').getByRole('combobox').first();
  await search.click();
  await page.keyboard.type('1-');
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/#\/settings\?section=stack$/);
});

test('Escape on the page goes back to the office; on a control it does nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'human-wait', '#/summary');
  await expect(page.getByRole('heading', { name: 'Run summary', level: 1 })).toBeVisible();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'PRs' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Run summary', level: 1 })).toBeVisible();
  await page.locator('#main').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Office', level: 1 })).toBeVisible();
});

// Every screen opens from the top bar over the office, and ✕ goes back to it. The template arrangement (owner, T5.12): Action items is one
// drawer; Boards holds Pipeline, Run summary, Product, Brain and Benchmark; PRs is Evidence and pull requests; Settings' menu holds Team,
// the Assistant and New project. Each screen appears exactly once.
const SCREENS = [
  [null, 'Action items', 'actions', 'Action items'],
  ['Boards', 'Pipeline', 'pipeline', 'Pipeline'], ['Boards', 'Run summary', 'summary', 'Run summary'], ['Boards', 'Product', 'product', 'Product'], ['Boards', 'Brain', 'brain', 'Project Brain'], ['Boards', 'Benchmark', 'benchmark', 'Benchmark'],
  [null, 'PRs', 'evidence', 'Evidence'], [null, 'Settings', 'settings', 'Settings'],
  ['Settings', 'Team fleet', 'team', 'Team'], ['Settings', 'Assistant', 'assistant', 'The assistant is off in demo mode'], ['Settings', 'New project', 'onboarding', null],
] as const;

test('every screen opens from the top bar\'s menus over the office, which stays in view, and ✕ goes back to it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  for (const [menu, link, route, heading] of SCREENS) {
    if (menu === 'Settings') {
      await nav.getByRole('link', { name: 'Settings', exact: true }).click();
      await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: link, exact: true }).click();
    } else {
      if (menu) await nav.getByRole('button', { name: new RegExp(`^${menu}`) }).click();
      await nav.getByRole('link', { name: new RegExp(`^${link}`) }).click();
    }
    await expect(page.getByTestId('view-drawer')).toHaveAttribute('data-view', route);
    if (heading) await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expect(page.locator('#main')).toBeFocused();
    // The office is still drawn behind, and hidden from assistive technology while a drawer is in front.
    await expect(page.getByTestId('office-canvas')).toBeVisible();
    await expect(page.getByRole('img', { name: /^Office for/ })).toHaveCount(0);
    if (route === 'settings') {
      // Settings is the centred modal; everything else is inert while it is open.
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('aria-modal', 'true');
      expect(await page.getByTestId('top-bar').evaluate((el) => el.closest('[inert]') !== null)).toBe(true);
    } else {
      // A side drawer: the team cards stay usable beside it.
      await expect(page.getByTestId('team-panel')).toBeVisible();
    }
    await page.getByTestId('view-drawer-close').click();
    await expect(page.getByTestId('view-drawer')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Office', level: 1 })).toHaveCount(1);
  }
});

test('the top bar matches the reference: mark and name, Demo data, project, plan wall, demo speed, zoom, sandbox count and the main menus', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await spied(page, 'human-wait');
  const bar = page.getByTestId('top-bar');
  await expect(bar).toContainText('SelariKru');
  await expect(bar.getByTestId('demo-badge')).toHaveText('Demo data');
  await expect(bar.getByRole('combobox', { name: 'Run shown on the plan wall' })).toBeVisible();
  await expect(bar.getByRole('group', { name: /speed/ }).getByRole('button')).toHaveText(['1x', '2x', '4x']);
  // Counted from attempts with no end that a worker holds: in this fixture one is still open.
  await expect(bar.getByTestId('sandbox-chip')).toHaveText(/^Sandbox · 1 running$/);
  const nav = bar.getByRole('navigation', { name: 'Primary' });
  await expect(nav.locator(':scope > *')).toHaveText([/^Action items/, /^Boards/, 'PRs', /^Terminal/, 'Settings', 'Debug']);
  // Terminal with no worker chosen lets you pick one; picking opens that worker's Terminal tab.
  await nav.getByRole('button', { name: 'Terminal' }).click();
  await nav.getByRole('link', { name: /terminal$/ }).first().click();
  await expect(page.getByTestId('worker-drawer').getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  // Debug (development builds only) opens the debug panel.
  await page.keyboard.press('Escape');
  await nav.getByRole('button', { name: 'Debug' }).click();
  await expect(page.getByTestId('debug-panel')).toBeVisible();
});

test('the plan wall select chooses the run on the plan wall and its banner', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await spied(page, 'human-wait');
  const select = page.getByRole('combobox', { name: 'Run shown on the plan wall' });
  await expect(select).toBeVisible();
  const runs = await select.locator('option').allTextContents();
  expect(runs[0]).toBe('Current run');
  expect(runs.length).toBeGreaterThan(1);
  await select.selectOption({ index: 1 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __selarikruOffice: { world: { planRunId: string | null } } }).__selarikruOffice.world.planRunId)).not.toBeNull();
});

test('in live mode the demo speed buttons are not shown', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'human-wait', observed: true }; });
  await page.goto('/tests/harness/index.html');
  await expect(page.getByTestId('top-bar')).toBeVisible();
  await expect(page.getByRole('group', { name: /speed/ })).toHaveCount(0);
  await expect(page.getByTestId('demo-badge')).toHaveCount(0);
});

test('Action items is one button and one drawer: what workers ask first, then everything else waiting on you', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'decision-queue');
  const button = page.getByTestId('action-items');
  await expect(button).toHaveText(/^Action items · \d+/);
  await expect(button).not.toHaveAttribute('aria-expanded', /.*/);
  await button.click();
  await expect(page.getByRole('heading', { name: 'Action items', level: 1 })).toBeVisible();
  await expect(page.getByTestId('view-drawer-aside')).toHaveText(/^\d+ waiting on you$/);
  const workers = page.getByTestId('from-workers');
  await expect(workers.getByRole('heading', { name: 'From workers' })).toBeVisible();
  await expect(workers.getByTestId('decision-card').first()).toHaveAttribute('data-kind', 'approval');
  await expect(workers.getByTestId('card-worker').first()).toContainText('From ');
  // Everything else waiting on you is a compact row with its primary action; a budget stop is one.
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'budget-stop' }; });
  await page.goto('about:blank');
  await page.goto('/tests/harness/index.html#/actions');
  const also = page.getByTestId('also-waiting');
  await expect(also.getByRole('heading', { name: 'Also waiting on you' })).toBeVisible();
  // A compact row: one line and its primary action; the full card opens on request with the rest.
  const row = also.getByTestId('action-row').first();
  await expect(row.getByRole('button', { name: /^Details/ })).toHaveAttribute('aria-expanded', 'false');
  await row.getByRole('button', { name: /^Details/ }).click();
  await expect(also.getByTestId('decision-card').first()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Action items/ })).toHaveAttribute('aria-current', 'page');
});

test('with nothing waiting, the drawer says so', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'healthy-parallel-work', '#/actions');
  await expect(page.getByTestId('decisions-empty')).toContainText('Nothing is waiting on you.');
});

test('the side drawer can be maximised and resized, and keeps its width in this browser', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'human-wait', '#/team');
  const d = page.getByTestId('view-drawer');
  const before = (await d.boundingBox())!;
  await page.getByRole('button', { name: 'Maximize' }).click();
  await expect.poll(async () => (await d.boundingBox())!.x).toBe(16);
  await page.getByRole('button', { name: 'Restore size' }).click();
  await expect.poll(async () => Math.round((await d.boundingBox())!.width)).toBe(Math.round(before.width));
  const handle = (await page.getByTestId('drawer-resize').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 200, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await d.boundingBox())!.width)).toBe(Math.round(before.width) - 200);
  expect(Number(await page.evaluate(() => localStorage.getItem('selarikru.drawerWidth')))).toBe(Math.round(before.width) - 200);
});

test.describe('settings tabs', () => {
  test('the reference tab set, each holding our content or saying exactly what is missing', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spied(page, 'healthy-parallel-work', '#/settings');
    const tabs = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(tabs.getByRole('link')).toHaveText([/^Team/, /Knowledge and skills/, /^Workflow/, /^Stack/, /^MCP/, /^Sandbox/, /^Boards/, /^Project/, 'Team fleet', 'Assistant', 'New project']);
    // Team: workers, models and Bounded autonomy, with the same controls Overview has.
    await expect(tabs.getByRole('link', { name: 'Team', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('settings-workers').getByRole('listitem')).toHaveCount(2);
    await expect(page.getByTestId('bounded-autonomy')).toBeVisible();
    await page.getByTestId('settings-workers').getByRole('button', { name: /Open settings/ }).first().click();
    await expect(drawer(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);

    await tabs.getByRole('link', { name: 'Knowledge and skills' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Knowledge and skills' })).toBeVisible();
    await tabs.getByRole('link', { name: 'Workflow', exact: true }).click();
    await expect(page.locator('#main')).toContainText('Human merge on GitHub. Agents never merge.');
    await tabs.getByRole('link', { name: 'Stack', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Stack' })).toBeVisible();
    await tabs.getByRole('link', { name: 'MCP', exact: true }).click();
    await expect(page.getByTestId('settings-mcp-missing')).toContainText('No MCP connections yet. Connectors are not built.');
    await tabs.getByRole('link', { name: 'Sandbox', exact: true }).click();
    await expect(page.getByTestId('settings-sandbox-missing')).toContainText('not reported');
    await tabs.getByRole('link', { name: 'Boards', exact: true }).click();
    await expect(page.getByTestId('settings-boards-missing')).toContainText('No Feedback Board is linked');
    await tabs.getByRole('link', { name: 'Project', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Product brief and roadmap' })).toHaveAttribute('href', '#/product');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });

  test('the font style is chosen in Project, applies at once, and is kept in this browser', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spied(page, 'healthy-parallel-work', '#/settings?section=project');
    await expect(page.locator('html')).not.toHaveAttribute('data-font', /.+/);
    await page.getByRole('radio', { name: /Clean/ }).check();
    await expect(page.locator('html')).toHaveAttribute('data-font', 'clean');
    expect(await page.evaluate(() => localStorage.getItem('selarikru.font'))).toBe('clean');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-font', 'clean');
    await expect(page.getByRole('radio', { name: /Clean/ })).toBeChecked();
    await page.getByRole('radio', { name: /Pixel/ }).check();
    await expect(page.locator('html')).not.toHaveAttribute('data-font', /.+/);
  });
});

test('no storage key, event name or visible text uses the reference\'s names', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'healthy-parallel-work', '#/settings?section=project');
  await page.getByRole('radio', { name: /Mono/ }).check();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.every((k) => k.startsWith('selarikru.'))).toBe(true);
  for (const hash of ['#/office', '#/settings', '#/summary', '#/actions']) {
    await page.goto(`/tests/harness/index.html${hash}`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toMatch(/jsm|javascript mastery/i);
  }
});

test.describe('closing Settings', () => {
  for (const how of ['Escape on the modal', 'Escape on its main region', 'the close button', 'the backdrop'] as const) {
    test(`${how} closes Settings and gives focus back to the button that opened it`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await spied(page, 'healthy-parallel-work');
      const opener = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings' });
      await opener.focus();
      await page.keyboard.press('Enter');
      const modal = page.getByRole('dialog', { name: 'Settings' });
      await expect(modal).toBeVisible();
      if (how === 'Escape on the modal') { await modal.focus(); await page.keyboard.press('Escape'); }
      else if (how === 'Escape on its main region') { await expect(page.locator('#main')).toBeFocused(); await page.keyboard.press('Escape'); }
      else if (how === 'the close button') await page.getByRole('link', { name: 'Close settings' }).click();
      else await page.mouse.click(8, 450);
      await expect(modal).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Office', level: 1 })).toHaveCount(1);
      await expect(opener).toBeFocused();
    });
  }

  test('a link from Settings to another screen moves focus to that screen\'s main region, not back to the opener', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spied(page, 'healthy-parallel-work');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    for (const [link, view] of [['Open the Team screen', 'team'], ['Product brief and roadmap', 'product']] as const) {
      if (view === 'product') {
        await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings' }).click();
        await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Project', exact: true }).click();
      }
      await page.getByRole('link', { name: link }).click();
      await expect(page.getByTestId('view-drawer')).toHaveAttribute('data-view', view);
      await expect(page.locator('#main')).toBeFocused();
    }
  });

  test('a control inside Settings keeps its own Escape, and Settings stays open', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spied(page, 'healthy-parallel-work', '#/settings?section=stack');
    const search = page.locator('#main').getByRole('combobox').first();
    await search.click();
    await page.keyboard.type('re');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expect(search).toBeFocused();
    // A button inside is a control too: Escape there does nothing.
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'MCP' }).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  });

  test('a screen picked from a menu is named on that menu\'s button, which carries aria-current', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spied(page, 'healthy-parallel-work');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await nav.getByRole('button', { name: /^Boards/ }).click();
    await nav.getByRole('link', { name: 'Brain' }).click();
    const more = nav.getByRole('button', { name: /^Boards: Brain/ });
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('aria-current', 'page');
  });
});

test('the office stops animating while it cannot be seen, and follows a change of the reduced-motion preference', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await spied(page, 'healthy-parallel-work', '#/team');
  const looping = () => page.evaluate(() => { const o = (window as unknown as { __selarikruOffice?: { raf: number } }).__selarikruOffice; return o ? o.raf !== 0 : null; });
  await expect.poll(looping).toBe(true);
  await page.getByRole('button', { name: 'Maximize' }).click();
  await expect.poll(looping).toBe(false);
  await page.getByRole('button', { name: 'Restore size' }).click();
  await expect.poll(looping).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(looping).toBe(false);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(looping).toBe(true);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings' }).click();
  await expect.poll(looping).toBe(false);
});


test('the worker drawer follows the reference: identity line with the reported coding agent, session bar, activity, and its tabs in order', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'human-wait', '#/office?worker=runner_local_1');
  const d = page.getByTestId('worker-drawer');
  await expect(d.getByRole('tab')).toHaveText(['Terminal', 'Shell', 'Task', 'Sandbox', 'Messages', 'Settings']);
  // Read-only: the coding agent and model as the runner reports them, then the runtime. Nothing here is a picker.
  await expect(d.getByTestId('drawer-identity')).toHaveText(/^Backend · .+ claude-sonnet-5-5 · (Local|Cloud) sandbox$/);
  await expect(d.getByTestId('drawer-state-chip')).toHaveText('Needs input');
  await expect(d.getByTestId('drawer-session')).toContainText(/Session running|Stopped|Idle/);
  await expect(d.getByTestId('drawer-activity')).not.toBeEmpty();
  await expect(d.getByRole('combobox', { name: /Coding agent/ })).toHaveCount(0);
  // Its requests are in Messages, linked to their cards in Action items.
  await d.getByRole('tab', { name: 'Messages' }).click();
  await expect(d.getByTestId('drawer-messages').getByRole('link', { name: 'Open in Action items' }).first()).toBeVisible();
});

test('"Cancel task…" in the session bar says where it leads, and lands on the existing cancel control or its heading', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'healthy-parallel-work', '#/office?worker=runner_local_1');
  const d = page.getByTestId('worker-drawer');
  await expect(d.getByTestId('drawer-session')).toContainText('Session running');
  const button = d.getByRole('button', { name: 'Cancel task…' });
  await expect(button).toHaveAccessibleDescription('Opens Settings, where you can cancel this task.');
  await button.click();
  await expect(d.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
  // Focus is in the Cancel this task section: its button when it can take focus, else the section's heading.
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="settings-stop"]')))).toBe(true);
  const cancel = d.getByTestId('settings-stop').locator('[data-action]');
  if (await cancel.count()) await expect(cancel).toHaveAccessibleDescription(/Cancelling stops the running attempt/);
});

test.describe('H7 fix: errands and effects follow real events, with motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' });
  type Live = { world: { cues: { agentId: string; needsYou: boolean }[]; agents: { id: string; state: string }[] }; recentEvents: { kind: string; agentId?: string }[]; bots: Map<string, { x: number; y: number; queue: { current(): unknown } }>; effectCount: number; setWorld(w: unknown): void };

  test('a claim in the demo script sends that worker to the PLAN table: it walks, and only after the event', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spied(page, 'human-wait');
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __selarikruOffice?: Live }).__selarikruOffice?.world))).toBe(true);
    let claimed: string | null = null;
    for (let i = 0; i < 12 && claimed === null; i++) {
      await page.evaluate(() => (window as unknown as { __advance: (ms: number) => void }).__advance(15_000));
      claimed = await page.evaluate(() => (window as unknown as { __selarikruOffice: Live }).__selarikruOffice.recentEvents.find((e) => e.kind === 'claimed')?.agentId ?? null);
    }
    expect(claimed).not.toBeNull();
    const where = () => page.evaluate((id) => { const b = (window as unknown as { __selarikruOffice: Live }).__selarikruOffice.bots.get(id!)!; return { x: Math.round(b.x), y: Math.round(b.y), errand: b.queue.current() !== null }; }, claimed);
    const start = await where();
    await expect.poll(async () => { const now = await where(); return now.x !== start.x || now.y !== start.y; }, { timeout: 10_000 }).toBe(true);
  });

  test('a worker that starts needing you sends an envelope to the shop front', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spied(page, 'healthy-parallel-work');
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __selarikruOffice?: Live }).__selarikruOffice?.world))).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __selarikruOffice: Live }).__selarikruOffice.effectCount)).toBe(0);
    await page.evaluate(() => {
      const s = (window as unknown as { __selarikruOffice: Live }).__selarikruOffice;
      const w = s.world;
      const id = w.cues[0]!.agentId;
      s.setWorld({ ...w, cues: w.cues.map((c) => (c.agentId === id ? { ...c, needsYou: true } : c)), agents: w.agents.map((a) => (a.id === id ? { ...a, state: 'needs_input' } : a)) });
    });
    expect(await page.evaluate(() => (window as unknown as { __selarikruOffice: Live }).__selarikruOffice.recentEvents.map((e) => e.kind))).toContain('needsYou');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __selarikruOffice: Live }).__selarikruOffice.effectCount)).toBeGreaterThan(0);
  });
});

test.describe('H7 fix round 2: a new epoch invents no events', () => {
  test.use({ reducedMotion: 'no-preference' });
  type Live = { world: { epoch: string; cues: { agentId: string; needsYou: boolean; attemptId: string | null; attemptRunning: boolean }[]; agents: { id: string; state: string }[] }; recentEvents: unknown[]; effectCount: number; setWorld(w: unknown): void };
  test('when the demo loop wraps or the fixture switches, the scene starts afresh: no walk and no effect is dispatched', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spied(page, 'healthy-parallel-work');
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __selarikruOffice?: Live }).__selarikruOffice?.world))).toBe(true);
    const out = await page.evaluate(() => {
      const s = (window as unknown as { __selarikruOffice: Live }).__selarikruOffice;
      const w = s.world;
      const id = w.cues[0]!.agentId;
      // Everything a fresh projection could differ in: a new attempt, a worker that needs you, a new epoch.
      s.setWorld({ ...w, epoch: `${w.epoch}-next`, cues: w.cues.map((c) => (c.agentId === id ? { ...c, needsYou: true, attemptId: 'brand-new', attemptRunning: true } : c)), agents: w.agents.map((a) => (a.id === id ? { ...a, state: 'needs_input' } : a)) });
      return { events: s.recentEvents.length, effects: s.effectCount };
    });
    expect(out).toEqual({ events: 0, effects: 0 });
  });
});

test('H7 fix round 2: the demo plays at 1x and pauses when reduced motion turns on during the session', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=human-wait#/office');
  await expect(page.getByTestId('demo-play')).toHaveText('Pause');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByTestId('demo-play')).toHaveText('Play');
});
