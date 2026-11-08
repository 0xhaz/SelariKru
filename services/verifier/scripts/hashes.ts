// Regenerates suites/feedback-board/HASHES.json:  pnpm --filter @selarikru/verifier hashes
// Verify without writing:                          pnpm --filter @selarikru/verifier hashes:check
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashTree, sha256 } from '../src/hashing.ts';

const here = dirname(fileURLToPath(import.meta.url));
const suiteDir = resolve(here, '../suites/feedback-board');
const contractDir = resolve(here, '../../../examples/feedback-board-starter/contract');
const outPath = join(suiteDir, 'HASHES.json');

export function computeHashes() {
  return {
    description:
      'manifestSha256 = sha256(manifest.json). suiteSha256 = stable tree hash of this directory excluding HASHES.json (this is the verifierSha). contractSha256 = stable tree hash of examples/feedback-board-starter/contract.',
    manifestSha256: sha256(readFileSync(join(suiteDir, 'manifest.json'))),
    suiteSha256: hashTree(suiteDir, { exclude: (p) => p === 'HASHES.json' }),
    contractSha256: hashTree(contractDir),
  };
}

const next = computeHashes();
if (process.argv.includes('--check')) {
  const current = JSON.parse(readFileSync(outPath, 'utf8'));
  const same = ['manifestSha256', 'suiteSha256', 'contractSha256'].every((k) => current[k] === (next as any)[k]);
  console.log(same ? 'HASHES.json is up to date' : 'HASHES.json is STALE; run: pnpm --filter @selarikru/verifier hashes');
  process.exit(same ? 0 : 1);
}
writeFileSync(outPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(JSON.stringify(next, null, 2));
