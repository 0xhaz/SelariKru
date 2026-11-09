import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function openPipeline(page: Page, fixture: string, view = ''): Promise<void> {
  await page.goto(`/?demo&fixture=${fixture}#/pipeline${view ? `?view=${view}` : ''}`);
  await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible();
}

async function openHarness(page: Page, dependsOn: Record<string, string[] | null>, view = 'graph', taskPatch: Record<string, Record<string, unknown>> = {}): Promise<void> {
  await page.addInitScript(([deps, patch]) => {
    window.__scenario = { spiedFixture: 'feature-delivery', dependsOn: deps, taskPatch: patch };
  }, [dependsOn, taskPatch] as const);
  await page.goto(`/tests/harness/index.html#/pipeline?view=${view}`);
  await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible();
}

const row = (page: Page, id: string) => page.locator(`[data-testid="pipeline-row"][data-task-id="${id}"]`);
const node = (page: Page, id: string) => page.locator(`[data-testid="graph-node"][data-task-id="${id}"]`);
const inspector = (page: Page) => page.getByTestId('task-inspector');

async function expectNoAxeViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('the Pipeline nav item is a real link and the page is titled', async ({ page }) => {
  await page.goto('/?demo');
  await expect(page.getByRole('heading', { name: 'Mission Control', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Pipeline' }).click();
  await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible();
  await expect(page).toHaveTitle('Pipeline · SelariKru');
  await expect(page.locator('#main')).toBeFocused();
});

test('table columns per design §6', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery');
  await expect(page.getByTestId('pipeline-table').locator('thead th')).toHaveText(['Task and stage', 'Owner', 'State and reason', 'Predecessors', 'Accepted revision', 'Branch or candidate', 'Checks', 'Age', 'Next action']);
  await expect(page.getByTestId('pipeline-stage')).toHaveCount(6);
  await expect(page.locator('[data-stage="build"] th')).toContainText('Build');
});

test('"Why blocked?" names dependency, claim, approval, policy or budget', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'policy-block');
  const exportRow = row(page, 'policy-block.export');
  await expect(exportRow).toContainText('Restricted data may not reach a cloud destination.');
  await exportRow.getByRole('button', { name: 'Why blocked?' }).click();
  await expect(inspector(page).getByTestId('why-blocked').locator('[data-cause="policy"]')).toContainText('Policy');
  await inspector(page).getByRole('button', { name: 'Close' }).click();
  await expect(inspector(page)).toHaveCount(0);
  await expect(row(page, 'policy-block.report')).toContainText('needs your approval');

  await openPipeline(page, 'contract-change');
  const web = row(page, 'contract-change.web');
  await expect(web).toContainText('Waiting on Approve contract v1');
  await web.getByRole('button', { name: 'Why blocked?' }).click();
  await expect(inspector(page).getByTestId('why-blocked').locator('[data-cause="dependency"]')).toContainText('Waiting on Approve contract v1 (needs decision)');
});

test('a dependency wait reads as a quiet state, a failed gate does not', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'contract-change');
  const waiting = row(page, 'contract-change.web');
  await expect(waiting).toContainText('Waiting on Approve contract v1');
  await expect(waiting).toHaveAttribute('data-rail', 'none');
  await openPipeline(page, 'failed-ci');
  await expect(row(page, 'failed-ci.api')).toContainText('Failed check; repair queued');
  await expect(row(page, 'failed-ci.api')).toContainText('3 of 41 tests failed');
  await expect(row(page, 'failed-ci.api')).toHaveAttribute('data-rail', 'danger');
});

test('critical-path filter', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery');
  await expect(page.getByTestId('critical-label')).toContainText('Longest unfinished chain: 4 tasks');
  await expect(page.getByTestId('critical-label')).toContainText('Counted in tasks');
  await page.getByRole('checkbox', { name: 'Longest chain only' }).check();
  await expect(row(page, 'feature-delivery.web')).toBeVisible();
  await expect(row(page, 'feature-delivery.brief')).toHaveCount(0);
  await expect(page.getByTestId('filter-count')).toHaveText('Showing 5 of 8');
  await openPipeline(page, 'healthy-parallel-work');
  await expect(page.getByRole('checkbox', { name: 'Longest chain only' })).toBeDisabled();
  await expect(page.getByTestId('critical-label')).toContainText('No chain');
});

test('graph and table share selection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery', 'graph');
  const brief = node(page, 'feature-delivery.brief');
  await brief.focus();
  await page.keyboard.press('ArrowRight');
  await expect(node(page, 'feature-delivery.contract')).toBeFocused();
  await expect(node(page, 'feature-delivery.contract')).toHaveAttribute('data-selected', 'true');
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(row(page, 'feature-delivery.contract')).toHaveAttribute('data-selected', 'true');
  await row(page, 'feature-delivery.web').click();
  await inspector(page).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Graph' }).click();
  await expect(node(page, 'feature-delivery.web')).toHaveAttribute('data-selected', 'true');
  await expect(node(page, 'feature-delivery.contract')).toHaveAttribute('data-selected', 'false');
});

