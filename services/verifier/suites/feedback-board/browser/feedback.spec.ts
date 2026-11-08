import { expect, test as base, type Page } from '@playwright/test';
import { api, AppUnderTest } from '../lib/harness.ts';

type Fixtures = { seeded: AppUnderTest; empty: AppUnderTest };

/** Fresh process + fresh SQLite file for every test. */
const test = base.extend<Fixtures>({
  seeded: async ({}, use) => {
    const app = new AppUnderTest({ seed: true });
    await app.start();
    try {
      await use(app);
    } finally {
      await app.stop();
    }
  },
  empty: async ({}, use) => {
    const app = new AppUnderTest({ seed: false });
    await app.start();
    try {
      await use(app);
    } finally {
      await app.stop();
    }
  },
});

const ui = (page: Page) => ({
  title: page.getByRole('textbox', { name: 'Title', exact: true }),
  description: page.getByRole('textbox', { name: 'Description', exact: true }),
  submit: page.getByRole('button', { name: 'Submit feedback', exact: true }),
  list: page.getByRole('list', { name: 'Feedback list', exact: true }),
  items: page.getByRole('list', { name: 'Feedback list', exact: true }).getByRole('listitem'),
  filters: page.getByRole('group', { name: 'Filter by status', exact: true }),
  filter: (label: 'All' | 'Open' | 'Planned' | 'Done', n?: number) =>
    page
      .getByRole('group', { name: 'Filter by status', exact: true })
      .getByRole('button', { name: n === undefined ? new RegExp(`^${label}\\s+\\d+$`) : `${label} ${n}`, exact: n !== undefined }),
  item: (title: string) =>
    page.getByRole('list', { name: 'Feedback list', exact: true }).getByRole('listitem').filter({ hasText: title }),
  alert: page.getByRole('alert'),
  status: page.getByRole('status'),
});

async function add(page: Page, title: string, description?: string) {
  const u = ui(page);
  await u.title.fill(title);
  if (description !== undefined) await u.description.fill(description);
  await u.submit.click();
}

async function expectCounts(page: Page, all: number, open: number, planned: number, done: number) {
  const u = ui(page);
  await expect(u.filter('All', all)).toBeVisible();
  await expect(u.filter('Open', open)).toBeVisible();
  await expect(u.filter('Planned', planned)).toBeVisible();
  await expect(u.filter('Done', done)).toBeVisible();
}

const titlesInOrder = async (page: Page) => (await ui(page).items.allTextContents()).map((t) => t);

test('FB-01 create: submitting the form shows the saved, trimmed item and persists it', async ({ page, empty }) => {
  await page.goto(empty.url);
  await add(page, '  Browser created  ', '  from the form  ');
  const card = ui(page).item('Browser created');
  await expect(card).toBeVisible();
  await expect(card).toContainText('from the form');
  await expect(ui(page).items).toHaveCount(1);
  const list = await api(empty).list();
  expect(list.body.items).toHaveLength(1);
  expect(list.body.items[0].title).toBe('Browser created');
  expect(list.body.items[0].description).toBe('from the form');
  expect(list.body.items[0].status).toBe('open');
  await expectCounts(page, 1, 1, 0, 0);
});

test('FB-02 reject: invalid titles show a readable error and nothing is saved', async ({ page, empty }) => {
  await page.goto(empty.url);
  const u = ui(page);
  for (const bad of ['ab', '   ', 'a'.repeat(121)]) {
    await page.reload(); // fresh page: a previous alert must not satisfy the next assertion
    await expect(u.title).toBeVisible();
    await expect(u.alert).toHaveCount(0);
    await u.title.fill(bad);
    await u.submit.click();
    await expect(u.alert.first()).toBeVisible();
    await expect(u.alert.first()).toContainText(/title/i);
    expect(((await u.alert.first().textContent()) ?? '').trim().length).toBeGreaterThan(5);
    await expect(u.items).toHaveCount(0);
    expect((await api(empty).list()).body.counts.all).toBe(0);
    // the form must stay usable after a rejection
    await expect(u.title).toBeEnabled();
    await expect(u.description).toBeEnabled();
    await expect(u.submit).toBeEnabled();
  }
  // still on the page that just showed a rejection: a valid submission must succeed and clear the error
  await u.title.fill('Valid after rejections');
  await u.submit.click();
  await expect(u.item('Valid after rejections')).toBeVisible();
  await expect(u.alert).toHaveCount(0);
  expect((await api(empty).list()).body.counts.all).toBe(1);
});

