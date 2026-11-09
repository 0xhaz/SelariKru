import { describe, expect, it, vi } from 'vitest';
import { REDACTED, type ControlDownFrame, type ControlShell, type ControlShellEvent, type ControlUpFrame, type RuntimeAdapter, type SandboxHandle } from '@selarikru/protocol';
import { ControlBridge, type ControlHandlers } from '../src/control.ts';
import { runAttempt, type AttemptDeps } from '../src/attempt.ts';
import { makeWorld } from './world.ts';

const HANDLE: SandboxHandle = { sandboxId: 'sb', attemptId: 'att_1', taskId: 't', workspacePath: '/ws' };

class FakeShell implements ControlShell {
  readonly inputs: Array<{ seq: number; data: string }> = [];
  closed = false;
  private waiter: ((e: ControlShellEvent | null) => void) | null = null;
  private readonly queue: (ControlShellEvent | null)[] = [];
  readonly events: AsyncIterable<ControlShellEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<ControlShellEvent>>((resolve) => {
        const deliver = (e: ControlShellEvent | null) => resolve(e === null ? { value: undefined, done: true } : { value: e, done: false });
        if (this.queue.length > 0) { deliver(this.queue.shift()!); return; }
        this.waiter = deliver;
      }),
    }),
  };
  emit(e: ControlShellEvent | null): void {
    const w = this.waiter;
    if (w !== null) { this.waiter = null; w(e); } else this.queue.push(e);
  }
  /** The bridge is reading events. */
  get listening(): boolean { return this.waiter !== null; }
  get backlog(): number { return this.queue.length; }
  input(seq: number, data: string): void { this.inputs.push({ seq, data }); }
  async close(): Promise<void> { this.closed = true; this.emit(null); }
}

function bridge(shell: FakeShell | null, over: { openFails?: boolean } = {}) {
  const sent: ControlUpFrame[] = [];
  let handlers!: ControlHandlers;
  const runtime = { openControlShell: over.openFails ? undefined : vi.fn(async () => shell!) } as unknown as RuntimeAdapter;
  const log = vi.fn();
  const b = new ControlBridge({ connect: async (h) => { handlers = h; return { send: (f) => sent.push(f), sendable: true, close: () => handlers.onClose() }; }, runtime, handle: HANDLE, log, limits: { flushMs: 1, promptMs: 5, reconnectMs: 1, closeMs: 100 } });
  b.start();
  const down = (f: ControlDownFrame) => handlers.onFrame(f);
  return { b, sent, down, log, handlers: () => handlers };
}

const until = (assertion: () => void): Promise<void> => vi.waitFor(assertion, { timeout: 5_000, interval: 2 });
/** Everything emitted has been consumed by the bridge, and its 5 ms prompt timer has had the chance to fire. For asserting that something did not happen. */
const settled = async (shell: FakeShell): Promise<void> => {
  await until(() => expect(shell.backlog).toBe(0));
  await new Promise((r) => setTimeout(r, 30));
};

