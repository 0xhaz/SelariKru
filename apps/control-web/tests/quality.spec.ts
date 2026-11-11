/**
 * The T7.4 quality pass, kept as tests: the main flow by keyboard alone, contrast as rendered in both themes, reduced motion, and Decisions and status at 390 px.
 * Contrast here is axe's measurement of the colors the browser actually paints, not the token table (packages/ui/test/tokens.test.ts covers that).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { base, blueprint, configured, costPlan, ready } from './onboarding-fixtures.ts';

const API = 'http://127.0.0.1:5174/mockapi';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Presses Tab until `target` has focus. Never clicks: anything this cannot reach is not reachable by keyboard. */
async function tabTo(page: Page, target: Locator, max = 80): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`not reachable with Tab: ${String(target)}`);
}

/**
 * The focused element draws a real focus indicator (WCAG 2.4.7): it matches `:focus-visible` and has a solid outline at least 2 px wide in an opaque color. The app draws
 * focus with an outline everywhere; an ordinary box shadow, such as a card's or the drawer's, is not a focus indicator and does not count.
 */
async function expectVisibleFocus(page: Page): Promise<void> {
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    const alpha = (c: string) => { const m = c.match(/[\d.]+/g); return m && m.length === 4 ? Number(m[3]) : 1; };
    return { tag: `${el.tagName} ${(el.textContent ?? '').trim().slice(0, 30)}`, visible: el.matches(':focus-visible'), outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 && alpha(s.outlineColor) === 1 };
  });
  expect(ring.visible && ring.outline, `focus ring on ${ring.tag}`).toBe(true);
}

async function press(page: Page, target: Locator, key = 'Enter'): Promise<void> {
  await tabTo(page, target);
  await expectVisibleFocus(page);
  await page.keyboard.press(key);
}

async function typeInto(page: Page, target: Locator, text: string): Promise<void> {
  await tabTo(page, target);
  await expectVisibleFocus(page);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
}