test('the graph is one tab stop with keyboard travel, and Enter opens and returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery', 'graph');
  await page.getByRole('checkbox', { name: 'Longest chain only' }).focus();
  await page.keyboard.press('Tab');
  await expect(node(page, 'feature-delivery.brief')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-testid="graph-node"]:focus')).toHaveCount(0);
  const brief = node(page, 'feature-delivery.brief');
  await brief.focus();
  await page.keyboard.press('Enter');
  await expect(inspector(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inspector(page)).toHaveCount(0);
  await expect(brief).toBeFocused();
});

test('"Why blocked?" returns focus to its own trigger', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery');
  const why = page.locator('[data-why-task="feature-delivery.search"]');
  await why.focus();
  await page.keyboard.press('Enter');
  await expect(inspector(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inspector(page)).toHaveCount(0);
  await expect(why).toBeFocused();
});

test('a stale edge is labelled in the gap and tells a person to act', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHarness(page, {}, 'graph', { 'feature-delivery.api': { status: 'superseded', supersededByRevision: 2 } });
  const label = page.locator('[data-testid="graph-edge"][data-state="stale"] [data-testid="graph-edge-label"]');
  await expect(label).toContainText('Stale');
  const box = (await label.boundingBox())!;
  for (const n of await page.getByTestId('graph-node').all()) {
    const b = (await n.boundingBox())!;
    expect(box.x + box.width <= b.x || b.x + b.width <= box.x || box.y + box.height <= b.y || b.y + b.height <= box.y).toBe(true);
  }
  await node(page, 'feature-delivery.integrate').click();
  await expect(inspector(page).getByTestId('why-blocked')).toContainText('which was superseded by revision 2 and cannot finish');
  await expect(inspector(page).getByTestId('why-blocked')).toContainText('A person must replan or cancel this task.');
});

test('the legend shows only what is drawn, and an edgeless graph says why', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'healthy-parallel-work', 'graph');
  await expect(page.getByTestId('graph-legend')).toHaveCount(0);
  await expect(page.getByTestId('graph-no-edges')).toHaveText('No task here depends on another.');
  const [a, b] = await page.getByTestId('graph-node').all();
  expect((await a!.boundingBox())!.y).toBe((await b!.boundingBox())!.y);
  await openPipeline(page, 'feature-delivery', 'graph');
  await expect(page.getByTestId('graph-legend')).toContainText('Longest chain');
  await expect(page.getByTestId('graph-legend')).not.toContainText('Stale');
});

test('healthy waiting is not labelled held, and a first-layer unknown still draws its stub', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery', 'graph');
  await expect(node(page, 'feature-delivery.review')).not.toContainText('Held');
  await expect(node(page, 'feature-delivery.search')).toContainText('Held');
  await expect(node(page, 'feature-delivery.search')).toContainText('Longest chain');
  await expect(page.getByTestId('pipeline-summary')).toContainText('held (1 approval)');
  await page.goto('about:blank');
  await openHarness(page, { 'feature-delivery.brief': null });
  await expect(page.getByTestId('graph-unknown-stub')).toHaveCount(1);
  await expect(node(page, 'feature-delivery.brief')).toContainText('Dependencies unknown');
});

test('a node names its dependencies in text for a screen reader', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery', 'graph');
  await expect(node(page, 'feature-delivery.integrate')).toContainText('Depends on Feedback API (verified; awaiting merge), Feedback list UI (running), Search index (cannot be placed).');
  await expect(node(page, 'feature-delivery.integrate')).toContainText('Needed by End-to-end checks.');
});

test('null dependencies are not drawn as none, and Why blocked says unknown', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHarness(page, { 'feature-delivery.integrate': null });
  await expect(page.getByTestId('graph-unknown-stub')).toHaveCount(1);
  await expect(node(page, 'feature-delivery.integrate').getByTestId('node-unknown-deps')).toHaveText('Dependencies unknown');
  await expect(page.getByTestId('critical-label')).toContainText('Longest chain unknown');
  await expect(page.getByRole('checkbox', { name: 'Longest chain only' })).toBeDisabled();
  await node(page, 'feature-delivery.integrate').click();
  await expect(inspector(page).getByTestId('why-blocked')).toContainText('Its dependencies are not known yet');
  await expect(inspector(page).getByRole('region', { name: 'Inputs' })).toContainText('Not known yet');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(row(page, 'feature-delivery.integrate')).toContainText('Not known yet');
  await expect(row(page, 'feature-delivery.integrate').locator('td').nth(3)).toHaveText('Not known yet');
});

