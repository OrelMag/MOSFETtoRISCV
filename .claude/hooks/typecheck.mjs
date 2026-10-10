// Typecheck before Claude reports a turn done. Two entry points (see .claude/settings.json):
//   node typecheck.mjs mark   PostToolUse Edit|Write: remember the repo (main checkout or worktree) a .ts file was edited in
//   node typecheck.mjs check  Stop: `tsc --noEmit` each remembered repo; errors → exit 2, so Claude fixes them first
// Checking at the end of a turn, not after every edit, keeps a multi-file change from reporting its
// half-done state (tsc takes ~5 s here). Edits made through Bash (sed) are not seen.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const marks = join(tmpdir(), `claude-typecheck-${String(input.session_id ?? 'x').replace(/\W/g, '')}.json`);
const load = () => { try { return JSON.parse(readFileSync(marks, 'utf8')); } catch { return []; } };

if (process.argv[2] === 'mark') {
  const file = String(input.tool_input?.file_path ?? '');
  if (!/\.(ts|tsx|mts)$/.test(file)) process.exit(0);
  let top = null;
  try {
    top = execFileSync('git', ['-C', dirname(file), 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { process.exit(0); }
  const repos = load();
  if (top && !repos.includes(top)) writeFileSync(marks, JSON.stringify([...repos, top]));
  process.exit(0);
}

// check: a second stop in the same turn (stop_hook_active) lets Claude go, so a stuck fix cannot loop forever.
const repos = load();
rmSync(marks, { force: true });
if (input.stop_hook_active || !repos.length) process.exit(0);
const failures = [];
for (const top of repos) {
  const tsc = join(top, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc) || !existsSync(join(top, 'tsconfig.json'))) continue;
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', top], { cwd: top, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().split('\n');
    failures.push(`${top}: tsc --noEmit failed (${out.length} lines)\n${out.slice(0, 30).join('\n')}`);
  }
}
if (!failures.length) process.exit(0);
process.stderr.write(`${failures.join('\n\n')}\n\nFix these type errors before finishing. ` +
  'If they are in files another session is editing, say so instead of touching them.\n');
process.exit(2);
