import type {
  AttemptHandle,
  ControlShell,
  ProvisionOptions,
  ProvisionResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSnapshot,
  RuntimeStopAcknowledgement,
  SandboxHandle,
  SandboxSpec,
  SandboxState,
  TaskBundle,
  ToolchainSpec,
} from '@selarikru/protocol';
import { redactSecrets } from '@selarikru/protocol';
import { SbxControlShell, controlShellArgs } from './control-shell.ts';
import { assertSafeWorkspace, auditMounts } from './guards.ts';
import { inScope, isLegacySandbox, OUR_SANDBOX, sandboxName, taskPrefix } from './names.ts';
import type { SbxCommandRunner, SbxResult } from './sbx.ts';
import { EXACT_VERSION, NODE_TARBALL_SHA256, PATH_EXPORT, PROVISION_DEPS_SCRIPT, PROVISION_NODE_SCRIPT, PROVISION_PNPM_SCRIPT } from './toolchain.ts';

export class SandboxCreateError extends Error {
  constructor(detail: string) {
    super(`sandbox creation failed (no host fallback): ${redactSecrets(detail).slice(0, 500)}`);
    this.name = 'SandboxCreateError';
  }
}

export interface RuntimeTimeouts {
  /** Time allowed for the in-sandbox signal command. */
  readonly signalMs: number;
  /** How long to wait for the run to end after the signal, before escalating to `sbx stop`. */
  readonly graceMs: number;
  /** Time allowed for `sbx stop`. */
  readonly stopMs: number;
  readonly lsMs: number;
  readonly createMs: number;
  readonly rmMs: number;
  /**
   * Downloading, checking and unpacking Node (`curl`'s own limits fit inside this). The ~58.3 MB tarball gets `--max-time 420` per try, so a link holding ~150 KB/s (389 s) still
   * finishes in one; two tries (843 s) and the checksum list (64 s at worst) fit in 960 s.
   */
  readonly provisionNodeMs: number;
  readonly provisionPnpmMs: number;
  readonly provisionDepsMs: number;
}

export const DEFAULT_TIMEOUTS: RuntimeTimeouts = { signalMs: 5_000, graceMs: 10_000, stopMs: 30_000, lsMs: 10_000, createMs: 600_000, rmMs: 60_000, provisionNodeMs: 960_000, provisionPnpmMs: 180_000, provisionDepsMs: 480_000 };

export interface SbxRuntimeOptions {
  readonly home: string;
  /** Never mounted, nor containing / contained by the workspace: the SelariKru repository above all. */
  readonly forbidden: readonly string[];
  readonly attemptsRoot: string | null;
  readonly timeouts?: Partial<RuntimeTimeouts>;
  /**
   * The owner identity this runtime's sandboxes are named under: `tenant:runnerId` for a runner, a trial's own scope for a
   * benchmark trial. Sweeps and reconciliation touch only sandboxes in this scope.
   */
  readonly scope: string;
  /** Told once per legacy (unscoped) sandbox found, which is never swept automatically. */
  readonly log?: (line: string) => void;
}

const PID_FILE = '/tmp/selarikru-attempt.pid';
/** Records the agent's pid, then becomes the agent, so the pid is the agent's (observed need: spike section 5). */
export const PID_WRAPPER = `echo $$ > ${PID_FILE}; exec "$@"`;
/** As `PID_WRAPPER`, plus an in-guest hard limit: `timeout` sends TERM to the agent's process group, then KILL 10 s later. */
export const timedWrapper = (seconds: number): string => `echo $$ > ${PID_FILE}; exec timeout -k 10 ${Math.max(1, Math.floor(seconds))} "$@"`;
/**
 * Signals the agent and its children from inside the sandbox. Killing the host `sbx exec` client does not stop the agent
 * (spike section 5); this does (observed, one sample). Exits 0 whether or not a process was found.
 */
export const STOP_SCRIPT = `f=${PID_FILE}; [ -s "$f" ] || exit 0; p=$(cat "$f"); pkill -TERM -P "$p" 2>/dev/null; kill -INT "$p" 2>/dev/null; exit 0`;

