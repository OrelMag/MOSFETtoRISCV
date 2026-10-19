/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

// Version X.YYY.ZZZ: major and minor from package.json, the build number is the git commit count
// (it grows with every merge; CI checks out the full history for it).
const git = (cmd: string, fallback: string) => {
  try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return fallback; }
};
const [major, minor] = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string).split('.').map(Number);
const build = Number(git('rev-list --count HEAD', '0'));
const version = `${major}.${String(minor).padStart(3, '0')}.${String(build).padStart(3, '0')}`;

// Yosys in WebAssembly (@yowasp/yosys, ~78 MB) for the sandbox's Verilog chips: served beside the site as plain
// files (yosys/bundle.js and its wasm), never bundled, so nothing loads it until a Verilog chip is synthesized.
const YOSYS = fileURLToPath(new URL('./node_modules/@yowasp/yosys/gen', import.meta.url));
function yosysFiles(): Plugin {
  let outDir = 'dist';
  return {
    name: 'yosys-files',
    configResolved(c) { outDir = c.build.outDir; },
    configureServer(server) {
      server.middlewares.use('/yosys/', (req, res, next) => {
        const f = join(YOSYS, decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, ''));
        if (!f.startsWith(YOSYS) || !existsSync(f)) return next();
        res.setHeader('Content-Type', f.endsWith('.wasm') ? 'application/wasm' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        createReadStream(f).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(YOSYS)) return;
      const to = join(outDir, 'yosys');
      mkdirSync(to, { recursive: true });
      for (const f of readdirSync(YOSYS)) copyFileSync(join(YOSYS, f), join(to, f));
    },
  };
}

export default defineConfig({
  plugins: [yosysFiles()],
  // Relative base so the built site works from any sub-path (GitHub Pages, a folder on a server, ...)
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { target: 'es2022', sourcemap: true },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(git('rev-parse --short HEAD', 'dev')),
    __APP_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  test: {
    include: ['tests/**/*.test.ts'], environment: 'node', setupFiles: ['tests/setup.ts'],
    // The registry-wide sweeps (round-trip, layout, routing) take seconds per large component, more on a
    // slow runner; 30 s still catches a real hang. Explicit per-test timeouts are unchanged.
    testTimeout: 30_000,
  },
});
