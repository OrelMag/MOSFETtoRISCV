// Builds the portable Windows program: stages ../dist (stage.mjs), then packs it with electron-builder
// into release/MOSFET-to-RISCV-<site version>-portable.exe, one file that runs without installing anything.
import { build, Platform } from 'electron-builder';
import { versionOf } from '../scripts/version.mjs';
import './stage.mjs';

// The site's version (scripts/version.mjs): the file name carries the very string the site's footer shows (X.YYY.ZZZ);
// Windows' file properties need a semver without leading zeros, so the program's own version is X.Y.ZZZ of the same numbers.
const v = versionOf(new URL('../', import.meta.url));
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
