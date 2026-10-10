// PreToolUse guard for Bash / PowerShell: refuses the git commands this repo's workflow forbids
// (CLAUDE.md "Git workflow" and "Parallel sessions"). Exit 2 blocks the call; stderr tells Claude why.
//
// Anywhere: deleting a branch on a remote, force-pushing main, skipping hooks.
// In the shared checkout (the main worktree of a repo that has other worktrees, where other sessions
// work): switching branches, rewriting the tree (reset --hard, clean, stash, rebase, merge), and
// committing or pushing while it is on main. Do that work in your own `git worktree` instead.
//
// Escape hatch, only when the user explicitly asked for the command: end it with `# user-approved`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const cmd = String(input.tool_input?.command ?? '');
if (!/\bgit\b/.test(cmd) || /#\s*user-approved\s*$/m.test(cmd)) process.exit(0);

const block = (why) => {
  process.stderr.write(`Blocked by .claude/hooks/guard.mjs: ${why}\n` +
    `If the user explicitly asked for this exact command, re-run it ending with "# user-approved".\n`);
  process.exit(2);
};

// Git Bash spells E:\x as /e/x; Node wants E:/x.
const nativePath = (p) => p.replace(/^\/([a-zA-Z])(\/|$)/, (_, d, s) => `${d.toUpperCase()}:${s || '/'}`);
const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');

const git = (dir, ...args) => {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
  } catch { return null; }
};
const sharedCache = new Map();
/** The main worktree of a repo with other worktrees: other sessions may be working in it. */
const isShared = (dir) => {
  if (!sharedCache.has(dir)) {
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir');
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const trees = git(dir, 'worktree', 'list', '--porcelain');
    sharedCache.set(dir, !!gitDir && !!common && resolve(gitDir) === resolve(common) &&
      (trees?.match(/^worktree /gm)?.length ?? 0) > 1);
  }
  return sharedCache.get(dir);
};

// Walk the command's segments, following cd / Set-Location / pushd, so `cd E:/wt && git switch x` is judged in E:/wt.
let cwd = input.cwd || process.cwd();
for (const raw of cmd.split(/&&|\|\||[;|\n]/)) {
  const seg = raw.trim();
  const cd = seg.match(/^(?:cd|Set-Location|sl|pushd)\s+(.+)$/i);
  if (cd) {
    const next = resolve(cwd, nativePath(unquote(cd[1].trim())));
    if (existsSync(next)) cwd = next;
    continue;
  }
  const m = seg.match(/(?:^|\s)git((?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--?[\w-]+(?:=\S+)?)*)\s+([\w-]+)(.*)$/);
  if (!m) continue;
  const [, opts, sub, rest] = m;
  const dashC = opts.match(/-C\s+("[^"]*"|'[^']*'|\S+)/);
  const dir = dashC ? resolve(cwd, nativePath(unquote(dashC[1]))) : cwd;
  const args = ` ${rest} `;

  if (/\s--no-verify\s/.test(args) || (sub === 'commit' && /\s-n\s/.test(args)))
    block('skipping hooks (--no-verify) is forbidden in this repo.');

  if (sub === 'push') {
    if (/\s(--delete|-d|--prune|--mirror)\s/.test(args) || /\s\+?:[\w./-]+/.test(args))
      block('branches on GitHub are never deleted; they are kept as history.');
    if (/\s(-f|--force|--force-with-lease(=\S*)?|--force-if-includes)\s/.test(args) && /(^|[\s:+/])main(\s|$)/.test(args))
      block('main is never force-pushed and its history is never rewritten.');
  }

  if (!isShared(dir)) continue;
  const where = `${dir} is the shared checkout (other Claude sessions work in it). ` +
    'Work in your own worktree: git worktree add -b <branch> E:/MOSFET-<topic> origin/main';
  if (sub === 'checkout' || sub === 'switch') block(`no ${sub} here: ${where}`);
  if (sub === 'reset' && /\s--(hard|merge|keep)\s/.test(args)) block(`no reset --hard here: ${where}`);
  if (sub === 'clean' || sub === 'stash' || sub === 'rebase') block(`no ${sub} here: ${where}`);
  if (sub === 'merge' && !/\s--ff-only\s/.test(args)) block(`no merge here (only pull / merge --ff-only): ${where}`);
  if ((sub === 'commit' || sub === 'push') && git(dir, 'branch', '--show-current') === 'main')
    block(`no ${sub} from main in the shared checkout: ${where}. ` +
      'To merge: in your worktree, git checkout --detach origin/main && git merge --no-ff <branch> && git push origin HEAD:main');
}
process.exit(0);
