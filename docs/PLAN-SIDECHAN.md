# Plan: "Side channels" (Phase 23)

Roadmap item: "Side channels: Spectre on our out-of-order core and its cache". This is a plan and a mockup
(E:/mockups/sidechan/).

**Approved 2026-11-09** by the author as shown (artifact BXrBAGTWZqzEv7jMBp2Dtw), with all six decisions as recommended.
Built in stages:
1. The model's spec mode, with tests (feat/sidechan-spec).
2. The chapter, after `verify`.
3. The codex, and the AES power step only if it measures feasible.

Every number in the mockup is computed and pinned before it reaches the prose.

Stage 1 as built:
- `ooomodel.ts` spec mode (`SpecConfig`; `isRdcycle`, `isFence`); `CacheModel.holds`.
- `riscv/sideprograms.ts`: the attacker program for each defence, and the cache and memory map.
- `tests/ooo-fingerprint.test.ts`: every configuration × program, cycle by cycle, pinned before the change.
- `tests/sidechan-spec.test.ts`:
  - the program recovers the secret over 32 secrets, and each defence recovers nothing;
  - the out-of-bounds load ran on the wrong path and was flushed;
  - a miss measures 18 cycles more than a hit;
  - the benchmarks keep their architectural state;
  - wrong-path stores vanish;
  - the fence barrier.

One choice made while building: `csrr cycle` serializes fetch on a wrong path too. Otherwise the code after the victim's
`ret` runs on the wrong path into the attacker's timing loop, and that loop's own probe loads fill lines. Real attack
code serializes there for the same reason.

## Placement

- **Order.** Chapter id `sidechan`. Place it in `order.ts` right after `'verify'`, before `'lanes'`. The planned order is
  silicon → fpga → verify, with VM and OS after cache. The text never types the number (`numOf('sidechan')`).
