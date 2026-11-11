import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cspMeta } from './src/build/csp.ts';

// The test harness page (tests/harness) is served by the dev server only. It is not a build input,
// so fakes never reach the production bundle. bench.html is the benchmark bench page (Track A): it is a build input
// only when VITE_BENCH_PAGE=1, for the owner's benchmark deploy, and never in a default production build.
export function benchBuildInput(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return {
    main: fileURLToPath(new URL('./index.html', import.meta.url)),
    ...(env['VITE_BENCH_PAGE'] === '1' ? { bench: fileURLToPath(new URL('./bench.html', import.meta.url)) } : {}),
  };
}

export default defineConfig({
  // The CSP meta tag goes into the built page only (H11 fix round 2): the dev server's React refresh preamble is inline.
  plugins: [react(), tailwindcss(), cspMeta()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { rollupOptions: { input: benchBuildInput(process.env) } },
});
