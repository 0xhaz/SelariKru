import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const CANARY = 'CANARY-RESTRICTED-FAKE-0000-DO-NOT-EXPORT';

async function open(page: Page, scenario: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((s) => {
    (window as unknown as { __scenario: unknown }).__scenario = s;
  }, scenario);
  await page.goto('/tests/harness/index.html');
  await expect(page.getByRole('heading', { name: 'Assistant', level: 1 })).toBeVisible();
}

const calls = (page: Page) => page.evaluate(() => (window as any).__calls as { adapter: any[]; api: any[] });
const choose = async (page: Page, policy: string) => page.getByRole('radio', { name: policy }).check();
const indicator = (page: Page) => page.getByRole('region', { name: 'Assistant inference' });

async function pickOperation(page: Page, label: string) {
  await page.getByLabel('Operation').selectOption({ label });
}
async function generate(page: Page) {
  await page.getByRole('button', { name: 'Generate draft' }).click();
}

test('download progress distinct from generation', async ({ page }) => {
  await open(page, { device: 'downloadable', downloadProgress: [0.25, 0.6], holdDownload: true });

  // Download starts only from a click.
  await page.waitForTimeout(300);
  expect((await calls(page)).adapter.filter((c) => c.kind === 'download')).toHaveLength(0);
  await expect(indicator(page).getByTestId('inf-readiness')).toContainText('Needs download');

  await page.getByRole('button', { name: 'Download on-device model' }).click();
  const bar = page.getByRole('progressbar', { name: 'On-device model download' });
  await expect(bar).toHaveAttribute('aria-valuenow', '60');
  await expect(indicator(page).getByTestId('inf-readiness')).toContainText('Downloading');

  // Generation and delivered criteria are untouched while the download runs.
  await expect(page.getByTestId('generation-status')).toHaveText('Generation: not started');
  await expect(page.getByRole('region', { name: 'Draft output' })).toContainText('No draft yet');
  await expect(page.getByRole('button', { name: 'Generate draft' })).toBeDisabled();
  expect((await calls(page)).adapter.filter((c) => c.kind !== 'download')).toHaveLength(0);

  await page.evaluate(() => (window as any).__releaseDownload());
  await expect(bar).toBeHidden();
  await expect(indicator(page).getByTestId('inf-readiness')).toContainText('Ready');
  await expect(page.getByTestId('generation-status')).toHaveText('Generation: not started');
});

test('unknown source labeled unknown', async ({ page }) => {
  await open(page, { proposal: { observedSource: 'UNKNOWN', rawInferenceSource: null } });
  await choose(page, 'Cloud preferred');
  await generate(page);
  const ind = indicator(page);
  await expect(ind.getByTestId('inf-source')).toContainText('Unknown');
  await expect(ind.getByTestId('inf-source')).not.toContainText('On-device');
  await expect(ind.getByTestId('inf-policy')).toContainText('Cloud preferred');
  await expect(ind.getByTestId('inf-elapsed')).toHaveText('1.23 s');
  await expect(ind.getByTestId('inf-validation')).toContainText('Schema check passed');
});

test('blocked fallback explained without showing prompt text', async ({ page }) => {
  await open(page, {
    device: 'downloadable',
    proposal: { status: 'blocked', blockedReason: 'device_downloadable', requestedMode: 'ONLY_ON_DEVICE', observedSource: 'UNKNOWN' },
  });
  await page.getByLabel('Brief', { exact: true }).selectOption('restricted-brief');
  await choose(page, 'Device preferred');
  await generate(page);

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Blocked by data policy');
  await expect(alert).toContainText('no cloud fallback');
  await expect(alert).toContainText('device_downloadable');
  await expect(indicator(page).getByTestId('inf-policy')).toContainText('Device only');
  await expect(indicator(page).getByTestId('inf-source')).toContainText('No response');

  const text = (await page.locator('body').innerText()) + (await page.content());
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain('Internal note');
  expect(text).not.toContain('trimmed title');
});