interface SbxListEntry {
  name: string;
  status: string;
  mounts: string[];
  workspaces: string[];
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const MAX_CAUSE_CHARS = 160;
const MAX_DETAIL_CHARS = 1500;

/**
 * What a failed step said, redacted. `cause` is one short line for the published reason: the first line naming an error (`ERR_...` or `error`), looked for in stderr and then in
 * stdout, since `pnpm install` reports a stale lockfile on stdout while stderr may hold only deprecation warnings, and what follows the error line is often advice. With no such
 * line, the last line of stderr, else of stdout. `detail` is the end of both streams, for the runner's log.
 */
function stepOutput(r: SbxResult): { readonly cause: string; readonly detail: string } | null {
  const clean = (s: string) => redactSecrets(s.replace(ANSI, '').replace(CONTROL, '')).trim();
  const err = clean(r.stderr);
  const out = clean(r.stdout);
  const linesOf = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  const named = (lines: readonly string[]) => lines.find((l) => /\bERR_[A-Z0-9_]+|\berror\b/i.test(l));
  const errLines = linesOf(err);
  const outLines = linesOf(out);
  const line = named(errLines) ?? named(outLines) ?? errLines.at(-1) ?? outLines.at(-1);
  if (line === undefined) return null;
  const cause = line.slice(0, MAX_CAUSE_CHARS).replace(/[.:;,\s]+$/, '');
  const tail = [out, err].filter((s) => s !== '').join('\n').slice(-MAX_DETAIL_CHARS);
  return { cause, detail: tail.includes(cause) ? tail : `${cause}\n${tail}` };
}

const stateOf = (status: string): SandboxState => (status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'unknown');

export class SbxRuntimeAdapter implements RuntimeAdapter {
  private readonly t: RuntimeTimeouts;
  /** Attempts whose host client we killed. Their `exited` says nothing about the agent in the sandbox (spike section 5). */
  private readonly clientKilled = new WeakSet<AttemptHandle>();
  /** Sandboxes whose toolchain is installed and verified. Only these launch with it on PATH. */
  private readonly provisioned = new Set<string>();
  private readonly legacySeen = new Set<string>();
  constructor(
    private readonly sbx: SbxCommandRunner,
    private readonly opts: SbxRuntimeOptions,
  ) {
    this.t = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const r = await this.sbx.run(['--version'], { timeoutMs: this.t.lsMs }).catch(() => null);
    const version = r && r.code === 0 ? (/v\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? null) : null;
    return { location: 'local', runtimeVersion: version, hostFallback: false, stopAcknowledgement: 'confirmed', egressAllowlist: 'unsupported' };
  }

  private async list(): Promise<SbxListEntry[]> {
    const r = await this.sbx.run(['ls', '--json'], { timeoutMs: this.t.lsMs });
    if (r.code !== 0 || r.timedOut) throw new Error(`sbx ls failed: ${redactSecrets(r.stderr).slice(0, 200)}`);
    const parsed: unknown = JSON.parse(r.stdout.trim() === '' ? '[]' : r.stdout);
    if (!Array.isArray(parsed)) throw new Error('sbx ls returned an unexpected shape');
    return parsed.flatMap((e): SbxListEntry[] => {
      if (typeof e !== 'object' || e === null) return [];
      const o = e as Record<string, unknown>;
      if (typeof o['name'] !== 'string') return [];
      const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      return [{ name: o['name'], status: typeof o['status'] === 'string' ? o['status'] : 'unknown', mounts: strs(o['mounts']), workspaces: strs(o['workspaces']) }];
    });
  }

  private async removeByName(name: string): Promise<void> {
    const r = await this.sbx.run(['rm', '--force', name], { timeoutMs: this.t.rmMs });
    if (r.code === 0) return;
    // A missing sandbox is success. Anything else must really be gone.
    const still = (await this.list()).some((e) => e.name === name);
    if (still) throw new Error(`could not remove sandbox ${name}: ${redactSecrets(r.stderr).slice(0, 200)}`);
  }

