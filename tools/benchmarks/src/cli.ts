import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactSecrets } from '@selarikru/protocol';
import { FrozenError, ManifestError, StartRecordSchema, freezeOrder, readManifest, recordStart, type StartRecord } from './manifest.ts';
import { formatPreflight, preflight } from './preflight.ts';
import { PUBLIC_RESULTS_PATH, PublishError, preparePublish, writePublished } from './publish.ts';
import { ExportError, buildReport, exportResults, renderReport } from './report.ts';

/**
 * `pnpm --filter ./tools/benchmarks benchmark <command>`. Every command reads and writes files only: none dispatches a
 * run, calls a model, spends or opens a connection.
 *
 *   preflight     [--manifest p] [--hashes p] [--lockfile p] [--start p]   checklist; exit 1 when a track is blocked
 *   freeze        --seed s [--manifest p] [--start p]                       record the seed and its order; refused after start
 *   record-start  [--manifest p] [--start p]                                record the frozen seed and order a cohort is bound to
 *   report        --records p [--manifest p] [--out p]                      export raw records and print the report
 *   publish       --results p [--out p]                                     validate, redact, stamp and write for the web panel
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULTS = {
  manifest: join(REPO_ROOT, 'fixtures/benchmarks/manifest.json'),
  hashes: join(REPO_ROOT, 'services/verifier/suites/feedback-board/HASHES.json'),
  lockfile: join(REPO_ROOT, 'pnpm-lock.yaml'),
  publicOut: join(REPO_ROOT, PUBLIC_RESULTS_PATH),
};

export interface Io {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => string;
  /** Relative paths resolve against this. */
  readonly cwd?: string;
}

const USAGE = 'usage: benchmark preflight|freeze|record-start|report|publish [--manifest p] [--hashes p] [--lockfile p] [--start p] [--seed s] [--records p] [--results p] [--out p]';
const FLAGS = new Set(['manifest', 'hashes', 'lockfile', 'start', 'seed', 'records', 'results', 'out']);

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): { command: string | undefined; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]!.replace(/^--/, '');
    const value = rest[i + 1];
    if (!rest[i]!.startsWith('--') || !FLAGS.has(name) || value === undefined) throw new UsageError(`unexpected argument ${rest[i]}`);
    flags.set(name, value);
  }
  return { command, flags };
}

const sha256File = (path: string): string | null => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } };

function readHashes(path: string): { verifierSha256: string; lockfileSha256: string } | null {
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return typeof h.verifierSha256 === 'string' && typeof h.lockfileSha256 === 'string' ? { verifierSha256: h.verifierSha256, lockfileSha256: h.lockfileSha256 } : null;
  } catch {
    return null;
  }
}

function readStart(path: string): StartRecord | null {
  if (!existsSync(path)) return null;
  return StartRecordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const at = (p: string): string => (isAbsolute(p) ? p : resolve(io.cwd ?? process.cwd(), p));
  try {
    const { command, flags } = parseArgs(argv);
    const flag = (name: string, fallback?: string): string => {
      const v = flags.get(name) ?? fallback;
      if (v === undefined) throw new UsageError(`--${name} is required`);
      return flags.has(name) ? at(v) : v;
    };
    const manifestPath = flag('manifest', DEFAULTS.manifest);
    const startPath = flag('start', join(dirname(manifestPath), 'cohort-start.json'));

    switch (command) {
      case 'preflight': {
        const { manifest } = readManifest(manifestPath);
        const report = preflight({ manifest, env: io.env, verifierHashes: readHashes(flag('hashes', DEFAULTS.hashes)), lockfileSha256Now: sha256File(flag('lockfile', DEFAULTS.lockfile)), start: readStart(startPath) });
        io.out(formatPreflight(report));
        return report.liveDispatch.workers.allowed && report.liveDispatch.assistant.allowed ? 0 : 1;
      }
      case 'freeze': {
        const seed = flags.get('seed');
        if (seed === undefined) throw new UsageError('--seed is required');
        const { manifest } = readManifest(manifestPath);
        const frozen = freezeOrder(manifest, seed, io.now(), readStart(startPath));
        writeFileSync(manifestPath, `${JSON.stringify(frozen, null, 2)}\n`);
        io.out(`Froze seed and ${frozen.randomization.order.length} trials; order sha256 ${frozen.randomization.orderSha256}.`);
        return 0;
      }
      case 'record-start': {
        if (existsSync(startPath)) throw new FrozenError(`a start is already recorded at ${startPath}`);
        const { manifest, sha256 } = readManifest(manifestPath);
        const start = recordStart(manifest, sha256, io.now());
        writeFileSync(startPath, `${JSON.stringify(start, null, 2)}\n`);
        io.out(`Recorded start at ${start.startedAtUtc}; the seed and order are now fixed for this cohort.`);
        return 0;
      }
      case 'report': {
        const records = readJson(flag('records'));
        if (!Array.isArray(records)) throw new ExportError(['the records file must be a JSON array of trial records']);
        const { manifest, sha256 } = readManifest(manifestPath);
        const file = exportResults({ manifest, manifestSha256: sha256, records, generatedAtUtc: io.now() });
        if (flags.has('out')) writeFileSync(flag('out'), `${JSON.stringify(file, null, 2)}\n`);
        io.out(renderReport(buildReport(file, manifest)));
        return 0;
      }
      case 'publish': {
        const out = flag('out', DEFAULTS.publicOut);
        const file = preparePublish(readJson(flag('results')), io.now());
        writePublished(file, out);
        io.out(`Published ${file.records.length} records to ${out}, generated ${file.generatedAtUtc}.`);
        return 0;
      }
      default:
        throw new UsageError(command === undefined ? 'a command is required' : `unknown command ${command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) { io.err(`${e.message}\n${USAGE}`); return 2; }
    const known = e instanceof ManifestError || e instanceof ExportError || e instanceof PublishError || e instanceof FrozenError || e instanceof SyntaxError;
    io.err(redactSecrets(known ? e.message : `unexpected error: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const io: Io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), env: process.env, now: () => new Date().toISOString(), cwd: process.env.INIT_CWD ?? process.cwd() };
  main(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
