import {
  applyStackAction, emptyStack, NO_NATIVE, withholdRestrictedDetection, STACK_CATALOG_VERSION, StackDocumentSchema, stackEntry,
  type StackAction, type StackDetectionRecord, type StackDocument,
} from '@selarikru/domain';
import { schema, withTx, type Executor, type Tx } from '@selarikru/persistence';
import { redactSecrets, StackActionRequestSchema, StackDetectionRequestSchema } from '@selarikru/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from './app.ts';
import { AppError } from './errors.ts';
import { parseBody } from './routes-owner.ts';
import { requireProject } from './store.ts';

/**
 * Stack settings (docs/framework-tool-catalog.md §3, design.md §10 Stack). Per project and per component path, every category is explicitly Not decided, None, or a list
 * of catalog or custom entries. A selection is metadata: nothing here authenticates, installs, requests, spends, issues a runner command, appends an event or touches a
 * repository. A runner's static detection is stored as a proposal until the owner confirms it; its build and test commands are shown, never put in effect.
 *
 * Locking: every write takes the project's `project_stacks` row and nothing else, with no other lock held, and writes only that row. An owner write is followed, after its
 * transaction committed, by a Brain compile through the Brain's `onSend` hook (the stack is one of the records Brain sources are read from); a detection is not a Brain
 * input and compiles nothing. See the lock order in services/workflow/src/verification.ts.
 */

export interface StackRow {
  /** Owner writes only. */
  readonly revision: number;
  /** Stored detections only. */
  readonly detectionRevision: number;
  readonly document: StackDocument;
  /** The stored document could not be read by this build. It is shown as empty and is never overwritten: every write is refused until it is repaired. */
  readonly unreadable: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

const unreadableError = (): AppError => new AppError(409, 'stack_unreadable', 'the stored stack settings cannot be read by this build, so nothing was written over them');

/**
 * The project's stack as stored, or an empty one at revision 0. Categories a newer catalog added are dropped on read. A document that still cannot be read fails closed:
 * it reads as empty and unreadable, and no write replaces it.
 */
export async function loadStack(db: Executor, tenantId: string, projectId: string): Promise<StackRow> {
  const [row] = await db.select().from(schema.projectStacks).where(and(eq(schema.projectStacks.tenantId, tenantId), eq(schema.projectStacks.projectId, projectId)));
  if (!row) return { revision: 0, detectionRevision: 0, document: emptyStack(), unreadable: false, updatedBy: null, updatedAt: null };
  const doc = StackDocumentSchema.safeParse(row.document);
  return { revision: row.revision, detectionRevision: row.detectionRevision, document: doc.success ? doc.data : emptyStack(), unreadable: !doc.success, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() };
}

/** The project's stack lock. Taken with no other lock held. */
async function lockStack(tx: Tx, tenantId: string, projectId: string, at: Date): Promise<StackRow> {
  await tx.insert(schema.projectStacks).values({ tenantId, projectId, revision: 0, catalogVersion: STACK_CATALOG_VERSION, document: emptyStack(), updatedBy: 'control-api', updatedAt: at }).onConflictDoNothing();
  await tx.select({ r: schema.projectStacks.revision }).from(schema.projectStacks).where(and(eq(schema.projectStacks.tenantId, tenantId), eq(schema.projectStacks.projectId, projectId))).for('update');
  return loadStack(tx, tenantId, projectId);
}

/**
 * Stores the document. An owner write moves `revision` and records who and when; a detection moves only `detectionRevision` and leaves both alone (the detection carries
 * its own `detectedAt`). Either way, nothing detected under a restricted or secret component is kept, only its count.
 */
async function writeStack(tx: Tx, tenantId: string, projectId: string, change: { revision: number; by: string; at: Date } | { detectionRevision: number }, document: StackDocument): Promise<void> {
  const owner = 'revision' in change ? { revision: change.revision, updatedBy: change.by, updatedAt: change.at } : { detectionRevision: change.detectionRevision };
  await tx.update(schema.projectStacks).set({ ...owner, document: StackDocumentSchema.parse(withholdRestrictedDetection(document)) as unknown as Record<string, unknown>, catalogVersion: STACK_CATALOG_VERSION })
    .where(and(eq(schema.projectStacks.tenantId, tenantId), eq(schema.projectStacks.projectId, projectId)));
}

const view = (projectId: string, s: StackRow) => ({
  projectId, revision: s.revision, detectionRevision: s.detectionRevision, unreadable: s.unreadable, catalogVersion: STACK_CATALOG_VERSION, document: s.document, updatedBy: s.updatedBy, updatedAt: s.updatedAt,
  /** What runners report they can build natively. None reports a native toolchain in this build, so iOS and Android gates stay incomplete. */
  native: NO_NATIVE,
});

/** Every free text an owner action carries, so a credential pasted into one is refused before anything is stored. */
const textsOf = (a: StackAction): string[] => {
  if (a.kind === 'component.upsert') return [a.name, a.path];
  if (a.kind === 'item.add') return a.item.kind === 'custom' ? [a.item.label, a.item.canonicalSource ?? ''] : [a.item.version ?? ''];
  return [];
};

const ACTION_STATUS: Readonly<Record<string, number>> = {
  stack_component_not_found: 404, stack_item_not_found: 404, stack_detection_not_found: 404, stack_entry_unknown: 400, stack_entry_wrong_category: 400,
  stack_item_exists: 409, stack_detection_settled: 409, stack_limit: 409, classification_downgrade: 409,
};

export function registerStackRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx;
  const auth = { onRequest: [ctx.owner] };
  const projectOf = async (req: FastifyRequest): Promise<{ projectId: string; uid: string }> => {
    if (req.principal?.kind !== 'owner') throw new AppError(403, 'wrong_principal_type', 'owner credentials required');
    const projectId = (req.params as { id: string }).id;
    await requireProject(db, config.tenantId, projectId);
    return { projectId, uid: req.principal.uid };
  };

