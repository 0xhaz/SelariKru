import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, fixture: string, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((s) => { (window as unknown as { __scenario: unknown }).__scenario = s; }, { spiedFixture: fixture, ...extra });
  await page.goto('/tests/harness/index.html#/evidence');
  await expect(page.getByRole('heading', { name: 'Evidence', level: 1 })).toBeVisible();
}
async function axe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}
const state = (page: Page, key: string) => page.locator(`[data-testid="delivery-state"][data-key="${key}"]`);

test('each criterion links to check and candidate SHA', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, 'merge-review');
  const rows = page.getByTestId('criterion');
  await expect(rows).toHaveCount(5);
  for (const row of await rows.all()) {
    await expect(row.getByTestId('criterion-check')).toHaveAttribute('href', /check=/);
    await expect(row.getByTestId('criterion-candidate')).toHaveAttribute('href', /candidate=c{40}/);
  }
  await rows.first().getByTestId('criterion-check').click();
  await expect(page.locator('tr[id^="check-"]:not([hidden])').first()).toContainText('Verification record');
  await rows.first().getByTestId('criterion-candidate').click();
  await expect(page.getByTestId('candidate-sha')).toHaveText('c'.repeat(40));
  await axe(page);
});

test('verified, merged, deployed render as distinct states', async ({ page }) => {
  await open(page, 'merge-review');
  await expect(state(page, 'verified')).toContainText('Verified');
  await expect(state(page, 'verified')).toHaveAttribute('data-established', 'true');
  await expect(state(page, 'merged')).toContainText('Not merged');
  await expect(state(page, 'merged')).toHaveAttribute('data-established', 'false');
  await expect(state(page, 'deployed')).toContainText('Not established');
  await expect(state(page, 'deployed')).toHaveAttribute('data-established', 'false');
  await axe(page);
});

test('a failed criterion says why, as text only, with no markup from the failure message', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, 'failed-ci');
  const list = page.getByTestId('failure-list').first();
  await expect(list).toBeVisible();
  await expect(list).toContainText('expected <li> to contain');
  await expect(list.locator('li li')).toHaveCount(0);
  await axe(page);
});

test('failure text is labelled as test output', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, 'failed-ci');
  await expect(page.getByTestId('failure-list').first().getByTestId('failure-output-label')).toHaveText('Test output');
});

test('a failed load can be retried and then shows the failure', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, 'failed-ci', { refuseFailureLoads: true });
  const error = page.getByTestId('failure-load-error').first();
  await expect(error).toContainText('could not be loaded');
  const retry = error.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeEnabled();
  await page.evaluate(() => (window as unknown as { __allowFailureLoads: () => void }).__allowFailureLoads());
  await retry.click();
  await expect(page.getByTestId('failure-list').first()).toContainText('expected <li> to contain');
  await axe(page);
});

test('retrying is off with the reason given while the connection is down', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, 'failed-ci', { fault: 'reconnecting' });
  const error = page.getByTestId('failure-load-error').first();
  await expect(error.getByRole('button', { name: 'Try again' })).toBeDisabled();
  await expect(error).toContainText('once the connection is back');
});

test('a criterion that was not delivered does not read as still to come', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, 'budget-stop');
  const row = page.locator('tr[data-testid="criterion"][data-state="not_delivered"]').first();
  await expect(row.getByTestId('criterion-judged')).toHaveText('Not delivered');
  await expect(page.locator('tr[data-testid="criterion"][data-state="not_delivered"] [data-testid="criterion-judged"]', { hasText: 'Not yet' })).toHaveCount(0);
});

test('a fixture with no per-criterion evidence says so and never counts tasks', async ({ page }) => {
  await open(page, 'feature-delivery');
  await expect(page.getByTestId('evidence-coverage')).toHaveText(/not connected/);
  await expect(page.getByTestId('criterion')).toHaveCount(0);
  await axe(page);
});

// ---- the wire: a small server speaking the control API's snapshot and SSE formats, driven by the test.
interface Wire { base: string; server: Server; drop(): void; refuse(on: boolean): void; append(n?: number): void; approval: { granted: number }; close(): void; sent: number[] }

