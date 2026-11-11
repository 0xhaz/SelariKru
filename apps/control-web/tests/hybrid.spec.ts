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
  await expect(result.getByTestId('accept-note')).toContainText('goes back to planned, pending approvals for it are withdrawn, an open handover for it closes');
  const proposed = (await result.locator('li').first().textContent())!;
  await result.getByRole('button', { name: 'Accept criteria' }).click();
  await expect(result.getByTestId('criteria-accepted')).toContainText('Criteria revision recorded in the demo');
  // The next read of the task shows the accepted criteria.
  const next = await page.evaluate(() => window.__spiedSource!.getTaskContext!('demo-feature-delivery', 'feature-delivery.search', 'local'));
  expect(proposed).toContain(next.task.criteria[0]!.text);
  expect(next.task.criteria[0]!.text).toMatch(/checked by an automated test/);
  // Only one announcement per result, and the card itself is not a live region.
  await expect(criteria.getByTestId('result-announce')).toHaveText(/^Draft criteria: proposal ready, ran on this device\.$/);
  await expect(result).not.toHaveAttribute('role', 'status');
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
  // The override was for that call only.
  await expect(breakdown.getByLabel('Use cloud for this call')).not.toBeChecked();
  await expect(breakdown.getByTestId('agent-route')).toContainText('(Run default)');
  // A proposed change, made from the task's base files, is accepted for the no-model apply worker (H5). The demo has no runner, so nothing is applied.
  const patch = action(page, 'patch');
  await patch.getByRole('button', { name: 'Propose change' }).click();
  await expect(patch.getByTestId('agent-result')).toHaveAttribute('data-status', 'ok');
  await expect(patch.getByTestId('patch-accept-note')).toContainText('with no model');
  await patch.getByRole('button', { name: 'Accept and apply' }).click();
  await expect(patch.getByTestId('patch-accepted')).toContainText('Accepted in the demo: 1 file. The demo has no runner, so nothing is applied.');
  // Closed and opened again, the card reads where the proposal is from the source, not from its own memory (m6).
  await page.keyboard.press('Escape');
  await expect(inspector(page)).toHaveCount(0);
  await row(page, T('search')).getByRole('button', { name: 'Search index' }).click();
  await expect(action(page, 'patch').getByTestId('patch-accepted')).toContainText('Accepted in the demo: 1 file.');
  await expect(action(page, 'patch').getByRole('button', { name: 'Accept and apply' })).toHaveCount(0);
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
  await expect(pr.getByTestId('pr-body-note')).toContainText('sends it as the description');
  await expect(page.locator('[data-testid="team-panel-row"][data-panel-worker="runner_local_2"] [data-testid="team-panel-route"]')).toHaveText(/AI: Local first/);
});

test('a restricted task\'s proposed change is never accepted: it is applied by the local runner on this device (H5)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pipeline');
  await row(page, T('e2e')).getByRole('button', { name: 'End-to-end checks' }).click();
  const patch = action(page, 'patch');
  await patch.getByRole('button', { name: 'Propose change' }).click();
  await expect(patch.getByTestId('agent-result')).toHaveAttribute('data-status', 'ok');
  await expect(patch.getByRole('button', { name: 'Accept and apply' })).toBeDisabled();
  await expect(patch.getByTestId('patch-accept-note')).toHaveText('Restricted work is applied by the local runner on this device. This proposal stays here and is not sent.');
  await axe(page);
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

