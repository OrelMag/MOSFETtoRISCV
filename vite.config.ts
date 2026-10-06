/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

// Version X.YYY.ZZZ: major and minor from package.json, the build number is the git commit count
// (it grows with every merge; CI checks out the full history for it).
const git = (cmd: string, fallback: string) => {
  try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return fallback; }
};
const [major, minor] = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string).split('.').map(Number);
const build = Number(git('rev-list --count HEAD', '0'));
const version = `${major}.${String(minor).padStart(3, '0')}.${String(build).padStart(3, '0')}`;

export default defineConfig({
  // Relative base so the built site works from any sub-path (GitHub Pages, a folder on a server, ...)
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { target: 'es2022', sourcemap: true },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(git('rev-parse --short HEAD', 'dev')),
    __APP_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', setupFiles: ['tests/setup.ts'] },
});