function wire(): Promise<Wire> {
  let head = 3;
  let refusing = false;
  const streams = new Set<ServerResponse>();
  const approval = { granted: 0 };
  const sent: number[] = [];
  const event = (sequence: number) => ({ schemaVersion: 1, eventId: `evt_${sequence}`, projectId: 'p', runId: 'r', taskId: 'r', attemptId: null, type: 'candidate.assembled', sequence, aggregateRevision: 1, actor: { kind: 'integration', id: 'i' }, occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), causationId: null, traceId: 't', payload: {} });
  const snapshot = () => ({
    projectId: 'p', cursor: head, generatedAt: new Date().toISOString(), modelCatalog: { status: 'none', detail: null, projectDefault: null, providers: [] }, modelAssignments: [], limits: { maxConcurrentTotal: 2 }, runners: [], checks: [], usage: [], clientReports: [],
    runs: [{ runId: 'r', lifecycle: 'running', planRevision: 1, pinnedModel: null, latestEvidence: null, criteria: null, evidence: null, reducedScope: null, scopeAssessment: null }],
    tasks: [{ taskId: 't', runId: 'r', revision: 1, aggregateRevision: 1, status: 'awaiting_approval', placementBlock: null, blockedReason: null, title: 'Search index', role: 'backend', dependsOn: [], enteredStatusAt: '2026-11-09T01:00:00.000Z', latestEvidence: null, attempts: [], cancel: null }],
    approvals: [{ outcome: 'pending', approvalId: 'a1', runId: 'r', taskId: 't', revision: 1, requester: 'scheduler', scopeHash: 's', expiresAt: '2099-01-01T00:00:00.000Z', requestedAt: '2026-11-09T01:00:00.000Z', resolvedAt: null, operation: 'start_cloud_worker', reason: 'configured_require_approval:start_cloud_worker', destination: null }],
    approvalHistory: [], changeRequests: [],
  });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (refusing) { res.writeHead(503, cors); res.end('{}'); return; }
    if (req.url?.includes('/snapshot')) { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(snapshot())); return; }
    if (req.url?.includes('/events')) {
      const after = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? 0);
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
      for (let i = after + 1; i <= head; i += 1) { sent.push(i); res.write(`id: ${i}\ndata: ${JSON.stringify(event(i))}\n\n`); }
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    // This wire serves no Project Brain: the Decisions screen asks for one and is told there is none.
    if (req.url?.includes('/brain')) { res.writeHead(404, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } })); return; }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    approval.granted += 1;
    res.end(JSON.stringify({ approvalId: 'a1', outcome: 'granted', taskStatus: 'ready' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, approval, sent,
        drop() { for (const s of streams) s.destroy(); streams.clear(); },
        refuse(on) { refusing = on; },
        append(n = 1) { for (let i = 0; i < n; i += 1) { head += 1; for (const s of streams) { sent.push(head); s.write(`id: ${head}\ndata: ${JSON.stringify(event(head))}\n\n`); } } },
        close() { for (const s of streams) s.destroy(); server.close(); },
      });
    });
  });
}

test('drop during restart shows last-confirmed time, disables privileged actions, replays without gaps or duplicates', async ({ page }) => {
  const api = await wire();
  try {
    await page.addInitScript((s) => { (window as unknown as { __scenario: unknown }).__scenario = s; }, { liveApi: { baseUrl: api.base, token: 'test-token', projectId: 'p' } });
    await page.goto('/tests/harness/index.html#/decisions');
    const grant = page.getByRole('button', { name: 'Grant cloud start' });
    await expect(grant).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByTestId('freshness')).toContainText('Live');

    // The server goes away with the decision card open: a restart.
    api.refuse(true);
    api.drop();
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toContainText('Reconnecting', { timeout: 10_000 });
    await expect(banner).toContainText(/last confirmed state from \d/i);
    await expect(page.getByTestId('freshness')).toContainText('Reconnecting');
    await expect(page.getByTestId('freshness')).toContainText('last confirmed');
    await expect(grant).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Deny and block task' })).toBeDisabled();
    await expect(page.getByTestId('connection-banner')).not.toContainText('stream stopped');
    expect(api.approval.granted).toBe(0);
    await new AxeBuilder({ page }).analyze().then((r) => expect(r.violations).toEqual([]));

    // It comes back, having moved on while no client was connected.
    api.append(4);
    api.refuse(false);
    await expect(page.getByTestId('freshness')).toContainText('Live', { timeout: 15_000 });
    await expect(grant).toBeEnabled();
    await page.waitForFunction(() => (window as unknown as { __projection: { getState(): { projection: { snapshot: { meta: { cursor: string } } } | null } } }).__projection.getState().projection?.snapshot.meta.cursor === '7');

    // Replay: everything delivered after the reconnect is gapless and nothing arrives twice.
    api.append(3);
    await page.waitForFunction(() => (window as unknown as { __calls: { sequences: number[] } }).__calls.sequences.includes(10));
    const sequences = await page.evaluate(() => (window as unknown as { __calls: { sequences: number[] } }).__calls.sequences);
    expect(sequences).toEqual([8, 9, 10]);
    await grant.click();
    await expect.poll(() => api.approval.granted).toBe(1);
  } finally {
    api.close();
  }
});
