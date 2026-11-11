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

/** Regular files under `prefix` at `baseSha`, sorted. Links and submodules are not files. */
async function listFiles(repo: string, baseSha: string, prefix: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP('git', ['-C', repo, 'ls-tree', '-r', '-z', '--full-tree', baseSha, '--', prefix], { env: GIT_ENV, maxBuffer: 8 * 1024 * 1024 });
    return stdout.split('\0').filter(Boolean).flatMap((line) => {
      const tab = line.indexOf('\t');
      const [mode, type] = line.slice(0, tab).split(' ');
      return type === 'blob' && (mode === '100644' || mode === '100755') ? [line.slice(tab + 1)] : [];
    }).sort();
  } catch {
    return [];
  }
}

export async function answerFileRequest(repo: string | undefined, req: BaseFileRequest): Promise<BaseFileAnswer> {
  const files: { path: string; content: string }[] = [];
  const omitted: { path: string; reason: BaseFileOmission }[] = [];
  const omit = (path: string, reason: BaseFileOmission) => { if (omitted.length < MAX_LISTED) omitted.push({ path, reason }); };
  if (repo === undefined) {
    for (const p of req.paths) omit(p, 'not_found');
    return { requestId: req.requestId, files, omitted };
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
