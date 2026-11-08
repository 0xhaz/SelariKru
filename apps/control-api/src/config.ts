import { z } from 'zod';

/** Thrown at startup when configuration is missing or invalid. `missing` names the absent settings. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(
    message: string,
    readonly missing: readonly string[] = [],
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host);

const posInt = z.number().int().min(1);

/**
 * The one validated configuration object. Scheduler caps live here and nowhere else; every cap is required, so a
 * missing limit stops startup instead of becoming "unlimited" or an invented default.
 */
export const ControlApiConfigSchema = z
  .object({
    mode: z.enum(['local', 'hosted']),
    host: z.string().min(1),
    port: z.number().int().min(0).max(65535),
    tenantId: z.string().min(1),
    ownerUid: z.string().min(1),
    firebaseProjectId: z.string().min(1),
    allowedOrigins: z.array(z.string().min(1)),
    caps: z
      .object({
        maxConcurrentTotal: posInt,
        attemptTimeoutSeconds: posInt,
        maxInfraRetries: z.number().int().min(0),
        infraRetryBackoffSeconds: posInt,
        infraRetryBackoffMaxSeconds: posInt,
      })
      .strict(),
    pairingCodeTtlSeconds: posInt,
    /** How long a draft reclassification grant stays usable. Default 24 hours. */
    reclassificationGrantTtlSeconds: posInt.default(86_400),
    expireLeasesIntervalMs: posInt,
    sse: z.object({ pollIntervalMs: posInt, keepAliveMs: posInt }).strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.mode === 'local' && !isLoopbackHost(c.host)) {
      ctx.addIssue({ code: 'custom', path: ['host'], message: 'local mode binds to loopback only' });
    }
    if (c.mode === 'hosted' && c.allowedOrigins.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['allowedOrigins'], message: 'hosted mode needs an explicit origin allowlist' });
    }
    if (c.caps.infraRetryBackoffMaxSeconds < c.caps.infraRetryBackoffSeconds) {
      ctx.addIssue({ code: 'custom', path: ['caps', 'infraRetryBackoffMaxSeconds'], message: 'must be at least infraRetryBackoffSeconds' });
    }
  });
export type ControlApiConfig = z.infer<typeof ControlApiConfigSchema>;

export function parseConfig(input: unknown): ControlApiConfig {
  const r = ControlApiConfigSchema.safeParse(input);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new ConfigError(`invalid control API configuration: ${issues.join('; ')}`, [], issues);
}

/** Env names -> config. No limit has a default: absent, empty and non-numeric values are all errors. */
const REQUIRED_ENV = [
  'SELARIKRU_TENANT_ID',
  'SELARIKRU_OWNER_UID',
  'FIREBASE_PROJECT_ID',
  'SELARIKRU_MAX_CONCURRENT_TOTAL',
  'SELARIKRU_ATTEMPT_TIMEOUT_SECONDS',
  'SELARIKRU_MAX_INFRA_RETRIES',
  'SELARIKRU_INFRA_RETRY_BACKOFF_SECONDS',
  'SELARIKRU_INFRA_RETRY_BACKOFF_MAX_SECONDS',
  'SELARIKRU_PAIRING_CODE_TTL_SECONDS',
  'SELARIKRU_EXPIRE_LEASES_INTERVAL_MS',
] as const;

type Env = Readonly<Record<string, string | undefined>>;

function int(env: Env, name: string): number {
  const v = env[name]?.trim() ?? '';
  return /^\d+$/.test(v) ? Number(v) : Number.NaN;
}

export function loadConfigFromEnv(env: Env): ControlApiConfig {
  const missing = REQUIRED_ENV.filter((n) => (env[n]?.trim() ?? '') === '');
  if (missing.length > 0) throw new ConfigError(`missing required configuration: ${missing.join(', ')}`, missing);

  const mode = env['SELARIKRU_MODE'] === 'hosted' ? 'hosted' : 'local';
  if (env['SELARIKRU_MODE'] !== undefined && env['SELARIKRU_MODE'] !== 'local' && env['SELARIKRU_MODE'] !== 'hosted') {
    throw new ConfigError('SELARIKRU_MODE must be "local" or "hosted"', [], ['SELARIKRU_MODE']);
  }
  // The Firebase SDK skips signature checks when the emulator variable is set. A hosted process must never run that way.
  if (mode === 'hosted' && (env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '') !== '') {
    throw new ConfigError('FIREBASE_AUTH_EMULATOR_HOST must not be set in hosted mode', [], ['FIREBASE_AUTH_EMULATOR_HOST']);
  }

  return parseConfig({
    mode,
    host: env['SELARIKRU_API_HOST']?.trim() || '127.0.0.1',
    port: env['SELARIKRU_API_PORT'] ? int(env, 'SELARIKRU_API_PORT') : 8787,
    tenantId: env['SELARIKRU_TENANT_ID'],
    ownerUid: env['SELARIKRU_OWNER_UID'],
    firebaseProjectId: env['FIREBASE_PROJECT_ID'],
    allowedOrigins: (env['SELARIKRU_ALLOWED_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    caps: {
      maxConcurrentTotal: int(env, 'SELARIKRU_MAX_CONCURRENT_TOTAL'),
      attemptTimeoutSeconds: int(env, 'SELARIKRU_ATTEMPT_TIMEOUT_SECONDS'),
      maxInfraRetries: int(env, 'SELARIKRU_MAX_INFRA_RETRIES'),
      infraRetryBackoffSeconds: int(env, 'SELARIKRU_INFRA_RETRY_BACKOFF_SECONDS'),
      infraRetryBackoffMaxSeconds: int(env, 'SELARIKRU_INFRA_RETRY_BACKOFF_MAX_SECONDS'),
    },
    pairingCodeTtlSeconds: int(env, 'SELARIKRU_PAIRING_CODE_TTL_SECONDS'),
    ...(env['SELARIKRU_RECLASSIFICATION_GRANT_TTL_SECONDS'] ? { reclassificationGrantTtlSeconds: int(env, 'SELARIKRU_RECLASSIFICATION_GRANT_TTL_SECONDS') } : {}),
    expireLeasesIntervalMs: int(env, 'SELARIKRU_EXPIRE_LEASES_INTERVAL_MS'),
    sse: { pollIntervalMs: 250, keepAliveMs: 15_000 },
  });
}
