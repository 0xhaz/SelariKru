import { StackActionSchema, StackCommandProposalSchema, StackDetectedItemSchema, StackSkipSchema } from '@selarikru/domain';
import { z } from 'zod';
import { LeaseRefSchema } from './runner.ts';

/** An owner's stack change, against the revision the screen last read: a write over a newer revision is refused, never merged silently. */
export const StackActionRequestSchema = z.strictObject({ expectedRevision: z.number().int().min(0), action: StackActionSchema });
export type StackActionRequest = z.input<typeof StackActionRequestSchema>;

/**
 * What a runner detected in its own checkout at the task's base commit: entries with the manifest, lockfile or config path and version text they were read from, and
 * build and test commands proposed from package.json scripts. Read with git (`ls-tree` and `cat-file`), never by running anything. Sent only for work whose data may
 * leave the device. A proposal until the owner confirms it.
 */
export const StackDetectionReportSchema = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  items: z.array(StackDetectedItemSchema).max(400),
  commands: z.array(StackCommandProposalSchema).max(40),
  skipped: z.array(StackSkipSchema).max(200),
});
export type StackDetectionReport = z.infer<typeof StackDetectionReportSchema>;

export const StackDetectionRequestSchema = z.strictObject({ lease: LeaseRefSchema, detection: StackDetectionReportSchema });

/** The runner's static detection reads git objects and parses them with the domain's pure detector; re-exported here so the runner needs no other package. */
export { detectStack, isStackDetectionPath, isStackManifestPath, STACK_DETECTION_MAX_BYTES, STACK_DETECTION_MAX_FILES, type StackDetectionFile } from '@selarikru/domain';
