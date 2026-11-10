import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { CHECKPOINT_LIMITS, checkpointDigest, insideAllowedPaths, secretFileReason, type CheckpointExclusion, type ExclusionReason } from '@selarikru/domain';
import { redactSecrets, secretContent, type CheckpointFileWire, type CheckpointUpload } from '@selarikru/protocol';
import { readRegularFile, type FileChange } from '@selarikru/runtime-docker-local';
import type { FetchedCheckpoint } from './api.ts';

/**
 * Checkpoint continuation on the runner (docs/architecture.md §4). The prior attempt, once its worker is stopped and confirmed, sends its change set against the base: the
 * same diff the completion gate reads, every file hashed, with secret-bearing files, secret-shaped content and anything outside the allowed paths left out and listed by
 * path and reason. The successor checks every hash, the patch hash its lease names and the base, then writes the files into its fresh workspace before any sandbox exists.
 * Nothing here reads a home directory, model memory or sandbox state, and no excluded file's content is read past the check that excludes it.
 */

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const plainPath = (p: string): boolean => !p.includes('\0') && !p.includes('\\') && !p.startsWith('/') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..') && !p.toLowerCase().split('/').includes('.git');

export interface BuiltCheckpoint {
  readonly body: Omit<CheckpointUpload, 'lease'>;
  readonly exclusions: readonly CheckpointExclusion[];
}

/** Builds the checkpoint from the workspace and the change set the gate computed. `reserved` are workspace roots that are never the worker's work (signals, packs). */
export async function buildCheckpoint(workspace: string, changes: readonly FileChange[], task: { readonly baseSha: string; readonly allowedPaths: readonly string[] }, reserved: readonly string[]): Promise<BuiltCheckpoint> {
  const files: CheckpointFileWire[] = [];
  const exclusions: CheckpointExclusion[] = [];
  const exclude = (path: string, reason: ExclusionReason) => exclusions.push({ path, reason });
  for (const c of [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    // A name shaped like a credential is never sent, not even as an exclusion: the checkpoint then cannot list it, and the control plane offers a restart.
    if (redactSecrets(c.path) !== c.path) throw new Error('a changed file has a secret-shaped name; no checkpoint is sent');
    if (reserved.some((r) => c.path === r || c.path.startsWith(`${r}/`))) { exclude(c.path, 'reserved_path'); continue; }
    if (secretFileReason(c.path) !== null) { exclude(c.path, 'secret_file_name'); continue; }
    if (!plainPath(c.path) || !insideAllowedPaths(c.path, task.allowedPaths)) { exclude(c.path, 'outside_allowed_paths'); continue; }
    if (c.status === 'deleted') { files.push({ path: c.path, status: 'deleted', sha256: null, size: null, executable: false, content: null }); continue; }
    if (c.kind !== 'file') { exclude(c.path, 'not_a_regular_file'); continue; }
    const abs = join(workspace, c.path);
    // The bytes must still be the ones the gate hashed: a file that changed since is a failure, never sent.
    const bytes = await readRegularFile(abs);
    if (sha256(bytes) !== c.sha256) throw new Error(`${c.path} changed after it was checked`);
    if (bytes.length > CHECKPOINT_LIMITS.maxFileBytes) { exclude(c.path, 'too_large'); continue; }
    if (secretContent(bytes)) { exclude(c.path, 'secret_content'); continue; }
    const executable = ((await lstat(abs)).mode & 0o111) !== 0;
    files.push({ path: c.path, status: c.status, sha256: c.sha256, size: bytes.length, executable, content: Buffer.from(bytes).toString('base64') });
  }
  const patchSha256 = checkpointDigest(task.baseSha, files.map((f) => ({ path: f.path, status: f.status, sha256: f.sha256, executable: f.executable })));
  return { body: { baseSha: task.baseSha, patchSha256, files, exclusions }, exclusions };
}

export type ApplyResult = { readonly ok: true; readonly files: number } | { readonly ok: false; readonly reason: 'checkpoint_tampered' | 'checkpoint_apply_failed'; readonly detail: string };

/**
 * Checks a fetched checkpoint against what the lease and the task name, then writes it into the workspace. Every check runs before the first write, so a refused checkpoint
 * leaves the workspace at the base. Paths are written only inside the workspace, never through a link.
 */
export async function applyCheckpoint(workspace: string, fetched: FetchedCheckpoint, expected: { readonly baseSha: string; readonly patchSha256: string | null; readonly allowedPaths: readonly string[] }): Promise<ApplyResult> {
  const tampered = (detail: string): ApplyResult => ({ ok: false, reason: 'checkpoint_tampered', detail });
  if (fetched.baseSha !== expected.baseSha) return tampered('the checkpoint was made against another base');
  if (expected.patchSha256 === null || fetched.patchSha256 !== expected.patchSha256) return tampered('the patch hash is not the one the lease names');
  if (checkpointDigest(fetched.baseSha, fetched.files) !== fetched.patchSha256) return tampered('the file list does not give its patch hash');
  const decoded: { path: string; status: string; executable: boolean; bytes: Buffer | null }[] = [];
  for (const f of fetched.files) {
    if (!plainPath(f.path) || !insideAllowedPaths(f.path, expected.allowedPaths) || secretFileReason(f.path) !== null) return tampered(`${f.path} may not be carried`);
    if (f.status === 'deleted') { decoded.push({ path: f.path, status: f.status, executable: false, bytes: null }); continue; }
    if (f.content === null || f.sha256 === null) return tampered(`${f.path} has no content`);
    const bytes = Buffer.from(f.content, 'base64');
    if (sha256(bytes) !== f.sha256) return tampered(`${f.path} does not match its hash`);
    decoded.push({ path: f.path, status: f.status, executable: f.executable, bytes });
  }
  const root = resolve(workspace);
  try {
    for (const f of decoded) {
      const target = resolve(root, f.path);
      if (!target.startsWith(`${root}${sep}`)) return { ok: false, reason: 'checkpoint_apply_failed', detail: `${f.path} is outside the workspace` };
      // No directory on the way may be a link: the base was checked out here, so a link would be the base's own, and writing through it could leave the workspace.
      const segs = f.path.split('/');
      for (let i = 1; i < segs.length; i++) {
        const st = await lstat(join(root, ...segs.slice(0, i))).catch(() => null);
        if (st?.isSymbolicLink()) return { ok: false, reason: 'checkpoint_apply_failed', detail: `${f.path} would be written through a link` };
      }
      const existing = await lstat(target).catch(() => null);
      if (existing !== null && !existing.isFile()) return { ok: false, reason: 'checkpoint_apply_failed', detail: `${f.path} is not a regular file in the base` };
      if (f.bytes === null) {
        await rm(target, { force: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.bytes);
      await chmod(target, f.executable ? 0o755 : 0o644);
    }
  } catch (err) {
    return { ok: false, reason: 'checkpoint_apply_failed', detail: err instanceof Error ? err.message : 'error' };
  }
  return { ok: true, files: decoded.length };
}
