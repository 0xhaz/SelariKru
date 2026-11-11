import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BASE_FILE_LIMITS, baseFileIssue, redactSecrets, type BaseFileAnswer, type BaseFileOmission, type BaseFileRequest } from '@selarikru/domain';
import { gitBaseReader } from './checkpoint.ts';

/**
 * Base files for the patch agent (H5). The server relays a read from the owner's browser; this runner answers from its own checkout with git at the task's base commit
 * (`git ls-tree` and `git cat-file`, as the T6.3 manifest does): never the working tree, never a script. Only regular files under the asked paths, each inside the task's
 * allowed paths and neither reserved nor a credentials file, within the patch agent's count and size limits, with no secret-shaped content. Nothing is written or kept.
 */

const execFileP = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
/** How many paths one answer lists at most, served or not. */
const MAX_LISTED = 200;

/** Regular files under `prefix` at `baseSha` with their sizes, sorted. Links and submodules are not files. The path is literal: no glob or magic pathspec applies. */
export async function listEntries(repo: string, baseSha: string, prefix: string): Promise<{ path: string; size: number }[]> {
  try {
    const { stdout } = await execFileP('git', ['--literal-pathspecs', '-C', repo, 'ls-tree', '-r', '-l', '-z', '--full-tree', baseSha, '--', prefix], { env: GIT_ENV, maxBuffer: 8 * 1024 * 1024 });
    return stdout.split('\0').filter(Boolean).flatMap((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, , size] = line.slice(0, tab).trim().split(/\s+/);
      return type === 'blob' && (mode === '100644' || mode === '100755') ? [{ path: line.slice(tab + 1), size: Number(size) || 0 }] : [];
    }).sort((a, b) => (a.path < b.path ? -1 : 1));
  } catch {
    return [];
  }
}
const listFiles = async (repo: string, baseSha: string, prefix: string): Promise<string[]> => (await listEntries(repo, baseSha, prefix)).map((e) => e.path);

export async function answerFileRequest(repo: string | undefined, req: BaseFileRequest): Promise<BaseFileAnswer> {
  const files: { path: string; content: string }[] = [];
  const omitted: { path: string; reason: BaseFileOmission }[] = [];
  const omit = (path: string, reason: BaseFileOmission) => { if (omitted.length < MAX_LISTED) omitted.push({ path, reason }); };
  // No copy of the project here: said so, so the browser can say a proposal can only add files.
  if (repo === undefined) return { requestId: req.requestId, files, omitted, noCheckout: true };
  if (req.mode === 'list') {
    const entries: { path: string; size: number }[] = [];
    let truncated = false;
    for (const prefix of req.paths) {
      if (baseFileIssue(prefix, req.allowedPaths) !== null) continue;
      for (const e of await listEntries(repo, req.baseSha, prefix)) {
        if (baseFileIssue(e.path, req.allowedPaths) !== null || entries.some((x) => x.path === e.path)) continue;
        if (entries.length >= BASE_FILE_LIMITS.listEntries) { truncated = true; break; }
        entries.push(e);
      }
    }
    return { requestId: req.requestId, files, omitted, entries, truncated };
  }
  const read = gitBaseReader(repo, req.baseSha);
  const seen = new Set<string>();
  let total = 0;
  for (const prefix of req.paths) {
    if (baseFileIssue(prefix, req.allowedPaths) !== null) continue;
    const listed = await listFiles(repo, req.baseSha, prefix);
    if (listed.length === 0) omit(prefix, 'not_found');
    for (const path of listed) {
      if (seen.has(path)) continue;
      seen.add(path);
      // Withheld paths are not named back: the server would drop them anyway.
      if (baseFileIssue(path, req.allowedPaths) !== null) continue;
      if (files.length >= BASE_FILE_LIMITS.files) { omit(path, 'too_many'); continue; }
      const bytes = await read(path);
      if (bytes === null) { omit(path, 'not_found'); continue; }
      const text = bytes.toString('utf8');
      if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) { omit(path, 'not_text'); continue; }
      if (text.length > BASE_FILE_LIMITS.fileChars || total + text.length > BASE_FILE_LIMITS.totalChars) { omit(path, 'too_large'); continue; }
      if (redactSecrets(text) !== text) { omit(path, 'secret_content'); continue; }
      total += text.length;
      files.push({ path, content: text });
    }
  }
  return { requestId: req.requestId, files, omitted };
}