  app.get('/v1/projects/:id/stack', auth, async (req) => {
    const { projectId } = await projectOf(req);
    return view(projectId, await loadStack(db, config.tenantId, projectId));
  });

  // One owner change. The Brain compiles after it commits (the `onSend` hook in brain.ts lists this route).
  app.post('/v1/projects/:id/stack', auth, async (req) => {
    const { projectId, uid } = await projectOf(req);
    const body = parseBody(StackActionRequestSchema, req.body);
    if (textsOf(body.action).some((s) => redactSecrets(s) !== s)) throw new AppError(400, 'credential_in_input', 'this contains something shaped like a secret; nothing was stored. Stack settings never hold credentials.');
    const at = now();
    const after = await withTx(db, async (tx) => {
      const current = await lockStack(tx, config.tenantId, projectId, at);
      if (current.unreadable) throw unreadableError();
      // Owner writes only: a detection stored since this was read does not make it stale. The action is applied to the locked, current document.
      if (current.revision !== body.expectedRevision) throw new AppError(409, 'stack_revision_conflict', 'the stack changed since it was read; reload and try again', { revision: current.revision });
      const r = applyStackAction(current.document, body.action, { by: uid, at: at.toISOString() });
      if (!r.ok) throw new AppError(ACTION_STATUS[r.code] ?? 400, r.code, r.message);
      await writeStack(tx, config.tenantId, projectId, { revision: current.revision + 1, by: uid, at }, r.doc);
      return { ...current, revision: current.revision + 1, document: withholdRestrictedDetection(r.doc), updatedBy: uid, updatedAt: at.toISOString() };
    });
    return view(projectId, after);
  });

  // A runner's static detection of its own checkout at the task's base commit, for the attempt it holds. Work whose data stays on the device does not send one.
  app.post('/v1/runners/stack/detection', { onRequest: [ctx.runner] }, async (req) => {
    const p = req.principal;
    if (p?.kind !== 'runner') throw new AppError(403, 'wrong_principal_type', 'runner credentials required');
    const body = parseBody(StackDetectionRequestSchema, req.body);
    const stale = new AppError(409, 'lease_conflict', 'the lease is not current', { reason: 'stale_fence', attemptId: body.lease.attemptId, fence: body.lease.fence });
    const [a] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.tenantId, p.tenantId), eq(schema.attempts.attemptId, body.lease.attemptId)));
    if (!a || a.runner !== p.runnerId || a.leaseFence !== body.lease.fence || a.leaseToken !== body.lease.leaseToken || a.endedAt !== null) throw stale;
    if (a.detail['terminalStreamable'] !== true) throw new AppError(403, 'stack_detection_restricted', 'a detection is not accepted for work whose data stays on the device');
    await requireProject(db, p.tenantId, a.projectId);
    const d = body.detection;
    const at = now();
    // Only entries this catalog knows; text read from the repository is redacted before it is stored, and a command is only ever a proposal.
    const items = d.items.filter((i) => stackEntry(i.entryId) !== undefined).map((i) => ({ ...i, version: i.version === null ? null : redactSecrets(i.version).slice(0, 40), evidence: { path: i.evidence.path, detail: redactSecrets(i.evidence.detail).slice(0, 160) } }));
    const commands = d.commands.map((c) => ({ ...c, body: redactSecrets(c.body).slice(0, 200), command: redactSecrets(c.command).slice(0, 100) }));
    await withTx(db, async (tx) => {
      const current = await lockStack(tx, p.tenantId, a.projectId, at);
      if (current.unreadable) throw unreadableError();
      const prior = new Map((current.document.detection?.items ?? []).map((i) => [i.detectionId, i.state]));
      const detection: StackDetectionRecord = {
        commit: d.commit, detectedAt: at.toISOString(), runnerId: p.runnerId.slice(0, 200), commands, skipped: d.skipped,
        // What the owner already confirmed or dismissed stays settled.
        items: items.map((i) => ({ ...i, state: prior.get(i.detectionId) ?? 'proposed' })),
      };
      const next = withholdRestrictedDetection({ ...current.document, detection });
      const same = current.document.detection !== null && JSON.stringify({ ...current.document.detection, detectedAt: '' }) === JSON.stringify({ ...next.detection, detectedAt: '' });
      if (same) return;
      await writeStack(tx, p.tenantId, a.projectId, { detectionRevision: current.detectionRevision + 1 }, next);
    });
    return { recorded: true };
  });
}
