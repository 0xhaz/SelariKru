/**
 * Best-effort redaction of secret-shaped values in free text. It is a backstop, not isolation: fields that
 * have no business carrying secrets are rejected by strict schemas instead of being stored and scrubbed.
 */
export const REDACTED = '[REDACTED]';

const WHOLE: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsr[tp]_[A-Za-z0-9_-]{16,}/g,
];

/** `name = value` pairs: the name stays, the value goes. */
const ASSIGNMENT = /((?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|credential)s?["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of WHOLE) out = out.replace(re, REDACTED);
  return out.replace(ASSIGNMENT, (_m, name: string) => `${name}${REDACTED}`);
}