test('FB-03 order: seeded items render newest first with the id tie-break', async ({ page, seeded }) => {
  await page.goto(seeded.url);
  const u = ui(page);
  await expect(u.items).toHaveCount(3);
  const texts = await titlesInOrder(page);
  expect(texts[0]).toContain('Improve form labels');
  expect(texts[1]).toContain('Export feedback');
  expect(texts[2]).toContain('Add dark mode');
});

test('FB-04 status: changing the status selector persists across reload', async ({ page, seeded }) => {
  await page.goto(seeded.url);
  const u = ui(page);
  const card = u.item('Add dark mode');
  await expect(card.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('open');
  await card.getByRole('combobox', { name: 'Status', exact: true }).selectOption('planned');
  await expectCounts(page, 3, 0, 2, 1);
  const patched = (await api(seeded).list()).body.items.find((i: any) => i.id === 'fb_001');
  expect(patched.status).toBe('planned');
  await page.reload();
  await expect(u.item('Add dark mode').getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('planned');
});

test('FB-05 filter: filters narrow the list while counts stay global and update after changes', async ({ page, seeded }) => {
  await page.goto(seeded.url);
  const u = ui(page);
  await expectCounts(page, 3, 1, 1, 1);
  await u.filter('Planned').click();
  await expect(u.filter('Planned')).toHaveAttribute('aria-pressed', 'true');
  await expect(u.items).toHaveCount(1);
  await expect(u.item('Export feedback')).toBeVisible();
  await expectCounts(page, 3, 1, 1, 1);
  await u.filter('Done').click();
  await expect(u.items).toHaveCount(1);
  await expect(u.item('Improve form labels')).toBeVisible();
  await expectCounts(page, 3, 1, 1, 1);
  await u.filter('All').click();
  await expect(u.items).toHaveCount(3);
  // create while "Open" is selected: counts update, list stays filtered
  await u.filter('Open').click();
  await add(page, 'Filter creation');
  await expectCounts(page, 4, 2, 1, 1);
  await expect(u.items).toHaveCount(2);
  // move one open item to done: counts update and the item leaves the Open view
  await u.item('Filter creation').getByRole('combobox', { name: 'Status', exact: true }).selectOption('done');
  await expectCounts(page, 4, 1, 1, 2);
  await expect(u.items).toHaveCount(1);
  await u.filter('Done').click();
  await expect(u.items).toHaveCount(2);
});

test('FB-06 persist: items and statuses survive a browser reload and a real API restart', async ({ page, empty }) => {
  await page.goto(empty.url);
  const u = ui(page);
  await add(page, 'Persistent item', 'kept');
  await expect(u.item('Persistent item')).toBeVisible();
  await page.reload();
  await expect(u.item('Persistent item')).toBeVisible();
  await u.item('Persistent item').getByRole('combobox', { name: 'Status', exact: true }).selectOption('done');
  await expectCounts(page, 1, 0, 0, 1);
  await empty.restart();
  await page.reload();
  const card = u.item('Persistent item');
  await expect(card).toBeVisible();
  await expect(card).toContainText('kept');
  await expect(card.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('done');
  await expectCounts(page, 1, 0, 0, 1);
  const list = await api(empty).list();
  expect(list.body.items).toHaveLength(1);
  expect(list.body.items[0].status).toBe('done');
});

test('FB-07 states: loading, empty, failed load and failed writes are usable and never look saved', async ({ page, seeded, empty }) => {
  const u = ui(page);

  // loading: hold the initial list request with route interception
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route('**/api/feedback*', async (route) => {
    if (route.request().method() === 'GET') await gate;
    await route.continue();
  });
  await page.goto(seeded.url);
  await expect(u.status.filter({ hasText: /loading/i })).toBeVisible();
  await expect(u.items).toHaveCount(0);
  release();
  await expect(u.items).toHaveCount(3);
  await expect(u.status.filter({ hasText: /loading/i })).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });

  // failed write (HTTP 500): alert, item never appears, nothing persisted
  await page.route('**/api/feedback', async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'boom', message: 'forced failure' } }) });
    else await route.continue();
  });
  await add(page, 'Never saved');
  await expect(u.alert.first()).toBeVisible();
  expect(((await u.alert.first().textContent()) ?? '').trim().length).toBeGreaterThan(0);
  await expect(u.item('Never saved')).toHaveCount(0);
  await expectCounts(page, 3, 1, 1, 1);
  expect((await api(seeded).list()).body.counts.all).toBe(3);
  await page.unrouteAll({ behavior: 'wait' });
  await page.reload();
  await expect(u.items).toHaveCount(3);
  await expect(u.alert).toHaveCount(0); // no stale alert may satisfy the next phase

  // failed write (network abort)
  await page.route('**/api/feedback', async (route) => {
    if (route.request().method() === 'POST') await route.abort('failed');
    else await route.continue();
  });
  await add(page, 'Never saved either');
  await expect(u.alert).toHaveCount(1);
  expect(((await u.alert.first().textContent()) ?? '').trim().length).toBeGreaterThan(0);
  await expect(u.item('Never saved either')).toHaveCount(0);
  await expect(u.title).toBeEnabled(); // still usable after the network failure
  await expect(u.submit).toBeEnabled();
  await page.unrouteAll({ behavior: 'wait' });
  await page.reload();
  await expect(u.alert).toHaveCount(0);
  await expect(u.items).toHaveCount(3);
  await expect(u.item('Never saved')).toHaveCount(0);

  // failed status update: the card must not show the unsaved status
  await expect(u.alert).toHaveCount(0);
  await page.route('**/api/feedback/*', async (route) => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'boom', message: 'forced failure' } }) });
    else await route.continue();
  });
  await u.item('Add dark mode').getByRole('combobox', { name: 'Status', exact: true }).selectOption('done');
  await expect(u.alert.first()).toBeVisible();
  await expect(u.item('Add dark mode').getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('open');
  await expectCounts(page, 3, 1, 1, 1);
  await page.unrouteAll({ behavior: 'wait' });
  await page.reload();
  await expect(u.items).toHaveCount(3);
  await expect(u.alert).toHaveCount(0);

  // failed load: error shown, and not mislabelled as empty
  await page.route('**/api/feedback*', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'boom', message: 'forced failure' } }) });
    else await route.continue();
  });
  await page.reload();
  await expect(u.alert.first()).toBeVisible();
  expect(((await u.alert.first().textContent()) ?? '').trim().length).toBeGreaterThan(0);
  await expect(u.status.filter({ hasText: /no feedback/i })).toHaveCount(0);
  await expect(u.items).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });

  // empty database
  await page.goto(empty.url);
  await expect(u.status.filter({ hasText: /no feedback/i })).toBeVisible();
  await expect(u.items).toHaveCount(0);
  await expect(u.alert).toHaveCount(0);
});