  /** Reconcile before any duplicate side effect: remove every older worker of this task, by stable name prefix. */
  private async reconcileTask(taskId: string): Promise<void> {
    const prefix = taskPrefix(this.opts.scope, taskId);
    for (const e of await this.list()) if (e.name.startsWith(prefix) && inScope(e.name, this.opts.scope)) await this.removeByName(e.name);
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    // sbx has per-sandbox deny rules (which only narrow egress) and a machine-wide allow list; it has no way to limit one sandbox to exactly a granted
    // destination without changing global policy, so a sandbox that needs an allowlist is refused, never created under whatever is already allowed.
    if ((spec.egressAllowlist?.length ?? 0) > 0) throw new SandboxCreateError('this runtime cannot restrict egress to a granted destination');
    const workspace = await assertSafeWorkspace(spec.workspacePath, { home: this.opts.home, forbidden: this.opts.forbidden, attemptsRoot: this.opts.attemptsRoot });
    const name = sandboxName(this.opts.scope, spec.taskId, spec.attemptId);
    await this.reconcileTask(spec.taskId);

    const args = [
      'create', '--no-progress', '--name', name, '--skills', 'off',
      '--cpus', String(spec.cpus), '--memory', `${spec.memoryMiB}m`,
      'claude', workspace,
    ];
    const created = await this.sbx.run(args, { timeoutMs: this.t.createMs });
    const cleanup = async (): Promise<void> => {
      try {
        if ((await this.list()).some((e) => e.name === name)) await this.removeByName(name);
      } catch {
        /* the original failure is the one reported */
      }
    };
    if (created.code !== 0 || created.timedOut) {
      await cleanup();
      throw new SandboxCreateError(created.timedOut ? 'timed out' : created.stderr || `exit ${created.code}`);
    }
    let entry: SbxListEntry | undefined;
    try {
      entry = (await this.list()).find((e) => e.name === name);
    } catch (err) {
      await cleanup();
      throw new SandboxCreateError(err instanceof Error ? err.message : 'could not inspect the new sandbox');
    }
    const violations = entry ? auditMounts(entry.mounts, workspace, { home: this.opts.home }) : ['sandbox not listed after create'];
    if (violations.length > 0) {
      await cleanup();
      throw new SandboxCreateError(`mount audit failed: ${violations.join('; ')}`);
    }
    return { sandboxId: name, attemptId: spec.attemptId, taskId: spec.taskId, workspacePath: workspace };
  }

  async start(handle: SandboxHandle, task: TaskBundle): Promise<AttemptHandle> {
    const base = task.timeoutSeconds !== undefined ? timedWrapper(task.timeoutSeconds) : PID_WRAPPER;
    // `sbx exec` takes no environment, so PATH is set inside the guest. `exec` keeps it for the agent and every shell its tools start.
    const wrapper = this.provisioned.has(handle.sandboxId) ? `${PATH_EXPORT} ${base}` : base;
    const stream = this.sbx.stream(['exec', '-w', task.cwd, handle.sandboxId, 'sh', '-c', wrapper, 'sh', ...task.command]);
    const attempt: AttemptHandle = {
      attemptId: task.attemptId,
      sandboxId: handle.sandboxId,
      startedAt: new Date().toISOString(),
      output: stream.output,
      stdin: stream.stdin,
      exited: stream.exited,
      killClient: () => {
        this.clientKilled.add(attempt);
        stream.kill();
      },
    };
    return attempt;
  }

  private async stateNow(id: string): Promise<SandboxState> {
    try {
      const e = (await this.list()).find((x) => x.name === id);
      return e ? stateOf(e.status) : 'absent';
    } catch {
      return 'unknown';
    }
  }

