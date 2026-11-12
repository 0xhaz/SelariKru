/**
 * H9 fix round 1 (H1): with coding workers off (the hackathon build, and so the demo and the hosted demo), nothing on screen says Claude, Anthropic or Codex
 * does the work. Accepted changes are applied with no model; every AI step runs through Firebase AI Logic. The one Settings line about the switched-off
 * integrations is the only mention allowed.
 */
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
