import { describe, expect, it } from 'vitest';
import { createDb, sql } from '@selarikru/persistence';
import { loadDefaultPolicy } from '@selarikru/policy/load';
import { main, type Io } from '../src/cli.ts';
import { dryRunHarness, scriptedVerifier } from '../src/workers/dry-run.ts';
import { benchSchemaName, openStack, sweepBenchSchemas } from '../src/workers/stack.ts';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://selarikru_test:selarikru_test@127.0.0.1:54329/selarikru_test';

async function schemas(names: readonly string[]): Promise<string[]> {
  const admin = createDb(DATABASE_URL, { max: 1 });
  try {
    const rows = await admin.db.execute(sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`);
    return rows.map((r) => String(r['schema_name'])).sort();
  } finally {
    await admin.close();
  }
}

async function exec(statement: string): Promise<void> {
  const admin = createDb(DATABASE_URL, { max: 1 });
  try { await admin.db.execute(sql.raw(statement)); } finally { await admin.close(); }
}

describe('M1 bench schemas', () => {
  it('openStack drops its schema when anything after creating it fails', async () => {
    let made: string | null = null;
    await expect(openStack({
      databaseUrl: DATABASE_URL, repoPath: '/nonexistent', artifactDir: '/nonexistent/a', integrationDir: '/nonexistent/i', verificationDir: '/nonexistent/v', now: () => new Date(),
      ...dryRunHarness('2.1.0'), policy: loadDefaultPolicy(), verifierRunner: scriptedVerifier(), verifierHost: 'x', repository: 'a/b',
      attemptTimeoutSeconds: 0, driverIntervalMs: 50, onSchema: (name) => { made = name; },
    })).rejects.toThrow();
    expect(made).toMatch(/^bench_/);
    expect(await schemas([made!])).toEqual([]);
  }, 30_000);

  it('sweep-schemas drops only bench_ schemas older than the threshold, never another schema or a name whose age it cannot read', async () => {
    const old = benchSchemaName(Date.now() - 3 * 86_400_000);
    const fresh = benchSchemaName(Date.now());
    const unreadable = `bench_${'a'.repeat(12)}`;
    const other = `t_sweepkeep${Date.now().toString(36)}`;
    for (const s of [old, fresh, unreadable, other]) await exec(`CREATE SCHEMA ${s}`);
    try {
      const dropped = await sweepBenchSchemas(DATABASE_URL, { olderThanMs: 86_400_000 });
      expect(dropped).toContain(old);
      expect(dropped).not.toContain(fresh);
      expect(await schemas([old, fresh, unreadable, other, 'public'])).toEqual([fresh, other, 'public', unreadable].sort());
      // The command form: needs DATABASE_URL, prints only counts.
      const lines: string[] = [];
      const io: Io = { out: (s) => lines.push(s), err: (s) => lines.push(s), env: { DATABASE_URL }, now: () => new Date().toISOString() };
      expect(await main(['sweep-schemas', '--older-than-hours', '1000'], io)).toBe(0);
      expect(lines.join('\n')).toMatch(/Dropped \d+ stale bench_ schema/);
      expect(lines.join('\n')).not.toContain('selarikru_test:');
      expect(await main(['sweep-schemas', '--older-than-hours', '1'], { ...io, env: {} })).toBe(2);
      // m4: a floor of 2 hours, so no schema of a trial that could still be running is ever dropped.
      expect(await main(['sweep-schemas', '--older-than-hours', '1.5'], io)).toBe(2);
      await expect(sweepBenchSchemas(DATABASE_URL, { olderThanMs: 3_600_000 })).rejects.toThrow(/2 h/);
    } finally {
      for (const s of [old, fresh, unreadable, other]) await exec(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    }
  }, 30_000);
});
