import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Manifest, StartRecords, Track } from './manifest.ts';
import type { PreflightReport } from './preflight.ts';
import type { RawRecord } from './report.ts';
import { assertLive, type LiveAuthorization } from './trials.ts';

/**
 * The two runner commands. Loaded only when one of them is asked for, so the file-only commands never import the
 * product stack. Exactly one of `--dry-run` and `--live` is required:
 *
 * - `--dry-run` uses fakes for everything that would cost or reach out (the scripted worker in a fake sandbox and a
 *   scripted verifier; a scripted SDK behind the real bench bridge) and records `simulated` data.
 * - `--live` refuses before connecting or dispatching anything unless preflight passes for the track and its start is
 *   recorded under this manifest (which needs the budget authorized, D4, and for workers the API key present, D6).
 *
 * Records are a JSON array, rewritten after every trial; an existing file is the cohort so far and the run continues
 * after it. The worker budget ledger sits next to it (`<records>.budget.json`); the assistant setup ledger and the
 * outputs for blinded review sit next to it too (`.setup.json`, `.outputs.json`). Nothing secret is written or printed.
 */

export interface RunContext {
  readonly flags: ReadonlyMap<string, string>;
  readonly manifest: Manifest;
  readonly repoRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (s: string) => void;
  readonly preflight: () => Promise<PreflightReport>;
  readonly starts: () => StartRecords;
  readonly signal?: AbortSignal;
}

export class RunUsageError extends Error {}

function mode(ctx: RunContext): 'live' | 'dry-run' {
  const live = ctx.flags.has('live');
  const dry = ctx.flags.has('dry-run');
  if (live === dry) throw new RunUsageError('exactly one of --live and --dry-run is required');
  return live ? 'live' : 'dry-run';
}

async function gate(ctx: RunContext, track: Track): Promise<LiveAuthorization> {
  const live = { preflight: await ctx.preflight(), starts: ctx.starts() };
  assertLive(ctx.manifest, track, live);
  return live;
}

function recordsPath(ctx: RunContext): string {
  const p = ctx.flags.get('records');
  if (p === undefined) throw new RunUsageError('--records is required');
  return p;
}

function readRecords(path: string): RawRecord[] {
  if (!existsSync(path)) return [];
  const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(v)) throw new Error('the records file must be a JSON array of trial records');
  return v as RawRecord[];
}

