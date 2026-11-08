import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

export interface ArtifactRef {
  /** Lowercase hex SHA-256 of the bytes. This is the whole identity of an artifact. */
  readonly sha256: string;
  readonly size: number;
}

/** Content-addressed storage. A GCS implementation must keep these semantics. */
export interface ArtifactStore {
  put(bytes: Uint8Array): Promise<ArtifactRef>;
  /** Null when absent. Throws `ArtifactIntegrityError` when stored bytes no longer match their hash. */
  get(sha256: string): Promise<Uint8Array | null>;
  has(sha256: string): Promise<boolean>;
}

export class InvalidArtifactIdError extends Error {
  constructor() {
    super('artifact id must be a lowercase hex sha256');
    this.name = 'InvalidArtifactIdError';
  }
}
export class ArtifactIntegrityError extends Error {
  constructor(readonly sha256: string) {
    super(`stored bytes do not match ${sha256}`);
    this.name = 'ArtifactIntegrityError';
  }
}
export class PathEscapeError extends Error {
  constructor(detail: string) {
    super(`path escapes its base: ${detail}`);
    this.name = 'PathEscapeError';
  }
}

const ID = /^[0-9a-f]{64}$/;
const sha256Of = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Resolves `rel` under `base` or throws. Rejects absolute paths, `..` segments, NUL and backslashes (lexically). */
export function resolveWithin(base: string, rel: string): string {
  if (rel === '' || rel.includes('\0') || rel.includes('\\') || isAbsolute(rel)) throw new PathEscapeError('invalid path');
  const segments = rel.split('/');
  if (segments.some((s) => s === '..')) throw new PathEscapeError('parent segment');
  const normalized = normalize(rel);
  if (normalized === '.' || normalized.startsWith('..')) throw new PathEscapeError('resolves to base');
  const root = resolve(base);
  const full = resolve(root, normalized);
  if (full !== root && !full.startsWith(root + sep)) throw new PathEscapeError('outside base');
  if (full === root) throw new PathEscapeError('resolves to base');
  return full;
}

export class LocalDiskArtifactStore implements ArtifactStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private check(sha256: string): void {
    if (typeof sha256 !== 'string' || !ID.test(sha256)) throw new InvalidArtifactIdError();
  }

  private pathFor(sha256: string): string {
    // The id is validated hex, so these segments cannot contain separators or dots.
    return join(this.root, sha256.slice(0, 2), sha256.slice(2));
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const st = await lstat(this.root);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new PathEscapeError('store root is not a plain directory');
  }

  async put(bytes: Uint8Array): Promise<ArtifactRef> {
    await this.ensureRoot();
    const sha256 = sha256Of(bytes);
    const target = this.pathFor(sha256);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
      await rename(tmp, target);
    } finally {
      await rm(tmp, { force: true });
    }
    return { sha256, size: bytes.byteLength };
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    this.check(sha256);
    let data: Buffer;
    try {
      data = await readFile(this.pathFor(sha256));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (sha256Of(data) !== sha256) throw new ArtifactIntegrityError(sha256);
    return data;
  }

  async has(sha256: string): Promise<boolean> {
    this.check(sha256);
    try {
      await lstat(this.pathFor(sha256));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
}
