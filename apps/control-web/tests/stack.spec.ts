import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ORIGIN } from './origin.ts';

/** A confirmation inside Settings. Settings is itself a dialog (the modal over the office), so it is left out. */
const confirmDialog = (page: Page) => page.getByRole('dialog').filter({ hasNot: page.getByTestId('settings-page') });



/** Presses Tab until `target` has focus, and checks it draws a real focus ring. Never clicks: anything this cannot reach is not reachable by keyboard. */
async function tabTo(page: Page, target: Locator, max = 300): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
      const ring = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const st = getComputedStyle(el);
        return el.matches(':focus-visible') && st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) >= 2;
      });
      expect(ring, `focus ring on ${String(target)}`).toBe(true);
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`not reachable with Tab: ${String(target)}`);
}
async function typeInto(page: Page, target: Locator, text: string): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
}

async function open(page: Page, width = 1440): Promise<string[]> {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'healthy-parallel-work' }; });
  await page.goto('/tests/harness/index.html#/settings?section=stack');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Stack' })).toBeVisible();
  return requests;
}
const notice = (page: Page) => page.getByTestId('stack-notice');
const category = (page: Page, id: string) => page.locator(`[data-testid="stack-category"][data-category="${id}"]`);
const commands = (page: Page) => page.evaluate(() => (window as unknown as { __calls: { commands: unknown[] } }).__calls.commands);

