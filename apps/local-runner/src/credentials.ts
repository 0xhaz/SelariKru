import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EnrollResponseSchema } from '@selarikru/protocol';
import { z } from 'zod';
import { assertSafeApiUrl } from './api.ts';

const CredentialsSchema = z
  .object({ apiBaseUrl: z.string(), runnerId: z.string(), token: z.string().min(1), location: z.literal('local'), tenantId: z.string() })
  .strict();
export type Credentials = z.infer<typeof CredentialsSchema>;

const FILE = 'credentials.json';

/** Reads the runner's own token. The token is the runner's, issued by pairing; no model or tool credential is ever stored here. */
export async function loadCredentials(stateDir: string): Promise<Credentials | null> {
  const file = join(stateDir, FILE);
  let st;
  try {
    st = await stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} has unsafe permissions; it must be readable by its owner only (chmod 600)`);
  return CredentialsSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

export interface PairInput {
  readonly apiUrl: string;
  /** One-time pairing code created by the owner in the web app. */
  readonly code: string;
  readonly label?: string;
  readonly stateDir: string;
  readonly fetchImpl?: typeof fetch;
}

/** Outbound enrolment. Returns the runner identity only; the token goes to the 0600 credentials file and nowhere else. */
export async function pair(input: PairInput): Promise<{ runnerId: string; location: 'local'; tenantId: string }> {
  const base = assertSafeApiUrl(input.apiUrl);
  const f = input.fetchImpl ?? fetch;
  const res = await f(new URL('/v1/runners/enroll', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.code}` },
    body: JSON.stringify(input.label !== undefined ? { label: input.label } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`pairing failed: the control API responded ${res.status}`);
  const r = EnrollResponseSchema.parse(await res.json());
  if (r.location !== 'local') throw new Error('this pairing code is not for a local runner');
  await mkdir(input.stateDir, { recursive: true, mode: 0o700 });
  const file = join(input.stateDir, FILE);
  const creds: Credentials = { apiBaseUrl: base.origin, runnerId: r.runnerId, token: r.token, location: 'local', tenantId: r.tenantId };
  await writeFile(file, JSON.stringify(creds), { mode: 0o600 });
  await chmod(file, 0o600);
  return { runnerId: r.runnerId, location: 'local', tenantId: r.tenantId };
}