test('a plan cycle is reported as a plan error with its path', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHarness(page, { 'feature-delivery.e2e': ['feature-delivery.review'] });
  await expect(page.getByTestId('cycle-notice')).toContainText('End-to-end checks → Merge review → End-to-end checks');
  await expect(page.locator('[data-testid="graph-edge"][data-state="cycle"]')).toHaveCount(2);
  // A two-task cycle shares one gap, so the forward edge carries the label and it is not printed twice.
  await expect(page.locator('[data-testid="graph-edge"][data-back="false"][data-state="cycle"] [data-testid="graph-edge-label"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="graph-edge"][data-back="true"] [data-testid="graph-edge-label"]')).toHaveCount(0);
  await expect(page.getByTestId('critical-label')).toContainText('the plan has a cycle');
  await expectNoAxeViolations(page);
});

test('a contract change shows the replan comparison without claiming what it cannot', async ({ page }) => {
  await openPipeline(page, 'contract-change');
  const notice = page.getByTestId('replan-notice');
  await expect(notice).toContainText('Plan moved to revision 2');
  await expect(notice).toContainText('Feedback list UI (contract v2)');
  await expect(notice).toContainText('are not in this snapshot');
});

test('what changes on approval highlights eligible tasks without implying they finish', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'contract-change', 'graph');
  await node(page, 'contract-change.contract').click();
  await expect(inspector(page).getByTestId('if-approved')).toContainText('Becomes eligible once this task is verified');
  await inspector(page).getByRole('button', { name: 'Show on the graph' }).click();
  await expect(node(page, 'contract-change.web')).toHaveAttribute('data-eligible', 'true');
  await expect(page.getByTestId('highlight-notice')).toContainText('does not mean they will finish');
});

test('timestamps are not tab stops in table rows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery');
  await expect(page.locator('[data-testid="pipeline-row"] time[tabindex]')).toHaveCount(0);
});

test('a narrow screen replaces the graph with the list and says so', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openPipeline(page, 'feature-delivery', 'graph');
  await expect(page.getByTestId('graph-unavailable')).toContainText('The graph needs a wider screen');
  await expect(page.getByTestId('pipeline-graph')).toHaveCount(0);
  await expect(page.getByTestId('pipeline-cards')).toBeVisible();
  await expect(row(page, 'feature-delivery.search').getByRole('button', { name: 'Why blocked?' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test('a graph wider than the screen says more stages follow', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await openPipeline(page, 'feature-delivery', 'graph');
  await expect(page.getByTestId('graph-scroll-hint')).toContainText('More stages to the right');
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.getByTestId('graph-scroll-hint')).toHaveCount(0);
});

test('no data is an empty state, not zeros', async ({ page }) => {
  await openPipeline(page, 'no-data');
  await expect(page.getByText('No plan yet')).toBeVisible();
  await expect(page.getByTestId('pipeline-table')).toHaveCount(0);
  await expect(page.getByTestId('pipeline-summary')).toHaveCount(0);
});

test('group by stage can be switched off, and the stage moves into the row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery');
  await page.getByRole('checkbox', { name: 'Group by stage' }).uncheck();
  await expect(page.getByRole('rowheader')).toHaveCount(0);
  await expect(row(page, 'feature-delivery.integrate')).toContainText('Integrate · Task rev 1');
});

test('no source is an honest unavailable state, with the view intact', async ({ page }) => {
  await page.goto('/?demo&fixture=feature-delivery&fault=unavailable#/pipeline');
  await expect(page.getByText('Project data is unavailable')).toBeVisible();
  await expect(page.getByTestId('pipeline-table')).toHaveCount(0);
});

test('a deep link restores the graph view and the selected task', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?demo&fixture=feature-delivery#/pipeline?view=graph&task=feature-delivery.web');
  await expect(node(page, 'feature-delivery.web')).toHaveAttribute('data-selected', 'true');
});

test('no percentage is shown anywhere in the pipeline', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery');
  await expect(page.locator('main')).not.toContainText('%');
  await page.getByRole('button', { name: 'Graph' }).click();
  await expect(page.locator('main')).not.toContainText('%');
});

test('axe finds no violations in the table, graph, inspector, narrow layout and light theme', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPipeline(page, 'feature-delivery');
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Graph' }).click();
  await expect(page.getByTestId('pipeline-graph')).toBeVisible();
  await expectNoAxeViolations(page);
  await node(page, 'feature-delivery.search').click();
  await expect(inspector(page)).toBeVisible();
  await expectNoAxeViolations(page);
  await inspector(page).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Light theme' }).click();
  await expectNoAxeViolations(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByTestId('pipeline-cards')).toBeVisible();
  await expectNoAxeViolations(page);
});
