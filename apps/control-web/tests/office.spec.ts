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
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Office' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('img', { name: /^Office for .*: 2 workers\. 1 needs you, 1 working\./ })).toBeVisible();
  await expect(page.getByTestId('office-summary')).toContainText('1 needs you, 1 working');
  // Each colour in the key carries its word.
  await expect(page.getByTestId('office-legend')).toContainText('Needs you');
  await expect(page.getByTestId('office-legend')).toContainText('Working');
  await expect(page.getByTestId('activity-item').first()).toBeVisible();
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
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Pipeline' }).click();
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
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Pipeline' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
  await page.locator('#main').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Office', level: 1 })).toBeVisible();
});

// Every screen that existed before T5.12 opens from the top bar in a drawer over the office, and the drawer's Office link goes back.
const SCREENS = [
  ['Overview', 'overview', 'Mission Control'], ['Pipeline', 'pipeline', 'Pipeline'], ['Decisions', 'decisions', 'Decisions'], ['Team', 'team', 'Team'],
  ['Evidence and PR', 'evidence', 'Evidence'], ['Product', 'product', 'Product'], ['Brain', 'brain', 'Project Brain'], ['Benchmark', 'benchmark', 'Benchmark'],
  ['Assistant', 'assistant', 'The assistant is off in demo mode'], ['Settings', 'settings', 'Settings'],
] as const;

test('every screen opens from the top bar in a drawer over the office, and Office goes back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spied(page);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  for (const [link, route, heading] of SCREENS) {
    // A count can follow the name (Decisions, 1 waiting).
    await nav.getByRole('link', { name: new RegExp(`^${link}`) }).click();
    await expect(page.getByTestId('view-drawer')).toHaveAttribute('data-view', route);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expect(page.locator('#main')).toBeFocused();
    // The office is behind the drawer, hidden from assistive technology there.
    await expect(page.getByRole('img', { name: /^Office for/ })).toHaveCount(0);
  }
  await nav.getByRole('link', { name: 'New project', exact: true }).click();
  await expect(page.getByTestId('view-drawer')).toHaveAttribute('data-view', 'onboarding');
  await page.getByTestId('view-drawer-close').click();
  await expect(page.getByRole('heading', { name: 'Office', level: 1 })).toBeVisible();
  await expect(page.getByTestId('view-drawer')).toHaveCount(0);
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
    await expect(page.getByRole('main')).toContainText('Human merge on GitHub. Agents never merge.');
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
