// One-command local demo: `pnpm dev:demo`. Runs dev-stack (Postgres, migrations, Auth Emulator, control API) plus
// a seeded demo account, project and run, generated plan-config and policy, and the web dev server.
// Everything is local. The account lives only in the Auth Emulator (the seed refuses to run without the emulator host),
// and the generated files go to the git-ignored .local/demo/. policies/default.json is not changed.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Must match DEMO in apps/control-api/src/demo.ts (the seed fails if the UID differs).
const OWNER_UID = 'demo-owner-local';
const EMAIL = 'demo-owner@selarikru.invalid';
const PASSWORD = 'demo-local-only-password';
const PROJECT_ID = 'proj_demo_local';
const RUN_ID = 'run_demo_local';

const dir = resolve('.local/demo');
mkdirSync(dir, { recursive: true });

const budget = process.env.SELARIKRU_DEMO_BUDGET_LIMIT_USD ?? '5';
Object.assign(process.env, {
  SELARIKRU_DEMO: '1',
  SELARIKRU_DEMO_DIR: dir,
  SELARIKRU_OWNER_UID: OWNER_UID,
  SELARIKRU_POLICY_FILE: resolve(dir, 'policy.json'),
  SELARIKRU_PLAN_CONFIG_FILE: resolve(dir, 'plan-config.json'),
  VITE_API_BASE_URL: 'http://127.0.0.1:8787',
  VITE_AUTH_EMULATOR_URL: `http://127.0.0.1:${process.env.SELARIKRU_AUTH_EMULATOR_PORT ?? '9099'}`,
  VITE_DEMO_PROJECT_ID: PROJECT_ID,
  VITE_DEMO_RUN_ID: RUN_ID,
  SELARIKRU_DEMO_BANNER: [
    '',
    '=== SelariKru local demo ===',
    '  Open:      http://127.0.0.1:5173',
    `  Email:     ${EMAIL}`,
    `  Password:  ${PASSWORD}   (emulator-only, not a secret)`,
    `  Project:   ${PROJECT_ID}`,
    `  Run:       ${RUN_ID}   (budget limit ${budget} USD, classification internal)`,
    '  Ctrl+C stops the API, emulator and web server. Postgres keeps running; pnpm db:down stops it.',
    '',
  ].join('\n'),
});

await import('./dev-stack.mjs');
