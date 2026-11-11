import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);
export const Id = z.string().min(1);
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase hex sha256');
export const Timestamp = z.iso.datetime();

/** `agent` (H11): the Project Manager agent, acting only inside the owner's accepted plan (`agent:pm`). */
export const ACTOR_KINDS = ['worker', 'verifier', 'human', 'scheduler', 'integration', 'system', 'agent'] as const;
export const ActorKindSchema = z.enum(ACTOR_KINDS);
export type ActorKind = z.infer<typeof ActorKindSchema>;
export const ActorSchema = z.object({ kind: ActorKindSchema, id: Id }).strict();
export type Actor = z.infer<typeof ActorSchema>;
