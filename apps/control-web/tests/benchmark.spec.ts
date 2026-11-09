import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { BenchmarkFile } from '../src/features/benchmark/schema.ts';
import { assistantCohort, benchmarkFile, completeAssistant, completeWorkers, partialFile, workerCohort, workerRecord } from '../src/features/benchmark/testing.ts';

async function open(page: Page, file: BenchmarkFile | 'absent' | { invalid: string }, tab: 'Assistant' | 'Workers' = 'Workers'): Promise<void> {
  await page.route('**/benchmark-results.json', (route) => {
    if (file === 'absent') return route.fulfill({ status: 404, body: 'none' });
    if ('invalid' in file) return route.fulfill({ status: 200, contentType: 'application/json', body: file.invalid });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(file) });
  });
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'merge-review', observed: true }; });
  await page.goto('/tests/harness/index.html#/benchmark');
  await expect(page.getByRole('heading', { name: 'Benchmark', level: 1 })).toBeVisible();
  await expect(page.getByTestId('benchmark-status')).toBeVisible();
  if (tab === 'Workers') await page.getByRole('tab', { name: 'Workers' }).click();
}
async function axe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}
const measuredComplete = (): BenchmarkFile => benchmarkFile({ records: [...completeWorkers('measured'), ...completeAssistant('measured')] });

test('the Benchmark nav item opens the panel', async ({ page }) => {
  await page.route('**/benchmark-results.json', (route) => route.fulfill({ status: 404, body: 'none' }));
  await page.addInitScript(() => { (window as unknown as { __scenario: unknown }).__scenario = { spiedFixture: 'merge-review', observed: true }; });
  await page.goto('/tests/harness/index.html#/overview');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Benchmark' }).click();
  await expect(page.getByRole('heading', { name: 'Benchmark', level: 1 })).toBeVisible();
  await expect(page).toHaveTitle(/Benchmark/);
});

test('reads "Not measured" with no results', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'absent', 'Assistant');
  await expect(page.getByTestId('benchmark-status')).toContainText('Not measured');
  for (const tab of ['Assistant', 'Workers']) {
    await page.getByRole('tab', { name: tab }).click();
    const figures = page.getByTestId('figure');
    const count = await figures.count();
    expect(count).toBeGreaterThan(4);
    for (let i = 0; i < count; i += 1) {
      const text = (await figures.nth(i).innerText());
      expect(text).toContain('Not measured');
      expect(text).not.toMatch(/\d/);
    }
    await expect(page.getByTestId('winner-badge')).toHaveCount(0);
    await axe(page);
  }
  await expect(page.getByTestId('worker-row')).toHaveCount(3);
});

