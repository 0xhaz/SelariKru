import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactSecrets } from '@selarikru/protocol';
import { verifierHashes } from '@selarikru/verifier/hashing';
import { FrozenError, ManifestError, StartRecordSchema, TRACKS, freezeOrder, readManifest, recordStart, type Manifest, type StartRecord, type StartRecords, type Track } from './manifest.ts';
import { formatPreflight, preflight, type PreflightReport, type VerifierHashPair } from './preflight.ts';
import { PUBLIC_RESULTS_PATH, PublishError, preparePublish, writePublished } from './publish.ts';
import { ExportError, ReportError, buildReport, exportResults, renderReport } from './report.ts';

/**
 * `pnpm --filter ./tools/benchmarks benchmark <command>`. Every command reads and writes files only: none dispatches a
 * run, calls a model, spends or opens a connection.
 *
 *   preflight     [--manifest p] [--verifier p] [--repo p] [--starts dir]         checklist; exit 1 when a track is blocked
 *   freeze        --seed s [--manifest p] [--starts dir]                          record the seed and its order; refused after any start
 *   record-start  --track workers|assistant [--manifest p] [--verifier p] [--repo p] [--starts dir]
 *                 on a passing preflight for the track, write its cohort-start file and stamp the manifest
 *   report        --records p [--manifest p] [--starts dir] [--out p]             export raw records and print the report
 *   publish       --results p [--manifest p] [--out p]                            validate, redact, stamp and write for the web panel
 *
 * `--verifier` is the verifier package (default services/verifier) and `--repo` the directory holding pnpm-lock.yaml;
 * preflight recomputes their hashes with the verifier's own hashing. Start files are `cohort-start-<track>.json` in
 * `--starts`, by default the manifest's directory.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULTS = {
  manifest: join(REPO_ROOT, 'fixtures/benchmarks/manifest.json'),
  verifier: join(REPO_ROOT, 'services/verifier'),
  repo: REPO_ROOT,
  publicOut: join(REPO_ROOT, PUBLIC_RESULTS_PATH),
};
const HASHES_PATH = 'suites/feedback-board/HASHES.json';

export interface Io {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => string;
  /** Relative paths resolve against this. */
  readonly cwd?: string;
}

const USAGE = 'usage: benchmark preflight|freeze|record-start|report|publish [--manifest p] [--verifier p] [--repo p] [--starts dir] [--track t] [--seed s] [--records p] [--results p] [--out p]';
const FLAGS = new Set(['manifest', 'verifier', 'repo', 'starts', 'track', 'seed', 'records', 'results', 'out']);
const PATH_FLAGS = new Set(['manifest', 'verifier', 'repo', 'starts', 'records', 'results', 'out']);

class UsageError extends Error {}
class BlockedError extends Error {}

function parseArgs(argv: readonly string[], at: (p: string) => string): { command: string | undefined; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const arg = rest[i]!;
    const name = arg.replace(/^--/, '');
    const value = rest[i + 1];
    if (!arg.startsWith('--') || !FLAGS.has(name) || value === undefined) throw new UsageError(`unexpected argument ${arg}`);
    flags.set(name, PATH_FLAGS.has(name) ? at(value) : value);
  }
  return { command, flags };
}

function readRecorded(verifierRoot: string): VerifierHashPair | null {
  try {
    const h = JSON.parse(readFileSync(join(verifierRoot, HASHES_PATH), 'utf8')) as Record<string, unknown>;
    return typeof h.verifierSha256 === 'string' && typeof h.lockfileSha256 === 'string' ? { verifierSha256: h.verifierSha256, lockfileSha256: h.lockfileSha256 } : null;
  } catch {
    return null;
  }
}

/** The verifier's own hashing over its files and the lockfile, as its `hashes --check` does. */
function recompute(verifierRoot: string, repoRoot: string): VerifierHashPair | null {
  try {
    const h = verifierHashes(verifierRoot, repoRoot);
    return { verifierSha256: h.verifierSha256, lockfileSha256: h.lockfileSha256 };
  } catch {
    return null;
  }
}

const startPath = (dir: string, track: Track): string => join(dir, `cohort-start-${track}.json`);

