# Plan: "How do you know it works?" (Phase 23)

A new chapter on how the book's hardware is checked. The first half covers **design verification**: is the design right? The second half covers **manufacturing test**: was this chip made right? Everything in the first half already exists in this repository (tests/verify/, docs/VERIFICATION.md, the Spike workflow). The chapter turns it into something the learner can watch and play with. The second half builds on the fault brush (sim/faults.ts, ONI D, merged 48736b0a) and on sim/ablate.ts.

Status: **approved by the author on 2026-11-09, as shown, with all six decisions as recommended** (mockup published as
https://claude.ai/artifact/RbNcMnUD29z9BeaK7WKeYD). Being built in three stages, each landed as its own tip:
1. Simulator and library (feat/verify-sim): sim/faultsim.ts, sim/atpg.ts, sim/march.ts, lib/dft.ts (scan), lib/bist.ts, tests.
2. The chapter (steps, widgets, tours, recap), after silicon.
3. Codex entries and the two campaign levels.

Mockup: `E:/mockups/verify/index.html` (steps 2, 9 and 11, each in light and dark).

Changes against the plan as approved, found while building stage 1:
- The 4-bit ripple adder's smallest complete test set is **3** vectors, not 4 (the exact cover finds 3; greedy needs 4).
  The full adder's is 3 too, but several 3-vector sets exist.
- A planted fault in a chapter scene uses Rock's `plantedDef(def, at, tag)` (sim/faults.ts, feat/oni-breakit, batch 7),
  not a new `Scene.faults` field (agreed with Rock). Chapter drill views read the driver's net, so a stuck wire there shows
  its healthy value (the readers get the constant). Stage 2 decides whether the stage maps its reads through `seenNets`.
- The full-scan cost is counted from the definitions (`scanCost`: flip-flops, multiplexer NANDs, chain length), not by
  rebuilding the design with scan flip-flops (`withScan`): the numbers are the same and nothing large is built. The
  pipelined CPU has **2 676** flip-flops: full scan adds 10 704 NANDs to its 68 957.
- The March test is a reference model over a memory fault model in stage 1 (sim/march.ts: March C− finds all 312 single
  faults of an 8-cell memory; writing and reading all 0s then all 1s finds 68). Its controller in gates comes with step 12
  in stage 2.
- The BIST adder's 5-bit signature lets **1** of the 90 faults escape (aliasing), which step 12 shows.

Stage 2 (the chapter, feat/verify-chapter), against the plan:
- **Placement**: `verify` after `silicon` in order.ts. The author's order is silicon → fpga → verify → sidechan; John's
  `fpga` lands later and goes in between.
- **Step 4's bug** needs no generator option: the old lost-branch bug is exactly one stuck-at fault, the `pcEn` OR's inverter
  on its taken input (`pcEn.g2` stuck at 1), planted with plantedDef. With today's generator it fails seeds 3, 15 and 42 of
  the first 64 (CI's run in 2026 saw 5 of 256 with the generator then); seed 3 shrinks from 111 instructions to 4.
- **Step 3** plants `alu.slt` stuck at 0, not the forwarding fault: the riscv-tests' own loader needs forwarding, so with that
  fault every test hangs. With the slt fault exactly slt and slti fail, at case 4.
- **Step 5** ("Make it small") is an ordinary step: `deep` is only for chapters with parts (15 steps or more).
- **Step 7** shows the "What this found" table (src/verify/data.ts, held to docs/VERIFICATION.md by a test), not a Spike log:
  Spike runs only on CI, and a log written by hand would be invented.
- **Step 12**: the March test is the reference model's numbers in the text; its controller in gates is not built.
- The drill views keep reading the driver's net (a stuck wire shows what its gate drives; the readers see the constant),
  and step 8's text says so. No change to view/.

## Placement

- **Order.** Place it in `order.ts` right after `'silicon'` and before `'lanes'`. With VM and OS approved as chapters 23 and 24 after cache, silicon becomes chapter 30 and this becomes **chapter 31**. The text never types the number (`numOf('verify')`).
- **Id and title.** Id `verify`, title "How do you know it works?", level label "Verification and test".
- **Why there.**
  - Manufacturing test needs the fab, defects and yield. "Wafers, yield and cost" is silicon's second-to-last step, so this chapter picks up exactly where that one stops: yield says how many dies are bad, and test says which ones.
  - Verification needs every CPU the book has built: single-cycle, pipeline, traps (the riscv-tests' `env/p` uses them), M, F, caches, out of order, multicore. All of them come before silicon.
  - It closes the CPU half of the book before the GPU chapters.
- **`builds`:** `cpu`, `pipeline`, `traps`, `cache`, `float`, `silicon`, `latches`.
- **Alternative:** split it in two, with verification right after `pipepay` and test after `silicon`. I don't recommend this; see decision 1.

## Goals ("In this chapter you will …")

1. Hold a CPU to a golden model instruction by instruction, and see a planted bug caught at the first instruction it changes.
2. Know what each kind of check proves and what it misses: directed tests, self-checking riscv-tests, random programs, coverage, a second oracle.
3. Model a manufacturing defect as a stuck-at fault, measure the fault coverage of a test set, and find a small test set that covers everything.
4. Make flip-flops testable with a scan chain, and let a chip test itself with an LFSR and a signature.

## Steps (13; under the 15-step `parts` threshold)

Every number below was measured on this repository on 2026-11-09 (scratch script `.tmp/atpg.ts` in the worked-examples worktree). When the chapter is built, each one is computed by the chapter itself and pinned by a test.

| # | Title | Scene / widget | What it teaches |
|---|---|---|---|
| 1 | Two questions | widget `verifyMap`: the ladder of checks (directed program → riscv-tests → random → coverage → Spike → Yosys round trip), one row per layer: its oracle, what it caught here, what it cannot catch | Verification (design right?) vs test (chip made right?); an oracle; why the CPU and the golden model by the same author can share a misreading |
| 2 | The golden model in lock step | scene: `cpuScene({ source, pipeline: true, planted })` with one planted fault (the high bit of the hazard unit's 2-bit `fwdA` stuck at 0, so forwarding from M is lost, `Scene.faults`); the CPU panel stops at the **first mismatch** (ONI B's breakpoint "stop when it differs") | Compare at every retirement, not at the end; the first difference names the instruction; drill down from there (Why?, the stage diagram) |
| 3 | Who checks the checker? riscv-tests | widget `rvTestsPanel`: pick an rv32ui test, see its source (a `TEST_RR_OP` case), run it on BitSim lanes in the browser (riscv/rvimage.ts, already used by ucodecheck), the `tohost` verdict `(n << 1) \| 1` naming the failing case; the matrix from VERIFICATION.md read from the checked-in images | Self-checking tests written by someone else check the model too; real bugs they found here: the `shamt[5]` decode and the missing `mvendorid` (VERIFICATION.md "What this found") |
| 4 | Random programs | widget `fuzzPanel`: a seed → `randomProgram32` listing, run on the gate-level pipeline beside the model, final state compared, and on a mismatch a lock-step replay to the first differing retirement | Directed tests check what the author thought of. The real find: the RV32IF pipeline lost a taken branch's target while D waited on an FP interlock, in **5 of 256 seeds**. Decision 3: how to show it |
| 5 | Make it small (deep dive) | widget: delta debugging on a failing random program (delete halves, then single instructions, while it still fails) → a 4–6 instruction reproducer | Shrinking; the failing test that comes first in every fix (CLAUDE.md's rule, shown) |
| 6 | Coverage: what did the tests reach? | widget `coverageGrid`: instructions × CPUs, plus hardware events (each forwarding path, load-use stall, flush, cache miss kinds) read off the nets, from tests/verify/coverage.ts made browser-safe | Coverage finds what was never exercised; it counts what happened, not what matters (every forwarding path fired ≠ every hazard pair met) |
| 7 | A second oracle | widget: the Spike story as a recorded log, checked in and pinned: Spike's `mret` writes `mstatush`, and ours trapped on it as illegal. Shown as a commit-by-commit diff | Two independent models; the bug the CPU and our model shared, which no lock-step test could see. Then the Yosys round trip (synthesized netlist against our simulation) in one paragraph |
| 8 | A chip comes back from the fab | scene: the 9-NAND full adder with the **fault brush** on the stage (a stuck-at on any net from a menu); its truth table with wrong rows in red | Defects (shorts, opens, particles from silicon's yield step) → the **stuck-at model**; a test is input vectors plus expected outputs, applied on a tester |
| 9 | Fault coverage | widget `faultMatrix`: the full adder's **24** stuck-at faults (12 nets × 2) × **8** vectors, a dot where the vector catches the fault; click vectors into a test set and watch coverage. Then the 4-bit ripple adder: **90** faults, **512** vectors; random vectors cover 40 / 60 / 76 / 88 / 90 of 90 after 1 / 2 / 4 / 8 / 16 | Fault simulation; coverage = detected / modelled faults; random tests' long tail |
| 10 | ATPG in miniature | widget: pick a fault, then **activate** (drive the net to the opposite value), **propagate** (sensitize a path: the other NAND inputs at 1), **justify** (back to the inputs), steps lit on the circuit. Greedy cover: **4** vectors; exact minimum: **3** (one of several 3-vector sets); the 4-bit adder: greedy **4**, smallest **3** of 512 vectors catch all 90 | Automatic test pattern generation; greedy is not optimal; a redundant net would be untestable (show one built on purpose: a consensus term) |
| 11 | Scan chains | scene: a 4-bit counter whose flip-flops are **scan flip-flops** (a 2-input mux in front of the D: `mux2` 4 NANDs + `dff` 11 = 15, **+36 %** per flip-flop); a `se` (scan enable) pin. Panel: shift a pattern in (4 clocks), one capture clock, shift the response out; a timeline of `si` / `so` | Sequential logic is hard to test; scan turns every flip-flop into an input and an output, so a sequential circuit is tested like a combinational one; the cost in NANDs and in test time (shift clocks per pattern) |
| 12 | The chip tests itself | scene: BIST around the 4-bit adder: a **9-bit LFSR** (taps 9, 5) as pattern generator and a MISR compressing the sums into a signature; a 9-bit LFSR covers 65 / 73 / 87 / **90** of 90 faults after 4 / 8 / 16 / **32** patterns; then a memory March test on the RAM of chapter `memory` | LFSRs taught here (first use: the Ethernet chapter comes later, so it is explained in place); signature aliasing ≈ 2^−k; memory BIST |
| 13 | What a CPU costs to test | widget: the pipelined CPU (**68 957** NANDs) with full scan: flip-flop count, scan NANDs, chain length → shift clocks per pattern, patterns for a coverage target, tester time per die, set against the wafer cost of silicon's yield step | Test cost is part of the chip's cost; JTAG (one paragraph); why 99 % stuck-at coverage is a common target and why it is not enough (transition faults: the fault brush's "slow") |
| recap | | `keep`, three `check` questions, `practise`: the new levels below | |

Layers (`more`): each step gets its derivation, a real-silicon note (ATE testers, scan compression, IEEE 1149.1 JTAG, 1500, the Pentium FDIV as a verification escape, formal methods as the next rung), the usual mistake, and numbers. The mechanism goes in `tour`s: step 2's mismatch, step 10's activate / propagate / justify, step 11's shift / capture / shift.

## New code (when approved)

- **`sim/faultsim.ts`**: a fault simulator over sim/faults.ts.
  - `faultList(def)`: stem faults on every NAND output and input pin (collapsed). Branch faults are an option; the step text says which.
  - `detects(def, faults, vectors)`: bit-parallel, 32 vectors a word, three-valued, as in ablate.ts.
  - `coverage`, `greedyCover`, `exactCover` (small only, within a budget, like lib/sop.ts).
  - Chip outputs are read through `seenNets`; the scratch script found that a stuck output is invisible without it.
  - Tests: equal to GateSim with `applyFaults` per fault, on the full adder and rca(4); every fault listed is detectable there.
- **`sim/atpg.ts`**: a D-algorithm small enough to explain on NAND-only netlists (activate, propagate along one path, justify by backtracking with a budget), returning the steps for the widget. Tests: every vector it returns detects its fault; it finds a test for every testable fault of the full adder, rca(4) and the 4-bit ALU; it says "untestable" for the redundant net.
- **`lib/scan.ts`**: `SCAN_DFF` (mux2 + dff, ports d, si, se, clk, q), `scanRegister(n)`, `scanCounter(n)` (the counter of chapter `registers` with its flip-flops swapped and the chain wired q → si), and `withScan(def)`, a generator that swaps every `dff` / `dffe` in a hierarchy for its scan version and threads the chain (for step 13's numbers; memoized by def id). Specs and sequence tests: shift n, capture, shift out, equal to the plain counter with `se = 0`.
- **`lib/bist.ts`**: `misr(n)`, `bistAdder(n)` (lfsr from seqparts.ts → rca(n) → misr), and `marchRam(k, w)`: a March C− controller as a small FSM around ram(k, w). Tests: the signature of the good adder; every stuck-at in the adder changes it except the computed aliasing cases (listed and counted).
- **`Scene.faults`**: planted `FlatFault`s applied after flatten (the way EditorSim applies `ChipDoc.faults`, hidden: no badge). Used by steps 2 and 8 and later by "break it" steps in the core chapters (the next roadmap item, Rock's).
- **Mismatch stop on the CPU panel**: ONI B's breakpoint "stop when it differs from the golden model" if that has landed; otherwise a `stopOnMismatch` flag in widgets/cpupanel.ts.
- **Browser-safe verification pieces**:
  - riscv/rvimage.ts already loads the images lazily, so the riscv-tests panel reuses ucodecheck's path.
  - The fuzz panel needs `randomProgram32` (DOM-free already) and a lane runner. ucodecheck's DualSim loop serves.
  - The coverage grid reads a JSON written by `scripts/coverage.ts --json` (checked in, pinned by a test like bench/results.json).
- **Spike log (step 7)**: `src/verify/spikecase.json`, a short real log of the `mstatush` case written by `scripts/spike-oracle.ts --out` on CI and checked in. A test checks it still parses and that our model now agrees.
- **Widgets**: `widgets/verify.ts` (verifyMap, rvTestsPanel, fuzzPanel, shrink, coverageGrid, spikeDiff) and `widgets/dft.ts` (faultMatrix, atpgWalk, scanPanel, bistPanel, testCost); styles in `styles/verify.css`. All lazy chunks, nothing on the first-load path.

## Codex and campaign

- **Codex**, new entries (none exist today), each with a `chapters/taught.ts` row, two Check-yourself quizzes and a glossary alias:
  - `golden` (golden model, tool)
  - `selfcheck` (self-checking test, tool)
  - `fuzzing` (random testing, tool)
  - `coverage` (concept)
  - `stuckat` (stuck-at fault, concept)
  - `faultcov` (fault coverage, law: random coverage's long tail)
  - `atpg` (tool)
  - `scan` (scan chain, trick)
  - `lfsr` (component; also referenced by the Ethernet and serial chapters, which describe one today without an entry)
  - `bist` (trick)
- **Campaign**, an optional act section or two levels in act 3 (decision 4):
  - `t_scan`: build a 4-bit scan register from the given `dff` and `mux2`. Graded on NANDs; a sequence check that shifts through.
  - `t_tests`: a test-set level, as a new kind `testset` (a level whose answer is a list of vectors, like a drill). Given the 4-bit adder, enter at most N vectors that catch every stuck-at fault. Graded on vector count against par 4; checked by faultsim.
- **"Break it" levels** (PLAN-ONI D2, Rock's) are the natural practice for step 8. The recap's `practise` lists them once they land.

## Decisions (with recommendations)

1. **One chapter or two?** I recommend **one chapter of 13 steps**: the parallel ("what is the oracle, what does coverage mean") between the two halves is the point. Alternative: split into "Verifying a CPU" after pipepay and "Testing a chip" after silicon. That puts verification earlier, but traps, caches and FP then come after it, and a third of the real bugs live there.
2. **Placement**: after `silicon` (recommended), or as the last CPU chapter after `multicore`, before `silicon`. That reads well for verification, but defects and yield haven't been taught yet there.
3. **The historical bug in step 4**: should the learner see the RV32IF pipeline's lost-branch bug?
   - (a) A test-only generator option `pipelinedCpu({ fpu, bug: 'stallPc' })` that restores the old PC enable, used only by this widget (recommended: it is the real bug, and the fuzz panel finds it the way CI did).
   - (b) A planted stuck-at instead. Simpler, but not what random testing is good at.
   - (c) Only tell the story.
4. **Campaign**: two levels in act 3 (`t_scan` after `s_reg4`, `t_tests` after `a_add4`; recommended), or none until "break it" lands.
5. **Faults counted**: stem faults only (12 on the full adder, as above) with a sentence on fan-out branches (recommended, since it is simplest to see), or full checkpoint faults (inputs and fan-out branches). The numbers change: decide before the widget is built.
6. **Step 5 (shrinking)**: keep it as a `deep: true` dive (recommended), or drop it to keep 12 steps.

## Rough cost

| Piece | Size |
|---|---|
| faultsim.ts + atpg.ts + tests | 2 days |
| scan.ts, bist.ts (incl. March) + tests | 1.5 days |
| Scene.faults, mismatch stop, the old-bug option (3a) | 1 day |
| Verification widgets (map, riscv-tests panel, fuzz, shrink, coverage, Spike diff) + coverage JSON | 3 days |
| DFT widgets (fault matrix, ATPG walk, scan panel, BIST, test cost) | 3 days |
| Chapter text (13 steps, layers, tours, quizzes, recap) | 2.5 days |
| Codex (10 entries, quizzes, taught rows), 2 campaign levels | 1.5 days |
| Mockups of the remaining widgets, review, smoke, renumbering checks | 1 day |
| **Total** | **≈ 15 days** of one agent; two agents in parallel (verification half / test half) ≈ 8 |

Renumbering: inserting the chapter moves every later chapter's number. Text uses `numOf`. Saved progress is keyed by chapter id, so nothing migrates. Run `npm run manifest` and tests/chapter-numbers.
