/**
 * H9 fix round 1 (H1): with coding workers off (the hackathon build, and so the demo and the hosted demo), nothing on screen says Claude, Anthropic or Codex
 * does the work. Accepted changes are applied with no model; every AI step runs through Firebase AI Logic. The one Settings line about the switched-off
 * integrations is the only mention allowed.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const ALLOWED = 'Worker integrations (Claude Code, MCP) are outside Firebase AI Logic and are off in this build.';
const BANNED = /claude|anthropic|codex/i;

async function words(page: Page): Promise<string> {
  return (await page.evaluate(() => document.body.innerText)).split(ALLOWED).join('');
}

for (const fixture of ['feature-delivery', 'healthy-parallel-work', 'benchmark-trial']) {
  test(`${fixture}: the office, Team, Settings and a worker's drawer never name Claude, Anthropic or Codex`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => { try { localStorage.setItem('selarikru.tour.offered', '1'); } catch { /* none */ } });
    for (const hash of ['#/office', '#/team', '#/settings', '#/settings?section=skills', '#/settings?section=sandbox']) {
      await page.goto(`/?demo&fixture=${fixture}${hash}`);
      await expect(page.getByTestId('top-bar')).toBeVisible();
      await expect(page.getByTestId('team-panel').or(page.getByRole('status', { name: /loading/i })).first()).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.body.innerText.length)).toBeGreaterThan(200);
      expect((await words(page)).match(BANNED), `${fixture} ${hash}`).toBeNull();
    }
    // The worker cards say what the worker does, not a raw model id.
    await page.goto(`/?demo&fixture=${fixture}#/office`);
    await expect(page.getByTestId('team-panel-model').first()).toContainText('Applies accepted changes (no model)');
    expect(await words(page)).not.toContain('apply-proposal');
    await page.goto(`/?demo&fixture=${fixture}#/team`);
    await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Provider', { exact: true })).toHaveCount(0);
    // A worker's drawer: its header (the coding agent), and each tab.
    await page.goto(`/?demo&fixture=${fixture}#/office`);
    await page.getByTestId('team-panel-row').first().click();
    const drawer = page.getByTestId('worker-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Applies accepted changes');
    for (const tab of await drawer.getByRole('tab').allTextContents()) {
      await drawer.getByRole('tab', { name: tab }).click();
      expect((await words(page)).match(BANNED), `${fixture} drawer ${tab}`).toBeNull();
    }
  });
}

test('with coding workers on (dev ?demo&codingWorkers=claude_code), the Claude catalog and assignments are back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=healthy-parallel-work&codingWorkers=claude_code#/team');
  await expect(page.getByTestId('model-assignments')).toContainText('Sonnet 5.5');
  await expect(page.getByTestId('fleet-row').first()).toContainText(/claude/i);
});

/** H9 fix round 2: the rest of the views, each Boards entry (AI calls included), PRs, Pipeline and Action items. */
const VIEWS = ['#/pm', '#/calls', '#/pipeline', '#/summary', '#/product', '#/brain', '#/benchmark', '#/evidence', '#/actions'] as const;

async function sweep(page: Page, base: string, label: string): Promise<void> {
  for (const hash of VIEWS) {
    await page.goto(`${base}${hash}`);
    await expect(page.getByTestId('top-bar')).toBeVisible();
    await expect(page.getByTestId('view-drawer')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.innerText.length)).toBeGreaterThan(200);
    // Each view settles from its own reads (records, product, brain): read again until it stops changing.
    let last = '';
    await expect.poll(async () => { const now = await words(page); const same = now === last; last = now; return same; }, { intervals: [300, 500, 1000] }).toBe(true);
    expect(last.match(BANNED), `${label} ${hash}`).toBeNull();
  }
}

test('H9 fix round 2: every other view on demo data (Boards, PRs, Pipeline, Action items) never names Claude, Anthropic or Codex', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { try { localStorage.setItem('selarikru.tour.offered', '1'); } catch { /* none */ } });
  await sweep(page, '/?demo&fixture=feature-delivery', '?demo');
});

/**
 * H9 fix round 2: the hosted root itself, built (vite build --mode hosted, placeholder env only) and served by vite preview on a port of its own. Its AI calls
 * would need a real project; this checks only what is on screen.
 */
test.describe('the hosted demo build', () => {
  test.describe.configure({ mode: 'serial' });
  const PORT = 5178;
  const ROOT = join(import.meta.dirname, '..');
  const VITE = join(ROOT, 'node_modules/vite/bin/vite.js');
  const env = {
    ...process.env, NODE_ENV: 'production',
    VITE_FIREBASE_API_KEY: 'placeholder-api-key', VITE_FIREBASE_AUTH_DOMAIN: 'placeholder.example.invalid', VITE_FIREBASE_PROJECT_ID: 'placeholder-project',
    VITE_FIREBASE_STORAGE_BUCKET: 'placeholder.example.invalid', VITE_FIREBASE_MESSAGING_SENDER_ID: '000000000000', VITE_FIREBASE_APP_ID: '1:000000000000:web:placeholder',
    VITE_RECAPTCHA_SITE_KEY: 'placeholder-site-key',
  };
  let dir = '';
  let server: ChildProcess | null = null;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    dir = mkdtempSync(join(tmpdir(), 'selarikru-hosted-'));
    execFileSync(process.execPath, [VITE, 'build', '--mode', 'hosted', '--outDir', dir, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, env });
    server = spawn(process.execPath, [VITE, 'preview', '--mode', 'hosted', '--outDir', dir, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, env, stdio: 'ignore' });
    await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { return false; } }, { timeout: 60_000 }).toBe(true);
  });
  test.afterAll(() => {
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('the hosted root shows no Claude, Anthropic or Codex on any view', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => { try { localStorage.setItem('selarikru.tour.offered', '1'); } catch { /* none */ } });
    const base = `http://127.0.0.1:${PORT}/`;
    await page.goto(`${base}#/office`);
    await expect(page.getByTestId('cloud-quota')).toBeVisible();
    for (const hash of ['#/office', '#/team', '#/settings']) {
      await page.goto(`${base}${hash}`);
      await expect(page.getByTestId('team-panel-row').first()).toBeVisible();
      expect((await words(page)).match(BANNED), `hosted ${hash}`).toBeNull();
    }
    await sweep(page, base, 'hosted');
  });
});
