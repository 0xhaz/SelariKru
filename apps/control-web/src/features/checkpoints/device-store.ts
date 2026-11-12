import { AiCheckpointSchema, redactSecrets, type AiCheckpoint } from '@selarikru/domain';

/**
 * H12: the checkpoints kept on this device, in the browser's own IndexedDB, keyed per owner and project. Every checkpoint is kept here, so the offline queue works
 * offline and survives a reload; a restricted, secret or locked one is kept only here and never sent. Secret-shaped text is redacted before anything is stored:
 * secrets never enter browser storage.
 */
export interface DeviceCheckpointStore {
  put(ownerKey: string, cp: AiCheckpoint): Promise<void>;
  list(ownerKey: string, projectId: string): Promise<AiCheckpoint[]>;
  /** Fix round 1 (M6): removes one checkpoint (a closed one past its retention). */
  remove(ownerKey: string, projectId: string, checkpointId: string): Promise<void>;
  /**
   * H9 step 0 (F2): marks a checkpoint whose last server write did not arrive (or clears the mark), so the list of unsynced writes survives a reload. Kept beside
   * the checkpoint, never inside it.
   */
  setUnsynced(ownerKey: string, projectId: string, checkpointId: string, unsynced: boolean): Promise<void>;
  /** H9 step 0 (F2): the checkpoints marked unsynced, for this owner and project. */
  listUnsynced(ownerKey: string, projectId: string): Promise<string[]>;
}

/** What is written: secret-shaped text redacted, in every text a checkpoint can carry. */
export function forDevice(cp: AiCheckpoint): AiCheckpoint {
  // A claim token belongs to one send in one tab: never kept (fix round 2, N4).
  const { claimToken: _token, ...rest } = cp;
  void _token;
  return {
    ...rest,
    partial: cp.partial ? { issues: cp.partial.issues.map(redactSecrets), texts: cp.partial.texts.map((t) => ({ ...t, text: redactSecrets(t.text) })) } : null,
    inputs: { ...cp.inputs, files: cp.inputs.files.map((f) => ({ ...f, path: redactSecrets(f.path) })) },
  };
}

const scopeKey = (ownerKey: string, projectId: string): string => `${ownerKey}|${projectId}`;

/** In memory: tests, and a browser without IndexedDB (nothing then survives a reload, and the screen says so). */
export function memoryDeviceStore(): DeviceCheckpointStore & { readonly rows: Map<string, AiCheckpoint> } {
  const rows = new Map<string, AiCheckpoint>();
  const unsynced = new Set<string>();
  return {
    rows,
    async setUnsynced(ownerKey, projectId, checkpointId, on) { const k = `${scopeKey(ownerKey, projectId)}|${checkpointId}`; if (on) unsynced.add(k); else unsynced.delete(k); },
    async listUnsynced(ownerKey, projectId) {
      const prefix = `${scopeKey(ownerKey, projectId)}|`;
      return [...unsynced].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
    async put(ownerKey, cp) { rows.set(`${scopeKey(ownerKey, cp.projectId)}|${cp.checkpointId}`, structuredClone(forDevice(cp))); },
    async list(ownerKey, projectId) {
      const prefix = `${scopeKey(ownerKey, projectId)}|`;
      return [...rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v));
    },
    async remove(ownerKey, projectId, checkpointId) { rows.delete(`${scopeKey(ownerKey, projectId)}|${checkpointId}`); unsynced.delete(`${scopeKey(ownerKey, projectId)}|${checkpointId}`); },
  };
}

const DB = 'selarikru-checkpoints';
const STORE = 'checkpoints';
/** H9 step 0 (F2): the ids whose last server write did not arrive. Version 2 of the database adds it. */
const UNSYNCED = 'unsynced';

const promised = <T,>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** The browser's IndexedDB, with a tiny wrapper: one object store, a key per owner, project and checkpoint, and an index per owner and project. */
export function indexedDbStore(factory: IDBFactory = indexedDB): DeviceCheckpointStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const req = factory.open(DB, 2);
      req.onupgradeneeded = (e) => {
        if (e.oldVersion < 1) {
          const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('scope', 'scope');
        }
        if (e.oldVersion < 2) req.result.createObjectStore(UNSYNCED, { keyPath: 'key' }).createIndex('scope', 'scope');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { opened = null; reject(req.error); };
    });
    return opened;
  };
  return {
    async put(ownerKey, cp) {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      const scope = scopeKey(ownerKey, cp.projectId);
      await promised(tx.objectStore(STORE).put({ key: `${scope}|${cp.checkpointId}`, scope, checkpoint: forDevice(cp) }));
    },
    async list(ownerKey, projectId) {
      const db = await open();
      const rows = await promised(db.transaction(STORE, 'readonly').objectStore(STORE).index('scope').getAll(scopeKey(ownerKey, projectId))) as { checkpoint: unknown }[];
      // Anything this build cannot read is left alone, never shown.
      return rows.flatMap((r) => { const p = AiCheckpointSchema.safeParse(r.checkpoint); return p.success ? [p.data] : []; });
    },
    async remove(ownerKey, projectId, checkpointId) {
      const db = await open();
      const tx = db.transaction([STORE, UNSYNCED], 'readwrite');
      await promised(tx.objectStore(STORE).delete(`${scopeKey(ownerKey, projectId)}|${checkpointId}`));
      await promised(tx.objectStore(UNSYNCED).delete(`${scopeKey(ownerKey, projectId)}|${checkpointId}`));
    },
    async setUnsynced(ownerKey, projectId, checkpointId, on) {
      const db = await open();
      const scope = scopeKey(ownerKey, projectId);
      const os = db.transaction(UNSYNCED, 'readwrite').objectStore(UNSYNCED);
      if (on) await promised(os.put({ key: `${scope}|${checkpointId}`, scope, checkpointId }));
      else await promised(os.delete(`${scope}|${checkpointId}`));
    },
    async listUnsynced(ownerKey, projectId) {
      const db = await open();
      const rows = await promised(db.transaction(UNSYNCED, 'readonly').objectStore(UNSYNCED).index('scope').getAll(scopeKey(ownerKey, projectId))) as { checkpointId: unknown }[];
      return rows.flatMap((r) => (typeof r.checkpointId === 'string' ? [r.checkpointId] : []));
    },
  };
}

/** IndexedDB when the browser has it; otherwise memory. */
export function defaultDeviceStore(): DeviceCheckpointStore {
  return typeof indexedDB === 'undefined' ? memoryDeviceStore() : indexedDbStore();
}
