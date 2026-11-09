import { describe, expect, it } from 'vitest';
import { REDACTED, TerminalRedactor, TerminalUploadRequestSchema } from './index.ts';

const SECRET = 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789';

describe('TerminalRedactor', () => {
  it('a secret split across two chunks is still redacted, and neither half is ever released', () => {
    const r = new TerminalRedactor();
    const mid = 28; // Long enough that the head would match on its own, which is exactly why nothing may redact it early.
    const first = r.write(`deploying with ${SECRET.slice(0, mid)}`);
    expect(first).toEqual([]); // line-buffered: nothing of the partial line leaves.
    const out = [...first, ...r.write(`${SECRET.slice(mid)} now\n`), ...r.flush()];
    expect(out).toEqual([`deploying with ${REDACTED} now`]);
    expect(out.join('')).not.toContain(SECRET.slice(0, mid));
    expect(out.join('')).not.toContain(SECRET.slice(mid));
  });

  it('a split across many small chunks and CR/LF boundaries behaves the same', () => {
    const r = new TerminalRedactor();
    const line = `token=${SECRET}\r\nsecond\r\n`;
    const out = [...line].flatMap((c) => r.write(c));
    expect([...out, ...r.flush()]).toEqual([`token=${REDACTED}`, 'second']);
  });

  it('removes ANSI, bidi and zero-width text before matching, so they cannot hide a secret', () => {
    const r = new TerminalRedactor();
    const out = [...r.write(`\u001b[31msk-ant-​AbCdEf0123456789‮AbCdEf012345\u001b[0m rest\n`), ...r.flush()];
    expect(out).toEqual([`${REDACTED} rest`]);
  });

  it('withholds every line of a private key, even when lines arrive in separate chunks', () => {
    const r = new TerminalRedactor();
    const out: string[] = [];
    out.push(...r.write('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuv\n'));
    out.push(...r.write('ZZZsecretpemlinebbbbbbbbbbbbbbbbbbbbbbbb\n-----END RSA PRIVATE KEY-----\nafter the key\n'));
    out.push(...r.flush());
    expect(out.join('\n')).not.toMatch(/MIIEpAIBAAKCAQEA|ZZZsecretpemline/);
    expect(out[0]).toBe(REDACTED);
    expect(out.at(-1)).toBe('after the key');
  });

  it('reads a value on the line after its credential name', () => {
    const r = new TerminalRedactor();
    const out = [...r.write(`api_key:\n${SECRET}\nnext\n`), ...r.flush()];
    expect(out.join('\n')).not.toContain(SECRET);
    expect(out.at(-1)).toBe('next');
  });

  it('a line that never ends is withheld, not released in pieces', () => {
    const r = new TerminalRedactor();
    const out = [...r.write('x'.repeat(70_000)), ...r.write(`${SECRET}\nend\n`), ...r.flush()];
    expect(out[0]).toMatch(/withheld/);
    expect(out.join('')).not.toContain('x'.repeat(100));
    expect(out.join('\n')).not.toContain(SECRET);
    expect(out.at(-1)).toBe('end');
  });

  it('holds a partial line until its newline, and flush releases it', () => {
    const r = new TerminalRedactor();
    expect(r.write('no newline yet')).toEqual([]);
    expect(r.write('\n')).toEqual(['no newline yet']);
    r.write('ends without newline');
    expect(r.flush()).toEqual(['ends without newline']);
    expect(r.flush()).toEqual([]);
  });
});

describe('the terminal upload schema', () => {
  const lease = { attemptId: 'a', fence: 1, leaseToken: 't' };
  it('accepts a bounded batch and refuses more', () => {
    expect(TerminalUploadRequestSchema.safeParse({ lease, seq: 0, lines: [{ at: '2026-11-09T00:00:00.000Z', text: 'hi' }], dropped: 0, ended: false }).success).toBe(true);
    expect(TerminalUploadRequestSchema.safeParse({ lease, seq: 0, lines: Array.from({ length: 101 }, () => ({ at: '2026-11-09T00:00:00.000Z', text: 'x' })), dropped: 0, ended: false }).success).toBe(false);
  });
});