const writeJson = (path: string, v: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`); };

export async function runWorkersCommand(ctx: RunContext): Promise<number> {
  const how = mode(ctx);
  const path = recordsPath(ctx);
  // Refused here, before any stack, sandbox or connection exists.
  const live = how === 'live' ? await gate(ctx, 'workers') : null;
  const { runWorkerCohort } = await import('./workers/runner.ts');
  const { loadDefaultPolicy } = await import('@selarikru/policy/load');
  const prior = readRecords(path);
  const ledgerPath = `${path}.budget.json`;
  const ledger = existsSync(ledgerPath) ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as { spentUsd: number; unmetered: boolean }) : { spentUsd: 0, unmetered: false };
  const databaseUrl = ctx.env['DATABASE_URL'];
  if (!databaseUrl) throw new RunUsageError('DATABASE_URL must name the PostgreSQL server; each trial makes and drops its own bench_* schema there');
  const starterRepo = ctx.flags.get('starter');
  if (starterRepo === undefined) throw new RunUsageError('--starter must name a repository holding the manifest\'s starter commit');
  const workRoot = ctx.flags.get('work') ?? mkdtempSync(join(tmpdir(), 'selarikru-bench-'));
  const all = [...prior];
  let env;
  if (live === null) {
    const dry = await import('./workers/dry-run.ts');
    env = {
      ...dry.dryRunHarness(ctx.manifest.environment.harnessVersion), runtime: dry.fakeRuntimeFactory(dry.DRY_RUN_WORKER, [ctx.repoRoot]),
      verifierRunner: dry.scriptedVerifier(), verifierHost: 'dry-run',
    };
  } else {
    const { detectClaude } = await import('@selarikru/harness-claude');
    const { NodeSbxRunner, SbxRuntimeAdapter } = await import('@selarikru/runtime-docker-local');
    const { dockerRunner, LOCAL_DOCKER_HOST } = await import('../../../services/verifier/src/service.ts');
    const catalog = await detectClaude();
    env = {
      catalog, runnerReport: catalog.providers.map((p) => ({ provider: p.provider, harnessVersion: p.harnessVersion, models: p.models.map((m) => m.id) })),
      runtime: (o: { home: string; attemptsRoot: string; scope: string }) => new SbxRuntimeAdapter(new NodeSbxRunner(), { scope: o.scope, home: homedir(), forbidden: [ctx.repoRoot], attemptsRoot: o.attemptsRoot, log: (l: string) => ctx.out(l) }),
      verifierRunner: dockerRunner(), verifierHost: LOCAL_DOCKER_HOST,
      agentState: (await import('./workers/agent-state.ts')).sbxAgentState(),
    };
  }
  try {
    const result = await runWorkerCohort({
      manifest: ctx.manifest, live, prior, spentUsd: ledger.spentUsd, unmetered: ledger.unmetered, ...(ctx.signal ? { signal: ctx.signal } : {}),
      env: {
        ...env, databaseUrl, starterRepo, workRoot, policy: loadDefaultPolicy(), driverIntervalMs: live ? 2_000 : 50, pollMs: live ? 2_000 : 50, heartbeatMs: live ? 10_000 : 100,
        ...(ctx.flags.has('evidence') ? { evidenceDir: ctx.flags.get('evidence')! } : {}), log: (l: string) => ctx.out(l),
      } as Parameters<typeof runWorkerCohort>[0]['env'],
      onRecord: (r) => { all.push(r); writeJson(path, all); },
    });
    writeJson(ledgerPath, { spentUsd: result.spentUsd, unmetered: result.unmetered });
    ctx.out(`Recorded ${result.records.length} worker trial(s) (${live ? 'measured' : 'simulated'}) to ${path}; spend charged $${result.spentUsd.toFixed(2)} of $${result.budgetUsd}.`);
    return 0;
  } finally {
    if (!ctx.flags.has('work')) rmSync(workRoot, { recursive: true, force: true });
  }
}

export async function runAssistantCommand(ctx: RunContext): Promise<number> {
  const how = mode(ctx);
  const path = recordsPath(ctx);
  const live = how === 'live' ? await gate(ctx, 'assistant') : null;
  const { runAssistantCohort } = await import('./assistant/runner.ts');
  const { loadBriefFixtures } = await import('./assistant/payload.ts');
  const fixtures = loadBriefFixtures(ctx.manifest, ctx.repoRoot);
  let adapter;
  if (live === null) {
    const { benchPageAdapter } = await import('./assistant/route.ts');
    const { createBenchBridge, installBenchBridge } = await import('@selarikru/inference-firebase-web/bench');
    const { scriptedSdk } = await import('./assistant/dry-run.ts');
    const target: Record<string, unknown> = {};
    installBenchBridge(createBenchBridge({ sdk: scriptedSdk() }), target);
    adapter = benchPageAdapter({ url: () => 'about:dry-run', evaluate: async (fn, arg) => structuredClone(await withGlobal(target, () => fn(structuredClone(arg)))) });
  } else {
    const cdp = ctx.flags.get('cdp');
    const benchUrl = ctx.flags.get('bench-url');
    if (cdp === undefined || benchUrl === undefined) throw new RunUsageError('--live needs --cdp (the loopback DevTools endpoint of the owner\'s Chrome) and --bench-url (the open bench page)');
    const { connectBenchPage } = await import('./assistant/route.ts');
    adapter = await connectBenchPage({ endpoint: cdp, benchUrl });
  }
  const prior = readRecords(path);
  const all = [...prior];
  const result = await runAssistantCohort({
    manifest: ctx.manifest, fixtures, adapter, live, prior, ...(ctx.signal ? { signal: ctx.signal } : {}),
    onRecord: (r) => { all.push(r); writeJson(path, all); },
  });
  const append = (p: string, items: readonly unknown[]) => writeJson(p, [...(existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as unknown[]) : []), ...items]);
  append(`${path}.setup.json`, result.setupLedger);
  append(`${path}.outputs.json`, result.outputs);
  ctx.out(`Recorded ${result.records.length} assistant request(s) (${live ? 'measured' : 'simulated'}) to ${path}; setup ledger and outputs beside it.`);
  return 0;
}

/** Runs `fn` with `target`'s properties visible on globalThis, as the page's own globals are to code evaluated in it. */
async function withGlobal<R>(target: Record<string, unknown>, fn: () => R | Promise<R>): Promise<R> {
  const keys = Object.getOwnPropertyNames(target);
  for (const k of keys) Object.defineProperty(globalThis, k, { value: target[k], configurable: true });
  try {
    return await fn();
  } finally {
    for (const k of keys) delete (globalThis as Record<string, unknown>)[k];
  }
}
