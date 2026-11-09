import { createHmac, timingSafeEqual } from 'node:crypto';
import { schema, sql, type Db } from '@selarikru/persistence';
import { and, eq } from 'drizzle-orm';

export interface WebhookDeps {
  readonly db: Db;
  readonly tenantId: string;
  /** The webhook secret from configuration. Never from a request. */
  readonly secret: string;
  readonly now?: () => Date;
}

export interface WebhookRequest {
  /** The request body exactly as received. The signature covers these bytes, not a re-serialisation. */
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface WebhookResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export const INTEGRATION = 'github';

/** `sha256=<hex>` HMAC of the raw bytes, as GitHub sends it in `X-Hub-Signature-256`. */
export function signBody(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (secret.length === 0 || !header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const want = Buffer.from(signBody(secret, body));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Handles `POST /v1/webhooks/github`. A delivery is a hint only: after the signature is verified over the raw bytes it is recorded in
 * `integration_deliveries` (deduplicated on the delivery ID) as `received`, and the reconciler later reads the pull request from GitHub.
 * Nothing in the body (merged flag, SHA, action) is trusted or applied here, and delivery order does not matter.
 * Unsigned deliveries are 401; unsupported events 422; a repository that is not a project's configured repository 404.
 */
export async function handleGithubWebhook(req: WebhookRequest, deps: WebhookDeps): Promise<WebhookResponse> {
  if (!verifySignature(deps.secret, req.rawBody, one(req.headers['x-hub-signature-256']))) return { status: 401, body: { error: 'invalid_signature' } };
  const deliveryId = one(req.headers['x-github-delivery']);
  if (!deliveryId || deliveryId.length > 200) return { status: 400, body: { error: 'missing_delivery_id' } };
  const event = one(req.headers['x-github-event']);
  if (event === 'ping') return { status: 200, body: { ok: true, ping: true } };
  if (event !== 'pull_request') return { status: 422, body: { error: 'unsupported_event' } };

  let parsed: unknown;
  try { parsed = JSON.parse(req.rawBody.toString('utf8')); } catch { return { status: 400, body: { error: 'malformed_body' } }; }
  const p = parsed as { action?: unknown; number?: unknown; repository?: { full_name?: unknown } };
  const fullName = p?.repository?.full_name;
  const number = p?.number;
  if (typeof fullName !== 'string' || typeof number !== 'number' || !Number.isInteger(number) || number < 1) return { status: 400, body: { error: 'malformed_body' } };

  const projects = await deps.db.select({ projectId: schema.projects.projectId }).from(schema.projects).where(and(
    eq(schema.projects.tenantId, deps.tenantId), sql`lower(${schema.projects.repository}) = ${fullName.toLowerCase()}`));
  const project = projects[0];
  if (!project) return { status: 404, body: { error: 'unknown_repository' } };

  const detail = { event, action: typeof p.action === 'string' ? p.action.slice(0, 40) : null, repository: fullName, prNumber: number };
  const inserted = await deps.db.execute(sql`
    INSERT INTO integration_deliveries (tenant_id, project_id, delivery_id, integration, sequence, status, detail, updated_at)
    VALUES (${deps.tenantId}, ${project.projectId}, ${deliveryId}, ${INTEGRATION}, NULL, 'received', ${JSON.stringify(detail)}::jsonb, ${(deps.now?.() ?? new Date()).toISOString()}::timestamptz)
    ON CONFLICT (tenant_id, project_id, delivery_id) DO NOTHING RETURNING delivery_id`);
  if (inserted.length === 0) return { status: 200, body: { ok: true, duplicate: true } };
  return { status: 202, body: { ok: true, queued: true } };
}
