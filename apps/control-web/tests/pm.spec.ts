/**
 * H11: Talk to the Project Manager on demo data (the real adapter over the stand-in SDK: no model and no network). A reply says where it ran and that it is a proposal;
 * the PM's assignments apply on their own inside the accepted plan, and the office shows the PM's envelopes going to the workers' desks.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, hash: string): Promise<void> {
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'feature-delivery' }; });
  await page.goto(`/tests/harness/index.html${hash}`);
}
type Live = { recentEvents: { kind: string; agentId?: string }[]; world: { pm: { name: string } } };

test('the PM answers on demo data as a labelled proposal, from the Boards menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/office');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: /^Boards/ }).click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Talk to the PM' }).click();
  await expect(page.getByRole('heading', { name: 'Talk to the Project Manager', level: 1 })).toBeVisible();
  await page.getByTestId('pm-question').fill('What blocks the list screen?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const reply = page.getByTestId('pm-turn-reply').first();
  await expect(reply.getByTestId('pm-attribution')).toContainText('Simulated in the demo; no model ran.');
  await expect(reply.getByTestId('pm-attribution')).toContainText('A person accepts every proposal');
  await expect(reply).toContainText('Ran on this device');
  await expect(reply.getByTestId('pm-answer')).toContainText('Demo answer');
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});

test('web research is refused for a locked task, in plain words', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pm');
  await page.getByTestId('pm-subject').selectOption('feature-delivery.e2e');
  await page.getByTestId('pm-question').fill('How do others test this?');
  await expect(page.getByRole('button', { name: 'Research the web' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Research the web' })).toHaveAttribute('title', 'Web research is never used for restricted work.');
});

test('the PM proposes assignments, they apply inside the accepted plan, and the office shows the envelopes to the workers\' desks', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pm');
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __selarikruOffice?: Live }).__selarikruOffice?.world))).toBe(true);
  await page.getByTestId('pm-question').fill('Who should take the open tasks?');
  await page.getByRole('button', { name: 'Propose assignments' }).click();
  const reply = page.getByTestId('pm-turn-reply').first();
  await expect(reply.getByTestId('pm-delegation')).toBeVisible();
  await expect(reply.getByTestId('pm-applied').first()).toContainText('assigned by the Project Manager under your accepted plan rev');
  // The office (behind the drawer) saw the delegation: the PM sends an envelope to the worker's desk.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __selarikruOffice: Live }).__selarikruOffice.recentEvents.map((e) => e.kind))).toContain('delegated');
});

test('Settings › Workflow turns auto-delegate off, and then the PM\'s assignments wait for you', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/settings?section=workflow');
  const panel = page.getByTestId('auto-delegate');
  await expect(panel).toHaveAttribute('data-on', 'true');
  await panel.getByRole('button', { name: 'Turn off auto-delegate' }).click();
  await expect(panel).toHaveAttribute('data-on', 'false');
  await page.goto('/tests/harness/index.html#/pm');
  await page.getByTestId('pm-question').fill('Who should take the open tasks?');
  await page.getByRole('button', { name: 'Propose assignments' }).click();
  const reply = page.getByTestId('pm-turn-reply').first();
  await expect(reply.getByTestId('pm-needs-you').first()).toContainText('Auto-delegation is off in Settings › Workflow');
  await expect(reply.getByTestId('pm-applied')).toHaveCount(0);
});

test('a worker is renamed in its drawer and shown as "Name · Role"', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/office?worker=runner_local_1');
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('tab', { name: 'Settings' }).click();
  await drawer.getByTestId('worker-name-input').fill('Nurul');
  await drawer.getByRole('button', { name: 'Save name' }).click();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(/^Nurul · /);
});

test('I4: the PM drafts a plan, the owner accepts it, and the PM then assigns inside it (envelopes in the office)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pm');
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __selarikruOffice?: Live }).__selarikruOffice?.world))).toBe(true);
  await page.getByTestId('pm-question').fill('Plan the rest of the work.');
  await page.getByRole('button', { name: 'Draft a plan' }).click();
  const reply = page.getByTestId('pm-turn-reply').first();
  // H12: the PM proposes where each task runs, with its reason; the routes are accepted with the plan.
  await expect(reply.getByTestId('pm-plan-route')).toHaveCount(2);
  await expect(reply.getByTestId('pm-plan-route').first()).toContainText(/Runs on: (Local first|Local only|Cloud first|Cloud only)/);
  await reply.getByRole('button', { name: 'Accept plan' }).click();
  await expect(reply.getByTestId('pm-plan-accepted')).toContainText('Accepted as plan rev 2');
  await expect(reply.getByTestId('pm-plan-accepted')).toContainText('Routes set:');
  // Fix round 1 (I5): what was applied is exactly what was shown, never wider than the task's route now.
  await expect(reply.getByTestId('pm-plan-route').first()).toContainText(/now .+ → proposed /);
  const shown = await reply.getByTestId('pm-plan-route').evaluateAll((els) => els.filter((e) => e.getAttribute('data-locked') === 'false').map((e) => e.getAttribute('data-mode')));
  const applied = await page.evaluate(() => (window.__calls.commands as { method: string; command?: { command: string; args: { change: { field: string; value: unknown } } } }[])
    .filter((c) => c.method === 'execute' && c.command?.command === 'setting.set' && c.command.args.change.field === 'route_override').map((c) => c.command!.args.change.value));
  expect(applied.length).toBeGreaterThan(0);
  expect(applied).toEqual(shown);
  // Fix round 2 (I4): the plan revised an existing task (same id, the PM's title) and added one; it did not only bump the revision.
  await expect(page.getByTestId('pm-subject').locator('option', { hasText: 'Demo plan step (revised)' })).toHaveCount(1);
  await expect(page.getByTestId('pm-subject').locator('option', { hasText: 'Demo follow-up' })).toHaveCount(1);
  // With auto-delegation on, the PM assigns under the new revision.
  await expect(page.getByTestId('pm-applied').first()).toContainText('under your accepted plan rev 2');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __selarikruOffice: Live }).__selarikruOffice.recentEvents.map((e) => e.kind))).toContain('delegated');
});

test('I3: with auto-delegate off the PM\'s assignments wait in Action items, and Assign applies them as the owner', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/settings?section=workflow');
  await page.getByTestId('auto-delegate').getByRole('button', { name: 'Turn off auto-delegate' }).click();
  await expect(page.getByTestId('auto-delegate')).toHaveAttribute('data-on', 'false');
  await page.evaluate(() => { window.location.hash = '#/pm'; });
  await page.getByTestId('pm-question').fill('Who should take the open tasks?');
  await page.getByRole('button', { name: 'Propose assignments' }).click();
  await expect(page.getByTestId('pm-needs-you').first()).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/actions'; });
  const row = page.getByTestId('pm-proposal').first();
  await expect(row).toContainText(/^Assign .+ to .+ · .+\? \(proposed by the PM\)/);
  await expect(page.getByTestId('pm-proposals-tab-only')).toHaveText(/^Kept for this tab only/);
  await row.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByTestId('pm-proposal')).toHaveCount(0);
});

test('H2: a question about a locked task is restricted, and the checkbox cannot lower it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pm');
  await page.getByTestId('pm-subject').selectOption('feature-delivery.e2e');
  await expect(page.getByTestId('pm-restricted')).toBeChecked();
  await expect(page.getByTestId('pm-restricted')).toBeDisabled();
  await page.getByTestId('pm-question').fill('What is left?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByTestId('pm-turn-owner').first()).toContainText('restricted, kept on this device');
});

test('I5: web research is off until the owner turns on Google Search in Settings › Workflow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pm');
  await page.getByTestId('pm-question').fill('How do others sort feedback?');
  await expect(page.getByRole('button', { name: 'Research the web' })).toBeDisabled();
  await expect(page.getByTestId('pm-research-off')).toContainText('Settings › Workflow');
  await page.evaluate(() => { window.location.hash = '#/settings?section=workflow'; });
  await page.getByTestId('web-research').getByRole('button', { name: 'Turn on Google Search (web research)' }).click();
  await expect(page.getByTestId('web-research')).toHaveAttribute('data-on', 'true');
  await page.evaluate(() => { window.location.hash = '#/pm'; });
  await page.getByTestId('pm-question').fill('How do others sort feedback?');
  await expect(page.getByRole('button', { name: 'Research the web' })).toBeEnabled();
});

test('M10: the PM is named in Settings before any worker holds the role, and the office shows the name', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/settings?section=workflow');
  await page.getByTestId('pm-name-input').fill('Puan Zara');
  await page.getByTestId('pm-name').getByRole('button', { name: 'Save name' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __selarikruOffice?: Live }).__selarikruOffice?.world.pm.name)).toBe('Puan Zara');
});

test('M11: Search Suggestions keep their markup but nothing that runs', async ({ page }) => {
  await open(page, '#/pm');
  const out = await page.evaluate(async () => {
    const m = await import('/src/features/pm/suggestions.ts' as string) as { sanitizeSuggestions: (h: string) => string };
    return m.sanitizeSuggestions('<style>.c{color:red}</style><div class="c"><a href="https://www.google.com/search?q=x">x</a><img src="x" onerror="window.__pwned=1"><a href=" javascript:alert(1)">y</a><script>window.__pwned=2</script></div>');
  });
  expect(out).toContain('<style>.c{color:red}</style>');
  expect(out).toContain('href="https://www.google.com/search?q=x"');
  expect(out).not.toMatch(/onerror|javascript:|<script/i);
  // Fix round 2: SVG animation that can set an attribute, and inert containers whose content is parsed later, are removed too.
  const svg = await page.evaluate(async () => {
    const m = await import('/src/features/pm/suggestions.ts' as string) as { sanitizeSuggestions: (h: string) => string };
    return m.sanitizeSuggestions('<svg><a><animate attributeName="href" values="javascript:alert(1)"/><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg><noscript><img src=x onerror=alert(1)></noscript><template><img src=x onerror=alert(1)></template><b>kept</b>');
  });
  expect(svg).toContain('<b>kept</b>');
  expect(svg).not.toMatch(/<animate|<set|<noscript|<template/i);
});
