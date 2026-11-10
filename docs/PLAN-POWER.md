# Plan: the chapter "Power" (Phase 23)

**Approved 2026-11-09** by the author as shown (mockup artifact https://claude.ai/artifact/MrTBNyksDH3UrF23iDUzAC), every decision
as recommended: placement right before `lanes`; decision 2 = chapter 2's device law with a subthreshold (EKV) tail, calibrated to
0.9 V / 25 ps per NAND, the off current from a cited process figure, two flavours; clock gating on the register file and data
memory; glitches measured only; the codex `clockgating` entry gains the ICG; an optional `s_icg` level; chapter id `power`.
Built as three branches: (a) feat/power-model (this note), (b) the chapter, (c) codex and campaign.

**Resolved in (a)** (every "sketch" number below is now computed; src/bench/powercosts.json, tests/power-costs.test.ts):
- Device law (phys/cmosv.ts): the two processes are ITRS 2013 PIDS's high-performance logic (Ioff 100 nA/µm, Ion 1 355 µA/µm)
  and low-standby-power logic (10 pA/µm, Ion 35 % of high performance's); n = 1.4 (83 mV/decade, inside Taur & Ning's 70–100).
  Each threshold is solved from its on/off ratio (0.174 V and 0.520 V), each transistor width from the book's 25 ps per NAND
  at 0.9 V (35 nm and 99 nm). No DIBL: a stack of two off transistors leaks half of one, said so in the text.
- Leakage (sim/leakage.ts) from the simulation's own state, NAND by NAND: on `sum` the CPU leaks 161 µW (high performance;
  0.64 pJ of the 46.5 pJ an instruction costs at 0.9 V) or 0.046 µW (low leakage).
- Clock gating measured (lib/clockgate.ts ICG + gatedRegister, regfile / ram / dataMemory gated, singleCycleCpu gatedClocks):
  21.05 → 13.91 pJ per cycle on `sum` (−34 %), 56 498 → 48 938 NANDs (the enable muxes go), clock net 6 554 → 254 fF. The ICG
  has a setup time (4 NAND delays) and hold (1) like a flip-flop. The gated CPU's glitch share rises (28 % → 70 %): its
  registers change a few delays after the rest, so the read paths switch twice. Chapter (b) explains it.