  async stop(attempt: AttemptHandle): Promise<RuntimeStopAcknowledgement> {
    const id = attempt.sandboxId;
    const ack = (status: 'stopped' | 'stop_failed', confirmed: boolean, escalated: boolean, detail: string | null): RuntimeStopAcknowledgement => ({
      attemptId: attempt.attemptId,
      sandboxId: id,
      status,
      terminationConfirmed: confirmed,
      escalated,
      detail: detail === null ? null : redactSecrets(detail).slice(0, 500),
    });
    const raceExit = async (ms: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)));
      try {
        return await Promise.race([attempt.exited.then(() => true, () => true), timeout]);
      } finally {
        clearTimeout(timer);
      }
    };

    // Already down is normal. Do not exec into it: that would start it again.
    const before = await this.stateNow(id);
    if (before === 'stopped' || before === 'absent') return ack('stopped', true, false, 'sandbox was already not running');

    let detail: string | null = null;
    try {
      const sig = await this.sbx.run(['exec', id, 'sh', '-c', STOP_SCRIPT], { timeoutMs: this.t.signalMs });
      if (sig.timedOut || sig.code !== 0) detail = `signal command ${sig.timedOut ? 'timed out' : `exited ${sig.code}`}`;
    } catch (err) {
      detail = err instanceof Error ? err.message : 'signal failed';
    }
    // The run ending is not evidence the sandbox is quiet: a background process (a daemon that outlived the agent) can keep
    // writing to the bind mount. So the sandbox is ALWAYS stopped and confirmed by sbx before anyone reads the workspace.
    // `escalated` records whether the signal alone had ended the run (and the host client was not killed by us).
    const endedBySignal = !this.clientKilled.has(attempt) && (await raceExit(this.t.graceMs));
    let stopDetail: string | null = null;
    try {
      const r = await this.sbx.run(['stop', id], { timeoutMs: this.t.stopMs });
      if (r.timedOut) stopDetail = 'sbx stop timed out';
      else if (r.code !== 0) stopDetail = `sbx stop exited ${r.code}: ${r.stderr}`;
    } catch (err) {
      stopDetail = err instanceof Error ? err.message : 'sbx stop failed';
    }
    const after = await this.stateNow(id);
    if (after === 'stopped' || after === 'absent') return ack('stopped', true, !endedBySignal, stopDetail ?? detail);
    return ack('stop_failed', false, !endedBySignal, `sandbox still ${after} after sbx stop${stopDetail ? `: ${stopDetail}` : ''}`);
  }

  /** The human's shell. Runs inside this sandbox only, through the same allow-listed `sbx exec`; there is no code path by which it starts on the host. */
  async openControlShell(handle: SandboxHandle, sessionId: string): Promise<ControlShell> {
    const stream = this.sbx.stream(controlShellArgs(handle.sandboxId, handle.workspacePath, sessionId));
    return new SbxControlShell(stream, this.sbx, handle.sandboxId, sessionId, this.t.signalMs);
  }

  async inspect(handle: SandboxHandle): Promise<RuntimeSnapshot> {
    const state = await this.stateNow(handle.sandboxId);
    return { sandboxId: handle.sandboxId, state, exists: state !== 'absent', observedAt: new Date().toISOString() };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.provisioned.delete(handle.sandboxId);
    await this.removeByName(handle.sandboxId);
  }

  /**
   * Installs the pinned toolchain in this sandbox, then the frozen dependencies, through `sbx exec` like everything else here. Never throws. A failed step ends the sequence; the
   * caller's `reason` is this adapter's sentence plus one short redacted line of the step's output, and the fuller output stays in `detail`, redacted and for the runner's log only.
   */
  async provision(handle: SandboxHandle, spec: ToolchainSpec, opts: ProvisionOptions = {}): Promise<ProvisionResult> {
    if (!EXACT_VERSION.test(spec.nodeVersion) || !EXACT_VERSION.test(spec.pnpmVersion)) return { ok: false, reason: 'invalid toolchain version', summary: 'invalid toolchain version', detail: null };
    const { nodeVersion: node, pnpmVersion: pnpm } = spec;
    const startedMs = Date.now();
    const deadlineMs = opts.timeoutMs !== undefined ? startedMs + opts.timeoutMs : Infinity;
    let arch: string | null = null;
    const steps: readonly { readonly label: string; readonly args: readonly string[]; readonly limitMs: number; readonly failed: (code: number | null) => string; readonly done?: (stdout: string) => void }[] = [
      {
        label: 'Node install', args: ['exec', handle.sandboxId, 'sh', '-c', PROVISION_NODE_SCRIPT, 'sh', node, NODE_TARBALL_SHA256[node]?.x64 ?? '', NODE_TARBALL_SHA256[node]?.arm64 ?? ''], limitMs: this.t.provisionNodeMs,
        failed: (code) => ({ 64: 'unsupported sandbox architecture', 65: `could not download Node ${node} from nodejs.org`, 66: `the Node ${node} download failed its SHA-256 check against nodejs.org's SHASUMS256.txt`, 67: `could not unpack Node ${node}` } as Record<number, string>)[code ?? -1] ?? `Node install exited ${code}`,
        done: (stdout) => { arch = /(?:x64|arm64)/.exec(stdout)?.[0] ?? null; },
      },
      {
        label: 'pnpm install', args: ['exec', handle.sandboxId, 'sh', '-c', PROVISION_PNPM_SCRIPT, 'sh', node, pnpm], limitMs: this.t.provisionPnpmMs,
        failed: (code) => ({ 70: `could not install pnpm ${pnpm}`, 71: 'the installed toolchain did not report the pinned versions' } as Record<number, string>)[code ?? -1] ?? `pnpm install exited ${code}`,
      },
      {
        label: 'pnpm install --frozen-lockfile', args: ['exec', '-w', handle.workspacePath, handle.sandboxId, 'sh', '-c', PROVISION_DEPS_SCRIPT], limitMs: this.t.provisionDepsMs,
        failed: (code) => `pnpm install --frozen-lockfile failed (exit ${code})`,
      },
    ];
    for (const step of steps) {
      if (opts.signal?.aborted) return { ok: false, reason: 'provisioning stopped', summary: 'provisioning stopped', detail: null };
      const timeoutMs = Math.max(1, Math.min(step.limitMs, deadlineMs - Date.now()));
      const r = await this.sbx.run(step.args, { timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) }).catch((err: unknown) => ({ code: null, stdout: '', stderr: err instanceof Error ? err.message : 'error', timedOut: false }));
      if (opts.signal?.aborted) return { ok: false, reason: 'provisioning stopped', summary: 'provisioning stopped', detail: null };
      if (r.timedOut || r.code !== 0) {
        const said = stepOutput(r);
        const what = r.timedOut ? `${step.label} timed out` : step.failed(r.code);
        return { ok: false, reason: said ? `${what}: ${said.cause}` : what, summary: what, detail: said?.detail ?? null };
      }
      step.done?.(r.stdout);
    }
    this.provisioned.add(handle.sandboxId);
    return { ok: true, arch: arch ?? 'unknown', nodeVersion: node, pnpmVersion: pnpm, seconds: (Date.now() - startedMs) / 1000 };
  }

  /**
   * Removes every sandbox in this runtime's own scope that no active attempt owns (startup: after a crash or laptop sleep). Other scopes are
   * another runner's or a benchmark trial's and are left alone; a legacy unscoped name is left alone and reported once.
   */
  async sweepOrphans(active: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    for (const e of await this.list()) {
      if (isLegacySandbox(e.name) && !this.legacySeen.has(e.name)) {
        this.legacySeen.add(e.name);
        this.opts.log?.(`left legacy sandbox ${e.name} in place: it has no owner scope, so it is never swept automatically`);
      } else if (OUR_SANDBOX.test(e.name) && !inScope(e.name, this.opts.scope) && !this.legacySeen.has(e.name)) {
        this.legacySeen.add(e.name);
        this.opts.log?.(`left sandbox ${e.name} in place: it belongs to another owner scope (another runner or a benchmark trial on this machine)`);
      }
      if (inScope(e.name, this.opts.scope) && !active.has(e.name)) {
        await this.removeByName(e.name);
        removed.push(e.name);
      }
    }
    return removed;
  }
}