test('keyboard only: confirm a detection, search and select two entries for each of two components, set a category to None', async ({ page }) => {
  const requests = await open(page);
  await expect(page.getByTestId('stack-demo-badge')).toHaveText(/Demo data/);
  const main = page.locator('#main');

  // Confirm a detection: it becomes a selection with its evidence.
  const react = page.locator('[data-testid="stack-detection"][data-detection="det:.:react"]');
  await expect(react).toContainText('package.json · dependencies.react 19.3.1');
  await tabTo(page, react.getByRole('button', { name: 'Confirm React for .' }));
  await page.keyboard.press('Enter');
  await expect(react).toHaveAttribute('data-state', 'confirmed');
  await expect(notice(page)).toHaveText('Confirmed React for ..');

  // A second component, by keyboard.
  await typeInto(page, main.getByLabel('Component name'), 'API');
  await typeInto(page, main.getByLabel('Repository path'), 'server');
  await tabTo(page, main.getByRole('checkbox', { name: 'Server' }));
  await page.keyboard.press('Space');
  await tabTo(page, main.getByRole('button', { name: 'Add component' }));
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="stack-component"][data-path="server"]')).toBeVisible();
  await expect(page.getByRole('radio', { name: /API server/ })).toBeChecked();

  // Grouped search with the combobox: Express and then SQLite for the API, the list staying open between them.
  const frameworks = main.getByRole('combobox', { name: 'Search frameworks & runtimes for API' });
  await typeInto(page, frameworks, 'expr');
  await expect(frameworks).toHaveAttribute('aria-expanded', 'true');
  const list = main.getByRole('listbox', { name: /Search frameworks & runtimes for API results/ });
  await expect(list.getByRole('group', { name: 'JavaScript/TypeScript APIs' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(list.getByRole('option', { name: /Express/ })).toHaveAttribute('aria-selected', 'true');
  await expect(category(page, 'frameworks').getByTestId('stack-item')).toHaveCount(1);
  await page.keyboard.press('Escape');
  const services = main.getByRole('combobox', { name: 'Search tools & services for API' });
  await typeInto(page, services, 'sqlite');
  await page.keyboard.press('Enter');
  await expect(category(page, 'database_engines').locator('[data-item="sqlite"]')).toBeVisible();
  await expect(notice(page)).toContainText('Added SQLite to Database engines for server. Recorded only');
  await page.keyboard.press('Escape');

  // Back to the root component with the arrow keys, then two entries there.
  await tabTo(page, page.getByRole('radio', { name: /API server/ }));
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('radio', { name: /Feedback Board \./ })).toBeChecked();
  const rootServices = main.getByRole('combobox', { name: 'Search tools & services for Feedback Board' });
  await typeInto(page, rootServices, 'tailwind');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('stripe');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(category(page, 'ui').locator('[data-item="tailwind-css"]')).toBeVisible();
  await expect(category(page, 'payments').locator('[data-item="stripe"]')).toBeVisible();
  await expect(category(page, 'frameworks').locator('[data-item="react"]')).toContainText('Detected in package.json');

  // Analytics set to None: a different state from Not decided.
  const analytics = category(page, 'analytics');
  await expect(analytics).toHaveAttribute('data-state', 'not_decided');
  await tabTo(page, analytics.getByRole('radio', { name: 'Not decided' }));
  await page.keyboard.press('ArrowRight');
  await expect(analytics).toHaveAttribute('data-state', 'none');
  await expect(analytics.getByRole('radio', { name: 'None · not used' })).toBeChecked();
  await expect(analytics).toContainText('does not turn off any platform verification');
  await expect(category(page, 'cms')).toHaveAttribute('data-state', 'not_decided');

  // Selecting Stripe made no request, issued no runner command and used no credential.
  expect(await commands(page)).toEqual([]);
  expect(requests.filter((u) => !u.startsWith(ORIGIN))).toEqual([]);
});

test('keyboard: moving off a category with selections asks first, and Escape keeps the selections', async ({ page }) => {
  await open(page);
  const main = page.locator('#main');
  const services = main.getByRole('combobox', { name: 'Search tools & services for Feedback Board' });
  await typeInto(page, services, 'stripe');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  const payments = category(page, 'payments');
  await expect(payments).toHaveAttribute('data-state', 'selected');
  // The radio group's tab stop is the checked radio. An arrow key alone never clears the selection.
  await tabTo(page, payments.getByRole('radio', { name: 'Selected (1)' }));
  await page.keyboard.press('ArrowLeft');
  const dialog = page.getByRole('dialog', { name: /Clear 1 selection from Payments/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('deletes no provider data');
  await expect(payments).toHaveAttribute('data-state', 'selected');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(payments).toHaveAttribute('data-state', 'selected');
  await expect(payments.locator('[data-item="stripe"]')).toBeVisible();
  await expect(payments.getByRole('radio', { name: 'Selected (1)' })).toBeChecked();
  // Asked again, and confirmed by keyboard: now None.
  await tabTo(page, payments.getByRole('radio', { name: 'Selected (1)' }));
  await page.keyboard.press('ArrowLeft');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Clear and set None' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(payments).toHaveAttribute('data-state', 'none');
  await expect(notice(page)).toContainText('no provider data was deleted');
  // Moving between Not decided and None has nothing to lose, so it needs no confirmation.
  await tabTo(page, payments.getByRole('radio', { name: 'None · not used' }));
  await page.keyboard.press('ArrowLeft');
  await expect(payments).toHaveAttribute('data-state', 'not_decided');
  await expect(confirmDialog(page)).toHaveCount(0);
});

test('keyboard: the active result is scrolled into view as the arrow keys move through a long list', async ({ page }) => {
  await open(page);
  const main = page.locator('#main');
  const services = main.getByRole('combobox', { name: 'Search tools & services for Feedback Board' });
  await tabTo(page, services);
  await page.keyboard.press('ArrowDown');
  const list = page.getByTestId('stack-results');
  await expect(list).toBeVisible();
  const inView = async () => {
    const id = await services.getAttribute('aria-activedescendant');
    return page.evaluate((optionId) => {
      const o = document.getElementById(optionId!)!.getBoundingClientRect();
      const l = document.querySelector('[data-testid="stack-results"]')!.getBoundingClientRect();
      return o.top >= l.top - 0.5 && o.bottom <= l.bottom + 0.5;
    }, id);
  };
  await page.keyboard.press('End');
  await expect.poll(inView).toBe(true);
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
  await expect.poll(inView).toBe(true);
  await page.keyboard.press('Home');
  await expect.poll(inView).toBe(true);
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});

test('a service shows separate readiness axes and a disabled Disconnect; a mobile component shows its native gates as incomplete', async ({ page }) => {
  await open(page);
  const main = page.locator('#main');
  const services = main.getByRole('combobox', { name: 'Search tools & services for Feedback Board' });
  await services.fill('stripe');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  const stripe = category(page, 'payments').locator('[data-item="stripe"]');
  await expect(stripe).toContainText('Selected · not connected · not tested · No reviewed skills');
  await stripe.locator('summary').click();
  await expect(stripe).toContainText('Connector');
  await expect(stripe).toContainText('No connector.');
  await expect(stripe).toContainText('Not connected.');
  await expect(stripe.getByRole('button', { name: /Disconnect/ })).toBeDisabled();
  await expect(stripe).toContainText('deletes no provider data and revokes no credential');
  // Removing it deletes nothing else.
  await stripe.getByRole('button', { name: /Remove/ }).click();
  await expect(notice(page)).toContainText('No provider data was deleted and no credential was revoked.');
  await expect(category(page, 'payments')).toHaveAttribute('data-state', 'not_decided');

  await main.getByLabel('Component name').fill('Mobile');
  await main.getByLabel('Repository path').fill('apps/mobile');
  await main.getByRole('checkbox', { name: 'iOS' }).check();
  await main.getByRole('checkbox', { name: 'Android' }).check();
  await main.getByRole('button', { name: 'Add component' }).click();
  const mobile = page.locator('[data-testid="stack-component"][data-path="apps/mobile"]');
  await expect(mobile).toContainText('iOS gate incomplete: iOS runner required.');
  await expect(mobile).toContainText('Android gate incomplete: Android build not assessed.');
  await expect(mobile).toContainText('does not verify native behaviour');
  await main.getByRole('combobox', { name: 'Search frameworks & runtimes for Mobile' }).fill('expo');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  const expo = category(page, 'frameworks').locator('[data-item="expo"]');
  await expo.locator('summary').click();
  await expect(expo.getByRole('list', { name: 'Target gates for Expo' })).toContainText('iOS: iOS runner required');

  // A custom entry: recorded as named, unknown on every axis.
  await main.getByRole('textbox', { name: 'Name', exact: true }).first().fill('In-house router');
  await main.getByRole('button', { name: 'Add custom entry' }).first().click();
  const custom = category(page, 'frameworks').locator('[data-item="custom:inhouserouter"]');
  await expect(custom).toContainText('Custom · not reviewed');
  await custom.locator('summary').click();
  await expect(custom.getByText('Unknown · not reviewed')).toHaveCount(5);

  // Commands from package.json are proposals only.
  await expect(page.getByTestId('stack-command').first()).toContainText('Proposed · needs review · not in effect');
});

test('a restricted component is removed only through an explicit, recorded confirmation', async ({ page }) => {
  await open(page);
  const main = page.locator('#main');
  await main.getByLabel('Component name').fill('Billing');
  await main.getByLabel('Repository path').fill('services/billing');
  await main.getByRole('checkbox', { name: /Restricted/ }).check();
  await main.getByRole('button', { name: 'Add component' }).click();
  const row = page.locator('[data-testid="stack-component"][data-path="services/billing"]');
  await expect(row).toContainText('Restricted: local workers only');
  await row.getByRole('button', { name: /Remove/ }).click();
  const dialog = page.getByRole('dialog', { name: /Remove the restricted component/ });
  await expect(dialog).toContainText('recorded');
  await page.keyboard.press('Escape');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Remove/ }).click();
  await dialog.getByRole('button', { name: 'Remove and record it' }).click();
  await expect(row).toHaveCount(0);
  await expect(notice(page)).toContainText('The removal is recorded.');
});

test('at 390 px the stack settings fit, and a search result list stays usable', async ({ page }) => {
  await open(page, 390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#main').getByRole('combobox', { name: /Search frameworks/ }).fill('re');
  await expect(page.getByTestId('stack-results')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});