test.describe('keyboard only', () => {
  test('onboarding from a new project to the first run', async ({ page }) => {
    const blueprintView = { ...base, state: 'blueprint_ready', source: { kind: 'new' }, focus: { tracks: ['saas_web'] }, blueprint: blueprint(), template: { executable: true, unsupported: [] } };
    const sequence: Record<string, unknown> = {
      create: base, source: { ...base, source: { kind: 'new' } }, focus: blueprintView,
      accept: { ...configured, execution: null, connection: null, costPlan: { ...costPlan, confirmed: false } },
      cost: { ...configured, execution: null, connection: null }, execution: { ...configured, connection: null }, connections: configured,
      readiness: ready, activate: { ...ready, state: 'activated', firstRunId: 'run_7f2' },
    };
    let current: unknown = null;
    let step = 'create';
    const posts: string[] = [];
    await page.addInitScript((url) => { (window as unknown as { __scenario: unknown }).__scenario = { onboardingApi: { baseUrl: url } }; }, API);
    await page.route('**/mockapi/v1/onboarding**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (r.request().method() === 'POST') { posts.push(path); current = sequence[step]; }
      const body = path.endsWith('/v1/onboarding') && r.request().method() === 'GET' ? { items: [] } : current;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const main = page.locator('#main');
    const heading = (name: string) => expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await page.goto('/tests/harness/index.html#/onboarding');

    // The skip link is the first stop and lands on the content.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await expectVisibleFocus(page);
    await press(page, page.getByRole('button', { name: 'Start a new project' }));

    await typeInto(page, main.getByLabel('Project name'), 'Clinic queue');
    await typeInto(page, main.getByLabel('Your idea'), 'Patients see their place in a clinic queue on their phone.');
    await typeInto(page, main.getByLabel('Who it is for'), 'Small clinics and their patients');
    await typeInto(page, main.getByLabel('First useful outcome'), 'A patient can see their position in the queue');
    // Each POST answers with the next view: `step` names what the server will say once the button below is pressed.
    step = 'create';
    await press(page, main.getByRole('button', { name: 'Save and continue' }));
    await heading('Is this a new project or an existing app?');
    await press(page, main.getByRole('radio', { name: /A new project/ }), 'Space');
    step = 'source';
    await press(page, main.getByRole('button', { name: 'Save and continue' }));
    await heading('What are you building first?');
    const pilot = main.getByRole('checkbox', { name: /Pilot stack/ });
    await tabTo(page, pilot);
    if (!(await pilot.isChecked())) await page.keyboard.press('Space');
    await expect(pilot).toBeChecked();
    step = 'focus';
    await press(page, main.getByRole('button', { name: 'Draft the blueprint' }));
    await heading('Review your blueprint');
    step = 'accept';
    await press(page, main.getByRole('button', { name: 'Accept version 1' }));
    await heading('What will it cost?');
    step = 'cost';
    await press(page, main.getByRole('button', { name: 'Save cost plan' }));
    await heading('Where should work happen?');
    step = 'execution';
    await press(page, main.getByRole('button', { name: 'Save and continue' }));
    await heading('Connect the repository');
    await typeInto(page, main.getByLabel('GitHub repository'), 'acme/clinic-queue');
    await typeInto(page, main.getByLabel('Base branch'), 'main');
    step = 'connections';
    await press(page, main.getByRole('button', { name: 'Save and continue' }));
    await heading('Is everything really ready?');
    step = 'readiness';
    await press(page, main.getByRole('button', { name: 'Run the checks' }));
    await press(page, main.getByRole('button', { name: 'Continue', exact: true }));
    await heading('Confirm the first run');
    step = 'activate';
    await press(page, main.getByRole('button', { name: 'Start first run' }));
    await heading('Your first run is accepted');
    await expect(page.getByRole('link', { name: 'Plan the run' })).toBeVisible();
    expect(posts.length).toBeGreaterThanOrEqual(9);
  });

  test('Decisions: reach a card, inspect, back out, then deny, all from the keys', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'decision-queue' }; });
    await page.goto('/tests/harness/index.html#/summary');
    // Decisions are in the Action items drawer, one button in the top bar.
    await press(page, page.getByTestId('action-items'));
    await expect(page.getByRole('heading', { name: 'Action items', level: 1 })).toBeVisible();
    const first = page.getByTestId('decision-card').first();
    const deny = first.getByRole('button', { name: 'Deny and block task' });
    await press(page, deny);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('confirm-keys')).toHaveText(/Esc keeps/);
    // Focus moves into the dialog, and Tab never reaches the page under it. A native modal dialog lets focus pass to the browser's own controls after its last
    // control (the document then reports body), and the next Tab comes back into the dialog.
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    let inside = 0;
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      const where = await dialog.evaluate((d) => (d.contains(document.activeElement) ? 'dialog' : document.activeElement === document.body ? 'browser' : 'page'));
      expect(where).not.toBe('page');
      if (where === 'dialog') { inside++; await expectVisibleFocus(page); }
    }
    expect(inside).toBeGreaterThan(4);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(deny).toBeFocused();
    await page.keyboard.press('Enter');
    await press(page, dialog.getByRole('button', { name: 'Deny and block task' }));
    await expect(page.getByTestId('decision-status')).toContainText('Denial recorded');
    await expect(page.locator(':focus')).toHaveRole('heading');
    expect(await page.evaluate(() => (window as unknown as { __calls: { commands: unknown[] } }).__calls.commands.length)).toBe(1);
  });

  test('the worker drawer: open from the panel, move between tabs with arrows, close with Escape', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'human-wait' }; });
    await page.goto('/tests/harness/index.html#/summary');
    const row = page.locator('[data-testid="team-panel-row"][data-panel-worker="runner_local_1"]');
    await press(page, row);
    const drawer = page.getByTestId('worker-drawer');
    await expect(drawer.getByRole('tab', { name: 'Task' })).toBeFocused();
    await expectVisibleFocus(page);
    await page.keyboard.press('ArrowRight');
    const next = drawer.getByRole('tab', { selected: true });
    await expect(next).toBeFocused();
    await expect(next).not.toHaveAccessibleName('Task');
    await page.keyboard.press('End');
    await expect(drawer.getByRole('tab').last()).toBeFocused();
    await expect(drawer.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(drawer.getByRole('tab', { name: 'Terminal' })).toBeFocused();
    // The keys are shown where they work (design section 11: show shortcuts in the UI).
    await expect(drawer.getByTestId('drawer-keys')).toHaveText(/^Esc closes this\. On the tabs, ←.*and →.* switch tabs; Home and End go to the first and last\.$/);
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(row).toBeFocused();
  });
});

// The office (T5.12) is the default screen; every other route opens in a drawer over it.
const ROUTES = ['office', 'actions', 'summary', 'team', 'pipeline', 'evidence', 'product', 'brain', 'benchmark', 'settings', 'settings?section=skills'] as const;
const FIXTURES = ['human-wait', 'decision-queue', 'failed-ci', 'runner-loss', 'budget-stop', 'merge-flow'] as const;

async function contrastFailures(page: Page): Promise<{ violations: string[]; incomplete: string[] }> {
  const r = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  const list = (xs: typeof r.violations) => xs.flatMap((v) => v.nodes.map((n) => `${n.target.join(' ')}: ${n.any[0]?.message ?? v.help}`));
  return { violations: list(r.violations), incomplete: list(r.incomplete) };
}

