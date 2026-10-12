// Builds the portable Windows program: stages ../dist (stage.mjs), then packs it with electron-builder
// into release/MOSFET-to-RISCV-<version>-portable.exe, one file that runs without installing anything.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { build, Platform } from 'electron-builder';
import './stage.mjs';

// The site's version (vite.config.ts): major.minor from the root package.json, the commit count as the build.
const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [major, minor] = root.version.split('.').map(Number);
let count = 0;
try { count = Number(execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { /* no git */ }
const version = `${major}.${minor}.${count}`;

await build({
  targets: Platform.WINDOWS.createTarget(['portable'], 1 /* x64 */),
  config: {
    appId: 'io.github.orelmag.mosfettoriscv',
    productName: 'MOSFET to RISC-V',
    copyright: '© OrelMag',
    extraMetadata: { version },
    directories: { output: 'release' },
    compression: 'maximum',
    electronLanguages: ['en-US'], // Chromium's UI strings: the site is in English
    files: ['main.cjs', 'icon.png', 'app/**/*'],
    // A program, never a Node runtime: ignore ELECTRON_RUN_AS_NODE (set by VS Code and other Electron hosts),
    // NODE_OPTIONS and --inspect, and load only the packed app.
    electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true },
    win: { icon: 'icon.png' },
    portable: { artifactName: 'MOSFET-to-RISCV-${version}-portable.exe' },
    publish: null, // the desktop workflow publishes the release itself
  },
});
