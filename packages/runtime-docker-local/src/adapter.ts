import type {
  AttemptHandle,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSnapshot,
  RuntimeStopAcknowledgement,
  SandboxHandle,
  SandboxSpec,
  SandboxState,
  TaskBundle,
} from '@selarikru/protocol';
import { redactSecrets } from '@selarikru/protocol';
import { assertSafeWorkspace, auditMounts } from './guards.ts';
import { isOurSandbox, sandboxName, taskPrefix } from './names.ts';
import type { SbxCommandRunner } from './sbx.ts';

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
}

export const DEFAULT_TIMEOUTS: RuntimeTimeouts = { signalMs: 5_000, graceMs: 10_000, stopMs: 30_000, lsMs: 10_000, createMs: 600_000, rmMs: 60_000 };

export interface SbxRuntimeOptions {
  readonly home: string;
  /** Never mounted, nor containing / contained by the workspace: the SelariKru repository above all. */
  readonly forbidden: readonly string[];
  readonly attemptsRoot: string | null;
  readonly timeouts?: Partial<RuntimeTimeouts>;
}

const PID_FILE = '/tmp/selarikru-attempt.pid';
/** Records the agent's pid, then becomes the agent, so the pid is the agent's (observed need: spike section 5). */
export const PID_WRAPPER = `echo $$ > ${PID_FILE}; exec "$@"`;
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

const stateOf = (status: string): SandboxState => (status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'unknown');

export class SbxRuntimeAdapter implements RuntimeAdapter {
  private readonly t: RuntimeTimeouts;
  /** Attempts whose host client we killed. Their `exited` says nothing about the agent in the sandbox (spike section 5). */
  private readonly clientKilled = new WeakSet<AttemptHandle>();
  constructor(
    private readonly sbx: SbxCommandRunner,
    private readonly opts: SbxRuntimeOptions,
  ) {
    this.t = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const r = await this.sbx.run(['--version'], { timeoutMs: this.t.lsMs }).catch(() => null);
    const version = r && r.code === 0 ? (/v\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? null) : null;
    return { location: 'local', runtimeVersion: version, hostFallback: false, stopAcknowledgement: 'confirmed' };
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
    const prefix = taskPrefix(taskId);
    for (const e of await this.list()) if (e.name.startsWith(prefix) && isOurSandbox(e.name)) await this.removeByName(e.name);
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const workspace = await assertSafeWorkspace(spec.workspacePath, { home: this.opts.home, forbidden: this.opts.forbidden, attemptsRoot: this.opts.attemptsRoot });
    const name = sandboxName(spec.taskId, spec.attemptId);
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
    const stream = this.sbx.stream(['exec', '-w', task.cwd, handle.sandboxId, 'sh', '-c', PID_WRAPPER, 'sh', ...task.command]);
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
    // The run ending is evidence only if we did not end the host client ourselves.
    if (!this.clientKilled.has(attempt) && (await raceExit(this.t.graceMs))) return ack('stopped', true, false, detail);

    // The agent ignored the signal or the signal never ran: stop the whole sandbox, then confirm from sbx itself.
    let stopDetail: string | null = null;
    try {
      const r = await this.sbx.run(['stop', id], { timeoutMs: this.t.stopMs });
      if (r.timedOut) stopDetail = 'sbx stop timed out';
      else if (r.code !== 0) stopDetail = `sbx stop exited ${r.code}: ${r.stderr}`;
    } catch (err) {
      stopDetail = err instanceof Error ? err.message : 'sbx stop failed';
    }
    const after = await this.stateNow(id);
    if (after === 'stopped' || after === 'absent') return ack('stopped', true, true, stopDetail ?? detail);
    return ack('stop_failed', false, true, `sandbox still ${after} after sbx stop${stopDetail ? `: ${stopDetail}` : ''}`);
  }

  async inspect(handle: SandboxHandle): Promise<RuntimeSnapshot> {
    const state = await this.stateNow(handle.sandboxId);
    return { sandboxId: handle.sandboxId, state, exists: state !== 'absent', observedAt: new Date().toISOString() };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await this.removeByName(handle.sandboxId);
  }

  /** Removes every selarikru-managed sandbox that no active attempt owns (startup: after a crash or laptop sleep). */
  async sweepOrphans(active: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    for (const e of await this.list()) {
      if (isOurSandbox(e.name) && !active.has(e.name)) {
        await this.removeByName(e.name);
        removed.push(e.name);
      }
    }
    return removed;
  }
}
