import { redactSecrets } from '@selarikru/protocol';

/** One log line per error; an `AggregateError` lists each cause on its own line. Every message goes through `redactSecrets`. */
export function describeError(e: unknown): string {
  const text = (x: unknown): string => redactSecrets(x instanceof Error ? x.message : String(x));
  if (e instanceof AggregateError) return [text(e), ...e.errors.map((c) => `  - ${text(c)}`)].join('\n');
  return text(e);
}
