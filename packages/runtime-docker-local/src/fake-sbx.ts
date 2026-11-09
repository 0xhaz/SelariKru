import type { AttemptExit } from '@selarikru/protocol';
import { assertSafeSbxArgs, execNameIndex, type SbxCommandRunner, type SbxResult, type SbxStream } from './sbx.ts';

export interface FakeSandbox {
  status: 'running' | 'stopped';
  mounts: string[];
  workspaces: string[];
  agent: string;
}

export interface FakeOptions {
  failCreate?: boolean;
  /** Registers the sandbox even though create "failed" (partial success). */
  createLeavesOrphan?: boolean;
  extraMounts?: string[];
  failExec?: boolean;
  /** The in-sandbox signal is accepted but the agent keeps running. */
  ignoreSignal?: boolean;
  /** `sbx stop` never returns before its timeout. */
  hangStop?: boolean;
  /** `sbx stop` returns success but the sandbox stays running. */
  stopDoesNotStop?: boolean;
  signalExitCode?: number;
  /** Called when an agent exec starts, so a test can script what the "agent" does. */
  onStream?: (stream: FakeStream, args: readonly string[]) => void;
}

export class FakeStream implements SbxStream {
  readonly written: string[] = [];
  stdinEnded = false;
  killed = false;
  private queue: string[] = [];
  private waiter: ((v: IteratorResult<string>) => void) | null = null;
  private done = false;
  private resolveExit!: (e: AttemptExit) => void;
  readonly exited = new Promise<AttemptExit>((r) => (this.resolveExit = r));
  readonly stdin = { write: (d: string) => void this.written.push(d), end: () => void (this.stdinEnded = true) };
  readonly output: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const q = this.queue.shift();
        if (q !== undefined) return Promise.resolve({ value: q, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    }),
  };
  constructor(readonly args: readonly string[]) {}
  push(chunk: string): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: chunk, done: false });
    } else this.queue.push(chunk);
  }
  end(code: number | null = 0, signal: string | null = null): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
    this.resolveExit({ code, signal });
  }
  get isEnded(): boolean {
    return this.done;
  }
  kill(): void {
    this.killed = true;
    this.end(null, 'SIGTERM');
  }
}

/** Stateful stand-in for the `sbx` binary. Applies the same allow-list as the real runner. */
export class FakeSbx implements SbxCommandRunner {
  readonly calls: string[][] = [];
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly streams: FakeStream[] = [];
  constructor(readonly options: FakeOptions = {}) {}

  addForeign(name: string): void {
    this.sandboxes.set(name, { status: 'running', mounts: [`/Users/x/${name}:/Users/x/${name}`], workspaces: [`/Users/x/${name}`], agent: 'claude' });
  }

  private endStreamsOf(name: string, code: number): void {
    for (const s of this.streams) if (s.args.includes(name) && !s.isEnded) s.end(code);
  }

  async run(args: readonly string[], opts: { timeoutMs?: number } = {}): Promise<SbxResult> {
    assertSafeSbxArgs(args);
    this.calls.push([...args]);
    const ok = (stdout = ''): SbxResult => ({ code: 0, stdout, stderr: '', timedOut: false });
    const fail = (stderr: string, code = 1): SbxResult => ({ code, stdout: '', stderr, timedOut: false });
    switch (args[0]) {
      case '--version':
        return ok('sbx version v0.51.0 7d55286de0c775148b985ed349f760f1eba06203\n');
      case 'ls':
        return ok(
          JSON.stringify(
            [...this.sandboxes.entries()].map(([name, s]) => ({ name, agent: s.agent, status: s.status, mounts: s.mounts, workspaces: s.workspaces })),
          ),
        );
      case 'create': {
        const name = args[args.indexOf('--name') + 1]!;
        const ws = args[args.length - 1]!;
        if (this.options.failCreate) {
          if (this.options.createLeavesOrphan) this.sandboxes.set(name, { status: 'stopped', mounts: [`${ws}:${ws}`], workspaces: [ws], agent: 'claude' });
          return fail('error: could not create sandbox');
        }
        this.sandboxes.set(name, { status: 'stopped', mounts: [`${ws}:${ws}`, ...(this.options.extraMounts ?? [])], workspaces: [ws], agent: 'claude' });
        return ok(`Created sandbox ${name}\n`);
      }
      case 'exec': {
        const name = args[execNameIndex(args)]!;
        const sb = this.sandboxes.get(name);
        if (!sb) return fail('error: sandbox not found', 125);
        sb.status = 'running';
        if (!this.options.ignoreSignal) this.endStreamsOf(name, this.options.signalExitCode ?? 130);
        return ok();
      }
      case 'stop': {
        const sb = this.sandboxes.get(args[1]!);
        if (this.options.hangStop) {
          await new Promise((r) => setTimeout(r, opts.timeoutMs ?? 50));
          return { code: null, stdout: '', stderr: '', timedOut: true };
        }
        if (!sb) return fail('error: sandbox not found');
        if (!this.options.stopDoesNotStop) {
          sb.status = 'stopped';
          this.endStreamsOf(args[1]!, 143);
        }
        return ok(`Stopped sandbox ${args[1]}\n`);
      }
      case 'rm': {
        const name = args[2]!;
        if (!this.sandboxes.delete(name)) return fail('error: sandbox not found');
        this.endStreamsOf(name, 143);
        return ok(`Removed sandbox ${name}\n`);
      }
      default:
        return fail('unsupported in fake', 2);
    }
  }

  stream(args: readonly string[]): SbxStream {
    assertSafeSbxArgs(args);
    this.calls.push([...args]);
    const s = new FakeStream(args);
    this.streams.push(s);
    const name = args[execNameIndex(args)]!;
    const sb = this.sandboxes.get(name);
    if (this.options.failExec || !sb) {
      queueMicrotask(() => s.end(125));
    } else {
      sb.status = 'running';
      this.options.onStream?.(s, args);
    }
    return s;
  }
}
