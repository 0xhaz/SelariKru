import { useRef } from 'react';

/**
 * One idempotency key per intent. It is reused until that intent succeeds, so a double submit or a retry after a lost response is the same request to the server.
 */
export function useIntentKeys(): { keyFor: (scope: string) => string; settle: (scope: string) => void } {
  const keys = useRef<Map<string, string>>(new Map());
  return {
    keyFor: (scope) => {
      const existing = keys.current.get(scope);
      if (existing) return existing;
      const fresh = crypto.randomUUID();
      keys.current.set(scope, fresh);
      return fresh;
    },
    settle: (scope) => keys.current.delete(scope),
  };
}
