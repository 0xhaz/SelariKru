import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkpointDigest, secretFileReason } from '@selarikru/domain';
import { CheckpointUploadSchema, validateCheckpoint, verifyCheckpointContent, type CheckpointFileWire } from './index.ts';

const BASE = 'a'.repeat(40);
const task = { baseSha: BASE, allowedPaths: ['server', 'tests/backend'] };
const file = (path: string, body: string, status: 'added' | 'modified' = 'modified'): CheckpointFileWire => {
  const bytes = Buffer.from(body);
  return { path, status, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, executable: false, content: bytes.toString('base64') };
};
const upload = (files: CheckpointFileWire[], exclusions: { path: string; reason: any }[] = []) => ({ baseSha: BASE, files, exclusions, patchSha256: checkpointDigest(BASE, files) });

describe('checkpoint rules', () => {
  it('names secret-bearing files by convention', () => {
    for (const p of ['.env', 'server/.env.local', 'certs/server.pem', 'keys/deploy.key', 'id_rsa', '.npmrc', 'config/credentials.json', 'server/aws-credentials.yaml', '.aws/config', 'secrets.yml', 'gcp-service-account.json'])
      expect(secretFileReason(p), p).toBe('secret_file_name');
    for (const p of ['server/env.ts', 'server/keyboard.ts', 'src/credentials-form.tsx', 'README.md', 'server/secretary.ts'])
      expect(secretFileReason(p), p).toBeNull();
  });

  it('accepts a change set inside the allowed paths with matching hashes, and lists exclusions by path and reason only', () => {
    const files = [file('server/app.ts', 'export const a = 2;\n'), { path: 'server/old.ts', status: 'deleted' as const, sha256: null, size: null, executable: false, content: null }];
    const r = validateCheckpoint(upload(files, [{ path: '.env', reason: 'secret_file_name' }, { path: 'notes/todo.md', reason: 'outside_allowed_paths' }]), task);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.checkpoint.files.map((f) => f.path)).toEqual(['server/app.ts', 'server/old.ts']);
    expect(r.exclusions).toEqual([{ path: '.env', reason: 'secret_file_name' }, { path: 'notes/todo.md', reason: 'outside_allowed_paths' }]);
    expect(JSON.stringify(r.exclusions)).not.toContain('content');
  });

  it('refuses a secret file or secret content that reached it, rather than storing it', () => {
    expect(validateCheckpoint(upload([file('server/.env', 'X=1')]), task)).toMatchObject({ ok: false, reason: 'secret_file_included' });
    expect(validateCheckpoint(upload([file('server/config.ts', 'const k = "sk_live_CANARY0123456789abcdefXYZ";')]), task)).toMatchObject({ ok: false, reason: 'secret_content_included' });
    // A credential-shaped file name is refused too, and the refusal does not repeat it.
    const named = validateCheckpoint(upload([file('server/x.ts', 'ok')], [{ path: 'sk_live_CANARY0123456789abcdefXYZ.txt', reason: 'outside_allowed_paths' }]), task);
    expect(named).toMatchObject({ ok: false, reason: 'secret_content_included' });
    expect(JSON.stringify(named)).not.toContain('CANARY');
  });

  it('refuses when a file the task changed inside its allowed paths had to be excluded', () => {
    expect(validateCheckpoint(upload([file('server/app.ts', 'x')], [{ path: 'server/.env.local', reason: 'secret_file_name' }]), task)).toMatchObject({ ok: false, reason: 'required_file_excluded', path: 'server/.env.local' });
  });

  it('refuses an exclusion labelled outside the allowed paths that is inside them (case C)', () => {
    expect(validateCheckpoint(upload([file('server/a.ts', 'x')], [{ path: 'server/needed.ts', reason: 'outside_allowed_paths' }]), task)).toMatchObject({ ok: false, reason: 'required_file_excluded', path: 'server/needed.ts' });
  });

  it('keeps a review diff only when its kept and added lines are the file, with its stat', () => {
    const f = file('server/app.ts', 'a\nb2\nc');
    const ok = validateCheckpoint(upload([{ ...f, diff: { binary: false, lines: [[' ', 'a'], ['-', 'b'], ['+', 'b2'], [' ', 'c']] } }]), task);
    expect(ok.ok && ok.checkpoint.diffs['server/app.ts']).toMatchObject({ added: 1, removed: 1, binary: false });
    // A diff that shows something other than what is applied is refused: the owner reviews exactly what the successor gets.
    expect(validateCheckpoint(upload([{ ...f, diff: { binary: false, lines: [[' ', 'a'], ['+', 'harmless'], [' ', 'c']] } }]), task)).toMatchObject({ ok: false, reason: 'diff_mismatch' });
    const del = { path: 'server/old.ts', status: 'deleted' as const, sha256: null, size: null, executable: false, content: null };
    expect(validateCheckpoint(upload([{ ...del, diff: { binary: false, lines: [['-', 'gone']] } }]), task).ok).toBe(true);
    expect(validateCheckpoint(upload([{ ...del, diff: { binary: false, lines: [['+', 'sneak']] } }]), task)).toMatchObject({ ok: false, reason: 'diff_mismatch' });
  });

  it('stores a removed base line redacted: only kept and added lines are the checked file, so the rest is the runner\'s word', () => {
    const f = file('server/app.ts', 'b');
    const r = validateCheckpoint(upload([{ ...f, diff: { binary: false, lines: [['-', 'token=sk_live_CANARY0123456789abcdefXYZ'], ['+', 'b']] } }]), task);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain('CANARY');
    expect(r.ok && r.checkpoint.diffs['server/app.ts']!.removed).toBe(1);
  });

  it('refuses paths outside the allowed paths, unsafe paths, a wrong base, an empty change set and oversize work', () => {
    expect(validateCheckpoint(upload([file('src/app.ts', 'x')]), task)).toMatchObject({ ok: false, reason: 'path_outside_allowed_paths' });
    expect(validateCheckpoint(upload([file('server/../etc/passwd', 'x')]), task)).toMatchObject({ ok: false, reason: 'path_invalid' });
    expect(validateCheckpoint({ ...upload([file('server/a.ts', 'x')]), baseSha: 'b'.repeat(40) }, task)).toMatchObject({ ok: false, reason: 'base_mismatch' });
    expect(validateCheckpoint(upload([]), task)).toMatchObject({ ok: false, reason: 'empty_checkpoint' });
    expect(validateCheckpoint(upload([file('server/big.ts', 'x'.repeat(600 * 1024))]), task)).toMatchObject({ ok: false, reason: 'file_too_large' });
    const many = Array.from({ length: 5 }, (_, i) => file(`server/f${i}.ts`, 'y'.repeat(500 * 1024)));
    expect(validateCheckpoint(upload(many), task)).toMatchObject({ ok: false, reason: 'checkpoint_too_large' });
  });

  it('refuses a tampered file or patch hash', () => {
    const f = file('server/app.ts', 'export const a = 2;\n');
    expect(validateCheckpoint(upload([{ ...f, content: Buffer.from('export const a = 3;\n').toString('base64') }]), task)).toMatchObject({ ok: false, reason: 'file_hash_mismatch' });
    expect(validateCheckpoint({ ...upload([f]), patchSha256: '0'.repeat(64) }, task)).toMatchObject({ ok: false, reason: 'patch_hash_mismatch' });
  });

  it('checks stored content again before it is served', () => {
    const r = validateCheckpoint(upload([file('server/app.ts', 'ok')]), task);
    if (!r.ok) throw new Error('expected ok');
    expect(verifyCheckpointContent(r.checkpoint)).toEqual({ ok: true });
    expect(verifyCheckpointContent({ ...r.checkpoint, content: { 'server/app.ts': Buffer.from('tampered').toString('base64') } })).toMatchObject({ ok: false, reason: 'checkpoint_tampered' });
  });

  it('the wire schema is strict', () => {
    const lease = { attemptId: 'a', fence: 1, leaseToken: 't' };
    expect(CheckpointUploadSchema.safeParse({ lease, ...upload([file('server/a.ts', 'x')]) }).success).toBe(true);
    expect(CheckpointUploadSchema.safeParse({ lease, ...upload([file('server/a.ts', 'x')]), home: '/Users/me' }).success).toBe(false);
  });
});
