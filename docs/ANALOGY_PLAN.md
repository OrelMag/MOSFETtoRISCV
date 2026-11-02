# Analogies: plan to finish them all

Written 2026-11-02 for the next Claude session. Read `CLAUDE.md` first (worktrees, gate, merge rules). The user approved
this track and authorized merging each piece once the full gate passes (tests, typecheck, build with hwstats, smoke);
report each deploy. The approved mockup is
https://claude.ai/artifact/351fVbAocdRVEf9zoGTGBM (Artifact tool, `action: "read"`).

## Where it stands

| Piece | State |
|---|---|
| A: the mechanism + 25 text analogies | **On main** (1b942e4). `src/chapters/analogies.ts` (table), `src/ui/analogy.ts` (folded aside), codex section in `src/campaign/ui/codexentry.ts`, `tests/analogies.test.ts` |
| C: four 2D figures | **On main** (90551c3). `src/widgets/analogy/{buckets,airlock,laundry,leaky}.ts`, DOM-free models in `model.ts`, helpers in `common.ts`, `tests/analogyfigs.test.ts` |
| B: water in 3D | Branch `feat/analogies-water` (worktree `E:/MOSFET-water`), merged with main, full gate was running on 2026-11-02. Ch 0 Wire / Water toggle (`widgets/basics.ts`), ch 1 "Three regions" Water view (`widgets/mosregions.ts`), CMOS column figures `water-cmos` / `water-cmos-weak`; kit `widgets/waterkit.ts` on `src/gl`, models `widgets/water.ts`, `tests/water.test.ts` |

**First thing to do:** `git log origin/main --oneline -5`. If B is not on main, finish it (its gate logs are
`E:/water-gate-{test,build,smoke}.log`; if all three end in exit 0, merge it with `--no-ff` as CLAUDE.md says). Don't
rebuild what B already built.

