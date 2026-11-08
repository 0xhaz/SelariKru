import { spawn } from 'node:child_process';
import { isOurSandbox } from './names.ts';
import type { AttemptExit } from '@selarikru/protocol';

export interface SbxResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface SbxStream {
  readonly output: AsyncIterable<string>;
  readonly stdin: { write(data: string): void; end(): void };
  readonly exited: Promise<AttemptExit>;
  kill(): void;
}

/** The only door to the `sbx` binary. Unit tests inject a fake; production uses `NodeSbxRunner`. */
export interface SbxCommandRunner {
  run(args: readonly string[], opts?: { timeoutMs?: number }): Promise<SbxResult>;
  stream(args: readonly string[]): SbxStream;
}

export class UnsafeSbxCommandError extends Error {
  constructor(detail: string) {
    super(`refused sbx command: ${detail}`);
    this.name = 'UnsafeSbxCommandError';
  }
}

/**
 * Allow-list of what this runtime may ask `sbx` to do. Other machine users' sandboxes, global policy, settings, the daemon,
 * reset/prune and every cloud verb are unreachable, whatever the caller passes.
 */
export function assertSafeSbxArgs(args: readonly string[]): void {
  const [verb] = args;
  const bad = (d: string): never => {
    throw new UnsafeSbxCommandError(d);
  };
  if (args.some((a) => a === '--cloud' || a === 'attach' || a === 'move')) bad('cloud verbs are not allowed');
  const ours = (name: string | undefined): void => {
    if (name === undefined || !isOurSandbox(name)) bad(`sandbox ${JSON.stringify(name)} is not a selarikru-managed sandbox`);
  };
  switch (verb) {
    case '--version':
      return;
    case 'ls':
      return;
    case 'create': {
      const i = args.indexOf('--name');
      ours(i >= 0 ? args[i + 1] : undefined);
      return;
    }
    case 'exec': {
      // exec [-w DIR] NAME command...
      const nameAt = args[1] === '-w' ? 3 : 1;
      ours(args[nameAt]);
      return;
    }
    case 'stop':
      if (args.length !== 2) bad('stop takes exactly one explicit sandbox name');
      ours(args[1]);
      return;
    case 'rm':
      if (args.length !== 3 || args[1] !== '--force') bad('rm takes --force and exactly one explicit sandbox name');
      ours(args[2]);
      return;
    default:
      bad(`verb ${JSON.stringify(verb)} is not allowed`);
  }
}

export class NodeSbxRunner implements SbxCommandRunner {
  constructor(private readonly bin = 'sbx') {}

  run(args: readonly string[], opts: { timeoutMs?: number } = {}): Promise<SbxResult> {
    assertSafeSbxArgs(args);
    return new Promise((resolve) => {
      const child = spawn(this.bin, ['--no-input', ...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      const timer =
        opts.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              child.kill('SIGKILL');
            }, opts.timeoutMs);
      const finish = (code: number | null, extraErr = ''): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + extraErr, timedOut });
      };
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.stderr.on('data', (b: Buffer) => err.push(b));
      child.on('error', (e) => finish(null, e.message));
      child.on('close', (code) => finish(code));
    });
  }

  stream(args: readonly string[]): SbxStream {
    assertSafeSbxArgs(args);
    const child = spawn(this.bin, ['--no-input', ...args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    // stderr is drained and dropped from the agent stream; sbx prints transport errors there.
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => undefined);
    const exited = new Promise<AttemptExit>((resolve) => {
      child.on('error', () => resolve({ code: null, signal: null }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    const decoder = new TextDecoder('utf-8');
    const output = (async function* (): AsyncGenerator<string> {
      for await (const b of child.stdout as AsyncIterable<Uint8Array>) {
        const s = decoder.decode(b, { stream: true });
        if (s) yield s;
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    })();
    return {
      output,
      stdin: {
        write: (d) => void child.stdin.write(d),
        end: () => void child.stdin.end(),
      },
      exited,
      kill: () => void child.kill('SIGTERM'),
    };
  }
}
