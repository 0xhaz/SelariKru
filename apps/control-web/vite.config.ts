import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The test harness page (tests/harness) is served by the dev server only. It is not a build input,
// so fakes never reach the production bundle. bench.html is the benchmark bench page (Track A): the owner opens
// it in Chrome on the hosted origin, so it is a build input next to the app.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), bench: fileURLToPath(new URL('./bench.html', import.meta.url)) } } },
});
