import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { REDACTED, TerminalRedactor, type ControlShellEvent } from '@selarikru/protocol';
import { CONTROL_HELPER, SbxControlShell, controlKillArgs, controlShellArgs } from './control-shell.ts';
import { FakeSbx } from './fake-sbx.ts';
import { assertSafeSbxArgs, UnsafeSbxCommandError } from './sbx.ts';
import { SbxRuntimeAdapter } from './adapter.ts';
import type { FakeStream } from './fake-sbx.ts';

const NAME = 'selarikru-t12345678-a87654321';

describe('the control shell command', () => {
  it('only goes through the allow-listed exec, in the named sandbox, with no host path and no privilege flag', () => {
    expect(() => assertSafeSbxArgs(controlShellArgs(NAME, '/ws', 'ctl_1'))).not.toThrow();
    expect(() => assertSafeSbxArgs(['exec', '-i', '-w', '/ws', 'hq-askwell-jim', 'sh'])).toThrow(UnsafeSbxCommandError);
    for (const bad of [['exec', '-u', 'root', NAME, 'sh'], ['exec', '-t', NAME, 'sh'], ['exec', '--privileged', NAME, 'sh'], ['exec', '-e', 'X=1', NAME, 'sh']]) {
      expect(() => assertSafeSbxArgs(bad)).toThrow(UnsafeSbxCommandError);
    }
  });

  it('python ignores the workspace on its import path, so a planted json.py cannot replace the standard library', () => {
    const args = controlShellArgs(NAME, '/ws', 'ctl_1');
    expect(args.slice(args.indexOf('python3'), args.indexOf('python3') + 3)).toEqual(['python3', '-I', '-c']);
  });

  it('a session id can never become part of a shell command', () => {
    expect(() => controlShellArgs(NAME, '/ws', 'x; rm -rf /')).toThrow();
    expect(() => controlKillArgs(NAME, '$(reboot)')).toThrow();
  });

  it('the helper runs a non-readline bash and never writes typed input anywhere', () => {
    expect(CONTROL_HELPER).toContain("'--noediting'");
    expect(CONTROL_HELPER).toContain("HISTFILE='/dev/null'");
    expect(CONTROL_HELPER).not.toMatch(/open\(.*typed|log/);
  });
});

function shellOver(runner: FakeSbx, args: string[]) {
  const stream = runner.stream(args) as FakeStream;
  return { stream, shell: new SbxControlShell(stream, runner, NAME, 'ctl_1', 50) };
}

async function collect(events: AsyncIterable<ControlShellEvent>, n: number): Promise<ControlShellEvent[]> {
  const out: ControlShellEvent[] = [];
  for await (const e of events) { out.push(e); if (out.length >= n) break; }
  return out;
}

describe('the shell frames', () => {
  const setup = () => {
    const runner = new FakeSbx();
    runner.addForeign(NAME);
    return { runner, ...shellOver(runner, controlShellArgs(NAME, '/ws', 'ctl_1')) };
  };

  it('reads echo, output and acks, and ignores anything else', async () => {
    const { stream, shell } = setup();
    stream.push('{"e":1}\n');
    stream.push(`{"o":"${Buffer.from('hi\n').toString('base64')}"}\nnot json\n{"unknown":1}\n`);
    stream.push('{"a":3,"e":0}\n');
    stream.end(0);
    const got = await collect(shell.events, 5);
    expect(got).toEqual([{ kind: 'echo', on: true }, { kind: 'output', text: 'hi\n' }, { kind: 'ack', seq: 3, echo: false }, { kind: 'exited' }]);
  });

  it('an unreadable echo state, or a raw-mode program, arrives as unknown rather than being dropped', async () => {
    const { stream, shell } = setup();
    stream.push('{"e":null}\n');
    stream.end(0);
    const got = await collect(shell.events, 2);
    expect(got).toEqual([{ kind: 'echo', on: null }, { kind: 'exited' }]);
  });

  it('a multi-byte character split across frames is rejoined', async () => {
    const { stream, shell } = setup();
    const bytes = Buffer.from('café', 'utf8');
    stream.push(`{"o":"${bytes.subarray(0, 4).toString('base64')}"}\n`);
    stream.push(`{"o":"${bytes.subarray(4).toString('base64')}"}\n`);
    stream.end(0);
    const got = await collect(shell.events, 3);
    expect(got.filter((e): e is Extract<ControlShellEvent, { kind: 'output' }> => e.kind === 'output').map((e) => e.text).join('')).toBe('café');
  });

  it('sends input as a frame that carries no shell text in the clear', () => {
    const { stream, shell } = setup();
    shell.input(1, 'echo hi\r');
    const sent = JSON.parse(stream.written[0]!.trim()) as { i: number; d: string };
    expect(sent.i).toBe(1);
    expect(Buffer.from(sent.d, 'base64').toString()).toBe('echo hi\r');
    expect(stream.written[0]).not.toContain('echo hi');
  });

  it('a stuck close is killed inside the guest, not only on the host, and a late input is dropped', async () => {
    const runner = new FakeSbx({ onStream: () => undefined });
    runner.addForeign(NAME);
    const { stream, shell } = shellOver(runner, controlShellArgs(NAME, '/ws', 'ctl_1'));
    await shell.close();
    expect(stream.stdinEnded).toBe(true);
    expect(runner.calls.some((c) => c.join(' ').includes('kill -TERM'))).toBe(true);
    shell.input(9, 'x');
    expect(stream.written.join('')).not.toContain('eA==');
  });

  it('the adapter opens it inside the handle\'s own sandbox', async () => {
    const sbx = new FakeSbx();
    sbx.addForeign(NAME);
    const adapter = new SbxRuntimeAdapter(sbx, { home: '/h', forbidden: [], attemptsRoot: null });
    await adapter.openControlShell({ sandboxId: NAME, attemptId: 'a', taskId: 't', workspacePath: '/ws' }, 'ctl_9');
    expect(sbx.calls[0]!.slice(0, 5)).toEqual(['exec', '-i', '-w', '/ws', NAME]);
  });
});

// Runs the real guest helper on a real PTY, because the termios flags are the whole point. Needs only python3 and bash, so nothing is mocked and no sandbox is involved.
const hasPython = spawnSync('python3', ['-c', 'import pty, termios']).status === 0 && process.platform !== 'win32';

describe.skipIf(!hasPython)('the guest helper on a real pty', () => {
  const run = async (command: string): Promise<(number | null)[]> => {
    const child = spawn('python3', ['-I', '-c', CONTROL_HELPER, `t${process.pid}${Date.now()}`], { stdio: ['pipe', 'pipe', 'ignore'], cwd: tmpdir() });
    const states: (number | null)[] = [];
    let held = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      held += chunk;
      for (let i = held.indexOf('\n'); i >= 0; i = held.indexOf('\n')) {
        const frame = JSON.parse(held.slice(0, i)) as { e?: number | null; a?: number };
        held = held.slice(i + 1);
        if ('e' in frame && frame.a === undefined) states.push(frame.e ?? null);
      }
    });
    await vi.waitFor(() => expect(states.length).toBeGreaterThan(0), { timeout: 5_000 });
    child.stdin.write(`${JSON.stringify({ i: 1, d: Buffer.from(`${command}\n`).toString('base64') })}\n`);
    try {
      await vi.waitFor(() => expect(states.slice(1).length).toBeGreaterThan(0), { timeout: 8_000 });
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      child.stdin.write('{"x":1}\n');
      child.kill();
    }
    return states;
  };

  it('a raw-mode program reports unknown, not echo off', async () => {
    const states = await run(`python3 -I -c 'import tty,time; tty.setraw(0); time.sleep(0.6)'`);
    expect(states).toContain(null);
    expect(states.slice(1)).not.toContain(0);
  }, 20_000);

  it('a value a program prints after a password prompt with echo off never reaches the output', async () => {
    const child = spawn('python3', ['-I', '-c', CONTROL_HELPER, `p${process.pid}${Date.now()}`], { stdio: ['pipe', 'pipe', 'ignore'], cwd: tmpdir() });
    const frames: { at: number; e?: number | null; o?: string }[] = [];
    let held = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      held += chunk;
      for (let i = held.indexOf('\n'); i >= 0; i = held.indexOf('\n')) {
        const frame = JSON.parse(held.slice(0, i)) as { e?: number | null; o?: string; a?: number };
        held = held.slice(i + 1);
        if (frame.a === undefined) frames.push({ at: Date.now(), ...frame });
      }
    });
    const raw = (): string => frames.map((f) => (f.o ? Buffer.from(f.o, 'base64').toString() : '')).join('');
    try {
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 5_000 });
      // The value is built in the shell, so the command echoed before stty -echo does not carry it.
      child.stdin.write(`${JSON.stringify({ i: 1, d: Buffer.from("V=printed; stty -echo; printf 'password: '; sleep 1; echo $V-value; stty echo\n").toString('base64') })}\n`);
      await vi.waitFor(() => expect(raw()).toContain('printed-value'), { timeout: 8_000 });
    } finally {
      child.stdin.write('{"x":1}\n');
      child.kill();
    }
    // Replays what the runner does: redact every chunk, and offer the held text as a prompt after a pause.
    const redactor = new TerminalRedactor();
    const lines: string[] = [];
    let echo: number | null | undefined;
    frames.forEach((f, i) => {
      if ('e' in f) echo = f.e;
      if (f.o) lines.push(...redactor.write(Buffer.from(f.o, 'base64').toString()));
      const next = frames[i + 1];
      if (next === undefined || next.at - f.at >= 200) {
        const released = redactor.releasePrompt(echo === 0);
        if (released !== null) lines.push(released);
      }
    });
    lines.push(...redactor.flush());
    expect(lines).toContain('password: ');
    expect(lines).toContain(REDACTED);
    expect(lines.join('\n')).not.toContain('printed-value');
  }, 20_000);

  it('echo off with canonical input reports echo off', async () => {
    const states = await run('stty -echo; sleep 0.6; stty echo');
    expect(states.slice(1)).toContain(0);
    expect(states).not.toContain(null);
  }, 20_000);
});
