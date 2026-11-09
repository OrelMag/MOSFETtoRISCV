# Design note: GateSim with loaded delays on a finer grain

Phase 19's open item: the event-driven simulator times every NAND by its load, in tenths of a unit, so glitches and races
follow the loads the way static timing already does (sim/delay.ts, the Timing panels' Unit / Load switch). **Status: design
note only, nothing built.** Written 2026-11-09 for the Coordinator; decisions below carry a recommendation each.

## What exists

- **sim/delay.ts** already computes a delay per leaf under three models: `leafDelays(d, 'unit' | 'load' | 'drawn')`. 'load' is
  logical effort with a buffer chain where it pays; 'drawn' is minimum-size and unbuffered. Today only static timing
  (timing.ts, slack.ts) and the inspector read it.
- **sim/gatesim.ts** schedules on an event wheel of `RING = 64` integer slots. A NAND fires at `time + 1` on a fast path
  (`evalDirty`'s `slot1`); behavioural leaves and slow-fault NANDs fire at `time + delay[li]` (an `Int32Array`, already per leaf).
  Delay is transport: `proj[net]` is the last value scheduled on a net, so a change that cancels a pending one still makes a pulse.
- **Measured** (single-cycle RV32I, 48 434 NANDs, `leafDelays(…, 'load')`):

  | | min | max | distinct values at 0.1 | NANDs at exactly 1.0 |
  |---|---|---|---|---|
  | 'load' | 0.48 | 7.33 | 22 | 38 860 (80 %) |
  | 'drawn' | 0.48 | 805 | 31 | 38 860 |
  | behaviours (memories) | | 18 | | |

  Chapter 8's flip-flops: the master–slave DFF's 11 NANDs are 1.0 × 8, 1.5 × 2 and 2.5 × 1; the six-gate DFF_EDGE6's 8 are 1.0 × 2,
  1.5 × 5 and 2.0 × 1. Under 'load' its internal races are no longer ties.

## Approach (recommended)

**One engine, integer ticks, a scale.** GateSim gains `ticksPerUnit`: 1 under the unit model (today, unchanged), 10 under
'load'. Every delay becomes an integer number of ticks, `max(1, round(10 · d))`; the event wheel stays integer, so there is no
floating-point time in the queue and the event order is exact and reproducible.

- **The wheel.** Its size becomes per instance: the next power of two above the largest delay in ticks, at least 64. That is 64
  under the unit model, and 256 under 'load' on the CPU (largest delay 180 ticks, a memory's). A delay that does not fit throws
  as it does today. The instance stores a mask and every slot is `t & mask`: `% RING` with a constant 64 compiles to a mask
  today, and a field modulo would be a real division on every schedule. The unit path is therefore not literally the same
  machine code, and its speed is measured (Performance).
- **The NAND fast path.** It keeps `slot1 = time + 1` when `ticksPerUnit = 1`. Under a scale, 80 % of NANDs sit at exactly 10
  ticks, so the loop keeps the cached buffers of slot `time + 10` for those and sends the rest through the general per-leaf
  path (`time + delay[li]`). The loop is written twice and chosen once per `evalDirty`, with no per-NAND branch on the model.
- **Order on a net is preserved.** Each net has exactly one driver with one fixed delay, so its events still arrive in the
  order they were scheduled, and `proj`'s transport semantics hold unchanged.
- **Time in the API.** `Sim.time` stays in units: under a scale it is `ticks / ticksPerUnit` (2.3), and exact integers under
  the unit model. A new `Sim.ticks` (integer) and `Sim.ticksPerUnit` serve code that needs exact arithmetic. `runUntil(t)` takes
  units and rounds to ticks. A new `nextEventTime()` (units, or null when nothing is pending) serves stepping.
- **Stepping keeps its rule under the unit model.** `stepEdge` (edge.ts) calls `runUntil(time + 1)`: one unit, standing on
  empty instants, never past the end of a fixed-period high phase. That stays exactly so when `ticksPerUnit = 1`. Under a scale
  it advances to `min(nextEventTime(), e.end)`, so a slow-motion step is the next change, never past the edge's end. The stage
  bar's Step follows the same rule. (A bare `step()` would jump past `e.end` behind a memory's 8-unit delay, and under the unit
  model it would skip the idle instants a learner sees today.)
- **settleLimit** (4 000) and edge.ts's `LIMIT` (10 000) count units, so they are multiplied by the scale.
- **saveState / restoreState / adopt / carry** carry ticks and the scale. Adopting a state of another scale converts the time
  and refuses pending events (DualSim hands over settled states only, so none are pending there).

### Alternatives considered

- **A separate FineGateSim class:** no risk to the unit engine, but two copies of 700 hot lines to keep equal (tests/ref already
  shows what that costs). The scale keeps one engine, and its unit-model path is the same code.
- **Floating-point time** (a heap keyed by doubles): any grain, but `2.3 + 1.2 ≠ 3.5` exactly in binary, ties become
  order-dependent, and a heap is slower than the wheel.
- **Hundredths:** only 31 distinct values even at 'drawn', so tenths lose nothing a learner can see (rounding error ≤ 0.05
  unit, under 1 % of a 7-unit gate); hundredths would make the wheel ten times larger for nothing.

## What changes, file by file

| Where | Change |
|---|---|
| sim/gatesim.ts | `GateSimOptions.delay?: DelayModel` (default 'unit'), `ticksPerUnit`, per-instance ring, the scaled fast path, ticks in save / adopt |
| sim/sim.ts | `ticks`, `ticksPerUnit` on Sim (1 for every other engine) |
| sim/dualsim.ts | passes the model to its GateSim; the cycle engine keeps no time (below) |
| sim/edge.ts | unit model: `runUntil(time + 1)` as today; under a scale: to `min(nextEventTime(), e.end)`; LIMIT scaled |
| sim/settle.ts, opdelay.ts, edgetiming.ts, riscv/cycletime.ts | take the model; report units with one decimal (`fmtDelay`). edgetiming's setup / hold sweep steps in tenths under 'load' |
| sim/power.ts | nothing in the code: toggles are counted per change, so glitches that loads create (or remove) count by themselves |
| sim/vcd.ts | under a scale: times in ticks, `$timescale` from PS_PER_UNIT / 10 (DELAY_NOTE's own unit, ≈ 2.5 ps a tick, written as 1 ps with times scaled); 1 ns per unit as today otherwise |
| view/stage.ts | `t = 12.3` and "settled in 12.3 units" under 'load'; the bar's Step goes to the next event |
| view/schematic.ts (slow motion) | a change's front is drawn over its driver's delay (`flowMs · delay`), so a loaded gate is visibly slower |
| view/analyzer.ts | time axis and cursors in units with ticks; the trace already stores times as numbers |
| editor/runtime.ts (sandbox gate mode) | the setting reaches EditorSim's GateSim (decision 2) |
| editor/editor.ts | "at t = …" and the run bar's `t`: one decimal under a scale |
| editor/analysis.ts | affected through the analyzer only (it sets / clears onTrace) |
| editor/challenges.ts | **unit only**: Check builds its own GateSim; a level is graded in unit delays whatever the setting. The test player replays on the editor's simulation, so its times follow the setting there: replay compares values, not times, and is unaffected |
| lib/techsteps.ts, campaign/commcheck.ts | **unit only**: their own simulators, counting steps for prices and checks |
| view/memfind.ts | **unit only**: its own GateSim probe (`SETTLE_DELAYS` are units) |
| widgets/sap.ts | a cache key with `sim.time` in it: works for any number |
| widgets/chiplayout.ts | not GateSim time (static timing stages from the layout flow): unaffected |
| doom/player.ts | its own runUntil (FastISS): unaffected |

**CycleSim's code is unchanged, but its claim needs a guard.** It has no time; its tables (ffmacro.ts) are built from unit-delay
simulation of each storage cluster, and its hazard refusals ("a pin changing with an inverted clock on a path shorter than it")
are judged in unit delays. For flip-flops clocked straight from a pin, the settled values do not depend on gate delays. But the
cycle engine also accepts clocks that reach flip-flops through inverter chains (clusters.ts `chainRoot / chainDelay`). Under
'load' such a chain's timing differs, and GateSim can resolve a hold race the other way from the cycle engine's unit-delay
tables: the skew pair (seqdeep.ts skewPair) is exactly that case.

So DualSim, under 'load', refuses the cycle engine for a design where any clock reaches storage through leaves (a chain
delay > 0); `whyNot` says so. Gated and ripple clocks are already refused and stay on GateSim. Designs clocked straight from a
pin (every CPU) keep the cycle engine.

A test runs, on GateSim under 'load', in lock step with the cycle engine (equal state every cycle):
- the single-cycle and pipelined CPUs;
- DFF_R (asynchronous reset).

It also checks that the skew pair is refused under 'load' and accepted under the unit model.

**Not changed:** SwitchSim, NmosSim and BitSim (no gate time), static timing (already has the models), relax() (zero delay by
definition).

## Unit-delay behaviour stays byte-identical by default

- **Default.** The model is 'unit' unless a caller asks; `ticksPerUnit = 1`, RING = 64, the same fast-path loop.
- **Fingerprint, taken on main before the change** (like the RV16 answers' pin): a hash of the full `onTrace` stream (net,
  value, time) with every net watched, over a fixed set:
  - the single-cycle and pipelined CPUs, 300 cycles of a program;
  - the master–slave DFF and DFF_EDGE6 over the setup / hold sweep;
  - an SR latch released symmetrically (the relax path);
  - a 5-stage ring oscillator for 200 units;
  - the ripple clock divider;
  - a slow fault.

  Also hashed: `evaluations`, the final `time` and the `unstable` flags. Checked in as tests/gatesim-fingerprint.json; the test
  fails on any difference.
- **A second fingerprint for stepping**, since the first hashes only the engine's own trace: the sequence of `sim.time` after
  each `stepEdge` call, on a CPU's rising edge with no period and with a fixed period, and on the bar's Step through an input
  change. That catches a stepping rule that skips or overshoots instants.
- **tests/gatesim-fast.test.ts** (the typed-array engine against tests/ref, same changes at the same times) keeps passing
  untouched.

## What it lets chapters show

1. **Glitches that depend on loads.** Under the unit model, paths of equal depth tie and their glitches vanish; under 'load'
   the ties break. The adders chapter can show a ripple adder's sum bits glitching more where the carry is heavily loaded,
   and the power estimate (glitch toggles, power.ts) rising with it: "glitch power" measured, not asserted.
2. **Races in chapter 8's flip-flops.** The master–slave DFF's setup and hold become fractional (the sweep in tenths). The
   six-gate DFF's internal races are no longer ties, and the skew pair's hold race moves with the clock buffers' load.
3. **A static hazard with a width.** The 2:1 mux's static-1 hazard on `s` is one unit wide today. Under 'load' it is the
   inverter's real delay, and it disappears when the inverter is lightly loaded.
4. **Simulated delay against static timing.** Chapter 14's per-class settle times measured under 'load' sit beside the static
   'load' critical path; where they differ, the difference is a false path.

These are content proposals; each chapter step would opt in with `Scene.delay: 'load'` (decision 2).

## Performance (to measure before landing; acceptance criteria)

The number of events stays about the same (one per change, plus the glitches the loads add). The cost is in instants: under
the unit model an instant batches every gate one level on; under 'load' a level spreads over several instants (22 distinct
delays), so `evalDirty` runs more often on fewer leaves each, and the wheel scan steps over empty ticks.

My estimate: 1.3–2× slower on GateSim under 'load'. scripts/sim-perf.ts gains `--delay load` and reports both.

- **Acceptance:** the unit model within noise of today (±3 %). This must be measured, not assumed: the per-instance mask
  replaces a constant modulo, though the loop is otherwise the same. 'load' at ≥ 50 % of the unit model's cycles/s on
  the single-cycle CPU.
- **If 'load' misses that:** batch the wheel scan (skip runs of empty slots with a bitmap) before anything else.
- The cycle engine, which cycle mode uses, is not affected at all.

## Decisions (recommendation first)

1. **Grain.** *Recommended:* integer tenths of a unit. Alternatives: hundredths (no visible gain, ten times the wheel); floating
   time (inexact ties, slower).
2. **Who turns it on.** *Recommended:* chapter scenes stay on the unit model unless the step sets `Scene.delay: 'load'`. The
   existing **Load-dependent delay** setting (settings.loadDelay, today only the Timing panels and the inspector) also times the
   gate-level simulation in the sandbox and the workbench, where nothing is written against unit-delay numbers.

   Why not chapters too: some learners already have the setting on, and coupling it to every chapter scene would silently
   change, for them:
   - tours timed in gate delays (tests/tours.test.ts pins them under the unit model);
   - "settled in n gate delays" readouts the prose quotes;
   - chapter 8's measured setup and hold;
   - any scene with a fixed clock period sized in unit delays. The 'load' critical path is longer, so such a scene would start
     capturing wrong values.

   Alternatives:
   - The setting reaches chapters too: simpler to explain, with the risk above. Every step with a tour, a quoted delay or a
     fixed period would then need `delay: 'unit'` pinned.
   - A separate simulation setting.
3. **Which models simulate.** *Recommended:* 'unit' and 'load' only. 'drawn' gives an unbuffered clock net of 805 units: true to
   the drawing, but a learner would see a CPU that never settles within a cycle, which teaches nothing new. Keep it for static
   timing.
4. **Transport or inertial delay.** *Recommended:* keep transport (as today): every pulse is shown, the semantics stay one
   rule, and glitches are what the feature is for. Inertial (a pulse shorter than a gate's delay is swallowed) is closer to
   silicon; offer it later as an option if a chapter needs it.
5. **Root inputs.** *Recommended:* ideal, as today (an input changes at its instant). `inputArrivals` (a minimum NAND outside
   driving each input) stays a static-timing convention.
6. **Cycle mode.** *Recommended:* stays on the cycle engine for designs clocked straight from a pin. Under 'load', DualSim
   refuses the cycle engine where a clock reaches storage through leaves, and `whyNot` says why. GateSim under 'load' is for
   gate mode, stepping, the analyzer and the opted-in chapter steps' slow motion. Alternative: accept the mismatch on
   clock-chain designs (wrong values without a word: no).
7. **Behavioural leaves** (memories, the ROM). *Recommended:* their declared delays in units × 10, unchanged in meaning.

## What a learner would see (for the author)

Beyond the setting:
- the time readout with one decimal while it is on;
- slow motion where a heavily loaded gate's front takes visibly longer;
- glitches and races that differ from the unit model.

The chapter steps in "What it lets chapters show" would be new content, each needing the author's approval.

With decision 2 as recommended, chapters change only in the steps that opt in. The setting changes the sandbox and the
workbench, and only for learners who have it on, which some already do for the Timing panels: for them, the gate-mode run bar
and slow motion there would start showing tenths and load-shaped glitches. The menu item's description would say so.

## Stages, each a tip

1. Both fingerprint tests on main (engine trace and stepping times), hashes taken before any engine change.
2. GateSim scale + per-instance ring and mask + Sim.ticks / nextEventTime; edge.ts; save / adopt; DualSim's clock-chain refusal under
   'load'; the lock-step tests against the cycle engine; sim-perf `--delay`.
3. Views: the run bar's readout, slow motion by delay, analyzer, VCD; the setting reaches the sandbox and the workbench;
   `Scene.delay` for chapter steps.
4. Measurers (settle, opdelay, edgetiming, cycletime) take the model.
5. Chapter steps, after the author approves them.