"All the analogies" means: **each of the 25 analogies has a working picture**, not just text. Eight have one already
(the loop and the faucet through their widgets' Water view; buckets, the two CMOS figures, airlock, laundry, leaky). The
**17 below have text only**. Each gets a figure in its aside.

## How a figure plugs in (already built, don't change it)

- Set `figure: '<key>'` on the entry in `src/chapters/analogies.ts`. Register the key in `src/ui/analogyfigs.ts`:
  `key: () => import('../widgets/analogy/<file>').then((m) => m.default)`. The default export is
  `(host: HTMLElement) => void`. It loads the first time the aside opens.
- Stop animating once `host.isConnected` is false. `frames(host, fn)` in `widgets/analogy/common.ts` does that already.
  Also use its `reducedMotion()`, `button()` and `setPressed()`.
- Put the logic in DOM-free functions in `widgets/analogy/model.ts` (or a sibling file), each with tests in
  `tests/analogyfigs.test.ts`. **Every number a figure shows comes from the site's own model or constants**; the
  "Source" column below names where. Check each source before you use it, and if the source disagrees with this plan,
  the source wins.
- Draw in SVG with the `h` / `s` helpers in `src/ui/dom.ts`. Use colours from tokens only, in both themes. If you need
  a new token, define it in all three blocks of `theme.css`.
- Readable sizes: the figure must work in the chapter pane at 254 px wide (text at least 11 px) and at 390 px on a phone,
  with no horizontal overflow. Stack the parts vertically instead of side by side; that's how the buckets figure was
  fixed.
- Reduced motion: no looping animation. Use step buttons, and still reach the correct final states.
- Buttons are real `<button>`s, with `aria-pressed` where they toggle. Add a touch-size rule in the
  `@media (pointer: coarse)` block at the end of `app.css`.
- Don't make the analogy text say more than the figure can back up. Keep the "Where it breaks" lines as they are
  unless the figure shows they're wrong.
- Screenshots: a CDP script that takes them is at
  `C:\Users\USER\AppData\Local\Temp\claude\e--MOSFET-to-RISCV\4900d32f-496c-4543-9d95-976400a43585\scratchpad\figshot.mjs`.
  Copy it into your own scratchpad, because that folder belongs to another session. Serve with `vite preview --port <free>`.
  Route: `#/c/<chapter>/<step index>`. Open the aside, shoot light and dark at 1280 px and 390 px, then **look at the
  images**.

## The 17 figures

Each row below is one figure. The chapter id and step title are the entry's own (`chapter` / `step` in `analogies.ts`).

### Merge D: storage and the clock (chapters `latches`, `registers`)

| Key | Step | What it shows | Controls | Source |
|---|---|---|---|---|
| `disagree` | latches / Two NANDs holding hands | Two speech bubbles, A and B, each the NOT of the other's word. S or R shouts into one ear, the other follows, and the pair holds | Set, Reset, Release | The SR latch's truth (`lib/sequential.ts` SR latch); state from a tiny NAND-pair model, checked against `simulate()` of the library part in the test |
| `hilltop` | latches / The forbidden input, and races | A ball on a hill between two valleys (0 and 1). "Release both" puts it on top; it waits, then rolls. Repeat with a seeded RNG and plot a histogram of the wait in gate delays: each delay halves the chance it is still up | Release both, Release one, Run 100 | The GateSim relaxation (`sim/gatesim.ts` relax, `sim.unstable`): state only that it resolves, not a picosecond figure. The histogram is geometric, with p per delay a stated assumption |
| `orchestra` | registers / A register is a row of flip-flops | A row of flip-flops (players) and a beat. Paths of different lengths settle between beats; slow the period below the longest path and the late player gets the wrong value | Period slider, Beat | Path lengths in NAND delays from `sim/timing.ts` on the 4-bit register + adder scene, or a fixed small example whose delays a test computes |

### Merge E: steering signals (chapters `gates`, `memory`, `appendix-sap`)

| Key | Step | What it shows | Controls | Source |
|---|---|---|---|---|
| `points` | gates / The multiplexer: a digital switch | Two tracks into railway points and one out. Points set by `s`; trains (bits) run on both inputs all the time, and only the selected one reaches the output. A small counter of gate toggles shows the unselected side still costs switching | s, a, b | MUX2 from `lib/gates.ts`, evaluated with `evalOnce` in the test; toggle counts from `GateSim.countToggles` on MUX2 over the same input sequence |
| `switchboard` | memory / Four words, one address | A switchboard with 4 rooms. A 2-bit address lights one line, and the data goes to that room only. A "bits" slider (1–4) shows the board doubling | Address bits, address, Write | `decoder(n)` in `lib/combinational.ts`: output one-hot and NAND count from `stats.ts` for n = 1–4 (the test pins them) |
| `microphone` | appendix-sap / What a bus really is | One microphone, four speakers (registers / ALU). Hand it to one: everyone hears it. Turn on two: the wire turns red, "shorted", and the value reads X | Enable per speaker | The SAP bus's `clash` output (`ch-sap.ts` scene part) or `TRIBUF` at switch level (`lib/switchparts.ts`) with `SwitchSim.shortText` for the message |

### Merge F: the pipeline (chapter `pipeline`)

| Key | Step | What it shows | Controls | Source |
|---|---|---|---|---|
| `handoff` | pipeline / Data hazards and forwarding | Five cooks (F D E M W). Dish 1's sauce is ready at E's end. Off: dish 2 waits for the shelf (W) and loses cycles. On: handed across, no wait. The mux in front of E is drawn as the extra hand | Forwarding on / off | The cycles per mode from the hazard rules in `lib/pipeline.ts` (`hazardUnit`) or from `pipegrid` on a two-instruction program run on the golden pipeline; the test pins the stall counts |
| `emptyplate` | pipeline / The load-use stall | The load's dish is still in the oven (M). The next cook waits one beat, and an empty plate (bubble) travels down the line, drawn with the same cells as `widgets/pipegrid.ts` | Step, the next instruction dependent or not | Same pipeline model: a load-use costs exactly 1 bubble with forwarding (test) |
| `fork` | pipeline / Control hazards | A road with a branch fork. The pipeline guesses and drives on, filling stages with greyed instructions. A wrong guess flushes them, and the counter shows the cycles lost | Guess taken / not, actual taken / not | Flush penalty from this pipeline's branch resolution stage (`lib/pipeline.ts` MISPREDICT / BRANCH_CMP: cycles lost per mispredict; the test pins it) |

### Merge G: memory in depth (chapters `cache`, `dram`, `flash`)

| Key | Step | What it shows | Controls | Source |
|---|---|---|---|---|
| `desk` | cache / The memory hierarchy | Desk, shelf, library, warehouse as four bars on a log scale of size and walking time, plus a stream of requests. A hit on the desk is instant, a miss walks further and brings back a whole line (the neighbours light up) | Access pattern (sequential / random), Step, Run | `sim/cachemodel.ts` for hits / misses and line fills; latencies the chapter itself states (read them from `ch-cache.ts` "The memory hierarchy" / AMAT step, never invent them) |
| `seesaw` | dram / The sense amplifier | A seesaw at the middle line (VDD / 2). The feather is the cell's ΔV; the seesaw tips and slams to a rail, writing back. Under 15 mV it wobbles to a coin toss (X) | Cell level, Precharge off (start off-centre), Sense | ΔV = (level − ½)·VDD·CELL_C / (CELL_C + BITLINE_C), `SENSE_OFFSET`, `VDD_VOLTS` (reuse the leaky figure's model in `widgets/analogy/model.ts`) |
| `island` | flash / A gate that remembers | A floating island (gate) above a channel. Program pulses push charge across (tunnelling arrows) in FG_STEP steps; reading tests against FG_READ; erase empties it. A wear meter counts crossings toward endurance | Program pulse, Erase, Read | `FG_STEP` = 0.2, `FG_READ` = 0.3 (`sim/switchsim.ts`), endurance and erase counts from `flash/model.ts` FlashDevice |

