import { describe, expect, it, vi } from 'vitest';
import type { NormalizedHarnessEvent } from '@selarikru/protocol';
import { ClaudeHarnessAdapter, type HarnessLauncher, type LaunchedProcess } from './adapter.ts';
import { CANARY, fullRun, initEvent } from './fixtures.ts';

function fakeLauncher(chunks: string[], exit: { code: number | null; signal?: string | null } = { code: 0 }) {
  const stdinEnd = vi.fn();
  const launch = vi.fn(async (): Promise<LaunchedProcess> => ({
    lines: (async function* () {
      for (const c of chunks) yield c;
    })(),
    stdin: { write: vi.fn(), end: stdinEnd },
    kill: vi.fn(),
    exited: Promise.resolve({ code: exit.code, signal: exit.signal ?? null }),
  }));
  const stop = vi.fn(async () => ({ accepted: true, detail: 'signal sent in sandbox' }));
  const launcher: HarnessLauncher = { launch, stop };
  return { launcher, launch, stop };
}

async function collect(it: AsyncIterable<NormalizedHarnessEvent>): Promise<NormalizedHarnessEvent[]> {
  const out: NormalizedHarnessEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const base = { attemptId: 'a1', prompt: 'do it', workspacePath: '/w' };
const lines = (xs: string[]): string[] => xs.map((x) => `${x}\n`);

describe('ClaudeHarnessAdapter', () => {
  it('normalizes tool, usage and exit events', async () => {
    const { launcher, launch } = fakeLauncher(lines(fullRun), { code: 0 });
    const events = await collect(new ClaudeHarnessAdapter(launcher).run(base));
    expect(launch.mock.calls[0]).toBeDefined();
    const spec = (launch.mock.calls[0] as unknown as [{ command: string[] }])[0];
    expect(spec.command).toEqual(expect.arrayContaining(['claude', '-p', '--output-format', 'stream-json', '--verbose']));
    expect(events[0]).toMatchObject({
      type: 'session_started',
      harnessVersion: '2.1.319',
      permissionMode: 'bypassPermissions',
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ toolName: 'Write', status: 'started' });
    expect(events.find((e) => e.type === 'tool_call')).not.toHaveProperty('preview');
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ toolName: 'Write', status: 'ok' });
    expect(JSON.stringify(events)).not.toContain('assistant prose');
    expect(JSON.stringify(events)).not.toContain('greet.py');
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { source: 'observed', inputTokens: 6, outputTokens: 531, cacheReadTokens: 66901, cacheCreationTokens: 16822, costUsd: 0.0793001, costBasis: 'list' },
    });
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success', terminalReason: 'completed' });
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 0 });
    expect(types).not.toContain('ended_without_result');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it('tolerates partial lines, unknown types and garbage', async () => {
    const whole = lines(fullRun).join('');
    const mid = Math.floor(whole.length / 2);
    const { launcher } = fakeLauncher([whole.slice(0, mid), whole.slice(mid), 'not json\n', '{"type":"brand_new","secret":"x"}\n']);
    const events = await collect(new ClaudeHarnessAdapter(launcher).run(base));
    expect(events.find((e) => e.type === 'raw_unrecognized')).toEqual(expect.objectContaining({ rawType: 'brand_new' }));
    expect(JSON.stringify(events)).not.toContain('"secret"');
    expect(events.some((e) => e.type === 'unparseable_line')).toBe(true);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
  });

  it('unsupported capability fails before launch', async () => {
    const { launcher, launch } = fakeLauncher([]);
    const adapter = new ClaudeHarnessAdapter(launcher);
    const events = await collect(adapter.run({ ...base, requires: ['resume'] }));
    expect(launch).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: 'launch_refused', attemptId: 'a1', seq: 0, reason: 'capability_unavailable', capability: 'resume', status: 'not established' },
    ]);
    const partial = await collect(adapter.run({ ...base, requires: ['cancel'] }));
    expect(partial[0]).toMatchObject({ type: 'launch_refused', capability: 'cancel', status: 'partial' });
    expect(launch).not.toHaveBeenCalled();
    await collect(adapter.run({ ...base, requires: ['cancel', 'usageReporting'], acceptPartial: ['cancel'] }));
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('declares exactly the spike capability table', () => {
    expect(new ClaudeHarnessAdapter(fakeLauncher([]).launcher).capabilities()).toEqual({
      structuredEvents: 'supported',
      resume: 'not established',
      cancel: 'partial',
      approvalCallbacks: 'not established',
      providerOverride: 'not established',
      localInference: 'not established',
      usageReporting: 'supported',
      networkEnforcement: 'not established',
      outputSchema: 'not established',
    });
  });

  it('missing usage → unavailable, not 0', async () => {
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false });
    const { launcher } = fakeLauncher(lines([initEvent, result]));
    const events = await collect(new ClaudeHarnessAdapter(launcher).run(base));
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { source: 'unavailable', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null, costBasis: null },
    });
    // partially present: absent fields stay null
    const partial = JSON.stringify({ type: 'result', subtype: 'success', usage: { output_tokens: 5 } });
    const e2 = await collect(new ClaudeHarnessAdapter(fakeLauncher(lines([initEvent, partial])).launcher).run(base));
    expect(e2.find((e) => e.type === 'usage')).toMatchObject({ usage: { source: 'observed', inputTokens: null, outputTokens: 5, costUsd: null } });
  });

  it('secret canary redacted', async () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', model: `m-${CANARY}`, permissionMode: 'default', claude_code_version: '1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t-${CANARY}`, name: `Tool-${CANARY}`, input: { cmd: `echo ${CANARY}` } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: `out ${CANARY}` }] } }),
      JSON.stringify({ type: `weird-${CANARY}` }),
    ];
    for (const previews of [undefined, { enabled: true, maxChars: 500 }]) {
      const { launcher } = fakeLauncher(lines(stream));
      const input = previews ? { ...base, previews } : base;
      const events = await collect(new ClaudeHarnessAdapter(launcher).run(input));
      expect(JSON.stringify(events)).not.toContain('CANARYCANARY');
      expect(JSON.stringify(events)).toContain('[REDACTED]');
    }
  });

  it('previews are off by default and bounded when enabled', async () => {
    const long = 'x'.repeat(1000);
    const stream = [
      initEvent,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: long }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: long } }] } }),
    ];
    const off = await collect(new ClaudeHarnessAdapter(fakeLauncher(lines(stream)).launcher).run(base));
    expect(JSON.stringify(off)).not.toContain('xxxxx');
    const on = await collect(new ClaudeHarnessAdapter(fakeLauncher(lines(stream)).launcher).run({ ...base, previews: { enabled: true, maxChars: 50 } }));
    const call = on.find((e) => e.type === 'tool_call');
    expect(call && 'preview' in call ? call.preview?.length : 0).toBeLessThanOrEqual(51);
  });

  it('end of stream without result is ended_without_result; no init still yields a first session event', async () => {
    const { launcher } = fakeLauncher(lines([initEvent, JSON.stringify({ type: 'system', subtype: 'task_started' })]), { code: null, signal: 'SIGTERM' });
    const events = await collect(new ClaudeHarnessAdapter(launcher).run(base));
    expect(events.map((e) => e.type)).toEqual(['session_started', 'system', 'ended_without_result', 'exit']);
    expect(events.at(-1)).toMatchObject({ code: null, signal: 'SIGTERM' });
    const none = await collect(new ClaudeHarnessAdapter(fakeLauncher([]).launcher).run(base));
    expect(none[0]).toMatchObject({ type: 'session_started', harnessVersion: null, permissionMode: null });
  });

  it('cancel returns acknowledgment, distinct from termination', async () => {
    const { launcher, stop } = fakeLauncher([]);
    const ack = await new ClaudeHarnessAdapter(launcher).cancel('a1');
    expect(stop).toHaveBeenCalledWith('a1');
    expect(ack).toEqual({ attemptId: 'a1', status: 'stop_requested', terminationConfirmed: false, detail: 'signal sent in sandbox' });
    stop.mockResolvedValueOnce({ accepted: false, detail: 'no such process' });
    expect(await new ClaudeHarnessAdapter(launcher).cancel('a1')).toMatchObject({ status: 'stop_rejected', terminationConfirmed: false });
    stop.mockRejectedValueOnce(new Error('sbx down'));
    expect(await new ClaudeHarnessAdapter(launcher).cancel('a1')).toMatchObject({ status: 'stop_rejected', terminationConfirmed: false });
  });
});
