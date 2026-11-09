import { describe, expect, it } from 'vitest';
import { CONTROL_MAX_INPUT_CHARS, ControlClientFrameSchema, ControlDownFrameSchema, ControlUpFrameSchema, redactControlInput } from './control.ts';

describe('control frames', () => {
  it('a typed line is one line of plain text: no line break, no escape or control characters', () => {
    const ok = (text: string) => ControlClientFrameSchema.safeParse({ type: 'input', seq: 1, text }).success;
    expect(ok('git status')).toBe(true);
    expect(ok('a\tb')).toBe(true);
    expect(ok('')).toBe(true);
    expect(ok('echo one\nrm -rf /')).toBe(false);
    expect(ok('echo one\rrm')).toBe(false);
    expect(ok('\u001b[2Jhidden')).toBe(false);
    expect(ok('\u0003')).toBe(false);
    expect(ok('a\u2028b')).toBe(false);
    expect(ok('x'.repeat(CONTROL_MAX_INPUT_CHARS + 1))).toBe(false);
  });

  it('refuses any field the schema does not name', () => {
    expect(ControlClientFrameSchema.safeParse({ type: 'auth', ticket: 't', token: 'x' }).success).toBe(false);
    expect(ControlDownFrameSchema.safeParse({ type: 'input', sessionId: 's', seq: 1, data: 'x', extra: 1 }).success).toBe(false);
    expect(ControlDownFrameSchema.safeParse({ type: 'input', sessionId: 'bad id;', seq: 1, data: 'x' }).success).toBe(false);
    expect(ControlUpFrameSchema.safeParse({ type: 'ack', sessionId: 's', seq: 1 }).success).toBe(false);
  });
});

describe('what is stored for a typed line', () => {
  it('uses the terminal policy, and is bounded', () => {
    expect(redactControlInput('export API_KEY=abc123')).toBe('export API_KEY=[REDACTED]');
    expect(redactControlInput('curl -H "Authorization: Bearer sk_live_0123456789abcdefghij"')).not.toContain('sk_live');
    expect(redactControlInput('x'.repeat(9000)).length).toBeLessThan(2100);
  });
});
