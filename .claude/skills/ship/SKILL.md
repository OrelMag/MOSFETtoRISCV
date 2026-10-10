---
name: ship
description: Merge the current feature branch into main and deploy (GitHub Pages), following CLAUDE.md's git workflow. Use when the user says "merge", "merge and deploy", "ship it" or approves a merge offer.
---

Merging deploys the site. Work from the branch's own worktree, never from the shared checkout
(`E:\MOSFET to RISCV`).

1. **Authorization.** Merge only if the user approved this branch in this conversation (or a standing
   authorization in memory covers it). If their reply was terse ("go ahead", "3"), first restate in one
   line what you are about to do: "Merging feat/x into main and deploying."
2. **Up to date.** In the worktree: `git fetch origin && git merge origin/main` (rebase only if the branch
   was never pushed). Resolve conflicts; flag anything ambiguous instead of guessing.
3. **Gate** (all must pass; on failure stop and report the output, do not merge):
   - `node node_modules/vitest/vitest.mjs run`
   - `node node_modules/typescript/bin/tsc --noEmit -p .`
   - `node node_modules/vite/bin/vite.js build`
   - if `src/sim/svexport.ts`, `src/sim/vexport.ts`, `src/sim/verilog.ts`, `src/lib/multicore.ts` or
     `src/lib/mpdecode.ts` changed: `node node_modules/vite-node/vite-node.mjs scripts/verify-export.ts all`
     (needs `pip install yowasp-yosys`; say so if unavailable)
   - visual change: a light and a dark screenshot from `vite preview --port <free port> --strictPort`.
4. **Push the branch** (`git push origin <branch>`).
5. **Merge without touching the shared checkout:**
   `git checkout --detach origin/main && git merge --no-ff <branch> -m "Merge: <summary>"` then
   `git push origin HEAD:main`. If the push is rejected (main moved): `git fetch`, redo step 5 from the
   new `origin/main`, and re-run the gate if the new commits touch the same areas.
   Then `git checkout <branch>` again in the worktree.
6. **Watch the deploy:** `gh run list --workflow deploy.yml --limit 1`, then `gh run watch <id> --exit-status`
   (gh is at `C:\Program Files\GitHub CLI`). On failure, report the failing job's log.
7. **Report** the merge commit, the deploy result and https://orelmag.github.io/MOSFETtoRISCV/ (the footer's
   build number is the commit count of main).

Never delete branches on GitHub, never force-push main, never use `--no-verify`. Removing the local
worktree is optional and only after the push: `cmd /c rmdir <worktree>\node_modules` (the junction)
first, then `git worktree remove <worktree>`.