test('the office marks a desk with where its call runs, expected while in flight and observed after, and lights the CLOUD rack while a cloud call is in flight', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, `#/pipeline?task=${T('web')}`, { holdAgents: true });
  type World = { cloudCall: boolean; agents: { id: string; ai: { place: string; state: string } | null }[] };
  const world = () => page.evaluate(() => (window as unknown as { __selarikruOffice?: { world: World } }).__selarikruOffice?.world ?? null);
  const frontend = async () => (await world())?.agents.find((a) => a.id === 'runner_local_2')?.ai ?? null;
  const canvas = page.getByTestId('office-canvas');
  // The list UI fell back to the cloud last time: an observed mark.
  await expect.poll(frontend).toEqual({ place: 'cloud', state: 'observed' });
  await expect(canvas).toHaveAttribute('aria-label', /Frontend last AI call ran in the cloud/);
  await row(page, T('web')).getByRole('button', { name: 'Feedback list UI', exact: true }).click();
  // Its route is Local first: held in flight, the desk shows where the call is expected to run.
  await action(page, 'criteria').getByRole('button', { name: 'Draft criteria' }).click();
  await expect.poll(frontend).toEqual({ place: 'device', state: 'expected' });
  await expect(canvas).toHaveAttribute('aria-label', /Frontend expected on this device/);
  expect((await world())?.cloudCall).toBe(false);
  await page.evaluate(() => window.__releaseAgents!());
  await expect(action(page, 'criteria').getByTestId('agent-result')).toContainText('Ran on this device');
  await expect.poll(frontend).toEqual({ place: 'device', state: 'observed' });
  await expect(canvas).toHaveAttribute('aria-label', /Frontend last AI call ran on this device/);
  // A one-call cloud override, held: headed to the cloud, and the CLOUD rack is lit until it lands.
  await page.evaluate(() => { (window as unknown as { __holdAgentsAgain: () => void }).__holdAgentsAgain(); });
  const breakdown = action(page, 'breakdown');
  await breakdown.getByLabel('Use cloud for this call').check();
  await breakdown.getByRole('button', { name: 'Break down' }).click();
  await expect.poll(frontend).toEqual({ place: 'cloud', state: 'expected' });
  await expect.poll(async () => (await world())?.cloudCall).toBe(true);
  await expect(canvas).toHaveAttribute('aria-label', /Frontend headed to the cloud \(expected\)\. The cloud rack is lit: a call is headed to the cloud\./);
  await page.evaluate(() => window.__releaseAgents!());
  await expect(breakdown.getByTestId('agent-result')).toContainText('Ran in the cloud');
  await expect.poll(async () => (await world())?.cloudCall).toBe(false);
  await expect.poll(frontend).toEqual({ place: 'cloud', state: 'observed' });
  await expect(page.getByTestId('activity-item').filter({ hasText: 'Feedback list UI: AI ran in cloud' })).toHaveCount(1);
});

test('a task that cannot be replanned does not offer to accept criteria, and says why', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pipeline');
  await row(page, T('api')).getByRole('button', { name: 'Feedback API' }).click();
  const criteria = action(page, 'criteria');
  await criteria.getByRole('button', { name: 'Draft criteria' }).click();
  await expect(criteria.getByRole('button', { name: 'Accept criteria' })).toBeDisabled();
  await expect(criteria.getByTestId('accept-note')).toContainText('A verified task cannot take a new revision');
});

test('a cloud route forced onto the locked task is refused by the source, and the refusal is said in words', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/pipeline');
  const control = runsOnIn(page, T('e2e'));
  const select = control.getByLabel('Runs on');
  await expect(select).toHaveAccessibleDescription(/Local only: Gemini Nano on this device\. Never the cloud/);
  // Past the disabled option, as a stale or tampered page could: the source still refuses.
  await select.evaluate((el: HTMLSelectElement) => { for (const o of el.options) o.disabled = false; });
  await select.selectOption('ONLY_IN_CLOUD');
  await control.getByRole('button', { name: 'Save' }).click();
  await expect(control.getByTestId('runs-on-feedback')).toHaveText(/restricted data, so its AI steps stay on this device/);
  await expect(control.getByTestId('runs-on-now')).toHaveText('Local only · Locked by restricted data');
  const sent = (await commands(page)).filter((c) => c.command === 'setting.set');
  expect(sent).toHaveLength(1);
});

test('accepting criteria for a task with a pending approval asks first, and Escape keeps everything as it was', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const at = new Date(Date.UTC(2026, 10, 1)).toISOString();
  await open(page, '#/pipeline', { extraApprovals: { apr_h4: { approvalId: 'apr_h4', taskId: T('search'), taskRevision: 1, runId: 'feature-delivery.run', scopeHash: 's', reason: 'Start a cloud worker', operation: 'start_cloud_worker', destination: null, requester: null, state: 'pending', requestedAt: at, expiresAt: null, resolvedAt: null } } });
  await row(page, T('search')).getByRole('button', { name: 'Search index' }).click();
  const criteria = action(page, 'criteria');
  await criteria.getByRole('button', { name: 'Draft criteria' }).click();
  await criteria.getByRole('button', { name: 'Accept criteria' }).click();
  const dialog = page.getByRole('dialog', { name: 'Replan this task with these criteria?' });
  await expect(dialog).toContainText('its pending approval is withdrawn');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(criteria.getByTestId('criteria-accepted')).toHaveCount(0);
  await criteria.getByRole('button', { name: 'Accept criteria' }).click();
  await page.getByRole('dialog', { name: 'Replan this task with these criteria?' }).getByRole('button', { name: 'Replan with these criteria' }).click();
  await expect(criteria.getByTestId('criteria-accepted')).toContainText('Criteria revision recorded in the demo');
});
