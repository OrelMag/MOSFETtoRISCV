// Builds the portable Windows program: stages ../dist (stage.mjs), then packs it with electron-builder
// into release/MOSFET-to-RISCV-<site version>-portable.exe, one file that runs without installing anything.
import { existsSync, readFileSync } from 'node:fs';
import { build, Platform } from 'electron-builder';
import { versionOf } from '../scripts/version.mjs';
import './stage.mjs';

// The version of the site this program carries, read from its own build (dist/sw.js: VERSION = '<X.YYY.ZZZ>-<commit>'), so
// the file name shows exactly what the footer inside shows even when dist/ was built at another commit; without it, the
// same formula here (scripts/version.mjs). Windows' file properties need a semver without leading zeros: X.Y.ZZZ of the
// same numbers.
const sw = new URL('../dist/sw.js', import.meta.url);
const stamped = existsSync(sw) ? /const VERSION = '(\d+)\.(\d+)\.(\d+)-[^']*'/.exec(readFileSync(sw, 'utf8')) : null;
const v = stamped
  ? { site: `${stamped[1]}.${stamped[2]}.${stamped[3]}`, semver: `${Number(stamped[1])}.${Number(stamped[2])}.${Number(stamped[3])}` }
  : versionOf(new URL('../', import.meta.url));
const version = v.semver;

await build({
  targets: Platform.WINDOWS.createTarget(['portable'], 1 /* x64 */),
  config: {
    appId: 'io.github.orelmag.mosfettoriscv',
    productName: 'From Switch to CPU',
    copyright: '© Orel Magidish',
    extraMetadata: { version },
    directories: { output: 'release' },
    compression: 'maximum',
    electronLanguages: ['en-US'], // Chromium's UI strings: the site is in English
    files: ['main.cjs', 'icon.png', 'app/**/*'],
    // A program, never a Node runtime: ignore ELECTRON_RUN_AS_NODE (set by VS Code and other Electron hosts),
    // NODE_OPTIONS and --inspect, and load only the packed app.
    electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true },
    win: { icon: 'icon.png' },
    portable: { artifactName: `MOSFET-to-RISCV-${v.site}-portable.exe` },
    publish: null, // the desktop workflow publishes the release itself
  },
});
