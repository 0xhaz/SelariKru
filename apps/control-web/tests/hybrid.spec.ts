/**
 * H4: where each task's AI runs. The "Runs on" control on the Pipeline row and in the task drawers, the data lock, the run default, the agent actions on demo data
 * (the real adapter over a stand-in SDK: no model and no network), accepting a criteria proposal, and the office's device and cloud marks.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const T = (local: string) => `feature-delivery.${local}`;

async function open(page: Page, hash: string, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((s) => { (window as unknown as { __scenario: unknown }).__scenario = s; }, { spiedFixture: 'feature-delivery', ...extra });
  await page.goto(`/tests/harness/index.html${hash}`);
}

const row = (page: Page, id: string) => page.locator(`[data-testid="pipeline-row"][data-task-id="${id}"]`);
const runsOnIn = (page: Page, id: string) => row(page, id).getByTestId('runs-on');
const inspector = (page: Page) => page.getByTestId('task-inspector');
const commands = (page: Page) => page.evaluate(() => (window.__calls.commands as { method: string; command?: { command: string; args: Record<string, unknown>; expectedRevision: number } }[]).filter((c) => c.method === 'execute').map((c) => c.command!));
const action = (page: Page, kind: string) => inspector(page).locator(`[data-testid="agent-action"][data-kind="${kind}"]`);

async function axe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('switch a task to Local only from its Pipeline row: an owner write, then in force from the snapshot', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pipeline');
  const control = runsOnIn(page, T('search'));
  await expect(control).toContainText('Local first · Run default');
  await expect(control).toContainText('No AI call yet');
  await control.getByLabel('Runs on').selectOption('ONLY_ON_DEVICE');
  await control.getByRole('button', { name: 'Save' }).click();
  await expect(control.getByTestId('runs-on-now')).toHaveText('Local only · Set on this task');
  await expect(control.getByTestId('runs-on-feedback')).toContainText('Saved: Local only');
  const sent = (await commands(page)).filter((c) => c.command === 'setting.set');
  expect(sent).toEqual([expect.objectContaining({ expectedRevision: 0, args: { projectId: 'demo-feature-delivery', key: T('search'), change: { scope: 'task', field: 'route_override', value: 'ONLY_ON_DEVICE' } } })]);
  // The inspector did not open: the control is not a click on the row.
  await expect(inspector(page)).toHaveCount(0);
  await expect(runsOnIn(page, T('web'))).toContainText('Fell back to cloud');
  await expect(runsOnIn(page, T('integrate'))).toContainText('Unknown');
});

test('the locked task shows the padlock and its reason, and offers no cloud route', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `#/pipeline?task=${T('e2e')}`);
  const control = runsOnIn(page, T('e2e'));
  await expect(control.getByTestId('route-lock')).toHaveText('Restricted data stays on this device');
  for (const v of ['PREFER_ON_DEVICE', 'ONLY_IN_CLOUD', 'PREFER_IN_CLOUD']) await expect(control.locator(`option[value="${v}"]`)).toBeDisabled();
  await expect(control.locator('option[value="ONLY_ON_DEVICE"]')).toBeEnabled();
  await row(page, T('e2e')).getByRole('button', { name: 'End-to-end checks' }).click();
  const full = inspector(page).getByTestId('runs-on');
  await expect(full.getByTestId('route-lock')).toContainText('restricted data');
  await expect(full.getByTestId('runs-on-suggestion')).toContainText('Suggested: Local only.');
  // Under the lock no step offers a cloud call, and each says the data stays here.
  await expect(action(page, 'criteria').getByTestId('agent-route')).toContainText('Local only, on this device only');
  await expect(action(page, 'criteria').getByTestId('agent-route')).toContainText('restricted data stays on this device');
  await expect(inspector(page).getByLabel(/for this call/)).toHaveCount(0);
  await axe(page);
});

test('run an agent on demo data, see its proposal with checks, source and timing, and accept the criteria through the replan path', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pipeline');
  await row(page, T('search')).getByRole('button', { name: 'Search index' }).click();
  await expect(inspector(page).getByTestId('agents-demo-note')).toContainText('Demo data');
  const criteria = action(page, 'criteria');
  await expect(criteria.getByTestId('agent-route')).toContainText('Uses Local first, on this device first (Run default)');
  await criteria.getByRole('button', { name: 'Draft criteria' }).click();
  const result = criteria.getByTestId('agent-result');
  await expect(result).toHaveAttribute('data-status', 'ok');
  await expect(result.getByTestId('result-demo')).toHaveText('Demo data');
  await expect(result).toContainText('Passed its checks');
  await expect(result).toContainText('Ran on this device');
  await expect(result.getByTestId('result-timing')).toHaveText(/^\d+\.\d s$/);
  await expect(result).toContainText('recorded as an untrusted browser report');
  await result.getByRole('button', { name: 'Accept criteria' }).click();
  await expect(result.getByTestId('criteria-accepted')).toContainText('Criteria revision recorded in the demo');
  // The route record went through the route.report command, metadata only.
  const reports = (await commands(page)).filter((c) => c.command === 'route.report');
  expect(reports).toHaveLength(1);
  expect(Object.keys(reports[0]!.args['report'] as object).sort()).toEqual(['blockedReason', 'callOverride', 'kind', 'model', 'observedSource', 'requestId', 'requestedMode', 'status', 'stepKind', 'timing', 'validation']);
  // The office's activity feed and the row's chip follow the record.
  await expect(runsOnIn(page, T('search'))).toContainText('Ran on this device');
  // A one-call override sends this call to the cloud and nothing else changes.
  const breakdown = action(page, 'breakdown');
  await breakdown.getByLabel('Use cloud for this call').check();
  await expect(breakdown.getByTestId('agent-route')).toContainText('Cloud only, in the cloud only (This call only)');
  await breakdown.getByRole('button', { name: 'Break down' }).click();
  await expect(breakdown.getByTestId('agent-result')).toContainText('Ran in the cloud');
  // A proposed change is shown, never applied.
  await action(page, 'patch').getByRole('button', { name: 'Propose change' }).click();
  await expect(action(page, 'patch').getByRole('button', { name: 'Apply comes next' })).toBeDisabled();
  // No change to review on this task yet, and no failed check to explain: said, not hidden.
  await expect(action(page, 'review').getByRole('button', { name: 'Review change' })).toBeDisabled();
  await expect(action(page, 'triage')).toContainText('no failed check');
  await axe(page);
});

test('explain a failure and write a PR description from the worker drawer\'s Task tab', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/?worker=runner_local_2');
  const drawer = page.getByTestId('worker-drawer');
  await expect(drawer.getByTestId('runs-on')).toContainText('Local first');
  const triage = drawer.locator('[data-testid="agent-action"][data-kind="triage"]');
  await triage.getByRole('button', { name: 'Explain failure' }).click();
  await expect(triage.getByTestId('agent-result')).toContainText('Likely cause');
  const pr = drawer.locator('[data-testid="agent-action"][data-kind="prDescription"]');
  await pr.getByRole('button', { name: 'Write PR description' }).click();
  await pr.getByRole('button', { name: 'Use as PR description' }).click();
  await expect(pr.getByTestId('pr-body')).toHaveValue(/^Demo: the change for this task/);
  await expect(page.locator('[data-testid="team-panel-row"][data-panel-worker="runner_local_2"] [data-testid="team-panel-route"]')).toHaveText(/AI: Local first/);
});

test('the run default is set in Settings › Workflow, seeded from setup', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/settings?section=workflow');
  const panel = page.getByTestId('run-default');
  await expect(panel.getByTestId('run-default-origin')).toHaveText('Seeded from the choice made at setup.');
  await panel.getByRole('combobox').selectOption('PREFER_IN_CLOUD');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByTestId('run-default-origin')).toHaveText('Saved here.');
  await expect(panel).toContainText('Saved: new tasks run Cloud first.');
});

test('the office marks a desk with where its call runs, and lights the CLOUD rack while a cloud call is in flight', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `#/pipeline?task=${T('api')}`, { holdAgents: true });
  type World = { cloudCall: boolean; agents: { id: string; ai: { place: string; live: boolean } | null }[] };
  const world = () => page.evaluate(() => (window as unknown as { __selarikruOffice?: { world: World } }).__selarikruOffice?.world ?? null);
  await expect.poll(async () => (await world())?.agents.find((a) => a.id === 'runner_local_2')?.ai ?? null).toEqual({ place: 'cloud', live: false });
  await row(page, T('api')).getByRole('button', { name: 'Feedback API' }).click();
  await action(page, 'criteria').getByRole('button', { name: 'Draft criteria' }).click();
  await expect.poll(async () => (await world())?.cloudCall).toBe(true);
  await expect(page.getByTestId('office-canvas')).toHaveAttribute('aria-label', /The cloud rack is lit/);
  await page.evaluate(() => window.__releaseAgents!());
  await expect(action(page, 'criteria').getByTestId('agent-result')).toContainText('Ran in the cloud');
  await expect.poll(async () => (await world())?.cloudCall).toBe(false);
  await expect(page.getByTestId('activity-item').filter({ hasText: 'Feedback API: AI ran in cloud' })).toHaveCount(1);
});