test('accepting a proposal creates a plan revision through the API', async ({ page }) => {
  await open(page, { proposal: { observedSource: 'IN_CLOUD', rawInferenceSource: 'in_cloud' } });
  await pickOperation(page, 'Draft task plan');
  await choose(page, 'Cloud preferred');
  await generate(page);

  await expect(page.getByRole('button', { name: 'Accept plan' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review with server' }).click();
  const handoff = page.getByRole('region', { name: 'Handoff to workflow' });
  await expect(handoff).toContainText('Build FB-01');
  await page.getByRole('button', { name: 'Accept plan' }).click();
  await expect(handoff).toContainText('Plan revision 4 created');

  const { api } = await calls(page);
  const kinds = api.map((c) => c.kind);
  expect(kinds).toEqual(['review', 'plan-revision', 'client-report']);
  expect(api[0].body.runId).toBe('run-1');
  expect(api[0].body.envelope).toMatchObject({ operation: 'draftTaskPlan', status: 'ok' });
  expect(api[1].body.expectedRevision).toBe(3);
  expect(api[1].body.tasks.map((t: any) => t.taskId)).toEqual(['prop-1', 'prop-2']);
  expect(api[2].body.taskId).toBe('prop-1');
  expect(api[2].body.report).toEqual({ kind: 'inference', mode: 'PREFER_IN_CLOUD', observedSource: 'in_cloud', model: 'gemini-3.5-flash-lite' });
  expect(JSON.stringify(api[2].body)).not.toContain('Build FB');
});

test('material criteria change requires engineer acceptance', async ({ page }) => {
  // brief-01 scope is FB-01 and FB-02; the draft drops FB-02.
  await open(page, { data: { tasks: [{ title: 'Build FB-01', description: 'Implement FB-01', requirementIds: ['FB-01'] }] } });
  await pickOperation(page, 'Draft task plan');
  await generate(page);
  await page.getByRole('button', { name: 'Review with server' }).click();

  const handoff = page.getByRole('region', { name: 'Handoff to workflow' });
  await expect(handoff).toContainText('Criteria coverage change');
  await expect(handoff).toContainText('FB-02');
  const accept = page.getByRole('button', { name: 'Accept plan' });
  await expect(accept).toBeDisabled();
  expect((await calls(page)).api.map((c) => c.kind)).toEqual(['review']);

  await page.getByRole('checkbox', { name: /I accept this change to the criteria coverage/ }).check();
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(handoff).toContainText('Plan revision 4 created');
  expect((await calls(page)).api.map((c) => c.kind)).toEqual(['review', 'plan-revision', 'client-report']);
});

test('fixture output visibly marked and excluded from evidence', async ({ page }) => {
  await open(page);
  await page.getByRole('checkbox', { name: /Use demo output/ }).check();
  await pickOperation(page, 'Draft task plan');
  await generate(page);

  const out = page.getByRole('region', { name: 'Draft output' });
  await expect(out.getByText('Demo data', { exact: true })).toBeVisible();
  await expect(indicator(page).getByTestId('inf-source')).toContainText('Demo data');
  await expect(indicator(page).getByTestId('inf-source')).not.toContainText('On-device');
  await expect(out).toContainText('Not evidence');
  await expect(page.getByRole('button', { name: 'Review with server' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept plan' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Handoff to workflow' })).toContainText('Demo data cannot be accepted');

  const c = await calls(page);
  expect(c.adapter).toHaveLength(0);
  expect(c.api).toHaveLength(0);
});

for (const status of ['route_violation', 'unverified_source'] as const) {
  test(`${status} cannot be accepted and shows no output`, async ({ page }) => {
    await open(page, {
      proposal: { status, blockedReason: status === 'route_violation' ? 'cloud_source_without_approval' : 'source_not_shown_on_device', observedSource: status === 'route_violation' ? 'IN_CLOUD' : 'UNKNOWN' },
    });
    await pickOperation(page, 'Draft task plan');
    await choose(page, 'Device only');
    await generate(page);
    await expect(page.getByRole('alert')).toContainText('cannot be accepted');
    await expect(page.getByRole('button', { name: 'Review with server' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Draft output' })).not.toContainText('Build FB');
    expect((await calls(page)).api).toHaveLength(0);
  });
}

test('restricted draft is viewable in place, held in memory, and nothing posts it', async ({ page }) => {
  await open(page);
  await page.getByLabel('Brief', { exact: true }).selectOption('restricted-brief');
  await generate(page);

  const out = page.getByRole('region', { name: 'Draft output' });
  await expect(out).toContainText('Restricted draft');
  await expect(out).toContainText('Criterion for FB-01');
  await expect(page.getByRole('region', { name: 'Handoff to workflow' })).toContainText('stays on this device');
  await expect(page.getByRole('button', { name: 'Review with server' })).toHaveCount(0);

  const state = await page.evaluate(() => ({
    store: JSON.stringify((window as any).__store.getState()),
    held: (window as any).__hold.toJSON().held,
    ls: JSON.stringify({ ...localStorage }),
    ss: JSON.stringify({ ...sessionStorage }),
  }));
  expect(state.held).toBe(1);
  for (const blob of [state.store, state.ls, state.ss]) {
    expect(blob).not.toContain('Criterion for');
    expect(blob).not.toContain(CANARY);
  }
  expect((await calls(page)).api).toHaveLength(0);

  await page.getByRole('button', { name: 'Discard draft' }).click();
  expect(await page.evaluate(() => (window as any).__hold.toJSON().held)).toBe(0);
  await expect(out).not.toContainText('Criterion for FB-01');
});

test('server acknowledgement is required for each issue path before acceptance', async ({ page }) => {
  const key = 'forbidden_scope:/tasks/0/description';
  await open(page, {
    data: { tasks: [{ title: 'Add sign in', description: 'Add login for users', requirementIds: ['FB-01', 'FB-02'] }] },
    review: [
      { ok: false, status: 409, code: 'acknowledgement_required', message: 'acknowledge', details: { paths: [key] } },
      { ok: true, value: { expectedRevision: 0, needsReview: true, droppedFields: [], issues: [{ kind: 'forbidden_scope', path: '/tasks/0/description', message: 'mentions login' }], tasks: [{ taskId: 'prop-1', title: 'Add sign in', requirementIds: ['FB-01', 'FB-02'] }] } },
    ],
  });
  await pickOperation(page, 'Draft task plan');
  await generate(page);
  await page.getByRole('button', { name: 'Review with server' }).click();

  const again = page.getByRole('button', { name: 'Review again with acknowledgements' });
  await expect(again).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Handoff to workflow' })).toContainText('forbidden_scope');
  await page.getByRole('checkbox', { name: /forbidden_scope.*\/tasks\/0\/description/ }).check();
  await again.click();
  await expect(page.getByRole('button', { name: 'Accept plan' })).toBeEnabled();

  const { api } = await calls(page);
  expect(api[0].body.acknowledgedIssuePaths ?? []).toEqual([]);
  expect(api[1].body.acknowledgedIssuePaths).toEqual([key]);
});

test('stale plan revision asks for a fresh review instead of retrying', async ({ page }) => {
  await open(page, { planRevision: { ok: false, status: 409, code: 'stale_revision', message: 'stale', details: { currentRevision: 5 } } });
  await pickOperation(page, 'Draft task plan');
  await generate(page);
  await page.getByRole('button', { name: 'Review with server' }).click();
  await page.getByRole('button', { name: 'Accept plan' }).click();
  await expect(page.getByRole('alert')).toContainText('plan changed');
  expect((await calls(page)).api.map((c) => c.kind)).toEqual(['review', 'plan-revision']);
});

test('API client sends the owner bearer token and the expected revision', async ({ page }) => {
  const seen: { url: string; auth: string | undefined; body: any }[] = [];
  await page.route('http://api.test/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    seen.push({ url: req.url(), auth: req.headers()['authorization'], body: req.postDataJSON() });
    const json = req.url().endsWith('/proposals/review')
      ? { expectedRevision: 7, needsReview: false, droppedFields: [], issues: [], tasks: [{ taskId: 'prop-1', title: 'Build FB-01', requirementIds: ['FB-01'] }, { taskId: 'prop-2', title: 'Build FB-02', requirementIds: ['FB-02'] }] }
      : req.url().endsWith('/plan-revisions')
        ? { planRevision: 8, taskIds: ['prop-1'] }
        : { reportId: 'rpt-9', trust: 'untrusted' };
    return route.fulfill({ status: req.url().endsWith('/client-reports') || req.url().endsWith('/plan-revisions') ? 201 : 200, headers: cors, contentType: 'application/json', body: JSON.stringify(json) });
  });
  await open(page, { realApi: { baseUrl: 'http://api.test', token: 'owner-token-1' } });
  await pickOperation(page, 'Draft task plan');
  await generate(page);
  await page.getByRole('button', { name: 'Review with server' }).click();
  await page.getByRole('button', { name: 'Accept plan' }).click();
  await expect(page.getByRole('region', { name: 'Handoff to workflow' })).toContainText('Plan revision 8 created');

  expect(seen.map((s) => new URL(s.url).pathname)).toEqual(['/v1/runs/run-1/proposals/review', '/v1/runs/run-1/plan-revisions', '/v1/tasks/prop-1/client-reports']);
  expect(seen.every((s) => s.auth === 'Bearer owner-token-1')).toBe(true);
  expect(seen[1]!.body.expectedRevision).toBe(7);
});

test.describe('accessibility', () => {
  const scan = async (page: Page) => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  };

  test('initial and downloadable states', async ({ page }) => {
    await open(page, { device: 'downloadable' });
    await scan(page);
  });
  test('draft result and handoff ready', async ({ page }) => {
    await open(page);
    await pickOperation(page, 'Draft task plan');
    await generate(page);
    await page.getByRole('button', { name: 'Review with server' }).click();
    await expect(page.getByRole('button', { name: 'Accept plan' })).toBeEnabled();
    await scan(page);
  });
  test('blocked and demo states', async ({ page }) => {
    await open(page, { proposal: { status: 'blocked', blockedReason: 'device_unavailable', observedSource: 'UNKNOWN' } });
    await generate(page);
    await expect(page.getByRole('alert')).toBeVisible();
    await scan(page);
    await page.getByRole('checkbox', { name: /Use demo output/ }).check();
    await generate(page);
    await expect(page.getByRole('region', { name: 'Draft output' }).getByText('Demo data', { exact: true })).toBeVisible();
    await scan(page);
  });
});
