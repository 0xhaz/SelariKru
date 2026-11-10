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
  await expect(page.getByRole('img', { name: /^Office for .*: 2 workers\. 1 needs you, 1 working\./ })).toBeVisible();
  await expect(page.getByTestId('office-summary')).toContainText('1 needs you, 1 working');
  // Each robot's colour has its word beside it, on the worker's card.
  await expect(page.locator('[data-testid="team-panel-row"][data-state="needs_you"]')).toContainText('Needs you');
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
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Mission Control/ }).click();
  await page.getByRole('navigation', { name: 'Mission Control' }).getByRole('link', { name: 'Pipeline' }).click();
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
  await spied(page, 'human-wait', '#/overview');
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Team' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
  await page.locator('#main').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Office', level: 1 })).toBeVisible();
});

// Every screen that existed before T5.12 opens from the top bar over the office, and ✕ goes back to it.
const SCREENS = [
  ['Mission Control', 'overview', 'Mission Control', false], ['Team', 'team', 'Team', false], ['Evidence and PR', 'evidence', 'Evidence', false], ['Settings', 'settings', 'Settings', false],
  ['Product', 'product', 'Product', true], ['Brain', 'brain', 'Project Brain', true], ['Benchmark', 'benchmark', 'Benchmark', true],
  ['Assistant', 'assistant', 'The assistant is off in demo mode', true], ['New project', 'onboarding', null, true],
] as const;

test('every screen opens from the top bar over the office, which stays in view, and ✕ goes back to it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  for (const [link, route, heading, inMore] of SCREENS) {
    if (inMore) await nav.getByRole('button', { name: /^More/ }).click();
    // A count can follow the name (Mission Control, 1 decision waiting).
    await nav.getByRole('link', { name: new RegExp(`^${link}`) }).click();
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

test('Mission Control is one drawer with Overview, Pipeline and Decisions as its tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page, 'decision-queue', '#/overview');
  const tabs = page.getByRole('navigation', { name: 'Mission Control' });
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: 'Pipeline' }).click();
  await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible();
  await tabs.getByRole('link', { name: /^Decisions/ }).click();
  await expect(page.getByRole('heading', { name: 'Decisions', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Mission Control/ })).toHaveAttribute('aria-current', 'page');
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

test('the action items entry in the top bar opens the attention queue', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page);
  await page.getByTestId('action-items').click();
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
  await expect(page.getByTestId('attention-item').first()).toBeVisible();
});

test.describe('settings tabs', () => {
  test('the reference tab set, each holding our content or saying exactly what is missing', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spied(page, 'healthy-parallel-work', '#/settings');
    const tabs = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(tabs.getByRole('link')).toHaveText([/^Team/, /Knowledge and skills/, /^Workflow/, /^Stack/, /^MCP/, /^Sandbox/, /^Boards/, /^Project/]);
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
  for (const hash of ['#/office', '#/settings', '#/overview']) {
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
        await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Project' }).click();
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

  test('a screen picked from the More menu is named on the More button, and closing Settings from it focuses More', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await spied(page, 'healthy-parallel-work');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await nav.getByRole('button', { name: /^More/ }).click();
    await nav.getByRole('link', { name: 'Brain' }).click();
    const more = nav.getByRole('button', { name: /^More: Brain/ });
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

