/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { routeRules } from './scripts/routerules';
import { versionOf } from './scripts/version.mjs';

// Version X.YYY.ZZZ: major and minor from package.json, the build number is the git commit count
// (it grows with every merge; CI checks out the full history for it). scripts/version.mjs: the desktop program's file
// name is made from the same string.
const git = (cmd: string, fallback: string) => {
  try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return fallback; }
};
const version = versionOf(new URL('./', import.meta.url)).site;

// Yosys in WebAssembly (@yowasp/yosys, ~78 MB) for the sandbox's Verilog chips: served beside the site as plain
// files (yosys/bundle.js and its wasm), never bundled, so nothing loads it until a Verilog chip is synthesized.
const YOSYS = fileURLToPath(new URL('./node_modules/@yowasp/yosys/gen', import.meta.url));
function yosysFiles(): Plugin {
  let outDir = 'dist', building = false;
  return {
    name: 'yosys-files',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); building = c.command === 'build' && !process.env.VITEST; },
    configureServer(server) {
      server.middlewares.use('/yosys/', (req, res, next) => {
        const f = join(YOSYS, decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, ''));
        if (!f.startsWith(YOSYS) || !existsSync(f)) return next();
        res.setHeader('Content-Type', f.endsWith('.wasm') ? 'application/wasm' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        createReadStream(f).pipe(res);
      });
    },
    closeBundle() {
      if (!building || !existsSync(YOSYS)) return; // (vitest runs plugins too: no copy into its dummy outDir)
      const to = join(outDir, 'yosys');
      mkdirSync(to, { recursive: true });
      for (const f of readdirSync(YOSYS)) copyFileSync(join(YOSYS, f), join(to, f));
    },
  };
}

// The service worker (scripts/sw-template.js): written into dist/ after the build with a version and the list of
// everything under assets/ (source maps left out) to precache. Not written by vitest or the dev server.
function serviceWorker(): Plugin {
  let outDir = 'dist', building = false;
  const walk = (dir: string, rel = ''): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name), `${rel}${d.name}/`) : d.name.endsWith('.map') ? [] : [`${rel}${d.name}`]);
  return {
    name: 'service-worker',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); building = c.command === 'build' && !process.env.VITEST; },
    closeBundle() {
      if (!building || !existsSync(join(outDir, 'assets'))) return;
      const list = walk(join(outDir, 'assets')).map((f) => `assets/${f}`).sort();
      const src = readFileSync(fileURLToPath(new URL('./scripts/sw-template.js', import.meta.url)), 'utf8');
      writeFileSync(join(outDir, 'sw.js'), src.replace('__VERSION__', `${version}-${git('rev-parse --short HEAD', 'dev')}`).replace('__PRECACHE__', JSON.stringify(list)));
    },
  };
}

export default defineConfig({
  plugins: [yosysFiles(), serviceWorker()],
  // Relative base so the built site works from any sub-path (GitHub Pages, a folder on a server, ...)
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { target: 'es2022', sourcemap: true },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(git('rev-parse --short HEAD', 'dev')),
    __APP_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    // the route cache's rules (src/view/routecache.ts): files made by another build of the router are never used
    __ROUTE_RULES__: JSON.stringify(routeRules(fileURLToPath(new URL('.', import.meta.url)))),
  },
  test: {
    include: ['tests/**/*.test.ts'], environment: 'node', setupFiles: ['tests/setup.ts'],
    // The registry-wide sweeps (round-trip, layout, routing) take seconds per large component, more on a
    // slow runner; 30 s still catches a real hang. Explicit per-test timeouts are unchanged.
    testTimeout: 30_000,
  },
});
