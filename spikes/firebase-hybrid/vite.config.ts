import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // The fixture lives at <repo>/docs/demo; allow the dev server to read it.
  server: { fs: { allow: [resolve(__dirname, "../..")] } },
});
