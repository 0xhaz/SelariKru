import { createHash } from 'node:crypto';
import { CHECKPOINT_LIMITS, checkpointDigest, diffPostImage, EXCLUSION_REASONS, insideAllowedPaths, secretFileReason, type CheckpointDiff, type CheckpointExclusion, type CheckpointFile, type CheckpointRefusal } from '@selarikru/domain';
import { z } from 'zod';
import { redactSecrets } from './redact.ts';
import { LeaseRefSchema } from './runner.ts';

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase hex sha256');
/** A plain repository path: no absolute path, no `..`, no backslash, no NUL. Checked again below with the reasons the record names. */
const WirePath = z.string().min(1).max(512);

export const CheckpointFileWireSchema = z.object({
  path: WirePath,
  status: z.enum(['added', 'modified', 'deleted']),
  sha256: Hex64.nullable(),
  size: z.number().int().min(0).nullable(),
  executable: z.boolean(),
  /** The file's bytes after the change, base64. Null for a deletion. */
  content: z.string().max(Math.ceil((CHECKPOINT_LIMITS.maxFileBytes * 4) / 3) + 8).nullable(),
  /** The owner's review diff against the base, every line of both sides. Null or absent: binary, or too large to show. Checked against `content` before it is kept. */
  diff: z.object({ binary: z.boolean(), lines: z.array(z.tuple([z.enum([' ', '+', '-']), z.string().max(CHECKPOINT_LIMITS.maxFileBytes)])).max(CHECKPOINT_LIMITS.maxDiffLines).nullable() }).strict().nullable().optional(),
}).strict();
export type CheckpointFileWire = z.infer<typeof CheckpointFileWireSchema>;

export const CheckpointExclusionSchema = z.object({ path: WirePath, reason: z.enum(EXCLUSION_REASONS) }).strict();

/**
 * What the runner holding the prior attempt sends when the owner asked to continue in cloud: the attempt's change set against the approved base, every file hashed, the paths
 * it left out with the reason. Untrusted: `validateCheckpoint` decides, and refuses rather than repairs. Restricted work never sends one (the route refuses it).
 */
export const CheckpointUploadSchema = z.object({
  lease: LeaseRefSchema,
  baseSha: z.string().min(1).max(64),
  patchSha256: Hex64,
  files: z.array(CheckpointFileWireSchema).max(CHECKPOINT_LIMITS.maxFiles + 1),
  exclusions: z.array(CheckpointExclusionSchema).max(CHECKPOINT_LIMITS.maxExclusions),
}).strict();
export type CheckpointUpload = z.infer<typeof CheckpointUploadSchema>;

/** What the successor fetches: the record's files with their bytes, and the hashes to check them against before any worker starts. */
export const CheckpointFetchSchema = z.object({ lease: LeaseRefSchema }).strict();

export interface CheckpointContent {
  readonly baseSha: string;
  readonly patchSha256: string;
  readonly files: readonly CheckpointFile[];
  /** base64 by path, for every file that is not a deletion. */
  readonly content: Readonly<Record<string, string>>;
  /** The review diff by path, checked against the content. A file with none shows no lines. */
  readonly diffs: Readonly<Record<string, CheckpointDiff>>;
}

export type CheckpointValidation =
  | { readonly ok: true; readonly checkpoint: CheckpointContent; readonly exclusions: readonly CheckpointExclusion[]; readonly totalBytes: number }
  | { readonly ok: false; readonly reason: CheckpointRefusal; readonly path?: string };

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const plainPath = (p: string): boolean => !p.includes('\0') && !p.includes('\\') && !p.startsWith('/') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..') && !p.toLowerCase().split('/').includes('.git');
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Secret-shaped text in a file's bytes, by the same detector every log line and event goes through. Binary content is judged on its UTF-8 reading. */
export const secretContent = (bytes: Uint8Array): boolean => {
  const text = Buffer.from(bytes).toString('utf8');
  return redactSecrets(text) !== text;
};

/**
 * Checks a checkpoint against the task it claims to continue. Every rule refuses: a secret file or secret content that reached the server, a path outside the allowed paths, a
 * hash that does not match, a file or a whole that is too large. A secret-bearing file the task changed inside its allowed paths was excluded by the runner, which leaves the
 * work incomplete, so that refuses too (`required_file_excluded`). Exclusions outside the allowed paths are only listed: the completion gate would refuse those changes anyway.
 */