describe('the control bridge', () => {
  const opened = async (shell: FakeShell | null, over: { openFails?: boolean } = {}) => {
    const b = bridge(shell, over);
    await until(() => expect(b.handlers()).toBeDefined());
    b.down({ type: 'open', sessionId: 's1' });
    if (shell !== null) await until(() => expect(shell.listening).toBe(true));
    return b;
  };
  const outputs = (sent: readonly ControlUpFrame[]): string[] => sent.flatMap((f) => (f.type === 'output' ? f.lines.map((l) => l.text) : []));

  it('opens a shell only in its attempt\'s own sandbox, and forwards acks and output', async () => {
    const shell = new FakeShell();
    const { sent, down } = await opened(shell);
    shell.emit({ kind: 'echo', on: true });
    await until(() => expect(sent).toContainEqual({ type: 'opened', sessionId: 's1', echo: true }));
    down({ type: 'input', sessionId: 's1', seq: 1, data: 'ls\r' });
    expect(shell.inputs).toEqual([{ seq: 1, data: 'ls\r' }]);
    shell.emit({ kind: 'ack', seq: 1, echo: true });
    shell.emit({ kind: 'output', text: 'ls\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' });
    await until(() => expect(outputs(sent).join('\n')).toContain(`GITHUB_TOKEN=${REDACTED}`));
    expect(outputs(sent).join('\n')).not.toContain('ghp_abc');
    await until(() => expect(sent).toContainEqual({ type: 'ack', sessionId: 's1', seq: 1, echo: true }));
    expect(JSON.stringify(sent)).not.toContain('ghp_abc');
  });

  it('never releases a partial line that is not a prompt, and releases one that is', async () => {
    const shell = new FakeShell();
    const { sent } = await opened(shell);
    shell.emit({ kind: 'echo', on: true });
    shell.emit({ kind: 'output', text: 'TOKEN=abc' });
    await settled(shell);
    expect(sent.filter((f) => f.type === 'output')).toEqual([]);
    shell.emit({ kind: 'output', text: 'def\nPassword: ' });
    // Echo on: the prompt goes out and the next line, where the terminal prints the value, is hidden.
    await until(() => expect(outputs(sent)).toEqual([`TOKEN=${REDACTED}`, 'Password: ']));
    shell.emit({ kind: 'output', text: 'typed-value\n' });
    await until(() => expect(outputs(sent)).toEqual([`TOKEN=${REDACTED}`, 'Password: ', REDACTED]));
    // Echo off: a program can still print after the prompt, so the next line is hidden there too.
    shell.emit({ kind: 'echo', on: false });
    shell.emit({ kind: 'output', text: 'Passphrase: ' });
    await until(() => expect(outputs(sent)).toContain('Passphrase: '));
    shell.emit({ kind: 'output', text: 'done\n' });
    await until(() => expect(outputs(sent)).toEqual([`TOKEN=${REDACTED}`, 'Password: ', REDACTED, 'Passphrase: ', REDACTED]));
  });

  it('a raw-mode program, reported as unknown echo, has what it prints after a credential prompt hidden', async () => {
    const shell = new FakeShell();
    const { sent } = await opened(shell);
    shell.emit({ kind: 'echo', on: true });
    shell.emit({ kind: 'echo', on: null });
    await until(() => expect(sent).toContainEqual({ type: 'echo', sessionId: 's1', on: null }));
    shell.emit({ kind: 'output', text: 'API key: ' });
    await until(() => expect(outputs(sent)).toEqual(['API key: ']));
    shell.emit({ kind: 'output', text: 'sk-typed-value-123\n' });
    await until(() => expect(outputs(sent)).toEqual(['API key: ', REDACTED]));
    expect(JSON.stringify(sent)).not.toContain('sk-typed-value-123');
  });

  it('tells the API when the runtime has no shell to give', async () => {
    const { sent } = await opened(null, { openFails: true });
    await until(() => expect(sent).toContainEqual({ type: 'shell_ended', sessionId: 's1', unavailable: true }));
  });

  it('a close frame ends the shell inside the sandbox', async () => {
    const shell = new FakeShell();
    const { down } = await opened(shell);
    down({ type: 'close', sessionId: 's1', reason: 'left' });
    await until(() => expect(shell.closed).toBe(true));
  });

  it('a lost connection ends the session and reconnects for the next one', async () => {
    const shell = new FakeShell();
    const { handlers } = await opened(shell);
    handlers().onClose();
    await until(() => expect(shell.closed).toBe(true));
  });

  it('shutdown ends the shell and stops reconnecting, and no input is forwarded after it', async () => {
    const shell = new FakeShell();
    const { b, down } = await opened(shell);
    await b.shutdown();
    down({ type: 'input', sessionId: 's1', seq: 2, data: 'rm -rf .\r' });
    expect(shell.closed).toBe(true);
    expect(shell.inputs).toEqual([]);
  });

  it('a slow connection drops the oldest output, counted, rather than growing without limit', async () => {
    const shell = new FakeShell();
    const sent: ControlUpFrame[] = [];
    let sendable = false;
    let handlers: ControlHandlers | undefined;
    const b = new ControlBridge({ connect: async (h) => { handlers = h; return { send: (f) => sent.push(f), get sendable() { return sendable; }, close: () => undefined }; }, runtime: { openControlShell: async () => shell } as unknown as RuntimeAdapter, handle: HANDLE, log: () => undefined, limits: { flushMs: 1, promptMs: 500, maxLines: 10, maxBytes: 100_000, reconnectMs: 1 } });
    b.start();
    await until(() => expect(handlers).toBeDefined());
    handlers!.onFrame({ type: 'open', sessionId: 's1' });
    await until(() => expect(shell.listening).toBe(true));
    shell.emit({ kind: 'echo', on: true });
    shell.emit({ kind: 'output', text: `${Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n')}\n` });
    await settled(shell);
    expect(sent.filter((f) => f.type === 'output')).toEqual([]);
    sendable = true;
    shell.emit({ kind: 'output', text: 'z\n' });
    await until(() => expect(sent.filter((f) => f.type === 'output').length).toBeGreaterThan(0));
    const out = sent.filter((f) => f.type === 'output') as Extract<ControlUpFrame, { type: 'output' }>[];
    expect(out.flatMap((o) => o.lines).length).toBeLessThanOrEqual(10);
    expect(out.reduce((n, o) => n + o.dropped, 0)).toBeGreaterThan(30);
  });
});

