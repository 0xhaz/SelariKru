import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Starts a Firebase Auth Emulator through the firebase CLI for one test file. Test files run in parallel, so nothing here may be shared between them:
 *
 * - Each file passes its own project ID. The CLI keeps one hub locator per project (`<tmpdir>/hub-<project>.json`), and a second emulator for the same project
 *   only warns about it, but separate IDs keep the files from ever depending on that file.
 * - Every port the suite would otherwise choose is set. The CLI starts a Logging Emulator on 4500 even with the UI off, and when two suites start together
 *   both probe 4500, one falls back to 4501 and the other can crash with EADDRINUSE. That crash is what made these tests flaky.
 * - The ports are drawn together, all held open until every one is known, so none is handed out twice.
 */
async function freePorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    return await Promise.all(Array.from({ length: count }, () => new Promise<number>((resolve, reject) => {
      const s = createServer();
      servers.push(s);
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
    })));
  } finally {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}

export interface AuthEmulator {
  readonly host: string;
  stop(): void;
}

export async function startAuthEmulator(projectId: string, timeoutMs = 60_000): Promise<AuthEmulator> {
  const [port, hub, logging] = await freePorts(3) as [number, number, number];
  const dir = mkdtempSync(join(tmpdir(), `${projectId}-emulator-`));
  const loopback = '127.0.0.1';
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({
    emulators: { auth: { host: loopback, port }, hub: { host: loopback, port: hub }, logging: { host: loopback, port: logging }, ui: { enabled: false } },
  }));
  const logPath = join(dir, 'emulator.log');
  const fd = openSync(logPath, 'w');
  const child = spawn('firebase', ['emulators:start', '--only', 'auth', '--project', projectId], { cwd: dir, stdio: ['ignore', fd, fd], detached: true });
  closeSync(fd);
  let exited: number | null | undefined;
  child.once('exit', (code) => { exited = code; });
  const host = `${loopback}:${port}`;
  const stop = (): void => {
    if (child.pid === undefined || exited !== undefined) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  };
  for (const end = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, 300))) {
    try { if ((await fetch(`http://${host}/`)).ok) return { host, stop }; } catch { /* not up yet */ }
    if (exited !== undefined || Date.now() > end) {
      stop();
      const tail = readFileSync(logPath, 'utf8').split('\n').slice(-15).join('\n');
      throw new Error(`Auth Emulator ${exited !== undefined ? `exited with ${exited}` : 'did not start'} (project ${projectId}, ${host}):\n${tail}`);
    }
  }
}
