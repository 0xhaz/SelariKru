import { createHash, randomBytes } from 'node:crypto';

/** Injected so tests can substitute it. The production implementation verifies Firebase ID tokens. */
export interface TokenVerifier {
  /** Resolves the verified identity or rejects. Never resolves for an unverified token. */
  verifyToken(idToken: string): Promise<{ uid: string }>;
}

export type Principal =
  | { readonly kind: 'owner'; readonly uid: string }
  | { readonly kind: 'runner'; readonly runnerId: string; readonly tenantId: string; readonly location: 'local' | 'cloud' };

export const RUNNER_TOKEN_PREFIX = 'srt_';
export const PAIRING_CODE_PREFIX = 'srp_';

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newSecret = (prefix: string): string => `${prefix}${randomBytes(32).toString('base64url')}`;

export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1] ?? null;
}