- Minimum-energy point of the single-cycle CPU: 0.225 V, 12 MHz, 6.1 pJ (high performance); 0.215 V, 8 kHz, 3.9 pJ (low leakage).
- The Activity view already exists (the overlay bar's Activity, ONI); the chapter uses it, nothing new to build there.

Mockup of steps 1, 6 and 10 in light and dark: `E:/mockups/power/index.html` (light.png, dark.png, phone-light.png, phone-dark.png).
The plan as approved follows. Every number below says where it comes from: **measured** = computed today by `sim/power.ts` (a GateSim run
counting every toggle, glitches included) or read from `src/bench/results.json`; **sketch** = computed from measured capacitance and
depth through the device law proposed in decision 2, whose constants are still open. The probe that produced the measured numbers is
kept outside the repo (scratchpad `power-probe.ts`); the chapter's own numbers are recomputed by the chapter and pinned by a test.

## What exists, and what the chapter adds

- `sim/power.ts`: PowerMeter (per-net toggles, settled vs glitch, `breakdown(node)` by the child driving each net, the clock net
  apart), `measurePower` on random vectors / cycles, `netCaps` (0.5 fF per NAND input, 0.5 fF per driver, 0.3 fF of wire per branch).
  Leakage is not modelled. The inspector's Power section, the CPU panel's energy per instruction and the Benchmarks tab already show it.
- `sim/delay.ts`: load-dependent delay (logical effort), no dependence on V.
- `widgets/mosphys.ts` / `phys/inverter.ts`: chapter 2's square-law device (VDD 1.8 V, VT 0.45 V), no subthreshold current.
- Power is **taught in pieces** today:
  - chapter `mosfet` (the codex `power` row in chapters/taught.ts) and its pitfall about "no static power";
  - `silicon`'s "Real" layer: ½CV², α, the clock tree's share, the latched clock gate, leakage per decade of threshold, the power grid;
  - `multicore`: the end of Dennard scaling;
  - codex: `power` (codexnew), its fuller entry (codexmore2), `clockgating` "Never gate the clock" (taught in `latches`), a leakage
    question in codexcheck4, glossary terms.
- This chapter becomes where power is **measured**. What moves and what links:
  - `power` stays first taught in `mosfet` (its row does not move); its codex entry gains a link here.
  - `silicon`'s layer keeps its paragraph and links forward to this chapter for the numbers.
  - `multicore`'s Dennard paragraph links forward to step 12.
  - `clockgating` keeps its rule (never AND the clock by hand) and gains a second half: gate it only through a latch (ICG), with a link to step 6.
  - New codex entries (leakage/stack effect, ICG, DVFS, minimum-energy point, power gating, dark silicon) get rows in `chapters/taught.ts`
    pointing here; tests/first-use.test.ts then holds every use before this chapter to a `data-ahead` or a rewording.

## Placement and builds-on

- **Recommended: right before `lanes`**, as the last chapter of the CPU half. Today that is right after `silicon`; with the planned
  `fpga`, `verify` and `sidechan` it lands after `sidechan`. It depends on none of those three, so it stays correct however they are
  ordered. The text never types its number (`numOf('power')`).
- Why there:
  - it needs every CPU the benchmarks measure (single-cycle, pipelines, M, dual-issue, out of order, multicore), all earlier;
  - it needs `silicon`'s clock tree, cells and leakage paragraph, and answers them with measurements;
  - it hands over to the GPU chapters: dark silicon and energy per operation are the reason for many simple lanes (step 12's last paragraph).
- Alternative: right after `pipeline`/`pipepay` (power where the CPUs are). Rejected: out-of-order, multicore, caches and the silicon
  vocabulary come later, and steps 10–12 need them.
- `builds: ['inverter', 'latches', 'cpu', 'pipeline', 'cache', 'ooo', 'multicore', 'silicon']` (chapters on main only).

## Goals (the first step)

1. Measure where a CPU's energy goes, net by net, and see that the clock and storage take most of it.
2. Tell dynamic from static power, and see glitches and leakage come out of the simulation, not out of a formula.
3. Gate a clock safely and measure what it saves and what it costs.
4. Trade voltage and frequency for energy, and find the minimum-energy point of our CPU.

## Steps (13; `deep` marks a deep dive)

| # | Title | Scene / widget | What it shows (measured unless marked) |
|---|---|---|---|
| 1 | Where the energy goes | scene: single-cycle CPU on `sum`, new **Power panel** (bars by block, live) and an **Activity** stage view | 21.1 pJ / cycle on `sum` at 0.9 V (5.4 mW at 3.88 ns); dm 27 %, clock net 25 %, rf 22 %, ALU 15 %; clock net 6.55 pF over 8 192 NAND inputs, 98 % of them in dm and rf. Mockup step A. |
| 2 | One toggle: ½ C V² | widget `toggleEnergy`: an inverter charging its load at switch level (chapter 2's device), the supply's charge C·V, half left in the pull-up, half stored | Where the ½ comes from; why a 1 → 0 costs the supply nothing. |
| 3 | Activity | scene: 8-bit adder fed by a counter, an LFSR, and a held operand (`vectorPower`), α per net on the Activity view | α is the data's, not the circuit's: the same adder at three activities. |
| 4 | Glitches | scene: ripple-carry adder stepped one gate delay at a time, settled vs glitch toggles; then results.json | Glitches are 48 % of the single-cycle CPU's energy over the four benchmarks, 10 % of the pipeline's: pipeline registers stop the ripple at each stage. |
| 5 | The clock is the biggest net | scene: the CPU with the clock net's readers lit | One net, 6.55 pF, two toggles a cycle; why SRAM is not flip-flops (the dm and rf arrays drive 98 % of it). |
| 6 | Stop the clock where nothing changes | scene: the ICG cell (D latch + AND) beside a bare AND; then the CPU with a gated register file and memory, measured against the plain one | The runt pulse a bare AND makes, and the ICG's clean output; the saving on clock net, rf and dm on `sum`, and the gates' own cost. **To measure** (new hardware). Mockup step B. |
| 7 | Operand isolation (deep) | scene: the ALU's inputs held while its result is not used | Data gating: fewer toggles in a block whose output is discarded. |
| 8 | Leakage | widget `nandLeak`: a NAND's off-state current by input state (stack effect: 00 lowest, 11 highest), then the CPU's leakage summed over its NANDs from the simulation's own values | Static power is state-dependent and computable from the simulator; sketch until decision 2. |
| 9 | Power gating | widget: a halted CPU (the `j .` loop): clock gated, then supply gated; leakage per µs against the energy to save state and wake | Break-even sleep time; why idle blocks are power-gated, not only clock-gated. Sketch. |
| 10 | Lower the voltage, slow the clock | widget `dvfs`: V slider, f from the measured critical path through the device law, energy per instruction split dynamic / leakage, low-leakage vs high-performance process | Minimum-energy point near threshold (sketch: 0.28 V, 6.7 pJ, 1.5 MHz for the low-leakage process; 0.29 V, 8.8 pJ for the other). Mockup step C. |
| 11 | Race to halt or pace yourself | widget: a task with a deadline, run fast then sleep vs run slow at lower V | When DVFS wins and when sleeping wins, from steps 9 and 10. |
| 12 | Which CPU for the job | widget `energyFront`: every CPU by time and energy per instruction (results.json), then each slid along its own V curve to compare at equal speed | At 0.9 V: balanced pipeline 2.22 ns / 46.8 pJ, out of order 2.32 ns / 129.3 pJ, dual-issue 2.12 ns / 69.6 pJ (sums over fib, sort, matmul and CRC-32). Mockup step C, second card. |
| 13 | Power density and dark silicon (deep) | widget: W/mm² from our NAND counts and silicon's sky130 areas, at 28 nm-class density | Why not every transistor can switch at once; hand-off to `lanes`. |

The recap: three questions (where the clock's energy goes; why a bare AND is not a clock gate; why energy per instruction rises
again below the minimum-energy point), practise: the ICG level (decision 6).

## New model work

1. **Device law** (`phys/cmosv.ts`, decision 2): current against V for on and off devices, one law above and below threshold
   (EKV form: equal to chapter 2's square law above threshold, exponential below), DIBL; `delayAt(V)` relative to the 25 ps / NAND
   calibration point; `ioffAt(V)`. Tests: square-law agreement above threshold, the calibration point, monotonicity.
2. **Leakage from the simulation** (`sim/leakage.ts`): per NAND, the off-state current of its input state (stack factor for 00,
   two parallel PMOS off at 11), summed over a GateSim's settled values; per block like PowerMeter.breakdown. Flip-flops leak by their state too.
3. **Activity view**: per-net toggles per cycle on the stage, reusing the slack heatmap's machinery (`data-slack` bands → a
   `data-activity` band, the same toggle and key in view/delayui.ts).
4. **Power panel** (`widgets/powerpanel.ts` scene panel, then the sandbox CPU drawer): live bars by block, energy per instruction,
   glitch share, clock net share; the CPU panel's energy line already computes the totals.
5. **Clock gating hardware** (`lib/clockgate.ts`): ICG (D latch + AND, from the library's D_LATCH and AND), `regfile(k, w, { gated })`
   and `ram(k, w, { gated })` gating each word's clock by its write select; `singleCycleCpu({ gatedClocks })`. Specs and sequence
   tests as for any part; tests/route and layout as usual. Scenes stay on GateSim (the meter needs toggles), so the cycle engine
   refusing a gated clock costs nothing.
6. **Numbers pinned**: `src/bench/powercosts.json` from `scripts/power-costs.ts --write` (step 1's breakdown, step 6's gated vs
   plain, step 8's leakage by state, step 10's curve points), checked by tests/power-chapter.test.ts like the other *costs.json files.

## Codex and campaign

- Codex: new `leakage` (stack effect, Ioff per decade), `icg` (or the second half of `clockgating`, decision 5), `dvfs`,
  `minenergy`, `powergating`, `darksilicon`; links from `power`, `clockgating`, `register`. Each with two Check-yourself questions.
- Campaign: one optional level in act 3 after the register (`s_icg`): build an ICG from a D latch and an AND; the check drives `en`
  at every gate-delay offset across the clock and fails any gclk pulse shorter than the clock's (a runt). Graded in NANDs.

## Decisions (recommendation first)

1. **Placement.** Right before `lanes`, the last CPU chapter (recommended); or right after `pipepay`.
2. **Device law and leakage calibration.** Extend chapter 2's device with a subthreshold tail (EKV form) and one parameter set for
   the 28 nm-class point the timing and power models already use (VDD 0.9 V, 25 ps / NAND), with Ioff tied to a cited process
   figure, two flavours (low-leakage, high-performance) (recommended). Alternative: alpha-power law for delay and a quoted
   nA / NAND for leakage (two laws, no curve below threshold, no minimum-energy point). The sketch today has leakage at 0.5 % of
   the energy at 0.9 V for the low-leakage flavour and 5.4 % for the other, so the choice decides whether steps 8–9 show leakage
   as small or large; the minimum-energy point is set by Ioff / Ion.
3. **What gating covers.** The single-cycle CPU's register file and data memory (recommended: they hold 98 % of the clock's load);
   or also the pipeline registers during a stall.
4. **Glitch reduction.** Measured, not built: the chapter shows the pipeline's lower glitch share from results.json (recommended);
   or also a balanced-path adder variant measured against the ripple.
5. **Codex `clockgating`.** Keep the entry and its rule, add the ICG as its second half (recommended); or a separate `icg` entry
   linked from it.
6. **Campaign level `s_icg`.** Yes, optional, in act 3 (recommended); or none.
7. **Chapter id.** `power` (recommended).

## Cost

- Model and parts: phys/cmosv.ts, sim/leakage.ts, lib/clockgate.ts and the gated variants, the Activity view: about 900 lines with tests.
- Widgets: Power panel, toggleEnergy, nandLeak, dvfs, race-to-halt, energyFront, dark silicon: about 1 300 lines.
- Chapter text, layers, tours, recap, codex (6 entries, 12 questions), campaign level: about 1 000 lines.
- Three branches: (a) model + parts + Activity view + Power panel; (b) the chapter and widgets; (c) codex and campaign.
  Runner gate for (a) (it touches view/ and the CPU options).
