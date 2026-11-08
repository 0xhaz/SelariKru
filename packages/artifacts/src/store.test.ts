import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactIntegrityError, InvalidArtifactIdError, LocalDiskArtifactStore, resolveWithin, PathEscapeError } from './index.ts';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artifacts-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalDiskArtifactStore', () => {
  it('stores by content hash, returns the same ref for the same bytes, and reads them back', async () => {
    const store = new LocalDiskArtifactStore(join(root, 'store'));
    const a = await store.put(Buffer.from('hello'));
    const b = await store.put(Buffer.from('hello'));
    expect(a).toEqual({ sha256: sha('hello'), size: 5 });
    expect(b).toEqual(a);
    expect(Buffer.from((await store.get(a.sha256))!).toString()).toBe('hello');
    expect(await store.has(a.sha256)).toBe(true);
    expect(await store.has(sha('other'))).toBe(false);
    expect(await store.get(sha('other'))).toBeNull();
  });

  it('rejects ids that are not a lowercase sha256, so no id can name a path outside the store', async () => {
    const store = new LocalDiskArtifactStore(join(root, 'store'));
    for (const bad of ['../../etc/passwd', '..', '', 'abc', `${sha('x')}/../x`, sha('x').toUpperCase(), `${sha('x')}\0`, '/etc/passwd', 'a/b']) {
      await expect(store.get(bad)).rejects.toBeInstanceOf(InvalidArtifactIdError);
      await expect(store.has(bad)).rejects.toBeInstanceOf(InvalidArtifactIdError);
    }
  });

  it('detects a blob changed on disk and refuses to return it', async () => {
    const store = new LocalDiskArtifactStore(join(root, 'store'));
    const ref = await store.put(Buffer.from('original'));
    const dir = join(root, 'store', ref.sha256.slice(0, 2));
    const file = join(dir, (await readdir(dir))[0]!);
    await writeFile(file, 'tampered');
    await expect(store.get(ref.sha256)).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it('leaves no temporary files behind', async () => {
    const store = new LocalDiskArtifactStore(join(root, 'store'));
    const ref = await store.put(Buffer.from('x'));
    const names = await readdir(join(root, 'store', ref.sha256.slice(0, 2)));
    expect(names).toEqual([ref.sha256.slice(2)]);
  });

  it('refuses a store root that is a symlink', async () => {
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'link'));
    const store = new LocalDiskArtifactStore(join(root, 'link'));
    await expect(store.put(Buffer.from('x'))).rejects.toBeInstanceOf(PathEscapeError);
  });
});

describe('resolveWithin', () => {
  it('accepts normal relative paths and rejects traversal, absolute paths, NUL and backslashes', () => {
    expect(resolveWithin('/base', 'a/b.txt')).toBe('/base/a/b.txt');
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a\0b', 'a\\..\\b', '', '.', '..'])
      expect(() => resolveWithin('/base', bad)).toThrow(PathEscapeError);
  });
});