### Merge H: parallel and system (chapters `ooo`, `simt`, `bus`, `traps`, `multicore`)

| Key | Step | What it shows | Controls | Source |
|---|---|---|---|---|
| `kitchen` | ooo / Rename, wait, commit in order | Tickets (instructions) enter in order. Cooks (ports) start any dish whose ingredients are ready, and the pass (ROB) hands them out in ticket order. A slow roast (divide or load miss) blocks the pass, and once the window is full new tickets stop | Program (one of the chapter's loops), window size, Step | `riscv/ooomodel.ts` OooModel / CycleInfo per cycle (issued, committed, the stall cause); window sizes as the lab allows (`configProblems`) |
| `squad` | simt / When lanes disagree | Four soldiers (lanes) under a mask. "Even numbers step forward": half go and half stand still, then the other half, then all march again. A slot counter shows the split costs both halves | Condition (all / half / one lane), Step | `riscv/simt.ts` SimtISS on a tiny kernel from `simtprograms.ts`: the mask per step and the utilization it reports |
| `movers` | bus / DMA | The CPU writes an order (src, dst, len) and goes back to its loop. A van (DMA) moves words; when both want the bus, one waits; the doorbell (irq) rings at the end. Counters: CPU instructions done meanwhile, words moved | Length, Start | `bus/model.ts` BusModel / the chapter's DMA timing (the bus chapter's numbers), or a cycle trace from `busBenchScene`'s program measured once in the test |
| `doorbell` | traps / The timer interrupt | Two timelines. Polling: check the door every k cycles, which costs k-spaced checks and adds up to k cycles of delay. Interrupt: work runs, the bell costs a trap entry plus the handler's saves. A slider for how often visitors come shows where polling wins | Visitor rate, Poll interval | Trap entry and handler costs from the chapter's handler (count its instructions in `sysprograms.ts` on the golden model in the test); not invented |
| `fourway` | multicore / The arbiter | A junction with 2–4 cars (cores) requesting. A four-way stop serves the first to arrive. Round robin serves the next after the last one served, so a car that keeps arriving first can't starve the others | Requests per core, Policy (first come / round robin), Step | `arbiterN(n)` (`lib/mpdecode.ts`) evaluated cycle by cycle (grant sequence pinned in the test); the first-come policy is a small model in `model.ts` |

## Leftovers (Merge I, small)

- **Loop sliders.** The ch 0 Water view has the widget's fixed 1.5 V and 15 Ω. The mockup had tank-height and narrowness
  sliders. Add them to the Water view only if `loopWidget`'s own text stays true (it says 1.5 V and 15 Ω). Otherwise
  label them "try other values" and keep the defaults.
- **The choke.** The faucet scene in "Three regions" shows saturation only in its caption. Draw the pinch: a narrowing
  at the outlet whose size follows V<sub>GS</sub> − V<sub>T</sub>, from `mosphys.ts` `current()`.
- **Hover cards.** The plan said the glossary hover card (`campaign/ui/glossaryui.ts`) would show a one-line
  "Analogy: <title>" for entries in `analogiesForCodex`. Not built yet. Add it under the summary, linking to the codex
  entry.
- **The same idea in another chapter.** `cache / Leaks, refresh and sense amplifiers` teaches DRAM leaks before the
  `dram` chapter. Add a second entry there with its own title (titles must be unique; the test checks) using
  `figure: 'leaky'`.
- **Smoke.** Smoke opens chapter steps but not asides. Add an option, or a route list, that opens each `.analogy` with a
  figure (the `details` `open` attribute) on its step, so a figure's runtime error fails CI.

## Order and size

Do D, E, F, G, H as separate branches (`feat/analogies-<d…h>`), one worktree each, each cut from an up-to-date main. They
touch different files apart from one line each in `analogies.ts` and `analogyfigs.ts` (keep both sides when merging).
Subagents may build them in parallel. Each needs its own worktree and the full brief above; the parent session gates and
merges. Do I last.

For each merge:
1. Build the models and their tests.
2. Build the figures.
3. Take screenshots and look at them.
4. Merge origin/main into the branch.
5. Run the full gate.
6. Merge with `--no-ff` from the worktree.
7. Watch the deploy. A newer push to main cancels the running deploy; the next one includes it.

## Acceptance

- Every entry in `ANALOGIES` has a `figure`, or opens a widget that has a water view (the loop, the faucet). Add a test
  for this once all 17 are in.
- `tests/analogies.test.ts` and `tests/analogyfigs.test.ts` are green, and each figure's numbers are pinned to its source.
- The full gate passes. Screenshots in light and dark at 254 px pane and 390 px are viewed and readable.
- Update the memory note `analogies.md` (`C:\Users\USER\.claude\projects\e--MOSFET-to-RISCV\memory\`) after each merge.
