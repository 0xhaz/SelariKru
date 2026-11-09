import { z } from 'zod';

export const VIEW_SCHEMA_VERSION = 1 as const;

/** `observed` data came from the live system; `simulated` data is a fixture and never counts as evidence. */
export const PROVENANCE = ['observed', 'simulated'] as const;
export const ProvenanceSchema = z.enum(PROVENANCE);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Same figures as the scheduler (architecture.md section 12): heartbeat 10 s, suspect 30 s, lease expiry 60 s. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const SUSPECT_AFTER_MS = 30_000;
export const LEASE_EXPIRY_MS = 60_000;

/** Liveness older than this (no successful refresh) is stale: workers read as unknown rather than disconnected. */
export const LIVENESS_STALE_MS = 30_000;

/** Time is always passed in. Reducers never read a clock; selectors take `nowMs`; sources take a `Clock`. */
export interface Clock {
  nowMs(): number;
}

export const isoOf = (ms: number): string => new Date(ms).toISOString();

export const CursorSchema = z.string().regex(/^\d+$/, 'cursor is a non-negative integer string');
/** Cursors are decimal sequence numbers; `'0'` means before the first event. */
export const cursorToSequence = (cursor: string): number => Number(cursor);
export const sequenceToCursor = (sequence: number): string => String(sequence);
