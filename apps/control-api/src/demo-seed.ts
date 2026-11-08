import { createDb } from '@selarikru/persistence';
import { DEMO, assertEmulatorHost, ensureEmulatorAccount, seedDemo, writeDemoFiles } from './demo.ts';

// Run by pnpm dev:demo after the database and the Auth Emulator are up. Refuses to run without an emulator host.
try {
  const host = assertEmulatorHost(process.env);
  if (process.env['SELARIKRU_OWNER_UID'] !== DEMO.ownerUid) throw new Error(`SELARIKRU_OWNER_UID must be ${DEMO.ownerUid} for the demo`);
  const url = process.env['DATABASE_URL'];
  const tenantId = process.env['SELARIKRU_TENANT_ID'];
  const dir = process.env['SELARIKRU_DEMO_DIR'];
  if (!url || !tenantId || !dir) throw new Error('DATABASE_URL, SELARIKRU_TENANT_ID and SELARIKRU_DEMO_DIR are required');
  const raw = process.env['SELARIKRU_DEMO_BUDGET_LIMIT_USD'];
  const budgetLimitUsd = raw === undefined || raw === '' ? DEMO.budgetLimitUsd : Number(raw);
  if (!Number.isFinite(budgetLimitUsd) || budgetLimitUsd < 0) throw new Error('SELARIKRU_DEMO_BUDGET_LIMIT_USD must be a number >= 0');
  await ensureEmulatorAccount(host, process.env['FIREBASE_PROJECT_ID'] ?? 'selarikru');
  const { db, close } = createDb(url, { max: 1 });
  const { created } = await seedDemo(db, { tenantId, budgetLimitUsd });
  await close();
  writeDemoFiles(dir, { tenantId });
  console.log(created ? 'demo project and run seeded' : 'demo project and run already present');
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