test('Assistant and Workers tabs', async ({ page }) => {
  await open(page, measuredComplete(), 'Assistant');
  await expect(page.getByRole('tab', { name: 'Assistant' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('assistant-table').first()).toBeVisible();
  await expect(page.getByTestId('worker-table')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Assistant' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Workers' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Workers' })).toBeFocused();
  await expect(page.getByTestId('worker-table').first()).toBeVisible();
  await expect(page.getByTestId('assistant-table')).toHaveCount(0);
});

test('worker rows separate execution host from inference destination', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, measuredComplete());
  const l1 = page.locator('[data-testid="worker-row"][data-mode="L1"]');
  await expect(l1.getByTestId('execution-host')).toHaveText('Local sandbox');
  await expect(l1.getByTestId('inference-destination')).toHaveText('Model in cloud');
  const c1 = page.locator('[data-testid="worker-row"][data-mode="C1"]');
  await expect(c1.getByTestId('execution-host')).toHaveText('Cloud sandbox');
  await expect(c1.getByTestId('inference-destination')).toHaveText('Model in cloud');
  await expect(page.getByRole('columnheader', { name: 'Execution host' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Inference destination' })).toBeVisible();
});

test('H2 carries a two-worker label', async ({ page }) => {
  await open(page, measuredComplete());
  await expect(page.locator('[data-testid="worker-row"][data-mode="H2"]').getByTestId('worker-label')).toContainText('Two coding workers');
  await expect(page.locator('[data-testid="worker-row"][data-mode="L1"]').getByTestId('worker-label')).toContainText('One coding worker');
  const h2L1 = page.locator('[data-testid="comparison"][data-id="H2-L1"]');
  await expect(h2L1.getByTestId('capacity-note')).toContainText('H2 has two coding workers, L1 has one');
  await expect(page.locator('[data-testid="comparison"][data-id="L1-C1"]').getByTestId('capacity-note')).toHaveCount(0);
});

test('failed trials stay listed', async ({ page }) => {
  await open(page, partialFile());
  const statuses = page.getByTestId('attempt').filter({ has: page.locator(':scope') });
  await expect(page.locator('[data-testid="attempt"][data-status="Failed"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="attempt"][data-status="Abandoned"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="attempt"][data-status="Failed checks"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="attempt"][data-status="Not run"]')).toHaveCount(2);
  await expect(statuses).toHaveCount(8);
  const counts = page.locator('[data-testid="worker-row"][data-mode="L1"]').getByTestId('attempt-counts');
  await expect(counts).toContainText('2 failed');
  await expect(counts).toContainText('1 abandoned');
  await expect(page.locator('[data-testid="worker-row"][data-mode="L1"]')).toContainText('2 of 5 passed');
  await expect(page.locator('[data-testid="attempt"][data-status="Failed"]').getByTestId('attempt-failure')).toBeVisible();
  await axe(page);
});

test('no winner badge on incomplete or mismatched cohorts', async ({ page }) => {
  await open(page, partialFile());
  await expect(page.getByTestId('winner-badge')).toHaveCount(0);
  await expect(page.locator('[data-testid="comparison"][data-id="L1-C1"]').getByTestId('no-winner')).toBeVisible();
  await expect(page.locator('[data-testid="comparison"][data-id="L1-C1"]').getByTestId('no-winner-reasons')).toContainText('C1:');
  await expect(page.locator('[data-testid="worker-row"][data-mode="H2"]')).toContainText('Not measured');
});

test('no winner badge when a matched dimension differs', async ({ page }) => {
  const records = completeWorkers('measured');
  records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', ms: 1_200_000, config: { codingModel: 'other-model' } });
  await open(page, benchmarkFile({ records }));
  await expect(page.locator('[data-testid="comparison"][data-id="L1-C1"]').getByTestId('winner-badge')).toHaveCount(0);
  await expect(page.locator('[data-testid="comparison"][data-id="L1-C1"]').getByTestId('no-winner-reasons')).toContainText('Not the same model');
});

test('a measured, complete, matched cohort shows the winner badge and says what it means', async ({ page }) => {
  await open(page, measuredComplete());
  const l1c1 = page.locator('[data-testid="comparison"][data-id="L1-C1"]');
  await expect(l1c1.getByTestId('winner-badge')).toContainText('Winner on this cohort: C1');
  await expect(l1c1).toContainText('On this fixture and configuration, 5 of 5 attempts passed');
  await expect(l1c1).toContainText('not a general claim');
  const h2 = page.locator('[data-testid="comparison"][data-id="H2-L1"]');
  await expect(h2.getByTestId('winner-badge')).toHaveCount(0);
  await expect(h2.getByTestId('descriptive-verdict')).toContainText('no winner');
  await expect(h2.getByTestId('comparison-sides')).toContainText('with twice the coding capacity');
  await axe(page);
});

test('simulated data never enters totals', async ({ page }) => {
  await open(page, benchmarkFile({ records: [...completeWorkers('simulated'), ...completeAssistant('simulated')] }));
  await expect(page.getByTestId('benchmark-status')).toHaveAttribute('data-state', 'not-measured');
  const simulated = page.getByTestId('simulated-section');
  await expect(simulated).toBeVisible();
  await expect(page.getByTestId('benchmark-status')).toContainText('Only simulated records exist');
  await expect(simulated.getByRole('heading', { level: 2 })).toContainText('Simulated');
  await expect(simulated.getByTestId('cohort-kind').first()).toContainText('Simulated');
  await expect(page.getByTestId('winner-badge')).toHaveCount(0);
  await expect(simulated.getByTestId('no-winner-reasons').first()).toContainText('Simulated');
  const cost = simulated.locator('[data-testid="worker-row"][data-mode="L1"]').getByTestId('figure').filter({ hasText: '$' }).first();
  await expect(cost).toContainText('Simulated');
  await axe(page);
});

test('a mixed file shows only measured attempts in the totals', async ({ page }) => {
  await open(page, benchmarkFile({ records: [...completeWorkers('measured').slice(0, 5), ...completeWorkers('simulated', {}, 'cohort-sim')], cohorts: [workerCohort(), workerCohort({ cohortId: 'cohort-sim' }), assistantCohort()] }));
  await expect(page.getByTestId('worker-totals')).toContainText('Worker attempts: 5');
  await expect(page.getByTestId('assistant-totals')).toContainText('Assistant requests: Not measured');
  await expect(page.getByTestId('simulated-section')).toBeVisible();
});

test('a confounded comparison has no badge and says so', async ({ page }) => {
  const records = completeWorkers('measured');
  records[0] = workerRecord({ mode: 'L1', index: 0, dataKind: 'measured', ms: 1_200_000, confounders: ['ARM laptop against x86 VM'] });
  await open(page, benchmarkFile({ records }));
  const c = page.locator('[data-testid="comparison"][data-id="L1-C1"]');
  await expect(c.getByTestId('winner-badge')).toHaveCount(0);
  await expect(c).toContainText('End-to-end configuration comparison');
  await expect(c.getByTestId('no-winner-reasons')).toContainText('ARM laptop against x86 VM');
});

test('human-intervened attempts are listed and excluded', async ({ page }) => {
  const records = completeWorkers('measured');
  records[3] = workerRecord({ mode: 'L1', index: 3, dataKind: 'measured', humanIntervened: true, ms: 1_260_000 });
  await open(page, benchmarkFile({ records }));
  await expect(page.locator('[data-testid="worker-row"][data-mode="L1"]').getByTestId('human-excluded')).toHaveText('1 human-intervened, not compared');
  await expect(page.getByTestId('attempt').filter({ hasText: 'l1-3-measured' })).toContainText('Human-intervened, excluded');
  await expect(page.locator('[data-testid="comparison"][data-id="L1-C1"]').getByTestId('winner-badge')).toHaveCount(0);
  await expect(page.getByTestId('exclusions')).toContainText('human-intervened');
});

test('a broken results file shows no numbers and says why', async ({ page }) => {
  await open(page, { invalid: '{"protocolVersion":"0.1","generatedAtUtc":"2026-11-20T10:00:00.000Z","cohorts":[],"records":[],"assistantEvidence":[],"surprise":true}' });
  await expect(page.getByTestId('benchmark-status')).toHaveAttribute('data-state', 'invalid');
  await expect(page.getByTestId('benchmark-status')).toContainText('Not measured');
  await expect(page.getByTestId('file-issues')).toBeVisible();
  await expect(page.locator('[data-testid="worker-row"][data-mode="L1"]').getByTestId('figure').first()).toContainText('Not measured');
  await axe(page);
});

for (const width of [1440, 1024, 768, 375]) {
  test(`nothing scrolls sideways at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, benchmarkFile({ records: [...completeWorkers('simulated'), ...completeAssistant('simulated')] }));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole('tab', { name: 'Workers' })).toBeVisible();
    await axe(page);
  });
}

test('in the light theme nothing fails contrast', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('selarikru.theme', 'light'));
  await open(page, partialFile());
  await axe(page);
  await page.getByRole('tab', { name: 'Assistant' }).click();
  await axe(page);
});
