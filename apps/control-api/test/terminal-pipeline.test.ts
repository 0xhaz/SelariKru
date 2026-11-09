import { ClaudeHarnessAdapter, type HarnessLauncher } from '@selarikru/harness-claude';
import { initEvent } from '@selarikru/harness-claude/fixtures';
import { TERMINAL_WITHHELD_NOTICE, type LeaseRef } from '@selarikru/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_FEED_LIMITS, TerminalFeed } from '../../local-runner/src/terminal.ts';
import { TerminalHub, type TerminalSocket } from '../src/terminal.ts';

/** The whole path output takes, with nothing between the parts replaced: raw harness lines through the real adapter, the runner's feed and the API's hub, read as a browser would. */
const LEASE: LeaseRef = { attemptId: 'a', fence: 1, leaseToken: 't' };

function launcherOf(stream: readonly string[]): HarnessLauncher {
  return {
    launch: async () => ({
      lines: (async function* () { for (const l of stream) yield `${l}\n`; })(),
      stdin: { write: () => {}, end: () => {} }, kill: () => {}, exited: Promise.resolve({ code: 0, signal: null }),
    }),
    stop: async () => ({ accepted: true, detail: null }),
  };
}

async function pipeline(stream: readonly string[]): Promise<string[]> {
  const hub = new TerminalHub(() => Date.now());
  const chunks: string[] = [];
  const socket: TerminalSocket = { write: (c) => { chunks.push(c); return true; }, once: () => socket };
  hub.attach('p', 'a', socket, () => {});
  const feed = new TerminalFeed({ terminal: async (_l, b) => { hub.publish('p', 'a', b); } }, LEASE, () => {}, { ...DEFAULT_TERMINAL_FEED_LIMITS, flushMs: 1, closeMs: 1000 });
  feed.start();
  const adapter = new ClaudeHarnessAdapter(launcherOf([initEvent, ...stream]));
  for await (const ev of adapter.run({ attemptId: 'a', prompt: 'p', workspacePath: '/w', previews: { enabled: true, maxChars: 4000, raw: true } })) feed.onEvent(ev);
  await feed.close();
  hub.stop();
  return chunks.filter((c) => c.includes('event: line')).map((c) => JSON.parse(/data: (.*)/.exec(c)![1]!).text as string);
}

/** What the model said, without the lines the end of the stream adds. */
const spoken = (out: readonly string[]): string[] => out.filter((l) => !/^(?:The agent ended|Agent exited)/.test(l));
const call = (id: string, name: string, input: unknown) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const say = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const bash = (id: string, command: string, output: string) => [call(id, 'Bash', { command }), result(id, output)];

