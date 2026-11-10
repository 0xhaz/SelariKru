import { SkillBindingSchema, SkillExecutionRecordSchema, SkillFileSchema, SkillScanReportSchema, SkillTriggersSchema, SKILL_STATES, type SkillBinding } from '@selarikru/domain';
import { z } from 'zod';

/**
 * The skill library as the server reports it for one project (docs/skill-candidates.md §7): every version the project can see, each with its states as separate facts
 * (Available, Reviewed, Tested here, Enabled for this task, Blocked, Revoked), the static scan of a staged pack, and the project's bindings. Metadata only: no pack text.
 */
export const SkillCatalogEntryViewSchema = z.object({
  versionId: z.string(),
  skillId: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  origin: z.enum(['first_party', 'third_party']),
  scope: z.enum(['platform', 'project']),
  digest: z.string().nullable(),
  files: z.array(SkillFileSchema),
  license: z.object({ spdx: z.string().nullable(), file: z.string().nullable() }).nullable(),
  source: z.record(z.string(), z.unknown()).nullable(),
  triggers: SkillTriggersSchema.nullable(),
  tools: z.array(z.string()),
  classification: z.string(),
  states: z.array(z.enum(SKILL_STATES)),
  review: z.object({ by: z.string(), at: z.string().nullable() }).nullable(),
  revocation: z.object({ by: z.string(), at: z.string(), reason: z.string() }).nullable(),
  scan: SkillScanReportSchema.nullable(),
  enabledFor: z.array(z.object({ taskId: z.string(), attemptId: z.string() })),
  evaluations: z.array(z.record(z.string(), z.unknown())),
});
export type SkillCatalogEntryView = z.infer<typeof SkillCatalogEntryViewSchema>;

export const SkillBindingViewSchema = z.object({
  skillId: z.string(),
  desired: SkillBindingSchema.nullable(),
  effective: SkillBindingSchema.nullable(),
  desiredRevision: z.number().int(),
  effectiveRevision: z.number().int(),
  state: z.enum(['applied', 'applying']),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type SkillBindingView = z.infer<typeof SkillBindingViewSchema>;

export const SkillsViewSchema = z.object({
  projectId: z.string(),
  catalog: z.array(SkillCatalogEntryViewSchema),
  bindings: z.array(SkillBindingViewSchema),
  /** The roles of the project's current tasks, offered as binding constraints. */
  roles: z.array(z.string()),
});
export type SkillsView = z.infer<typeof SkillsViewSchema>;

/** What one attempt received at claim, and which of those versions were revoked since: it keeps them, and the screen says so. */
export const AttemptSkillsViewSchema = z.object({ attemptId: z.string(), record: SkillExecutionRecordSchema.nullable(), revoked: z.array(z.string()) });
export type AttemptSkillsView = z.infer<typeof AttemptSkillsViewSchema>;

/** An owner's skill action. None installs, fetches or runs anything; an intake reads a local directory and scans it. */
export type SkillActionView =
  | { readonly kind: 'intake'; readonly path: string }
  | { readonly kind: 'review'; readonly versionId: string; readonly acknowledgeFindings: boolean }
  | { readonly kind: 'revoke'; readonly versionId: string; readonly reason: string }
  | { readonly kind: 'bind'; readonly skillId: string; readonly expectedRevision: number; readonly binding: SkillBinding | null };