test('FB-08 a11y and safety: accessible names, keyboard-only flow, script text renders as text', async ({ page, empty }) => {
  const u = ui(page);
  await page.goto(empty.url);
  for (const el of [u.title, u.description, u.submit, u.filters]) await expect(el).toBeVisible();
  await expect(u.list).toBeAttached();

  const tabUntil = async (target: () => Promise<boolean>, key = 'Tab') => {
    for (let i = 0; i < 25; i++) {
      if (await target()) return;
      await page.keyboard.press(key);
    }
    throw new Error('keyboard focus never reached the target control');
  };

  // keyboard-only: reach the form, fill it, submit with Enter
  await tabUntil(() => u.title.evaluate((e) => e === document.activeElement));
  await page.keyboard.type('Keyboard item');
  await page.keyboard.press('Tab');
  await expect(u.description).toBeFocused();
  await page.keyboard.type('typed without a mouse');
  await page.keyboard.press('Tab');
  await expect(u.submit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(u.item('Keyboard item')).toBeVisible();
  const select = u.item('Keyboard item').getByRole('combobox', { name: 'Status', exact: true });
  await expect(select).toBeVisible();

  // keyboard-only: change status
  await page.reload();
  await expect(u.item('Keyboard item')).toBeVisible();
  await tabUntil(() => select.evaluate((e) => e === document.activeElement));
  await page.keyboard.press('ArrowDown'); // exactly one press: open -> planned (Linux Chromium in the verifier image)
  await expect(select).toHaveValue('planned');
  await expect.poll(async () => (await api(empty).list()).body.items[0].status).toBe('planned');

  // keyboard-only: filter
  await page.reload();
  await tabUntil(() => u.filter('Planned').evaluate((e) => e === document.activeElement));
  await page.keyboard.press('Enter');
  await expect(u.filter('Planned')).toHaveAttribute('aria-pressed', 'true');
  await expect(u.items).toHaveCount(1);
  await page.goto(empty.url);

  // script-like text renders as text and never executes
  const scriptTitle = '<script>window.demoCanary=1</script>';
  const imgDescription = '<img src=x onerror="window.demoCanary=1">';
  await add(page, scriptTitle, imgDescription);
  const card = u.item(scriptTitle);
  await expect(card).toContainText(scriptTitle);
  await expect(card).toContainText(imgDescription);
  await expect(u.list.locator('script, img')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).demoCanary)).toBeUndefined();
  await page.reload();
  await expect(u.item(scriptTitle)).toContainText(scriptTitle);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).demoCanary)).toBeUndefined();
});
