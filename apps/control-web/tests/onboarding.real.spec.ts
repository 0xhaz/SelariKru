import { expect, test } from '@playwright/test';
import { API_POLICY, OWNER_TOKEN, bearer, enrolRunner, get, makeHarness, post, setupTestDb, testConfig, type TestDb } from '../../control-api/test/helpers.ts';
import type { ReadinessProbes } from '../../control-api/src/index.ts';
import { ORIGIN } from './origin.ts';

/**
 * The whole flow in a browser against the real control API and a throwaway Postgres schema. Only the machine's `git` and `gh` answers are faked, so no real repository or GitHub is touched.
 * This is what would have caught a screen sending requests in an order the server's tests never tried.
 */
test.describe.configure({ mode: 'serial' });

const WEB_ORIGIN = ORIGIN;
const probes: ReadinessProbes = {
  sourceCheckout: '/srv/source',
  git: async () => ({ checkout: { ok: true, reason: 'The checkout is a git repository.' }, identity: { status: 'passed', reason: 'Origin matches.' }, base: { sha: 'a'.repeat(40), reason: 'Resolved.' }, stack: { status: 'passed', reason: 'The frozen contract is there.' } }),
  githubAccess: async () => ({ status: 'passed', reason: 'This account can push.' }),
};

let t: TestDb;
let app: ReturnType<typeof makeHarness>['app'];
let baseUrl: string;

test.beforeAll(async () => {
  try {
    t = await setupTestDb(10);
  } catch (e) {
    throw new Error(`Could not reach the test Postgres. Start it with \`pnpm db:up\` (Compose), then run this spec again. Original error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const policy = { ...API_POLICY, operations: { ...API_POLICY.operations, create_draft_pr: 'allow' } } as const;
  ({ app } = makeHarness(t, { allowedOrigins: testConfig().allowedOrigins.concat(WEB_ORIGIN) }, policy, { readiness: probes, drivers: () => ({ assembly: true, verification: true }), github: { pullRequests: { port: {} as never, repoPath: '/srv/source', loadRecord: async () => null } } }));
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
});
test.afterAll(async () => {
  await app?.close();
  await t?.close();
});

test('the whole setup, in a browser, against the real API, starts one run', async ({ page }) => {
  await page.addInitScript(([url, token]) => { (window as unknown as { __scenario: unknown }).__scenario = { onboardingApi: { baseUrl: url, token } }; }, [baseUrl, OWNER_TOKEN]);
  await page.goto('/tests/harness/index.html#/onboarding');
  const runner = await enrolRunner(app);

  await page.getByRole('button', { name: 'Start a new project' }).click();
  await page.getByLabel('Project name').fill('Clinic queue');
  await page.getByLabel('Your idea').fill('Patients see their place in the queue');
  await page.getByLabel('Who it is for').fill('Small clinics');
  await page.getByLabel('First useful outcome').fill('A patient sees their position');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Is this a new project or an existing app?' })).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await page.getByRole('checkbox', { name: /Pilot stack/ }).check();
  await page.getByRole('radio', { name: 'No', exact: true }).check();
  await page.getByRole('button', { name: 'Draft the blueprint' }).click();

  await page.getByRole('button', { name: 'Accept version 1' }).click();

  await page.getByLabel('Agent budget ceiling, USD').fill('25');
  await page.getByRole('button', { name: 'Save cost plan' }).click();

  await expect(page.getByRole('heading', { name: 'Where should work happen?' })).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Connect the repository' })).toBeVisible();
  await page.getByLabel('GitHub repository').fill('acme/clinic-queue');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Is everything really ready?' })).toBeVisible();
  const list = await get(app, '/v1/onboarding');
  const projectId = list.body.items[0].projectId as string;
  await post(app, '/v1/runners/claim', { projects: [projectId] }, bearer(runner.token));

  await page.getByRole('button', { name: 'Run the checks' }).click();
  await expect(page.getByText('Every required check passed for this blueprint.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('button', { name: 'Start first run' }).click();
  await expect(page.getByRole('heading', { name: 'Your first run is accepted' })).toBeVisible();

  const snapshot = await get(app, `/v1/projects/${projectId}/snapshot`);
  expect(snapshot.status).toBe(200);
  const view = await get(app, `/v1/onboarding/${projectId}`);
  expect(view.body.state).toBe('activated');
  expect(view.body.costPlan.confirmed).toBe(true);
});
