import { execFile } from 'node:child_process';

/**
 * D6: local benchmarks use the owner's existing Claude Code CLI login, not an API key. This is the read-only check
 * preflight needs in `cli_login` mode: `claude auth status --json`, of which only the `loggedIn` flag is kept. The
 * rest of its output (account, organisation, method) is never returned, logged or printed, and no token is read.
 * Tests inject the exec function; they never run the CLI.
 */

export interface CliLoginStatus {
  /** The `claude` CLI is installed and answered. */
  readonly present: boolean;
  /** Logged in, not logged in, or null when the answer could not be read. */
  readonly loggedIn: boolean | null;
}

export type CliLoginProbe = () => Promise<CliLoginStatus>;

export type StatusExec = (file: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly code: number }>;

const defaultExec: StatusExec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 20_000, maxBuffer: 64 * 1024, env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' } }, (err, stdout) => {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err);
    resolve({ stdout: String(stdout), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
  });
});

export function claudeCliLoginProbe(exec: StatusExec = defaultExec): CliLoginProbe {
  return async () => {
    let out: { stdout: string; code: number };
    try {
      out = await exec('claude', ['auth', 'status', '--json']);
    } catch (e) {
      return { present: (e as NodeJS.ErrnoException | null)?.code !== 'ENOENT', loggedIn: null };
    }
    try {
      const v = (JSON.parse(out.stdout) as { loggedIn?: unknown }).loggedIn;
      return { present: true, loggedIn: typeof v === 'boolean' ? v : null };
    } catch {
      return { present: true, loggedIn: null };
    }
  };
}
