import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
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

/** A file's bytes at the base commit, or null when the base has none. Read with git from the runner's checkout, never from the workspace. */
export type ReadBase = (path: string) => Promise<Buffer | null>;

const MAX_DIFF_CHARS = 256 * 1024;
const MAX_LCS_CELLS = 4_000_000;
const asText = (b: Buffer): string | null => {
  if (b.includes(0)) return null;
  const t = b.toString('utf8');
  return Buffer.from(t, 'utf8').equals(b) ? t : null;
};

/**
 * Every line of both sides, each kept, added or removed: a common prefix and suffix, and between them the longest common subsequence while it is small enough to compute, else
 * the whole middle replaced. Not always the shortest diff, always a true one: its kept and added lines are the file, which the control plane checks.
 */
export function lineDiff(before: string | null, after: string | null): [' ' | '+' | '-', string][] {
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const am = a.slice(p, a.length - q);
  const bm = b.slice(p, b.length - q);
  const mid: [' ' | '+' | '-', string][] = [];
  if (am.length * bm.length <= MAX_LCS_CELLS && am.length > 0 && bm.length > 0) {
    const n = am.length, m = bm.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = am[i] === bm[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { mid.push([' ', am[i]!]); i++; j++; }
      else if (L[i + 1]![j]! >= L[i]![j + 1]!) mid.push(['-', am[i++]!]);
      else mid.push(['+', bm[j++]!]);
    }
    while (i < n) mid.push(['-', am[i++]!]);
    while (j < m) mid.push(['+', bm[j++]!]);
  } else {
    for (const l of am) mid.push(['-', l]);
    for (const l of bm) mid.push(['+', l]);
  }
  return [...a.slice(0, p).map((l) => [' ', l] as [' ', string]), ...mid, ...a.slice(a.length - q).map((l) => [' ', l] as [' ', string])];
}

async function reviewDiff(readBase: ReadBase | undefined, path: string, after: Buffer | null): Promise<CheckpointFileWire['diff']> {
  if (readBase === undefined) return null;
  const base = await readBase(path).catch(() => null);
  const before = base === null ? null : asText(base);
  const now = after === null ? null : asText(after);
  if ((base !== null && before === null) || (after !== null && now === null)) return { binary: true, lines: null };
  if ((before?.length ?? 0) + (now?.length ?? 0) > MAX_DIFF_CHARS) return { binary: false, lines: null };
  return { binary: false, lines: lineDiff(before, now) };
}

/** Builds the checkpoint from the workspace and the change set the gate computed. `reserved` are workspace roots that are never the worker's work (signals, packs). */
export async function buildCheckpoint(workspace: string, changes: readonly FileChange[], task: { readonly baseSha: string; readonly allowedPaths: readonly string[] }, reserved: readonly string[], readBase?: ReadBase): Promise<BuiltCheckpoint> {
  const files: CheckpointFileWire[] = [];
  const exclusions: CheckpointExclusion[] = [];
  const exclude = (path: string, reason: ExclusionReason) => exclusions.push({ path, reason });
  for (const c of [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    // A name shaped like a credential is never sent, not even as an exclusion: the checkpoint then cannot list it, and the control plane offers a restart.
    if (redactSecrets(c.path) !== c.path) throw new Error('a changed file has a secret-shaped name; no checkpoint is sent');
    if (reserved.some((r) => c.path === r || c.path.startsWith(`${r}/`))) { exclude(c.path, 'reserved_path'); continue; }
    if (secretFileReason(c.path) !== null) { exclude(c.path, 'secret_file_name'); continue; }
    if (!plainPath(c.path) || !insideAllowedPaths(c.path, task.allowedPaths)) { exclude(c.path, 'outside_allowed_paths'); continue; }
    if (c.status === 'deleted') { files.push({ path: c.path, status: 'deleted', sha256: null, size: null, executable: false, content: null, diff: await reviewDiff(readBase, c.path, null) }); continue; }
    if (c.kind !== 'file') { exclude(c.path, 'not_a_regular_file'); continue; }
    const abs = join(workspace, c.path);
    // The bytes must still be the ones the gate hashed: a file that changed since is a failure, never sent.
    const bytes = await readRegularFile(abs);
    if (sha256(bytes) !== c.sha256) throw new Error(`${c.path} changed after it was checked`);
    if (bytes.length > CHECKPOINT_LIMITS.maxFileBytes) { exclude(c.path, 'too_large'); continue; }
    if (secretContent(bytes)) { exclude(c.path, 'secret_content'); continue; }
    const executable = ((await lstat(abs)).mode & 0o111) !== 0;
    files.push({ path: c.path, status: c.status, sha256: c.sha256, size: bytes.length, executable, content: Buffer.from(bytes).toString('base64'), diff: await reviewDiff(readBase, c.path, bytes) });
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
  const written = await writeCheckedFiles(workspace, decoded.map((f) => ({ path: f.path, bytes: f.bytes, mode: f.executable ? 0o755 : 0o644 })));
  if (!written.ok) return { ok: false, reason: 'checkpoint_apply_failed', detail: written.detail };
  return { ok: true, files: decoded.length };
}

/** One file to write: its bytes, or null to delete it. `mode` `keep` keeps a file's existing mode (a new file gets 0644). */
export interface CheckedFile {
  readonly path: string;
  readonly bytes: Buffer | null;
  readonly mode: number | 'keep';
}

/**
 * Writes checked files into a workspace that holds the base: only inside it, never through a link on the way (every ancestor is `lstat`ed, T6.5), and only over a regular
 * file. The caller has checked every path and hash first. Used by checkpoint continuation and by the apply worker (H5).
 */
export async function writeCheckedFiles(workspace: string, files: readonly CheckedFile[]): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  const root = resolve(workspace);
  try {
    // Every target is checked before the first write, so a refusal leaves the workspace at the base.
    for (const f of files) {
      if (!plainPath(f.path)) return { ok: false, detail: `${f.path} is not a plain path` };
      const target = resolve(root, f.path);
      if (!target.startsWith(`${root}${sep}`)) return { ok: false, detail: `${f.path} is outside the workspace` };
      // No directory on the way may be a link: the base was checked out here, so a link would be the base's own, and writing through it could leave the workspace.
      const segs = f.path.split('/');
      for (let i = 1; i < segs.length; i++) {
        const st = await lstat(join(root, ...segs.slice(0, i))).catch(() => null);
        if (st?.isSymbolicLink()) return { ok: false, detail: `${f.path} would be written through a link` };
        if (st !== null && !st.isDirectory()) return { ok: false, detail: `${f.path} has a file where a directory is needed` };
      }
      const existing = await lstat(target).catch(() => null);
      if (existing !== null && !existing.isFile()) return { ok: false, detail: `${f.path} is not a regular file in the base` };
    }
    for (const f of files) {
      const target = resolve(root, f.path);
      if (f.bytes === null) {
        await rm(target, { force: true });
        continue;
      }
      const existing = await lstat(target).catch(() => null);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.bytes);
      await chmod(target, f.mode === 'keep' ? (existing !== null ? existing.mode & 0o777 : 0o644) : f.mode);
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'error' };
  }
  return { ok: true };
}

const execFileP = promisify(execFile);

/** Reads files at the base commit from the runner's own checkout with git, isolated from this machine's git configuration. */
export const gitBaseReader = (repo: string, baseSha: string): ReadBase => async (path) => {
  try {
    const r = await execFileP('git', ['-C', repo, 'cat-file', 'blob', `${baseSha}:${path}`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
    return r.stdout as Buffer;
  } catch {
    return null;
  }
};
