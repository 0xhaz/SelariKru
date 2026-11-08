import { ConfigError, loadConfigFromEnv } from './config.ts';
import { startServer } from './server.ts';

try {
  const config = loadConfigFromEnv(process.env);
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new ConfigError('missing required configuration: DATABASE_URL', ['DATABASE_URL']);
  const server = await startServer({
    config,
    databaseUrl,
    policyFile: process.env['SELARIKRU_POLICY_FILE'] || undefined,
    planConfigFile: process.env['SELARIKRU_PLAN_CONFIG_FILE'] || undefined,
    onError: (e) => console.error('lease expiry pass failed:', e instanceof Error ? e.message : e),
  });
  console.log(`control API listening on ${server.address}`);
  const shutdown = () => void server.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (e) {
  console.error(e instanceof ConfigError ? `${e.name}: ${e.message}` : e);
  process.exit(1);
}
