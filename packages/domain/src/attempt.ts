import { z } from 'zod';
import { Id, SchemaVersion, Timestamp } from './common.ts';

export const ATTEMPT_OUTCOMES = ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;

/** Attempts are separate, append-only records; a failed attempt is never rewritten. */
export const AttemptSchema = z
  .object({
    schemaVersion: SchemaVersion,
    attemptId: Id,
    taskId: Id,
    taskRevision: z.number().int().min(1),
    number: z.number().int().min(1),
    /** Monotonic fence; stale workers cannot publish authoritative results. */
    fence: z.number().int().min(1),
    outcome: z.enum(ATTEMPT_OUTCOMES),
    baseSha: Id,
    headSha: Id.nullable(),
    startedAt: Timestamp,
    endedAt: Timestamp.nullable(),
  })
  .strict();
export type Attempt = z.infer<typeof AttemptSchema>;