test.describe('contrast as painted', () => {
  // One theme since T5.12 round 2: the reference's cream and ink. The loops stay so a second theme would be measured the same way.
  for (const theme of ['light'] as const) {
    for (const fixture of FIXTURES) {
      test(`${theme}: every view with ${fixture}`, async ({ page }) => {
        test.setTimeout(90_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.addInitScript(([f, t]) => {
          (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: f };
          window.localStorage.setItem('selarikru.theme', t!);
        }, [fixture, theme]);
        const incomplete: string[] = [];
        for (const route of ROUTES) {
          await page.goto(`/tests/harness/index.html#/${route}`);
          await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          const r = await contrastFailures(page);
          expect(r.violations, `${route}`).toEqual([]);
          incomplete.push(...r.incomplete.map((x) => `${route}: ${x}`));
        }
        test.info().annotations.push({ type: 'incomplete', description: String(incomplete.length) });
      });
    }
  }
});

/** Everything on the page that moves: a running animation, a transition with a duration, or smooth scrolling. */
const moving = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')].flatMap((el) => {
  const s = getComputedStyle(el);
  const dur = (v: string) => v.split(',').some((d) => parseFloat(d) > 0);
  const out: string[] = [];
  if (s.animationName !== 'none' && dur(s.animationDuration)) out.push(`${el.tagName}.${el.className} animation ${s.animationName}`);
  if (dur(s.transitionDuration) && s.transitionProperty !== 'none') out.push(`${el.tagName}.${el.className} transition ${s.transitionProperty}`);
  if (s.scrollBehavior === 'smooth') out.push(`${el.tagName} smooth scroll`);
  return out;
}));

// One theme since T5.12 round 2: the reference's cream and ink. The loops stay so a second theme would be measured the same way.
  for (const theme of ['light'] as const) {
  test(`${theme}: contrast in the worker drawer, on the paused page beside it, and in a confirm dialog`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((t) => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'human-wait' }; window.localStorage.setItem('selarikru.theme', t); }, theme);
    await page.goto('/tests/harness/index.html#/summary');
    await page.locator('[data-testid="team-panel-row"][data-panel-worker="runner_local_1"]').click();
    await expect(page.getByTestId('page-paused-hint')).toBeVisible();
    for (const tab of ['Task', 'Settings', 'Terminal']) {
      await page.getByTestId('worker-drawer').getByRole('tab', { name: tab }).click();
      expect((await contrastFailures(page)).violations, `drawer ${tab}`).toEqual([]);
    }
    await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'decision-queue' }; });
    await page.goto('/tests/harness/index.html#/actions');
    await page.getByTestId('decision-card').first().getByRole('button', { name: 'Deny and block task' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect((await contrastFailures(page)).violations, 'confirm dialog').toEqual([]);
  });
}

test.describe('reduced motion', () => {
  test('with reduce, nothing on any view transitions or animates', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'healthy-parallel-work' }; });
    for (const route of ROUTES) {
      await page.goto(`/tests/harness/index.html#/${route}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      expect(await moving(page), route).toEqual([]);
    }
  });

  // The one thing that moves at all is the on-device model download bar. It eases without the preference and jumps with it.
  for (const motion of ['no-preference', 'reduce'] as const) {
    test(`the model download bar with ${motion}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: motion });
      await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { device: 'downloadable', downloadProgress: [0.25, 0.6], holdDownload: true }; });
      await page.goto('/tests/harness/index.html');
      await page.getByRole('button', { name: 'Download on-device model' }).click();
      await expect(page.getByRole('progressbar', { name: 'On-device model download' })).toHaveAttribute('aria-valuenow', '60');
      const found = await moving(page);
      if (motion === 'reduce') expect(found).toEqual([]);
      else expect(found).toEqual([expect.stringMatching(/progress-fill.* transition width/)]);
    });
  }
});

