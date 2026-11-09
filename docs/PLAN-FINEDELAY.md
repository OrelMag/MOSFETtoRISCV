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

- **The wheel.** `RING` becomes per instance: the next power of two above the largest delay in ticks, at least 64. That is 64
  under the unit model (today's code), and 256 under 'load' on the CPU (largest delay 180 ticks, a memory's). A delay that
  does not fit throws as it does today.
- **The NAND fast path.** It keeps `slot1 = time + 1` when `ticksPerUnit = 1`. Under a scale, the loop reads `delay[li]` per NAND.
  The loop is written twice and chosen once per `evalDirty` (no per-NAND branch), so the unit-model loop is the same code it is
  now.
- **Order on a net is preserved.** Each net has exactly one driver with one fixed delay, so its events still arrive in the
  order they were scheduled, and `proj`'s transport semantics hold unchanged.
- **Time in the API.** `Sim.time` stays in units: under a scale it is `ticks / ticksPerUnit` (2.3), and exact integers under
  the unit model. A new `Sim.ticks` (integer) and `Sim.ticksPerUnit` serve code that needs exact arithmetic. `runUntil(t)` takes
  units and rounds to ticks. `step()` already advances to the next instant that holds events, so it means "the next event",
  which under a scale is often 0.5 or 1.5 units on.
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
| sim/edge.ts | `stepEdge` advances to the next event (`step()`), not `time + 1`; LIMIT scaled |
| sim/settle.ts, opdelay.ts, edgetiming.ts, riscv/cycletime.ts | take the model; report units with one decimal (`fmtDelay`). edgetiming's setup / hold sweep steps in tenths under 'load' |
| sim/power.ts | nothing in the code: toggles are counted per change, so glitches that loads create (or remove) count by themselves |
| sim/vcd.ts | `$timescale` 100 ps with tick times under a scale (1 ns per unit as today otherwise) |
| view/stage.ts | `t = 12.3` and "settled in 12.3 units" under 'load'; the bar's Step goes to the next event |
| view/schematic.ts (slow motion) | a change's front is drawn over its driver's delay (`flowMs · delay`), so a loaded gate is visibly slower |
| view/analyzer.ts | time axis and cursors in units with ticks; the trace already stores times as numbers |
| editor/runtime.ts (sandbox gate mode) | the same setting reaches EditorSim's GateSim |

**CycleSim is unchanged.** It has no time; its tables (ffmacro.ts) are built from unit-delay simulation of each storage cluster,
and its claim is the settled values of a synchronous design, which do not depend on gate delays. DualSim keeps cycle mode on the
cycle engine whatever the model. Designs whose settled result depends on delays (gated and ripple clocks, hazards on a clock)
are already refused by the cycle engine and stay on GateSim. A test runs the single-cycle and pipelined CPUs on GateSim under
'load' in lock step with the cycle engine: equal state every cycle.

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

- **Acceptance:** the unit model within noise of today (±3 %, same code path). 'load' at ≥ 50 % of the unit model's cycles/s on
  the single-cycle CPU.
- **If 'load' misses that:** batch the wheel scan (skip runs of empty slots with a bitmap) before anything else.
- The cycle engine, which cycle mode uses, is not affected at all.

## Decisions (recommendation first)

1. **Grain.** *Recommended:* integer tenths of a unit. Alternatives: hundredths (no visible gain, ten times the wheel); floating
   time (inexact ties, slower).
2. **Who turns it on.** *Recommended:* two ways.
   - The existing **Load-dependent delay** setting (settings.loadDelay, today only the Timing panels and the inspector) also
     times the stage's and the sandbox's gate-level simulation, so one switch means one thing everywhere.
   - A chapter step can force it with `Scene.delay: 'load'` for the steps that teach with it.

   Alternative: a separate simulation setting.
3. **Which models simulate.** *Recommended:* 'unit' and 'load' only. 'drawn' gives an unbuffered clock net of 805 units: true to
   the drawing, but a learner would see a CPU that never settles within a cycle, which teaches nothing new. Keep it for static
   timing.
4. **Transport or inertial delay.** *Recommended:* keep transport (as today): every pulse is shown, the semantics stay one
   rule, and glitches are what the feature is for. Inertial (a pulse shorter than a gate's delay is swallowed) is closer to
   silicon; offer it later as an option if a chapter needs it.
5. **Root inputs.** *Recommended:* ideal, as today (an input changes at its instant). `inputArrivals` (a minimum NAND outside
   driving each input) stays a static-timing convention.
6. **Cycle mode.** *Recommended:* stays on the cycle engine, delay-independent; GateSim under 'load' is for gate mode,
   stepping, the analyzer and the chapters' slow motion.
7. **Behavioural leaves** (memories, the ROM). *Recommended:* their declared delays in units × 10, unchanged in meaning.

## What a learner would see (for the author)

Beyond the setting:
- the time readout with one decimal while it is on;
- slow motion where a heavily loaded gate's front takes visibly longer;
- glitches and races that differ from the unit model.

The chapter steps in "What it lets chapters show" would be new content, each needing the author's approval. Nothing changes for
anyone who leaves the setting off.

## Stages, each a tip

1. Fingerprint test on main (hashes taken before any engine change).
2. GateSim scale + per-instance ring + Sim.ticks; edge.ts; save / adopt; the lock-step test against the cycle engine; sim-perf `--delay`.
3. Views: the stage readout, slow motion by delay, analyzer, VCD; the setting reaches the stage and the sandbox.
4. Measurers (settle, opdelay, edgetiming, cycletime) take the model.
5. Chapter steps, after the author approves them.
