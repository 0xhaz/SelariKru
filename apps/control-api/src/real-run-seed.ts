import { createDb } from '@selarikru/persistence';
import { readRealRunConfig, seedRealRun, writeRealRunFiles } from './real-run.ts';

// Run by `pnpm dev:real` after the database is up. No network call: everything comes from the environment and the local checkout.
try {
  const url = process.env['DATABASE_URL'];
  const dir = process.env['SELARIKRU_REAL_RUN_DIR'];
  if (!url || !dir) throw new Error('DATABASE_URL and SELARIKRU_REAL_RUN_DIR are required');
  const cfg = readRealRunConfig(process.env);
  const { db, close } = createDb(url, { max: 1 });
  const { created } = await seedRealRun(db, cfg);
  await close();
  writeRealRunFiles(dir, cfg);
  console.log(`${created ? 'seeded' : 'already present'}: ${cfg.projectId} (${cfg.repository}) at ${cfg.baseSha}, run ${cfg.runId}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
