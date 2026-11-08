import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * Stable hash of a directory tree: sha256 over sorted "relative/path NUL sha256(file)\n" lines.
 * Independent of mtimes, permissions and traversal order. Symlinks are refused.
 */
export function hashTree(root: string, opts: { exclude?: (relPath: string) => boolean } = {}): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (name === '.DS_Store' || name === 'node_modules' || opts.exclude?.(relPath)) continue;
      const st = lstatSync(join(root, relPath));
      if (st.isSymbolicLink()) throw new Error(`refusing to hash symlink: ${relPath}`);
      if (st.isDirectory()) walk(relPath);
      else lines.push(`${relPath}\0${sha256(readFileSync(join(root, relPath)))}\n`);
    }
  };
  walk('');
  return sha256(lines.join(''));
}
