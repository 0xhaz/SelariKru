import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectStack, isStackDetectionPath, isStackManifestPath, STACK_DETECTION_MAX_BYTES, STACK_DETECTION_MAX_FILES, type StackDetectionFile, type StackDetectionReport } from '@selarikru/protocol';
import { BundleError, gitEnv, isExcludedPath, readBlobs } from './bundle.ts';

const execFileP = promisify(execFile);
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Static stack detection of a checkout at one commit, the same way the repository manifest is read: `git ls-tree` for the paths and `git cat-file --batch` for the
 * text of a few named manifests. Nothing in the repository runs (no script, package manager, hook or filter), the working tree is never read, and a symlink is never
 * followed: its blob is a target path, so it is skipped and reported. Paths a workspace never receives (`isExcludedPath`) are not read.
 */
export async function readStackDetection(repoPath: string, sha: string): Promise<StackDetectionReport> {
  if (!SHA.test(sha)) throw new BundleError('base is not a full commit id');
  const { stdout } = await execFileP('git', ['-C', repoPath, 'ls-tree', '-r', '-l', '-z', '--full-tree', sha], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: gitEnv() });
  const files: StackDetectionFile[] = [];
  const toRead: { path: string; oid: string }[] = [];
  const skipped: StackDetectionReport['skipped'] = [];
  for (const rec of stdout.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, oid, size] = rec.slice(0, tab).trim().split(/\s+/);
    const path = rec.slice(tab + 1);
    if (!isStackDetectionPath(path) || isExcludedPath(path)) continue;
    if (mode === '120000') { skipped.push({ path, reason: 'symlink' }); continue; }
    if (type !== 'blob' || !oid || (mode !== '100644' && mode !== '100755')) continue;
    if (!isStackManifestPath(path)) { files.push({ path }); continue; }
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes > STACK_DETECTION_MAX_BYTES) { skipped.push({ path, reason: 'too_large' }); continue; }
    if (toRead.length >= STACK_DETECTION_MAX_FILES) { skipped.push({ path, reason: 'limit' }); continue; }
    toRead.push({ path, oid });
  }
  const blobs = await readBlobs(repoPath, toRead.map((f) => f.oid));
  for (const f of toRead) {
    const buf = blobs.get(f.oid);
    if (buf === undefined) { skipped.push({ path: f.path, reason: 'unreadable' }); continue; }
    files.push({ path: f.path, content: buf.toString('utf8') });
  }
  const r = detectStack(files);
  return { commit: sha, items: r.items, commands: r.commands, skipped: [...skipped, ...r.skipped].slice(0, 200) };
}
