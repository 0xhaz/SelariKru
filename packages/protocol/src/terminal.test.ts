import { describe, expect, it } from 'vitest';
import { REDACTED, TerminalRedactor, TerminalUploadRequestSchema, redactSecrets, redactTerminalText } from './index.ts';

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
    expect(out).toEqual(['[private key withheld]', 'after the key']);
  });

  it('reads a value on the line after its credential name', () => {
    const r = new TerminalRedactor();
    const out = [...r.write(`api_key:\n${SECRET}\nnext\n`), ...r.flush()];
    expect(out.join('\n')).not.toContain(SECRET);
    expect(out.at(-1)).toBe('next');
  });

  it('the end of a run clears an unclosed private key and says how much went', () => {
    const r = new TerminalRedactor();
    r.write('-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n');
    expect(r.flush()).toEqual(['[private key withheld, 2 lines]']);
    expect(r.write('next run\n')).toEqual(['next run']);
  });

  it('a soft break keeps messages apart unless a secret runs across it', () => {
    const r = new TerminalRedactor();
    r.write('one');
    r.softBreak();
    r.write('two');
    expect(r.flush()).toEqual(['one', 'two']);
    r.write(`key ${SECRET.slice(0, 28)}`);
    r.softBreak();
    r.write(`${SECRET.slice(28)} end`);
    expect(r.flush()).toEqual([`key ${REDACTED} end`]);
  });

  it('lines mode waits only for a name with a separator', () => {
    const r = new TerminalRedactor('lines');
    expect(r.write('> Bash grep token\n')).toEqual(['> Bash grep token']);
    expect(r.write('[ok]\n')).toEqual(['[ok]']);
    expect(r.write('api_key:\n')).toEqual([]);
    expect(r.write('value\n').join('')).not.toContain('value');
  });

  it('does not change what redactSecrets means elsewhere', () => {
    expect(redactSecrets('DB_PASSWORD=correcthorsebattery')).toBe('DB_PASSWORD=correcthorsebattery');
    expect(redactTerminalText('DB_PASSWORD=correcthorsebattery')).toBe(`DB_PASSWORD=${REDACTED}`);
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

describe('names and values: both sides', () => {
  const VALUE = 'Zq9xPlanted7Val';
  const run = (text: string): string[] => { const r = new TerminalRedactor(); const out = r.write(text); out.push(...r.flush()); return out; };
  const attacks: readonly (readonly [string, string])[] = [
    ['DB_PASS', `DB_PASS=${VALUE}\n`], ['SMTP_PASS with a colon', `SMTP_PASS: ${VALUE}\n`], ['PASSPHRASE', `PASSPHRASE=${VALUE}\n`], ['Cookie', `> Cookie: session=${VALUE}\n`],
    ['Set-Cookie', `< Set-Cookie: sid=${VALUE}; Path=/\n`], ['SESSION_ID', `SESSION_ID=${VALUE}\n`], ['sessionId', `sessionId: ${VALUE}\n`], ['JSESSIONID', `JSESSIONID=${VALUE}\n`],
    ['a short bearer with a digit', `used Bearer ${VALUE} here\n`], ['a long bearer with no digit', 'Bearer abcdefghijklmnopqrstuvw\n'],
    ['AWS secret', `AWS_SECRET_ACCESS_KEY=wJ${VALUE}\n`], ['DB_PASSWORD', `DB_PASSWORD=x${VALUE}\n`], ['API_KEY', `API_KEY=a${VALUE}\n`], ['MY_SERVICE_KEY', `MY_SERVICE_KEY=9f${VALUE}\n`],
    ['apikey', `apikey: ${VALUE}\n`], ['signingKey hump', `signingKey: ${VALUE}\n`], ['x-api-key', `x-api-key: ${VALUE}\n`], ['x-auth segment', `x-auth: ${VALUE}\n`], ['Authorization', `Authorization: Basic ${VALUE}\n`],
    ['Proxy-Authorization', `Proxy-Authorization: x${VALUE}\n`], ['a query token', `https://x/y?access_token=${VALUE}&z=1\n`],
    ['a grep prefix on a password', `src/auth.ts:12: const password = "${VALUE}"\n`], ['a grep prefix on an env line', `config/prod.env:3:API_KEY=${VALUE}\n`],
    ['a numeric password', 'PASSWORD=123456\n'], ['a password in JSON', `{"password":"${VALUE}","x":1}\n`], ['nested under an object', `auth: { pass: "${VALUE}" }\n`],
    ['a name and its value after a blank line', `token:\n\n${VALUE}\n`], ['a bare name, then the value', `password\n${VALUE}\n`],
    ['a presigned S3 URL', `https://x.s3.amazonaws.com/a?X-Amz-Signature=${VALUE}\n`], ['a SAS URL', `https://a.blob/x?sig=${VALUE}&se=1\n`], ['Dockerfile ENV', `ENV DB_PASSWORD ${VALUE}\n`], ['Dockerfile ENV, weak name', `ENV SERVICE_KEY ${VALUE}\n`],
    ['--password', `deploy --password ${VALUE}\n`], ['--api-key', `deploy --api-key ${VALUE}\n`], ['a quoted weak value in code', `const key = "${VALUE}"\n`],
  ];
  for (const [name, text] of attacks) it(`redacts: ${name}`, () => { expect(run(text).join('\n')).not.toMatch(new RegExp(`${VALUE}|abcdefghijklmnop|123456`)); });

  const harmless: readonly (readonly [string, readonly string[]])[] = [
    ['src/auth.ts:12: const x = 1\n', ['src/auth.ts:12: const x = 1']],
    ['  at handler (/w/src/auth.ts:12:3)\n', ['  at handler (/w/src/auth.ts:12:3)']],
    ['<li key={item.id} className="row">{item.title}</li>\n', ['<li key={item.id} className="row">{item.title}</li>']],
    ['"author": "Jane Doe",\n', ['"author": "Jane Doe",']],
    ['author: Jane\n', ['author: Jane']],
    ['"keywords": ["a"],\n', ['"keywords": ["a"],']],
    ['keyboard: us\n', ['keyboard: us']],
    ['Authentication: uses cookies\n', ['Authentication: uses cookies']],
    ['tokens: 5\n', ['tokens: 5']],
    ['"max_tokens": 4096,\n', ['"max_tokens": 4096,']],
    ['primaryKey: true,\n', ['primaryKey: true,']],
    ['function f(token: string): void {\n', ['function f(token: string): void {']],
    ['const key = x\n', ['const key = x']],
    ['Key points: small diff\n', ['Key points: small diff']],
    ['Press the hotkey: ctrl-s\n', ['Press the hotkey: ctrl-s']],
    ['FAIL src/auth/login.test.ts > auth: rejects bad login\n', ['FAIL src/auth/login.test.ts > auth: rejects bad login']],
    ['foo(key, value)\n', ['foo(key, value)']],
    ['Tests: 3 passed\n', ['Tests: 3 passed']],
    ['The test failed on the monkey\nNext sentence stays visible\n', ['The test failed on the monkey', 'Next sentence stays visible']],
    ['I found the API key\nNext sentence stays visible\n', ['I found the API key', 'Next sentence stays visible']],
    ['password:\nthese are several words\n', ['password:', REDACTED]],
    ['bypass: yes\n', ['bypass: yes']],
    ['Bearer of bad news\n', ['Bearer of bad news']],
  ];
  for (const [text, expected] of harmless) it(`leaves alone: ${text.split('\n')[0]}`, () => { expect(run(text)).toEqual(expected); });
});

describe('the terminal upload schema', () => {
  const lease = { attemptId: 'a', fence: 1, leaseToken: 't' };
  it('accepts a bounded batch and refuses more', () => {
    expect(TerminalUploadRequestSchema.safeParse({ lease, seq: 0, lines: [{ at: '2026-11-09T00:00:00.000Z', text: 'hi' }], dropped: 0, ended: false }).success).toBe(true);
    expect(TerminalUploadRequestSchema.safeParse({ lease, seq: 0, lines: Array.from({ length: 101 }, () => ({ at: '2026-11-09T00:00:00.000Z', text: 'x' })), dropped: 0, ended: false }).success).toBe(false);
  });
});