describe('plain credentials never reach the browser', () => {
  const TAIL = 'keep this line';
  const PGP = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGNtYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo\nabcdefghijklmnopqrstuvwxyz0123456789\n-----END PGP PRIVATE KEY BLOCK-----';
  const cases: readonly (readonly [string, string, readonly string[]])[] = [
    ['AWS secret in an env file format', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', ['wJalrXUtnFEMIK7']],
    ['a database URL', 'DATABASE_URL=postgres://admin:s3cretpass@db.internal:5432/app', ['s3cretpass']],
    ['a word-only password', 'DB_PASSWORD=correcthorsebattery', ['correcthorsebattery']],
    ['API_KEY with no digits', 'API_KEY=plainvalueonly', ['plainvalueonly']],
    ['SESSION_SECRET', 'SESSION_SECRET=keyboardcat', ['keyboardcat']],
    ['a service key in hex', 'MY_SERVICE_KEY=deadbeefcafe0123', ['deadbeefcafe0123']],
    ['a Slack webhook', 'posting to https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXXXXXX now', ['XXXXXXXXXXXX', 'hooks.slack.com/services']],
    ['a Discord webhook', 'https://discord.com/api/webhooks/1234567/abcDEFghi', ['abcDEFghi']],
    ['curl -u user:pass', 'curl -u admin:hunter2 https://example.com/', ['hunter2']],
    ['URL userinfo', 'cloning https://admin:hunter2@example.com/repo.git', ['hunter2']],
    ['--password with a space', 'deploy --password hunter2 --region eu', ['hunter2']],
    ['mysql -p', 'mysql -h db -uroot -phunter2 appdb', ['hunter2']],
    ['a YAML block', `password: |\n  first-secret-line\n  second-secret-line`, ['first-secret-line', 'second-secret-line']],
    ['a name with no separator, the value on the next line', 'password\nhunter2value', ['hunter2value']],
    ['a PGP private key', PGP, ['lQOYBGNt', 'abcdefghijklmn']],
  ];
  for (const [name, text, secrets] of cases) {
    it(`in a tool result: ${name}`, async () => {
      const out = await pipeline(bash('u1', 'cat config.txt', `${text}\n${TAIL}`));
      for (const s of secrets) expect(out.join('\n')).not.toContain(s);
      expect(out).toContain(TAIL);
    });
    it(`in model text: ${name}`, async () => {
      const out = await pipeline([say(`${text}\n${TAIL}`)]);
      for (const s of secrets) expect(out.join('\n')).not.toContain(s);
    });
  }

  it('in a command line: the tool call itself is redacted', async () => {
    for (const command of ['curl -u admin:hunter2 https://x/', 'mysql -phunter2 db', 'deploy --password hunter2', 'API_KEY=hunter2 ./run', 'git clone https://me:hunter2@host/r']) {
      const out = await pipeline(bash('u1', command, 'done'));
      expect(out.join('\n')).not.toContain('hunter2');
      expect(out).toContain('done');
    }
  });
});

describe('results that are withheld whole', () => {
  const VALUE = 'ZZZ-plain-value';
  const cases: readonly (readonly [string, string, unknown])[] = [
    ['cat .env', 'Bash', { command: 'cat .env' }],
    ['cat .env.production', 'Bash', { command: 'cat ./config/.env.production' }],
    ['env', 'Bash', { command: 'env' }],
    ['env piped', 'Bash', { command: 'env | sort' }],
    ['printenv', 'Bash', { command: 'printenv' }],
    ['printenv NAME', 'Bash', { command: 'printenv SOME_VALUE' }],
    ['Read .env', 'Read', { file_path: '/w/.env' }],
    ['Read a key file', 'Read', { file_path: '/w/certs/server.key' }],
    ['Read an SSH key', 'Read', { file_path: '/home/me/.ssh/id_ed25519' }],
    ['Read AWS credentials', 'Read', { file_path: '/home/me/.aws/credentials' }],
    ['a service account', 'Bash', { command: 'cat service-account.json | jq .' }],
    ['a pem by Grep', 'Grep', { pattern: 'BEGIN', path: 'certs/tls.pem' }],
  ];
  for (const [name, tool, input] of cases) {
    it(name, async () => {
      const out = await pipeline([call('u1', tool, input), result('u1', VALUE), ...bash('u2', 'ls', 'ordinary')]);
      expect(out.join('\n')).not.toContain(VALUE);
      expect(out).toContain(TERMINAL_WITHHELD_NOTICE);
      expect(out).toContain('ordinary');
    });
  }

  it('an env prefix on a command does not withhold its output', async () => {
    expect(await pipeline(bash('u1', 'env NODE_ENV=test pnpm test', 'all passed'))).toContain('all passed');
  });
});

describe('private keys and long text through the whole path', () => {
  const body = (n: number) => Array.from({ length: n }, (_, i) => `QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5${String(i).padStart(4, '0')}`).join('\n');

  it('a 120-line key, cut by the preview limit, costs only itself: the tool calls after it still show', async () => {
    const out = await pipeline([...bash('k', 'cat tls.txt', `-----BEGIN RSA PRIVATE KEY-----\n${body(120)}\n-----END RSA PRIVATE KEY-----`), ...Array.from({ length: 30 }, (_, i) => bash(`u${i}`, `echo step-${i}`, `result-${i}`)).flat()]);
    expect(out.join('\n')).not.toContain('QUJDREVGR0hJ');
    expect(out.filter((l) => l.startsWith('[private key withheld'))).toHaveLength(1);
    expect(out.find((l) => l.startsWith('[private key withheld'))).toMatch(/\[private key withheld, \d+ lines\]/);
    for (let i = 0; i < 30; i += 1) { expect(out).toContain(`> Bash echo step-${i}`); expect(out).toContain(`result-${i}`); }
  });

  it('a grep hit on the BEGIN line does not swallow what follows the result', async () => {
    const out = await pipeline([...bash('g', 'grep -rn BEGIN src', 'src/a.txt:3:-----BEGIN PRIVATE KEY-----\nsrc/b.txt:9:other hit'), ...bash('u', 'ls', 'visible afterwards')]);
    expect(out).toContain('visible afterwards');
    expect(out.join('\n')).toContain('[private key withheld');
  });

  it('a long message arrives whole, or marked as cut', async () => {
    const long = 'word '.repeat(200).trim();
    expect(spoken(await pipeline([say(long)]))).toEqual([long]);
    const huge = 'word '.repeat(2000).trim();
    expect((await pipeline([say(huge)]))[0]).toMatch(/\[truncated\]$/);
  });

  it('consecutive messages stay separate lines, unless a secret runs across them', async () => {
    expect(spoken(await pipeline([say('First message.'), say('Second message.')]))).toEqual(['First message.', 'Second message.']);
    const SECRET = 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789';
    const split = await pipeline([say(`key ${SECRET.slice(0, 28)}`), say(`${SECRET.slice(28)} end`)]);
    expect(split.join('\n')).not.toContain(SECRET.slice(28));
    expect(split.join('\n')).not.toContain(SECRET.slice(0, 28));
  });

  it('a Write cut by the preview limit shows its path, never its content', async () => {
    const out = await pipeline([call('w', 'Write', { file_path: 'src/big.ts', content: 'FILEBODY '.repeat(1000) }), result('w', 'ok')]);
    expect(out).toContain('> Write src/big.ts');
    expect(out.join('\n')).not.toContain('FILEBODY');
  });
});
