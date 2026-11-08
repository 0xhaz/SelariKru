import { type ChildProcess, spawn } from 'node:child_process';
import { lchownSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateProcessCount, candidateProcessListing, killCandidateProcesses } from './killcand.ts';

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

/** True if something accepts TCP connections on the port. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (v: boolean) => { sock.destroy(); res(v); };
    sock.setTimeout(500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
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
      writeFileSync(this.seedFile, JSON.stringify({ items: SEED_ITEMS }, null, 2), { mode: 0o644 });
    } else {
      this.seedFile = null;
    }
    // The parent (VERIFY_RUN_DIR) is root-owned, so the candidate cannot swap this fresh directory for a symlink.
    // Hand the directory itself to the unprivileged app user only after root has written everything it needs.
    if (process.env.VERIFY_CAND_UID) lchownSync(dir, Number(process.env.VERIFY_CAND_UID), Number(process.env.VERIFY_CAND_GID));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const ids = AppUnderTest.candidateIds();
    if (ids && AppUnderTest.live === 0 && candidateProcessCount(ids.uid) !== 0) AppUnderTest.fatal(`candidate processes survived into the next case: ${candidateProcessListing(ids.uid)}`);
    if (this.port === 0) this.port = await freePort(); // restarts keep the port so open browser pages stay valid
    // a previous process (or a survivor of it) must not be mistaken for the one we are about to start
    if (await portOpen(this.port)) throw new Error(`port ${this.port} is already accepting connections before start; refusing to treat an old process as the new one`);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.VERIFY_CAND_HOME ?? process.env.HOME,
      NODE_ENV: 'production',
      PORT: String(this.port),
      FEEDBACK_DB_PATH: this.dbPath,
    };
    if (this.seedFile) env.FEEDBACK_SEED_FILE = this.seedFile;
    this.log = '';
    const proc = spawn('pnpm', ['start'], { cwd: appDir(), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...(process.env.VERIFY_CAND_UID ? { uid: Number(process.env.VERIFY_CAND_UID), gid: Number(process.env.VERIFY_CAND_GID) } : {}) });
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
        if (r.status === 200) {
          AppUnderTest.live++;
          this.counted = true;
          return;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    await this.stop().catch(() => undefined);
    throw new Error(`app did not become healthy within 45s\n${this.log}`);
  }

  private static live = 0;
  private counted = false;

  /**
   * Fail closed: if candidate processes cannot be stopped, record a fatal marker (the runner turns it into `error` for
   * every FB-ID) and fail the case.
   */
  private static fatal(message: string): never {
    const dir = process.env.VERIFY_REPORT_DIR;
    if (dir) writeFileSync(join(dir, 'fatal.txt'), message);
    throw new Error(`verifier fatal: ${message}`);
  }

  private static candidateIds(): { uid: number; gid: number } | null {
    return process.env.VERIFY_CAND_UID ? { uid: Number(process.env.VERIFY_CAND_UID), gid: Number(process.env.VERIFY_CAND_GID) } : null;
  }

  /** Between cases nothing the candidate started may still be running (daemons that left the process group). */
  private static killCandidateUser() {
    const c = AppUnderTest.candidateIds();
    if (!c) return;
    try {
      killCandidateProcesses(c.uid, c.gid);
    } catch (e) {
      AppUnderTest.fatal((e as Error).message);
    }
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
    // the listener must really be gone; a process that escaped the group (setsid, fork) would keep serving old data
    let survived = true;
    for (let i = 0; i < 50 && survived; i++) {
      survived = await portOpen(this.port);
      if (survived) await new Promise((r) => setTimeout(r, 100));
    }
    if (this.counted) AppUnderTest.live--;
    this.counted = false;
    if (AppUnderTest.live === 0) AppUnderTest.killCandidateUser(); // report the survivor first (below), but never leave it running into the next case
    if (survived) throw new Error(`app still accepts connections on port ${this.port} after SIGKILL of its process group; it did not really stop`);
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