function readStarts(dir: string): StartRecords {
  const read = (t: Track): StartRecord | null => {
    const p = startPath(dir, t);
    return existsSync(p) ? StartRecordSchema.parse(JSON.parse(readFileSync(p, 'utf8'))) : null;
  };
  return { workers: read('workers'), assistant: read('assistant') };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

interface Context {
  readonly flags: Map<string, string>;
  readonly io: Io;
  readonly manifestPath: string;
  readonly startsDir: string;
}

function required(flags: Map<string, string>, name: string): string {
  const v = flags.get(name);
  if (v === undefined) throw new UsageError(`--${name} is required`);
  return v;
}

function runPreflight(ctx: Context, manifest: Manifest): PreflightReport {
  const verifierRoot = ctx.flags.get('verifier') ?? DEFAULTS.verifier;
  const repoRoot = ctx.flags.get('repo') ?? DEFAULTS.repo;
  return preflight({
    manifest, env: ctx.io.env, starts: readStarts(ctx.startsDir),
    verifier: { recorded: readRecorded(verifierRoot), recomputed: recompute(verifierRoot, repoRoot) },
  });
}

const COMMANDS: Readonly<Record<string, (ctx: Context) => number>> = {
  preflight(ctx) {
    const report = runPreflight(ctx, readManifest(ctx.manifestPath).manifest);
    ctx.io.out(formatPreflight(report));
    return report.liveDispatch.workers.allowed && report.liveDispatch.assistant.allowed ? 0 : 1;
  },
  freeze(ctx) {
    const seed = required(ctx.flags, 'seed');
    const { manifest } = readManifest(ctx.manifestPath);
    const frozen = freezeOrder(manifest, seed, ctx.io.now(), readStarts(ctx.startsDir));
    writeJson(ctx.manifestPath, frozen);
    ctx.io.out(`Froze seed and ${frozen.randomization.order.length} slots; order sha256 ${frozen.randomization.orderSha256}.`);
    return 0;
  },
  'record-start'(ctx) {
    const track = required(ctx.flags, 'track');
    if (!(TRACKS as readonly string[]).includes(track)) throw new UsageError(`--track must be one of ${TRACKS.join(', ')}`);
    const t = track as Track;
    const path = startPath(ctx.startsDir, t);
    if (existsSync(path)) throw new FrozenError(`${t} already has a start recorded at ${path}`);
    const { manifest } = readManifest(ctx.manifestPath);
    const decision = runPreflight(ctx, manifest).liveDispatch[t];
    if (!decision.allowed) throw new BlockedError(`preflight blocks ${t}, so it cannot start: ${decision.blockers.join(', ')}`);
    const { start, manifest: stamped } = recordStart(manifest, t, ctx.io.now());
    writeJson(path, start);
    writeJson(ctx.manifestPath, stamped);
    ctx.io.out(`Recorded the ${t} start at ${start.startedAtUtc}; the seed, order and manifest are now fixed for it.`);
    return 0;
  },
  report(ctx) {
    const records = readJson(required(ctx.flags, 'records'));
    if (!Array.isArray(records)) throw new ExportError(['the records file must be a JSON array of trial records']);
    const { manifest } = readManifest(ctx.manifestPath);
    const file = exportResults({ manifest, starts: readStarts(ctx.startsDir), records, generatedAtUtc: ctx.io.now() });
    const out = ctx.flags.get('out');
    if (out !== undefined) writeJson(out, file);
    ctx.io.out(renderReport(buildReport(file, manifest)));
    return 0;
  },
  publish(ctx) {
    const out = ctx.flags.get('out') ?? DEFAULTS.publicOut;
    const { manifest } = readManifest(ctx.manifestPath);
    const file = preparePublish(readJson(required(ctx.flags, 'results')), ctx.io.now(), manifest);
    writePublished(file, out);
    ctx.io.out(`Published ${file.records.length} records to ${out}, generated ${file.generatedAtUtc}.`);
    return 0;
  },
};

const KNOWN_ERRORS = [ManifestError, ExportError, ReportError, PublishError, FrozenError, BlockedError, SyntaxError];

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const at = (p: string): string => (isAbsolute(p) ? p : resolve(io.cwd ?? process.cwd(), p));
  try {
    const { command, flags } = parseArgs(argv, at);
    const run = command === undefined ? undefined : COMMANDS[command];
    if (run === undefined) throw new UsageError(command === undefined ? 'a command is required' : `unknown command ${command}`);
    const manifestPath = flags.get('manifest') ?? DEFAULTS.manifest;
    return run({ flags, io, manifestPath, startsDir: flags.get('starts') ?? dirname(manifestPath) });
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n${USAGE}`);
      return 2;
    }
    const known = KNOWN_ERRORS.some((k) => e instanceof k);
    io.err(redactSecrets(known ? (e as Error).message : `unexpected error: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const io: Io = {
    out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), env: process.env,
    now: () => new Date().toISOString(), cwd: process.env.INIT_CWD ?? process.cwd(),
  };
  main(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
