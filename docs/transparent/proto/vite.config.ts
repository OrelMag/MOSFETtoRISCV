// The prototype's own build (never part of the site): node node_modules/vite/bin/vite.js build --config docs/transparent/proto/vite.config.ts
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'docs/transparent/proto',
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('../../../src', import.meta.url)) } },
  define: { __APP_VERSION__: '"proto"', __APP_COMMIT__: '"proto"', __APP_DATE__: '"proto"' },
  build: { target: 'es2022', outDir: '../../../.proto-dist', emptyOutDir: true, chunkSizeWarningLimit: 100000 },
});