test.describe('390 px', () => {
  for (const [route, fixture] of [['office', 'human-wait'], ['actions', 'decision-queue'], ['summary', 'human-wait'], ['team', 'human-wait'], ['pipeline', 'failed-ci'], ['actions', 'budget-stop'], ['brain', 'healthy-parallel-work'], ['settings', 'healthy-parallel-work'], ['settings?section=skills', 'healthy-parallel-work'], ['product', 'merge-flow']] as const) {
    // One theme since T5.12 round 2: the reference's cream and ink. The loops stay so a second theme would be measured the same way.
  for (const theme of ['light'] as const) {
      test(`${route} with ${fixture} in ${theme}: no sideways scroll, nothing cut off, targets big enough, axe clean`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.addInitScript(([f, t]) => {
          (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: f };
          window.localStorage.setItem('selarikru.theme', t!);
        }, [fixture, theme]);
        await page.goto(`/tests/harness/index.html#/${route}`);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        // Every visible control and text block ends inside the viewport, unless a scroll container of its own holds it.
        const cut = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, h1, h2, h3, p, li')].filter((el) => {
          const r = el.getBoundingClientRect();
          // Visually hidden text (sr-only: a clipped 1 px box) is meant to be off screen.
          if (r.width <= 1 || r.height <= 1 || getComputedStyle(el).visibility === 'hidden') return false;
          for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return false; }
          return r.right > window.innerWidth + 0.5 || r.left < -0.5;
        }).map((el) => `${el.tagName} ${(el.textContent ?? '').trim().slice(0, 40)}`));
        expect(cut).toEqual([]);
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
        // The decision actions are reachable and named at this width.
        if (route === 'actions') await expect(page.locator('[data-testid="decision-card"], [data-testid="action-row"]').first().getByRole('button').first()).toBeVisible();
      });
    }
  }
});

test('at 390 px the folded team panel and the worker drawer fit, keep focus, and pass axe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'human-wait' }; });
  await page.goto('/tests/harness/index.html#/summary');
  const toggle = page.getByTestId('team-panel-toggle');
  await press(page, toggle);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const row = page.locator('[data-testid="team-panel-row"][data-panel-worker="runner_local_1"]');
  await press(page, row);
  const drawer = page.getByTestId('worker-drawer');
  await expect(drawer.getByRole('tab', { name: 'Task' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const box = (await drawer.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390.5);
  for (const tab of ['Task', 'Settings', 'Terminal']) {
    await drawer.getByRole('tab', { name: tab }).focus();
    await page.keyboard.press('Enter');
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations.map((v) => `${tab} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  }
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  // Focus returns to what opened the drawer, or to the toggle when the folded panel closed with it: never to the page top.
  const back = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a?.getAttribute('data-testid') ?? a?.tagName ?? null; });
  expect(['team-panel-row', 'team-panel-toggle']).toContain(back);
});

/**
 * Text axe could not judge, measured here from computed colors: the team panel rows (their status rail is a pseudo element, which stops axe) and timestamps (their tooltip
 * overlaps them). The background is the nearest ancestor's, with translucent layers blended down to an opaque one.
 */
const measured = (page: Page, selector: string) => page.evaluate((sel) => {
  const parse = (c: string): [number, number, number, number] => { const m = c.match(/[\d.]+/g)!.map(Number); return [m[0]!, m[1]!, m[2]!, m[3] ?? 1]; };
  const lum = ([r, g, b]: number[]) => { const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * ch(r!) + 0.7152 * ch(g!) + 0.0722 * ch(b!); };
  const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
  const backdrop = (el: Element): number[] => {
    const layers: number[][] = [];
    for (let p: Element | null = el; p; p = p.parentElement) {
      const c = parse(getComputedStyle(p).backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let out = parse(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    for (const l of layers.reverse()) out = over(l, out);
    return out;
  };
  return [...document.querySelectorAll(sel)].filter((el) => (el.textContent ?? '').trim() !== '' && el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"]')).map((el) => {
    const bg = backdrop(el);
    const fg = over(parse(getComputedStyle(el).color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
    return { text: (el.textContent ?? '').trim().slice(0, 30), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 };
  });
}, selector);

// One theme since T5.12 round 2: the reference's cream and ink. The loops stay so a second theme would be measured the same way.
  for (const theme of ['light'] as const) {
  test(`${theme}: the team panel rows and timestamps axe cannot measure meet AA`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [fixture, route] of [['human-wait', 'summary'], ['human-wait', 'pipeline'], ['human-wait', 'actions'], ['budget-stop', 'actions']] as const) {
      await page.addInitScript(([f, t]) => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: f }; window.localStorage.setItem('selarikru.theme', t!); }, [fixture, theme]);
      await page.goto(`/tests/harness/index.html#/${route}`);
      await expect(page.locator('[data-testid="team-panel-row"]').first()).toBeVisible();
      const rows = await measured(page, '[data-testid="team-panel-row"] span:not(:has(span)), [data-testid="team-panel-row"] span:has(> .sr-only)');
      const times = await measured(page, 'time');
      expect(rows.length).toBeGreaterThan(4);
      expect(times.length).toBeGreaterThan(0);
      for (const m of [...rows, ...times]) expect(m.ratio, `${route} "${m.text}"`).toBeGreaterThanOrEqual(4.5);
    }
  });
}
