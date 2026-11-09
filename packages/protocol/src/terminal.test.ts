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

describe('prompts without a newline', () => {
  it('releases an ordinary prompt', () => {
    const r = new TerminalRedactor();
    r.write('Continue? ');
    expect(r.releasePrompt()).toBe('Continue? ');
    expect(r.write('y\nnext\n')).toEqual(['y', 'next']);
  });

  it('a prompt naming a credential goes out with echo on too, and the next line, where echo prints the value, is hidden', () => {
    const r = new TerminalRedactor();
    r.write('Database password: ');
    expect(r.releasePrompt()).toBe('Database password: ');
    expect(r.write('two tokens\nvisible\n')).toEqual(['[REDACTED]', 'visible']);
    const key = new TerminalRedactor();
    key.write('api_key: ');
    expect(key.releasePrompt()).toBe('api_key: ');
    expect(key.write('two tokens\n')).toEqual(['[REDACTED]']);
  });

  it('with echo off a credential prompt goes out and nothing after it is hidden, because the value is not printed', () => {
    const r = new TerminalRedactor();
    r.write('Database password: ');
    expect(r.releasePrompt(true)).toBe('Database password: ');
    expect(r.write('Connected\n')).toEqual(['Connected']);
  });

  it('an unknown echo state is treated as echo on', () => {
    const r = new TerminalRedactor();
    r.write('Password: ');
    expect(r.releasePrompt(false)).toBe('Password: ');
    expect(r.write('hunter2\n')).toEqual(['[REDACTED]']);
  });

  it('a prompt of the form "password for someone" names a credential even though it ends in another word', () => {
    const sudo = new TerminalRedactor();
    sudo.write('[sudo] password for haz: ');
    expect(sudo.releasePrompt()).toBe('[sudo] password for haz: ');
    expect(sudo.write('typed-value\n')).toEqual(['[REDACTED]']);
    const ssh = new TerminalRedactor();
    ssh.write("Enter passphrase for key '/home/u/.ssh/id_ed25519': ");
    expect(ssh.releasePrompt(true)).toBe("Enter passphrase for key '/home/u/.ssh/id_ed25519': ");
    expect(ssh.write('done\n')).toEqual(['done']);
    const ordinary = new TerminalRedactor();
    ordinary.write('Waiting for input: ');
    expect(ordinary.releasePrompt()).toBe('Waiting for input: ');
    expect(ordinary.write('yes\n')).toEqual(['yes']);
  });

  it("releases git's prompts, whose URL is already closed by a quote", () => {
    const user = new TerminalRedactor();
    user.write("Username for 'https://github.com': ");
    expect(user.releasePrompt()).toBe("Username for 'https://github.com': ");
    expect(user.write('octocat\n')).toEqual(['octocat']);
    const pass = new TerminalRedactor();
    pass.write("Password for 'https://octocat@github.com': ");
    expect(pass.releasePrompt(true)).toBe("Password for 'https://[REDACTED]@github.com': ");
    expect(pass.write('remote: ok\n')).toEqual(['remote: ok']);
    const passEchoed = new TerminalRedactor();
    passEchoed.write("Password for 'https://octocat@github.com': ");
    expect(passEchoed.releasePrompt()).toBe("Password for 'https://[REDACTED]@github.com': ");
    expect(passEchoed.write('hunter2\n')).toEqual(['[REDACTED]']);
    const double = new TerminalRedactor();
    double.write('Open "https://example.com/a"? ');
    expect(double.releasePrompt()).toBe('Open "https://example.com/a"? ');
  });

  it('a space after the URL closes it too: what follows a space was never part of its redaction', () => {
    const r = new TerminalRedactor();
    r.write('see https://admin: ');
    expect(r.releasePrompt()).toBe('see https://admin: ');
    expect(redactTerminalText('see https://admin: s3cretpw@db.example.com/x')).toContain('s3cretpw');
  });

  it('never shows part of a credential across a pause', () => {
    const url = new TerminalRedactor();
    url.write('https://admin:');
    expect(url.releasePrompt(true)).toBeNull();
    const out = url.write('s3cretpw@db.example.com/x\n').join('\n');
    expect(out).not.toContain('s3cretpw');
    const quoteless = new TerminalRedactor();
    quoteless.write('curl https://admin:secret?');
    expect(quoteless.releasePrompt(true)).toBeNull();
    const pair = new TerminalRedactor();
    pair.write('API_KEY=abc123');
    expect(pair.releasePrompt()).toBeNull();
    expect(pair.write('def456\n')).toEqual(['API_KEY=[REDACTED]']);
    const valued = new TerminalRedactor();
    valued.write('password=abc: ');
    expect(valued.releasePrompt(true)).toBeNull();
  });

  it('a prompt with no trailing space goes out only with echo off, and only one that ends like a question', () => {
    const on = new TerminalRedactor();
    on.write('Password:');
    expect(on.releasePrompt()).toBeNull();
    const off = new TerminalRedactor();
    off.write('Password:');
    expect(off.releasePrompt(true)).toBe('Password:');
    expect(off.write('\nok\n')).toEqual(['', 'ok']);
    const progress = new TerminalRedactor();
    progress.write('[12/40]');
    expect(progress.releasePrompt(true)).toBeNull();
  });

  it('holds what does not look like a prompt, or is too long to be one', () => {
    const r = new TerminalRedactor();
    r.write('downloading 40');
    expect(r.releasePrompt()).toBeNull();
    const noSpace = new TerminalRedactor();
    noSpace.write('name:');
    expect(noSpace.releasePrompt()).toBeNull();
    const long = new TerminalRedactor();
    long.write(`${'x'.repeat(400)}: `);
    expect(long.releasePrompt()).toBeNull();
  });

  it('never releases while a private key is withheld', () => {
    const r = new TerminalRedactor();
    r.write('-----BEGIN PRIVATE KEY-----\nabc: ');
    expect(r.releasePrompt()).toBeNull();
  });
});
