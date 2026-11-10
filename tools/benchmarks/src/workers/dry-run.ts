import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeProvider } from '@selarikru/harness-claude';
import { initEvent } from '@selarikru/harness-claude/fixtures';
import type { HarnessCatalog, RunnerHarnessReport } from '@selarikru/protocol';
import { SbxRuntimeAdapter } from '@selarikru/runtime-docker-local';
import { FakeSbx, type FakeStream } from '@selarikru/runtime-docker-local/fake-sbx';
import { verifierHashes } from '../../../../services/verifier/src/hashing.ts';
import { candidateContentHash, type RunnerInput, type RunnerOutput, type VerifierRunner } from '../../../../services/verifier/src/service.ts';

/**
 * The dry run's stand-ins, and nothing else: a scripted worker inside the runtime's fake `sbx`, and a scripted verifier
 * runner. Everything between them is the real product (control API, scheduler, runner, assembly and verification
 * drivers). No model is called and no sandbox or container is created. Records from a dry run are `simulated`.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const VERIFIER_ROOT = resolve(here, '../../../../services/verifier');
export const IN_REPO_STARTER = resolve(here, '../../../../examples/feedback-board-starter');

/** What the scripted worker sees and does, for tests to inspect. */
export interface WorkerScriptContext {
  readonly role: 'backend' | 'frontend' | null;
  readonly cwd: string;
  /** The worker's agent home (fresh per trial). */
  readonly home: string;
  readonly stream: FakeStream;
  write(rel: string, body: string): void;
}

/** Returns false to keep the worker running (it then stops only when the runner stops it). */
export type WorkerScript = (ctx: WorkerScriptContext) => boolean | void | Promise<boolean | void>;

const RESULT_LINE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 10, total_cost_usd: 0.05, terminal_reason: 'completed', usage: { input_tokens: 1200, output_tokens: 300 } });

/** The default dry-run worker: writes one small file inside its role's paths and leaves a note in its agent home, as a real session would leave memory. */
export const DRY_RUN_WORKER: WorkerScript = ({ role, write, home }) => {
  const rel = role === 'frontend' ? 'src/dry-run-note.ts' : 'server/dry-run-note.ts';
  write(rel, `// dry run: written by the scripted ${role ?? 'unknown'} worker, not an implementation\nexport const dryRun = true;\n`);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', `memory-${role ?? 'worker'}.md`), 'scripted session memory\n');
};

export interface FakeRuntimeFactory {
  (o: { readonly home: string; readonly attemptsRoot: string; readonly trialId: string; readonly scope: string }): SbxRuntimeAdapter;
  /** Every fake `sbx` made so far, one per trial, in order. */
  readonly made: { readonly trialId: string; readonly sbx: FakeSbx }[];
}

/**
 * `shared`: one fake `sbx` for every trial, standing for one machine, so a test can put the owner's own sandboxes beside the trials'. Default:
 * a new fake per trial.
 */
export function fakeRuntimeFactory(script: WorkerScript = DRY_RUN_WORKER, forbidden: readonly string[] = [], shared?: (options: ConstructorParameters<typeof FakeSbx>[0]) => FakeSbx): FakeRuntimeFactory {
  const made: { trialId: string; sbx: FakeSbx }[] = [];
  let home = '';
  let machine: FakeSbx | null = null;
  const factory = ((o) => {
    home = o.home;
    const options: ConstructorParameters<typeof FakeSbx>[0] = {
      onStream: (stream, args) => {
        if (args[1] === '-i') return;
        const cwd = args[2]!;
        const task = existsSync(join(cwd, 'TASK.md')) ? readFileSync(join(cwd, 'TASK.md'), 'utf8') : '';
        const role = /You are the (backend|frontend) worker/.exec(task)?.[1] as 'backend' | 'frontend' | undefined;
        const write = (rel: string, body: string): void => { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), body); };
        void (async () => {
          stream.push(`${initEvent}\n`);
          const keepOpen = (await script({ role: role ?? null, cwd, home, stream, write })) === false;
          if (keepOpen || stream.isEnded) return;
          stream.push(`${RESULT_LINE}\n`);
          stream.end(0);
        })();
      },
    };
    const sbx = shared ? (machine ??= shared(options)) : new FakeSbx(options);
    made.push({ trialId: o.trialId, sbx });
    return new SbxRuntimeAdapter(sbx, {
      scope: o.scope, home: o.home, forbidden: [...forbidden], attemptsRoot: o.attemptsRoot,
      timeouts: { signalMs: 100, graceMs: 150, stopMs: 150, lsMs: 100, createMs: 1000, rmMs: 100 },
    });
  }) as FakeRuntimeFactory;
  Object.defineProperty(factory, 'made', { value: made });
  return factory;
}

/** True when the fake `sbx` still holds a sandbox (ignoring none: the dry run adds no foreign ones). */
export const sandboxesLeft = (sbx: FakeSbx): number => sbx.sandboxes.size;

/** A scripted verifier result naming the real trusted hashes, so the real verification service accepts it. `fail` names criteria to fail. */
export function scriptedVerifier(fail: readonly string[] = []): VerifierRunner {
  const manifest = JSON.parse(readFileSync(join(VERIFIER_ROOT, 'suites/feedback-board/manifest.json'), 'utf8')) as {
    suiteId: string; version: string; tools: { playwrightImage: string }; criteria: { id: string; tests: { runner: string; title: string }[] }[];
  };
  return async (input: RunnerInput): Promise<RunnerOutput> => {
    const hashes = verifierHashes(VERIFIER_ROOT, resolve(VERIFIER_ROOT, '../..'));
    const criteria = manifest.criteria.map((c) => {
      const failed = fail.includes(c.id);
      return {
        id: c.id, status: failed ? 'failed' : 'passed', evidenceReferences: [],
        failures: failed ? [{ test: c.tests[0]?.title ?? c.id, status: 'failed', message: 'scripted failure (dry run)' }] : [],
        tests: c.tests.map((t) => ({ runner: t.runner, title: t.title, status: failed ? 'failed' : 'passed' })),
      };
    });
    return {
      exitCode: fail.length === 0 ? 0 : 1, log: 'scripted verifier (dry run)',
      result: {
        protocolVersion: '0.1', verifier: { suiteId: manifest.suiteId, suiteVersion: manifest.version, ...hashes, image: manifest.tools.playwrightImage, tools: { node: 'v24.0.0', vitest: '5.1.0', playwright: '1.65.0' } },
        candidate: { treeSha256: candidateContentHash(input.candidateDir) }, startedAtUtc: new Date().toISOString(), endedAtUtc: new Date().toISOString(), setup: {},
        quality: { allRequiredChecksPassed: fail.length === 0, criteria },
      },
    };
  };
}

/** The harness the dry run declares: the Claude adapter's own catalog entry, at the manifest's harness version. */
export function dryRunHarness(harnessVersion: string | null): { catalog: HarnessCatalog; runnerReport: RunnerHarnessReport[] } {
  const provider = claudeProvider(harnessVersion ?? '0.0.0-dry-run');
  return {
    catalog: { status: 'detected', detail: null, providers: [provider] },
    runnerReport: [{ provider: provider.provider, harnessVersion: provider.harnessVersion, models: provider.models.map((m) => m.id) }] as RunnerHarnessReport[],
  };
}

export const listFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []);
