import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { cspMeta } from './src/build/csp.ts';
import { hostedEnvGuard } from './src/build/hosted.ts';

// The test harness page (tests/harness) is served by the dev server only. It is not a build input,
// so fakes never reach the production bundle. bench.html is the benchmark bench page (Track A): it is a build input
// only when VITE_BENCH_PAGE=1, for the owner's benchmark deploy, and never in a default production build.
export function benchBuildInput(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return {
    main: fileURLToPath(new URL('./index.html', import.meta.url)),
    ...(env['VITE_BENCH_PAGE'] === '1' ? { bench: fileURLToPath(new URL('./bench.html', import.meta.url)) } : {}),
  };
}

/**
 * H9: `vite build --mode hosted` (pnpm build:hosted) is the hosted demo: demo data with real Firebase AI Logic calls, into dist-hosted/. The flag is a build-time
 * constant, so the hosted root is not in the real build and the live root is not in the hosted one. Every production build fails without its env (build/hosted.ts).
 */
export default defineConfig(({ mode }) => {
  const hosted = mode === 'hosted';
  const env = { ...loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_'), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_'))) };
  return {
    // The CSP meta tag goes into the built page only (H11 fix round 2): the dev server's React refresh preamble is inline.
    plugins: [react(), tailwindcss(), cspMeta(), hostedEnvGuard(env, { hosted })],
    define: { 'import.meta.env.VITE_HOSTED_DEMO': JSON.stringify(hosted ? '1' : '') },
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { outDir: hosted ? 'dist-hosted' : 'dist', rollupOptions: { input: hosted ? benchBuildInput({}) : benchBuildInput(process.env) } },
  };
});
