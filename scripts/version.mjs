// The version the site's footer and the desktop program's file name show, one string for both (vite.config.ts,
// desktop/build.mjs): major and minor from the root package.json, the build number the git commit count (CI checks out
// the full history for it), padded as X.YYY.ZZZ (tests/report.test.ts pins the form).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** `git rev-list --count HEAD` in `cwd`, 0 without git. */
export function buildNumber(cwd) {
  try { return Number(execSync('git rev-list --count HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { return 0; }
}

/** { major, minor, build, site: 'X.YYY.ZZZ', semver: 'X.Y.Z' } for the repository at `root` (a directory URL or path). */
export function versionOf(root) {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const [major, minor] = pkg.version.split('.').map(Number);
  const build = buildNumber(new URL('.', root));
  return { major, minor, build, site: `${major}.${String(minor).padStart(3, '0')}.${String(build).padStart(3, '0')}`, semver: `${major}.${minor}.${build}` };
}
