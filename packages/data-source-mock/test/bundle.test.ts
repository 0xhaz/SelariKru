import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const webRoot = resolve(import.meta.dirname, '../../../apps/control-web');

/** Strings that exist only in the mock package (fixture descriptions, terminal text). If any is in built output, the mock leaked. */
const NEEDLES = ['Two workers run in parallel, one local sandbox', 'A project with no runs, tasks, workers or usage', '[demo] this is fixture text, not a real terminal', 'Feedback list UI (contract v2)'];

const out: string[] = [];
const execFileAsync = promisify(execFile);
// Vitest sets NODE_ENV=test, which would make Vite treat the build as non-production. The build runs in a child with that unset, as `pnpm build` does.
const { NODE_ENV: _ignored, VITEST: _v, VITEST_WORKER_ID: _w, ...cleanEnv } = process.env;
void _ignored; void _v; void _w;

async function buildWeb(options: { forceDev: boolean }): Promise<{ dir: string; files: string[]; text: string }> {
  const viteBin = join(webRoot, 'node_modules/vite/bin/vite.js');
  const dir = await mkdtemp(join(tmpdir(), 'selarikru-web-'));
  out.push(dir);
  if (!options.forceDev) {
    // The real check: the same command as `pnpm build` minus the typecheck, with no changes to the app's config.
    await execFileAsync(process.execPath, [viteBin, 'build', '--outDir', dir, '--emptyOutDir', '--logLevel', 'error'], { cwd: webRoot, env: cleanEnv });
  } else {
    // The positive control forces the dev flag on, which re-opens the gate, so the scan below is shown to be able to fail.
    const script = `      const vite = await import(process.argv[1]);
      await vite.build({ root: process.cwd(), configFile: 'vite.config.ts', logLevel: 'error', define: { 'import.meta.env.DEV': 'true' }, build: { outDir: process.argv[2], emptyOutDir: true } });`;
    const viteEntry = createRequire(join(webRoot, 'package.json')).resolve('vite');
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script, pathToFileURL(viteEntry).href, dir], { cwd: webRoot, env: cleanEnv });
  }
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else files.push(join(d, e.name));
    }
  };
  await walk(dir);
  const text = (await Promise.all(files.filter((f) => /\.(js|mjs|css|html|map)$/.test(f)).map((f) => readFile(f, 'utf8')))).join('\n');
  return { dir, files, text };
}

afterAll(async () => {
  await Promise.all(out.map((d) => rm(d, { recursive: true, force: true })));
});

describe('mock absent from the production bundle', () => {
  it('a production build of apps/control-web contains no mock module, fixture or demo terminal text', async () => {
    const prod = await buildWeb({ forceDev: false });
    expect(prod.files.length).toBeGreaterThan(0);
    for (const needle of NEEDLES) expect(prod.text, `production bundle contains ${JSON.stringify(needle)}`).not.toContain(needle);
    // The chunk that holds the mock is not emitted at all, not merely unreferenced.
    expect(prod.files.filter((f) => f.endsWith('.js')).every((f) => !/data-source-mock/.test(f))).toBe(true);
  });

  it('the check can fail: with the dev gate forced open the same build does contain the mock', async () => {
    const dev = await buildWeb({ forceDev: true });
    for (const needle of NEEDLES) expect(dev.text, `control build lacks ${JSON.stringify(needle)}`).toContain(needle);
    expect(dev.files.filter((f) => f.endsWith('.js')).length).toBeGreaterThan(1); // the dynamic import became its own chunk
  });
});
