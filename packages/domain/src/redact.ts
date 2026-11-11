/**
 * Best-effort redaction of secret-shaped values in free text. It is a backstop, not isolation: fields that
 * have no business carrying secrets are rejected by strict schemas instead of being stored and scrubbed.
 */
export const REDACTED = '[REDACTED]';

/**
 * Token shapes are matched without a leading word boundary, because `_` and letters are word characters: a prefix such
 * as `task_` or `x_` must not hide a token. Each shape needs enough characters after its prefix to be a real credential,
 * so ordinary words and file names (`pk-migration-for-feedback-table`, `sk-button-component-variants.tsx`) are left alone.
 */
const WHOLE: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /sk-(?:ant|proj)-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\b(?:Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{20,}/gi,
  /sr[tp]_[A-Za-z0-9_-]{16,}/g,
];

/** `name = value` pairs: the name stays, the value goes. The value must look like a credential, not a word. */
const ASSIGNMENTS: readonly RegExp[] = [
  /((?:token|credential)s?["']?\s*[:=]\s*["']?)(?=[^\s"',;]*\d)[^\s"',;]{20,}/gi,
  /((?:secret|passw(?:or)?d|api[_-]?key|private[_-]?key)s?["']?\s*[:=]\s*["']?)(?=[^\s"',;]*\d)[^\s"',;]{8,}/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of WHOLE) out = out.replace(re, REDACTED);
  for (const re of ASSIGNMENTS) out = out.replace(re, (_m, name: string) => `${name}${REDACTED}`);
  return out;
}
