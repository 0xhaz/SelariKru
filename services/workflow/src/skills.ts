import {
  harnessForProvider, resolveSkills, SKILL_LIBRARY, SkillBindingSchema, SkillVersionSchema, StackDocumentSchema, WORKER_TOOLS,
  type KnownVersion, type SkillBinding, type SkillResolution, type TaskSpec,
} from '@selarikru/domain';
import { schema, type Executor } from '@selarikru/persistence';
import { and, eq } from 'drizzle-orm';

/**
 * Skill resolution at claim, inside the claim's transaction and after its scheduler lock. Bindings are read from what the owner saved (`desired`), so a revoke or an unbind
 * holds from the moment its save commits: saves take the scheduler lock too, so a claim either committed first or reads the change. Nothing here takes a lock or writes.
 */

const UNREADABLE = 'unreadable@0';

/** A binding as saved: a `SkillBinding`, or removed. A row this build cannot read binds an unknown version, which refuses every claim it could match (fail closed). */
export function bindingOf(desired: unknown): SkillBinding | null {
  if (desired !== null && typeof desired === 'object' && (desired as { removed?: unknown }).removed === true) return null;
  const p = SkillBindingSchema.safeParse(desired);
  return p.success ? p.data : { versionId: UNREADABLE, roles: [], paths: [] };
}

/** Every version a project can see, with its review, scan and revocation facts: the first-party library and the project's own staged packs. */
export async function loadKnownVersions(db: Executor, tenantId: string, projectId: string): Promise<Map<string, KnownVersion>> {
  const revoked = new Set((await db.select({ v: schema.skillRevocations.versionId }).from(schema.skillRevocations).where(eq(schema.skillRevocations.tenantId, tenantId))).map((r) => r.v));
  const out = new Map<string, KnownVersion>();
  // First-party packs are published reviewed: written and checked in this repository, pinned by commit and digest.
  for (const v of SKILL_LIBRARY) out.set(v.versionId, { version: v, reviewed: true, blocked: false, revoked: revoked.has(v.versionId) });
  const staged = await db.select().from(schema.skillStagedVersions).where(and(eq(schema.skillStagedVersions.tenantId, tenantId), eq(schema.skillStagedVersions.projectId, projectId)));
  for (const s of staged) {
    const p = SkillVersionSchema.safeParse(s.version);
    // An unreadable stored version is not known: a binding to it refuses its claims.
    if (!p.success || p.data.versionId !== s.versionId) continue;
    out.set(s.versionId, { version: p.data, reviewed: s.reviewedAt !== null && !s.blocked, blocked: s.blocked, revoked: revoked.has(s.versionId) });
  }
  return out;
}

export async function loadBindings(db: Executor, tenantId: string, projectId: string): Promise<{ skillId: string; binding: SkillBinding }[]> {
  const rows = await db.select({ skillId: schema.projectSkillBindings.skillId, desired: schema.projectSkillBindings.desired }).from(schema.projectSkillBindings)
    .where(and(eq(schema.projectSkillBindings.tenantId, tenantId), eq(schema.projectSkillBindings.projectId, projectId)));
  return rows.flatMap((r) => { const b = bindingOf(r.desired); return b === null ? [] : [{ skillId: r.skillId, binding: b }]; });
}

/** What this task's attempt would receive on a worker at `destination` running `provider`'s harness. */
export async function resolveTaskSkills(db: Executor, key: { tenantId: string; projectId: string }, spec: Pick<TaskSpec, 'role' | 'allowedPaths' | 'acceptanceCheckIds'>, destination: 'local' | 'cloud', provider: string): Promise<SkillResolution> {
  const bindings = await loadBindings(db, key.tenantId, key.projectId);
  if (bindings.length === 0) return { delivered: [], omitted: [], refused: [], context: { entries: [], actions: [] } };
  const [stackRow] = await db.select({ document: schema.projectStacks.document }).from(schema.projectStacks).where(and(eq(schema.projectStacks.tenantId, key.tenantId), eq(schema.projectStacks.projectId, key.projectId)));
  const stack = stackRow ? StackDocumentSchema.safeParse(stackRow.document) : null;
  return resolveSkills({
    task: spec, stack: stack?.success ? stack.data : null, bindings, versions: await loadKnownVersions(db, key.tenantId, key.projectId),
    destination, tools: WORKER_TOOLS, harness: harnessForProvider(provider),
  });
}