export function validateCheckpoint(upload: Pick<CheckpointUpload, 'baseSha' | 'patchSha256' | 'files' | 'exclusions'>, task: { readonly baseSha: string; readonly allowedPaths: readonly string[] }): CheckpointValidation {
  if (upload.baseSha !== task.baseSha) return { ok: false, reason: 'base_mismatch' };
  for (const x of upload.exclusions) {
    if (!plainPath(x.path)) return { ok: false, reason: 'path_invalid' };
    // A path is stored and shown: one shaped like a credential is refused, as anywhere else a name is recorded.
    if (redactSecrets(x.path) !== x.path) return { ok: false, reason: 'secret_content_included' };
    // Any exclusion inside the allowed paths is part of the task's work, whatever label the runner gave it: the work cannot be carried whole.
    if (insideAllowedPaths(x.path, task.allowedPaths)) return { ok: false, reason: x.reason === 'too_large' ? 'file_too_large' : 'required_file_excluded', path: x.path };
  }
  if (upload.files.length === 0) return { ok: false, reason: 'empty_checkpoint' };
  if (upload.files.length > CHECKPOINT_LIMITS.maxFiles) return { ok: false, reason: 'too_many_files' };
  const seen = new Set<string>();
  const files: CheckpointFile[] = [];
  const content: Record<string, string> = {};
  const diffs: Record<string, CheckpointDiff> = {};
  let total = 0;
  let diffChars = 0;
  /** A diff is display only, but it must say what the file becomes: its kept and added lines are the file. A deletion's diff adds nothing. */
  const takeDiff = (f: CheckpointFileWire, bytes: Buffer | null): CheckpointRefusal | null => {
    const d = f.diff;
    if (!d) return null;
    if (d.lines === null) { diffs[f.path] = { binary: d.binary, lines: null, added: 0, removed: 0 }; return null; }
    diffChars += d.lines.reduce((n, [, t]) => n + t.length + 1, 0);
    if (diffChars > CHECKPOINT_LIMITS.maxDiffChars) return 'checkpoint_too_large';
    const post = diffPostImage(d.lines);
    if (bytes === null ? d.lines.some(([op]) => op !== '-') : Buffer.from(post, 'utf8').compare(bytes) !== 0) return 'diff_mismatch';
    // Kept and added lines are the file, checked above and for secrets with it. A removed line is only the runner's word for the base, so it is redacted before it is kept.
    const lines = d.lines.map(([op, t]) => [op, op === '-' ? redactSecrets(t) : t] as const);
    diffs[f.path] = { binary: false, lines, redacted: lines.some(([, t], i) => t !== d.lines![i]![1]), added: d.lines.filter(([op]) => op === '+').length, removed: d.lines.filter(([op]) => op === '-').length };
    return null;
  };
  for (const f of upload.files) {
    if (!plainPath(f.path)) return { ok: false, reason: 'path_invalid', path: f.path };
    if (redactSecrets(f.path) !== f.path) return { ok: false, reason: 'secret_content_included' };
    if (seen.has(f.path)) return { ok: false, reason: 'duplicate_path', path: f.path };
    seen.add(f.path);
    if (!insideAllowedPaths(f.path, task.allowedPaths)) return { ok: false, reason: 'path_outside_allowed_paths', path: f.path };
    if (secretFileReason(f.path) !== null) return { ok: false, reason: 'secret_file_included', path: f.path };
    if (f.status === 'deleted') {
      if (f.sha256 !== null || f.content !== null) return { ok: false, reason: 'invalid_checkpoint', path: f.path };
      const bad = takeDiff(f, null);
      if (bad) return { ok: false, reason: bad, path: f.path };
      files.push({ path: f.path, status: 'deleted', sha256: null, size: null, executable: false });
      continue;
    }
    if (f.sha256 === null || f.content === null || !BASE64.test(f.content)) return { ok: false, reason: 'invalid_checkpoint', path: f.path };
    const bytes = Buffer.from(f.content, 'base64');
    if (bytes.length > CHECKPOINT_LIMITS.maxFileBytes) return { ok: false, reason: 'file_too_large', path: f.path };
    total += bytes.length;
    if (total > CHECKPOINT_LIMITS.maxTotalBytes) return { ok: false, reason: 'checkpoint_too_large' };
    if (sha256(bytes) !== f.sha256 || (f.size !== null && f.size !== bytes.length)) return { ok: false, reason: 'file_hash_mismatch', path: f.path };
    if (secretContent(bytes)) return { ok: false, reason: 'secret_content_included', path: f.path };
    const bad = takeDiff(f, bytes);
    if (bad) return { ok: false, reason: bad, path: f.path };
    files.push({ path: f.path, status: f.status, sha256: f.sha256, size: bytes.length, executable: f.executable });
    content[f.path] = f.content;
  }
  if (checkpointDigest(upload.baseSha, files) !== upload.patchSha256) return { ok: false, reason: 'patch_hash_mismatch' };
  const exclusions = upload.exclusions.map((x) => ({ path: x.path, reason: x.reason }));
  return { ok: true, checkpoint: { baseSha: upload.baseSha, patchSha256: upload.patchSha256, files, content, diffs }, exclusions, totalBytes: total };
}

/** The same hashes, checked on stored content before it is served or applied: a row changed after it was checked is refused, never trusted. */
export function verifyCheckpointContent(c: Omit<CheckpointContent, 'diffs'>): { readonly ok: true } | { readonly ok: false; readonly reason: 'checkpoint_tampered'; readonly path?: string } {
  for (const f of c.files) {
    if (f.status === 'deleted') continue;
    const b64 = c.content[f.path];
    if (b64 === undefined || f.sha256 === null || sha256(Buffer.from(b64, 'base64')) !== f.sha256) return { ok: false, reason: 'checkpoint_tampered', path: f.path };
  }
  if (checkpointDigest(c.baseSha, c.files) !== c.patchSha256) return { ok: false, reason: 'checkpoint_tampered' };
  return { ok: true };
}

const Key = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, 'expected an idempotency key');
/** The owner asks to continue a task in cloud (`resume`), or to restart it from its persisted input (`restart`). */
export const HandoverRequestSchema = z.strictObject({ mode: z.enum(['resume', 'restart']), idempotencyKey: Key });
/** The owner's answer: release a reviewed checkpoint, restart from the persisted input, or keep the task where it is. */
export const HandoverDecisionSchema = z.strictObject({ checkpointId: z.string().min(1).max(100), choice: z.enum(['release', 'restart', 'decline']), idempotencyKey: Key });
/** Which file's review diff the owner opens. */
export const HandoverDiffQuerySchema = z.strictObject({ checkpointId: z.string().min(1).max(100), path: z.string().min(1).max(512) });
