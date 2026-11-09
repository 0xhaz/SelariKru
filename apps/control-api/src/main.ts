import { describeError } from './log.ts';
import { ConfigError, loadConfigFromEnv } from './config.ts';
import { assemblyOptionsFromEnv, githubOptionsFromEnv, startServer, verificationOptionsFromEnv } from './server.ts';

try {
  const config = loadConfigFromEnv(process.env);
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new ConfigError('missing required configuration: DATABASE_URL', ['DATABASE_URL']);
  const server = await startServer({
    config,
    databaseUrl,
    policyFile: process.env['SELARIKRU_POLICY_FILE'] || undefined,
    planConfigFile: process.env['SELARIKRU_PLAN_CONFIG_FILE'] || undefined,
    github: githubOptionsFromEnv(process.env),
    verification: verificationOptionsFromEnv(process.env),
    assembly: (() => {
      const options = assemblyOptionsFromEnv(process.env);
      return options && {
        ...options,
        onRetry: (r) => console.warn(`assembly infrastructure failure for run ${r.runId}: ${r.reason}; retry ${r.count} of ${r.maxRetries} scheduled`),
      };
    })(),
    onAssemblyError: (e) => console.error('assembly driver pass failed:', describeError(e)),
    onVerificationError: (e) => console.error('verification driver pass failed:', describeError(e)),
    onReconcileError: (e) => console.error('github reconciler pass failed:', describeError(e)),
    onError: (e) => console.error('lease expiry pass failed:', describeError(e)),
  });
  console.log(`control API listening on ${server.address}`);
  const shutdown = () => void server.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (e) {
  console.error(e instanceof ConfigError ? `${e.name}: ${e.message}` : e);
  process.exit(1);
}
