import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export interface FeedbackItem {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'planned' | 'done';
  createdAt: string;
}

export const SEED_ITEMS = JSON.parse(
  readFileSync(join(here, '../fixtures/feedback-fixtures.json'), 'utf8'),
).items as FeedbackItem[];

function appDir(): string {
  const dir = process.env.VERIFY_APP_DIR;
  if (!dir) throw new Error('VERIFY_APP_DIR is not set (the runner provides the built candidate copy)');
  return resolve(dir);
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

/** One candidate app process bound to a fresh per-case SQLite file. restart() reuses the same file. */
export class AppUnderTest {
  readonly dbPath: string;
  readonly seedFile: string | null;
  port = 0;
  private proc: ChildProcess | null = null;
  private log = '';

  constructor(opts: { seed: boolean }) {
    const base = process.env.VERIFY_RUN_DIR ?? tmpdir();
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, 'case-'));
    this.dbPath = join(dir, 'feedback.sqlite');
    if (opts.seed) {
      this.seedFile = join(dir, 'seed.json');
      writeFileSync(this.seedFile, JSON.stringify({ items: SEED_ITEMS }, null, 2));
    } else {
      this.seedFile = null;
    }
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.port === 0) this.port = await freePort(); // restarts keep the port so open browser pages stay valid
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      PORT: String(this.port),
      FEEDBACK_DB_PATH: this.dbPath,
    };
    if (this.seedFile) env.FEEDBACK_SEED_FILE = this.seedFile;
    this.log = '';
    const proc = spawn('pnpm', ['start'], { cwd: appDir(), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    const append = (b: Buffer) => {
      this.log = (this.log + b.toString()).slice(-4000);
    };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    let exited: number | null | undefined;
    proc.once('exit', (code) => {
      exited = code ?? -1;
    });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (exited !== undefined) throw new Error(`app exited with code ${exited} before becoming healthy\n${this.log}`);
      try {
        const r = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(1000) });
        if (r.status === 200) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    await this.stop();
    throw new Error(`app did not become healthy within 45s\n${this.log}`);
  }

  /** Really stops the process tree (SIGKILL: no graceful-shutdown help for durability). */
  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.pid === undefined) return;
    const done = new Promise<void>((r) => {
      if (proc.exitCode !== null || proc.signalCode !== null) r();
      else proc.once('exit', () => r());
    });
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
    // the grandchild listening socket can outlive the parent by a moment
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(300) });
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export function api(app: AppUnderTest) {
  async function call(method: string, path: string, body?: unknown, raw?: string): Promise<ApiResult> {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }
  return {
    list: (status?: string) => call('GET', `/api/feedback${status === undefined ? '' : `?status=${encodeURIComponent(status)}`}`),
    create: (payload: unknown) => call('POST', '/api/feedback', payload),
    patch: (id: string, payload: unknown) => call('PATCH', `/api/feedback/${encodeURIComponent(id)}`, payload),
  };
}
