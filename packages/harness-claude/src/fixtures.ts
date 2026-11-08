/** Synthetic recorded-stream fixtures shaped after docs/evidence/spike-runtime.md. No real content. */
const j = (o: unknown): string => JSON.stringify(o);

export const CANARY = 'sk-ant-api03-CANARYCANARYCANARY123456';

export const initEvent = j({
  type: 'system',
  subtype: 'init',
  model: 'claude-sonnet-5-5',
  permissionMode: 'bypassPermissions',
  apiKeySource: 'none',
  claude_code_version: '2.1.319',
  session_id: 'sess-1',
  tools: ['Bash', 'Write'],
});

export const fullRun: string[] = [
  j({ type: 'system', subtype: 'hook_started' }),
  j({ type: 'system', subtype: 'hook_response' }),
  initEvent,
  j({ type: 'system', subtype: 'background_tasks_changed' }),
  j({ type: 'system', subtype: 'task_started' }),
  j({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'assistant prose that must not be forwarded' },
        { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/w/greet.py', content: 'def greet(): pass' } },
      ],
      usage: { input_tokens: 2, output_tokens: 21 },
    },
  }),
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'File created successfully' }] } }),
  j({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
  j({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 4,
    duration_ms: 9167,
    total_cost_usd: 0.0793001,
    terminal_reason: 'completed',
    usage: { input_tokens: 6, output_tokens: 531, cache_read_input_tokens: 66901, cache_creation_input_tokens: 16822 },
  }),
];