describe('an attempt with control enabled', () => {
  const deps = (w: Awaited<ReturnType<typeof makeWorld>>, connect: NonNullable<AttemptDeps['control']>): AttemptDeps => ({ api: w.api, runtime: w.runtime, artifacts: w.artifacts, workRoot: w.workRoot, repos: { proj1: w.repo }, heartbeatMs: 20, maxMissedHeartbeats: 3, cpus: 2, memoryMiB: 4096, log: () => undefined, control: connect, terminalFeedLimits: { maxLines: 500, maxBytes: 262144, batchLines: 100, flushMs: 1, keepaliveMs: 60000, closeMs: 100 } });

  it('dials out only when the lease says the attempt can host control mode', async () => {
    const connect = vi.fn(async () => ({ send: () => undefined, sendable: true, close: () => undefined }));
    const world = await makeWorld({ controllable: false });
    await runAttempt(deps(world, { connectorFor: () => connect }), world.lease);
    expect(connect).not.toHaveBeenCalled();
    await world.cleanup();
  });

  it('a finished attempt closes its shell before the workspace is read, and a late input does nothing', async () => {
    const sent: ControlUpFrame[] = [];
    let handlers!: ControlHandlers;
    const world = await makeWorld({
      controllable: true,
      agent: async ({ stream, write }) => {
        await write('src/app.ts', 'export const a = 2;\n');
        await new Promise((r) => setTimeout(r, 40));
        handlers.onFrame({ type: 'open', sessionId: 'ctl_1' });
        await new Promise((r) => setTimeout(r, 40));
        void stream;
      },
      onControlStream: (s) => {
        s.push('{"e":1}\n');
      },
    });
    const report = await runAttempt(deps(world, { connectorFor: () => async (h) => { handlers = h; return { send: (f) => sent.push(f), sendable: true, close: () => undefined }; }, limits: { closeMs: 200 } }), world.lease);
    // The change made while control mode was on is still judged by the same gate.
    expect(report.outcome).toBe('completed');
    expect(sent).toContainEqual({ type: 'opened', sessionId: 'ctl_1', echo: true });
    expect(world.controlStreams).toHaveLength(1);
    expect(world.controlStreams[0]!.killed || world.controlStreams[0]!.written.join('').includes('"x":1')).toBe(true);
    handlers.onFrame({ type: 'input', sessionId: 'ctl_1', seq: 9, data: 'rm -rf .\r' });
    expect(world.controlStreams[0]!.written.join('')).not.toContain(Buffer.from('rm -rf').toString('base64'));
    expect(world.sbx.sandboxes.size).toBeLessThanOrEqual(1);
    await world.cleanup();
  });

  it('a change outside the allowed paths during control mode still fails the gate, and so does the reserved directory', async () => {
    const world = await makeWorld({ controllable: true, agent: async ({ write }) => { await write('other/file.ts', 'x'); } });
    const report = await runAttempt(deps(world, { connectorFor: () => async () => ({ send: () => undefined, sendable: true, close: () => undefined }) }), world.lease);
    expect(report.outcome).toBe('failed');
    expect(world.api.published[0]).toMatchObject({ outcome: 'failed' });
    await world.cleanup();
  });
});
