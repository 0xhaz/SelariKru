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
}

/** What is written: secret-shaped text redacted, in every text a checkpoint can carry. */
export function forDevice(cp: AiCheckpoint): AiCheckpoint {
  return {
    ...cp,
    partial: cp.partial ? { issues: cp.partial.issues.map(redactSecrets), texts: cp.partial.texts.map((t) => ({ ...t, text: redactSecrets(t.text) })) } : null,
    inputs: { ...cp.inputs, files: cp.inputs.files.map((f) => ({ ...f, path: redactSecrets(f.path) })) },
  };
}

const scopeKey = (ownerKey: string, projectId: string): string => `${ownerKey}|${projectId}`;

/** In memory: tests, and a browser without IndexedDB (nothing then survives a reload, and the screen says so). */
export function memoryDeviceStore(): DeviceCheckpointStore & { readonly rows: Map<string, AiCheckpoint> } {
  const rows = new Map<string, AiCheckpoint>();
  return {
    rows,
    async put(ownerKey, cp) { rows.set(`${scopeKey(ownerKey, cp.projectId)}|${cp.checkpointId}`, structuredClone(forDevice(cp))); },
    async list(ownerKey, projectId) {
      const prefix = `${scopeKey(ownerKey, projectId)}|`;
      return [...rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v));
    },
    async remove(ownerKey, projectId, checkpointId) { rows.delete(`${scopeKey(ownerKey, projectId)}|${checkpointId}`); },
  };
}

const DB = 'selarikru-checkpoints';
const STORE = 'checkpoints';

const promised = <T,>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** The browser's IndexedDB, with a tiny wrapper: one object store, a key per owner, project and checkpoint, and an index per owner and project. */
export function indexedDbStore(factory: IDBFactory = indexedDB): DeviceCheckpointStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const req = factory.open(DB, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('scope', 'scope');
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
      await promised(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(`${scopeKey(ownerKey, projectId)}|${checkpointId}`));
    },
  };
}

/** IndexedDB when the browser has it; otherwise memory. */
export function defaultDeviceStore(): DeviceCheckpointStore {
  return typeof indexedDB === 'undefined' ? memoryDeviceStore() : indexedDbStore();
}
