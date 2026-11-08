import type { ErrorCode } from '@selarikru/protocol';

/** An error the API deliberately returns. Anything else becomes an opaque `internal_error`. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthenticated = (message = 'authentication required') => new AppError(401, 'unauthenticated', message);
export const invalidRequest = (message: string, details?: unknown) => new AppError(400, 'invalid_request', message, details);
export const staleRevision = (currentRevision: number, what: string) =>
  new AppError(409, 'stale_revision', `${what} has changed; reload and retry`, { currentRevision });