- **Builds on:** `cache` (hits, misses, a line, direct mapping), `ooo` (the reorder buffer, wrong-path work, the flush,
  the BTB's 2-bit counter), `cpu` (cycles of a program) and `verify` (the golden model as the oracle).
- **It borrows from** `os` (when that chapter has landed) only for one layer: a victim in another privilege domain, where
  partitioning and flush-on-switch make sense. Nothing in a step depends on it.
- **Why not earlier:** right after `ooo` would also work. Putting it after `verify` means "the golden model says the
  program is correct, yet it leaks" lands on a reader who has just learnt what the golden model checks. That is the
  chapter's point: correctness is not security.
- **The power side channel** (AES) goes in `secret`, which teaches AES much later, as one step that links back here
  (decision 5).

## Goals ("In this chapter you will …")

- measure a secret through time alone: a password check that stops early;
- use the cache as a memory you can read without reading it: evict, let the victim run, reload, time each line;
- watch our out-of-order core load a secret on a path it later throws away, and see the one thing the flush does not undo;
- try three defences and say what each costs in cycles.

## Steps (11; under the 15-step `parts` threshold)

| # | Title | Scene / widget | What it teaches |
|---|---|---|---|
| 1 | Time tells | widget `pwTiming`: a password check that returns at the first wrong byte, run on the golden model. Pick a guess and its cycle count shows; the reader finds the first byte, then the next, in 16 × n tries instead of 16^n. Then the constant-time version, whose cycles do not depend on the guess, and its cost | A side channel: an output nobody meant to give. Constant-time code |
| 2 | The cache remembers | widget `probe16`: our cache model (`sim/cachemodel.ts`, the configuration of `cache`) with 16 probe lines. The attacker evicts them, the victim loads `probe[s · 16]`, the attacker reloads each line and times it with `rdcycle`: one line is fast | Evict + reload. The cache's state is shared and nobody's to read, yet timing reads it |
| 3 | The path the core throws away | scene: the gate-level out-of-order core (the one of `ooo`, unchanged) on a bounds check whose branch waits on a 19-cycle divide. The ROB panel (`ooopanel`) shows the wrong-path load holding the out-of-bounds byte, then the flush | Transient execution, on our gates: the secret really is in a register for some cycles. Architecturally nothing happened |
| 4 | What the flush forgets | widget `specTimeline` on the model in spec mode (below): the same program; rows for fetch, issue, execute and commit, the wrong path shaded, a lane for cache lines filled, the flush line | The flush restores registers and the rename table. A line filled on the wrong path stays filled |
| 5 | Bounds check bypass | widget `specTimeline` plus `probe16`. The gadget `if (x < len) y = probe[array1[x] · 16]`, with `len` evicted so the check waits on a miss; an out-of-bounds x. The probe chart shows the secret nibble | Spectre variant 1 (Kocher et al., 2019), on a modelled machine: misprediction + a load + a dependent load + a cache |
| 6 | Reading a whole secret | the attacker program loops over nibbles and prints the recovered string; the golden model prints the real one beside it | The program itself recovers the secret: the leak is real on the model, not drawn. Our model has no noise; real attacks repeat and vote (layer) |
| 7 | The predictor learns back | `specTimeline` with the BTB entry's counter: after an out-of-bounds call commits, the branch predicts taken and the next attack fails; the attacker calls with in-bounds x first | The 2-bit counter of `ooo` turned into the attacker's tool: "training" |
| 8 | A fence | the gadget with a speculation barrier after the check (in spec mode, `fence` waits until older branches resolve). Cycles per call, with and without; the probe chart is flat | Stop speculation where it hurts. Cost: the window you bought the core for |
| 9 | A mask | the index masked without a branch (`sltu`, `neg`, `and`): the load's address depends on `len`, so the wrong path loads in bounds. Three instructions; cycles per call; flat chart | Data dependency instead of control dependency. The usual software fix |
| 10 | Fix it in hardware | spec-mode switch "fill at commit": a wrong-path load returns its value but fills no line until it commits. The benchmarks of `ooo` (fib, sort, matmul, CRC-32) in cycles, with and without | A hardware defence and its price across programs, not just the gadget. Partitioning and flush-on-switch as a layer |
| 11 | What it costs, side by side | widget `defenceTable`: no defence, fence, mask, fill-at-commit. Leaks (yes / no, from the attacker's own output), cycles per call, benchmark slowdown | Security is a cost like any other in this book: every row computed |

Recap: keep (three lines), check (three quizzes); no `practise` (no campaign level), a link to the puzzle below instead.

## New code (when approved)

- **`riscv/ooomodel.ts`, a `spec` option (opt-in).** `OOO_CORE` and every existing configuration stay byte-identical, so
  tests/ooocore, ooounits, ooosnap, ooosizes and ooolab do not move (a requirement, checked by the existing tests). With
  `spec: SpecConfig` the model:
  - computes values on the wrong path. At a misprediction it saves the golden ISS (`ISS.save`), steps a copy down the
    predicted path as those instructions are fetched, and restores at the flush. Wrong-path stores live in the copy and
    vanish with it;
  - gives loads their latency from a `CacheModel` (`sim/cachemodel.ts`, the `cache` chapter's direct-mapped
    configuration): a hit at the model's load latency (2), a miss at a miss penalty (`SpecConfig.missLat`, 20 to begin
    with). A line is filled once its miss request has gone out, wrong path or not: a request already sent completes after
    a flush, as on real cores, even though its value is thrown away. With `fillAtCommit`, a load fills only when it
    commits;
  - answers `csrr cycle` (rdcycle) with its own cycle. The instruction is serializing: fetch stops behind it; it executes
    once everything older has committed, and the ISS steps it then with that value. Otherwise `iss.ts` would answer with
    its own count (`mtime`), which is not the model's;
  - treats `fence` as a speculation barrier when `SpecConfig.fenceBarrier` is set: dispatch of younger instructions
    waits until every older branch has resolved.

  Timing then depends on data, as on a real core. That is why it is a mode of its own.
- **The window, counted.** The gadget is `lw t1, len` (a miss, 20 cycles), then `bgeu a0, t1, out`, `add`, `lbu`
  (secret), `slli`, `add`, `lw` (probe line): six instructions behind the branch, inside a 16-entry ROB and an 8-entry
  issue queue. No stores come before it, since loads wait for every older store. The bounds check falls through when in
  bounds, and a BTB miss predicts fall-through (`ooomodel.ts` predicts taken only for a counter ≥ 2), so the first attack
  needs no training. Step 7 shows the retraining. On the gates (step 3) the late branch waits on a `divu`, because the
  gate core has no cache.
- **The gate-level core gets no cache** (decision 2). Step 3 shows the transient secret in the ROB through `ooosnap` /
  `ooopanel`, unchanged. The leak itself (steps 4–11) runs on the model, and the text says so.
- **`widgets/sidechan.ts`:**
  - `pwTiming`: the golden model's cycles per guess;
  - `probe16`: the cache model's 16 lines, bars per reload time;
  - `specTimeline`: drawn like the ooo chapter's in-order / out-of-order timelines (`widgets/ooo.ts`), plus a cache lane;
  - `defenceTable`.
- **`riscv/sideprograms.ts`:** the password check (early-exit and constant-time), the evict + reload probe, the gadget,
  the attacker loop and the three defences, in RV32I assembly, each with its result computed in TypeScript.
- **Tests:**
  - `tests/sidechan.test.ts`:
    - the recovered secret equals the planted one over 32 seeds;
    - with each defence, the attacker recovers nothing (no line below the hit threshold);
    - the constant-time compare's cycles do not depend on the guess;
    - every number the prose quotes is pinned (SIDE_COSTS, measured like OWN_COST and RVC_COSTS);
  - the existing ooo tests are unchanged.
- **Measured later:** what the plan gives as estimates. The miss penalty, window, cycles per call and slowdowns come from
  the model and are pinned by the test above.

## Safety

Teaching only, at textbook level:
- every program runs on our modelled RV32 machine: the golden model and the ooo model in spec mode;
- nothing targets the reader's own computer: no browser timers, no `performance.now()` probes, no eviction-set searches
  for real caches, no calibration constants, no x86 or Arm code;
- the gadget is the one in the published paper and every architecture textbook since 2019;
- the layers describe real-world impact and the real mitigations (retpoline, lfence, site isolation, index masking in
  JIT compilers) at that level, with sources.

## Codex and campaign

- **Codex entries** (with chapter links and Check yourself, and `taught.ts` rows at `sidechan`): side channel,
  constant-time code, evict + reload (flush + reload as an alias), transient execution, Spectre (bounds check bypass),
  speculation barrier.
- **Puzzle:** one program puzzle in the sandbox's Puzzles drawer (`src/puzzles`, the RV32I puzzle computer), linked from
  the recap's prose (`practise` takes campaign levels): "constant-time compare". Write a compare whose cycles do not depend on the input; graded on
  cycles and checked over every guess of a hidden password, so no ooo model is needed. No campaign hardware level: the
  gate core has no cache (decision 2).

## Decisions (with recommendations)

1. **Placement:** after `verify` (recommended: "correct, yet it leaks"), or right after `ooo` (closer to the material, but
   the golden-model contrast is lost).
2. **A cache in the gate-level ooo core?**
   - **Recommended: no.** Variable load latency in gates touches the issue queue's wakeup, the result buses and every
     cycle-exact test against the model. The model shows the leak, and the gates show the transient secret (step 3).
   - Alternative: a small direct-mapped cache in front of `dataMemory2` with a miss stall. That is a phase of its own.
3. **Timer:** a serializing `rdcycle` on the model (recommended; like `lfence; rdtsc`, the textbook measurement), or the
   widget reading each load's latency from the model's trace. That is simpler, but then the program does not observe
   anything itself, and the leak would only be drawn.
4. **Hardware defence:** fill-at-commit (recommended; one switch, measurable on the benchmarks), or domain partitioning
   (needs two domains, so the `os` chapter first; kept as a layer).
5. **Power analysis on AES:** a step in `secret` (recommended; AES is taught there). Correlation power analysis on the
   gate-level `aesSbox`: per random plaintext byte, the switched energy from `sim/power.ts`'s PowerMeter, correlated with
   the Hamming weight of S-box(p ⊕ guess) for all 256 guesses; the right key byte stands out. Alternative: leave it out.
   Not yet measured: whether 64 / 256 / 1024 traces suffice is computed before the step is written.

   **Measured 2026-11-09 (scripts/sidechan-cpa.ts): not feasible as the textbook attack, so the step is not built.**
   - The setup: one trace is the switched capacitance, glitches included, of loading S(p ⊕ k) into an 8-bit register
     that held S(0), measured on the gate-level tower-field `aesSbox`. This is the byte-serial setting.
   - The textbook model, the register's Hamming distance HW(S(p ⊕ g) ⊕ S(0)), correlates only 0.17 with the energy over
     all 256 inputs.
     - The S-box's own glitching (126 to 22 263 fF a load) swamps the register's few bits.
     - Over 20 keys, the right one is found 1 / 20 times with 64 traces, 3 / 20 with 256 and 0 / 20 with 1024 (median
       rank 3).
   - A weaker model, the Hamming weight of the S-box's input HW(p ⊕ g), correlates 0.47. It finds the key 11 / 20
     times with 64 or 256 traces, and 16 / 20 with 1024.
     - That target is the XOR before the S-box, with ghost keys one bit away. It is not the attack the books teach.
   - So the step would teach either an attack that does not work on our gates, or a different one than the literature's.
     Neither is honest at textbook level. If wanted later, a masked or register-heavy design would make the textbook
     attack measurable; that is a hardware change of its own.
6. **Variant 2 / Meltdown:** layers only (recommended). Meltdown needs a privilege check the wrong path ignores. Our core
   has no privilege modes before `os`, and the honest version needs page tables (`vmem`).

## Cost (estimate)

- Model spec mode: ~400 lines (ISS copy on the wrong path, cache latency, rdcycle, fence barrier, fill-at-commit) and
  its tests.
- Widgets: ~600 lines. Programs: ~250 lines of assembly with TypeScript references.
- Chapter: 11 steps of prose, recap, six codex entries, one puzzle.
- No new hardware.
- First load: nothing (a chapter is its own chunk).
