# Plan: From netlist to FPGA

A chapter that explains what the sandbox's **File ▸ Export Verilog for FPGA…** already does: the same netlist that chapter
`silicon` turns into masks goes onto a chip whose logic is a grid of look-up tables, whose wires are switches, and whose
memories are blocks of RAM, configured in milliseconds rather than manufactured in months.

**Status: APPROVED by the author on 2026-11-09 as shown in the mockup, with every recommended decision below**, including the
order silicon → fpga → verify (chapter id `fpga`; Ross's verification chapter `verify` follows it). Built in stages, each a tip:
1. sim/lutmap.ts + lib/fpga.ts with tests ✅ (feat/fpga-lut)
2. CI numbers: nextpnr-himbaechel + Apicula in a workflow, fpgacosts.json pinned ✅ (feat/fpga-pnr: scripts/fpga-pnr.ts, .github/workflows/fpga.yml)
3. The chapter (numOf everywhere; every "to be measured" cell measured before it reaches the prose)
4. Codex entries, the side level and the drill

Phase 23, "From netlist to FPGA". Mockup: `E:/mockups/fpga/index.html` (steps 2, 4 and 9, light
and dark; screenshots `E:/mockups/fpga/{a,b,c}-{light,dark}.png`).

## What exists already

- `src/editor/fpga.ts` `fpgaExport(def, base)`: the synthesizable export (vexport.ts) with sandbox I/O punched out as ports, a
  board top for the Sipeed Tang Nano 9K (GW1NR-9: 27 MHz clock ÷ 2^DIV_LOG2, power-on reset, two buttons, six LEDs, header
  pins), an example `.cst`, a README, and a report (latch loops still drawn as NANDs, ff chips with extra pins, initial
  contents, asynchronous-read memories, pins with no board pin).
- `vexport.ts` memClock: memories exported for block RAM, read through a register on the board's clock; `scripts/fpga-memcheck.ts`
  proves it cycle-equal to the asynchronous memories (CI: 200 cycles, the ROM → RAM chain).
- `scripts/fpga-export.ts` (a deploy gate): Yosys `synth_gowin` on two examples. Last deploy (run 42650199813):
  - counter7: **12 LUTs, 26 flip-flops**, 0 block RAMs (60 cells, 29 modules)
  - computer: **4 448 LUTs, 1 178 flip-flops, 10 block RAMs** (7 440 cells, 78 modules), against the GW1NR-9's 8 640 LUTs and 26 BSRAMs
- What does **not** exist: place and route, a timing report, any explanation on the site. Nobody sees a LUT.

## Placement and builds-on

- **Recommended: right after `silicon`** (chapter 28 today, so this would be 29; numbers follow chapters/order.ts). The two chapters are a pair: the same netlist, two
  ways to make it physical. Silicon already taught technology mapping, placement, routing and static timing on standard cells,
  so this chapter can be short on those and spend its steps on what is different: the cell is a memory, the wires are switches.
- The verification chapter is approved to come after `silicon` too. Order to decide (Decision 1): silicon → fpga → verification
  keeps the two physical chapters together; silicon → verification → fpga keeps verification's approved place.
- builds: `memory` (a ROM / mux tree is a LUT), `latches` / `registers`, `adders` (the carry chain), `silicon` (mapping, P&R,
  timing), `routing` (the transmission gate that becomes a routing switch).

## Goals ("In this chapter you will …")

1. build a look-up table from a mux tree and a few flip-flops, and program it into any function of four inputs
2. cover a netlist with 4-input LUTs and say why LUT depth, not NAND depth, sets an FPGA's logic delay
3. explain where an FPGA's area and delay go: routing switches, carry chains, block RAM
4. read the report for our computer on a Tang Nano 9K: LUTs, flip-flops, block RAM, and the clock it reaches against our own estimate

## Steps (11 + recap)

| # | Title | Scene / widget | What it shows |
|---|---|---|---|
| 1 | Hardware you can rewrite | widget `fpgaWhy` | A mask set against a board: cost, weeks, how many times you can change it. The computer of the sandbox, the same Verilog, both ways. Sets up the question: what kind of chip can become any circuit? |
| 2 | A look-up table is a memory | **scene** `LUT4` (new, lib/fpga.ts) | 16 configuration flip-flops (or constants) into a 16:1 mux tree built from `muxTree` (60 NANDs, fifteen 2:1 muxes in four levels); the four inputs are the select. Config bits are clickable; presets AND, XOR, full-adder sum, carry, majority. The truth table *is* the config. NAND cost of a LUT4 against the 9-NAND full adder it replaces. Mockup step A. |
| 3 | Any function of four inputs | widget `lutProgrammer` | Type a Boolean expression (lib/boolexpr.ts) → the 16 bits; 2^16 functions, one cell. Why 4 (or 6) inputs: the mux grows 2^k, the logic it replaces grows slower. Table: k vs cost vs coverage. |
| 4 | Covering a netlist with LUTs | **widget** `lutCover` over our circuits (new sim/lutmap.ts) | Technology mapping again, now onto LUT4s: the 9-NAND full adder (6 deep: 2 LUTs, 1 level), the 4-bit ripple adder (36 NANDs, 12 deep: measured 10 LUTs, 3 levels: the mapper splits the carry into generate / propagate two bits at a time, which the step can show), the ALU; cuts drawn over the gates, NAND depth vs LUT depth, LUT count. Our mapper is checked equal by simulation; its counts are compared with Yosys's (`abc -lut 4`). Mockup step B. |
| 5 | The logic cell | scene `SLICE` (LUT4 + DFF + carry mux + output select) | What sits beside the LUT: a flip-flop (so a registered output costs no extra cell) and a dedicated carry chain. The ripple adder in plain LUTs against the same adder on the carry chain (LUTs and levels). Gowin's names (CLS, CFU, ALU mode) in a Layers aside, marked as the vendor's. |
| 6 | The wires are switches | scene `SWITCHBOX` at switch level (TGATEs from lib/switchparts.ts, config flip-flops) | A routing switch is a transmission gate held on by a configuration bit; a switch box joins tracks. Island-style grid widget (`fpgaRoute`): place a few LUTs, route nets through switch boxes with our Lee router (sim/pnr.ts), count switches per net. The point: most of the area and most of the delay is routing. |
| 7 | Memories: block RAM or flip-flops | widget `bsramVsFf` | Our 4K × 32 RAM as flip-flops + mux trees (LUTs, FFs it would take, too many for the device) against one 18-Kbit block RAM column. Why the export reads memories through a register on the board's clock (memClock) and why it is still cycle-equal (fpga-memcheck). |
| 8 | Configuration | widget `bitstream` | Every LUT bit, switch and BSRAM init is a configuration bit in SRAM, loaded from flash at power-on. Count them for our tiny model; the device's bitstream size (to be read from the vendor datasheet). Why an SRAM FPGA forgets at power-off and an antifuse / flash FPGA does not. |
| 9 | Our computer on a Tang Nano 9K | widget `fpgaReport` (numbers from CI, pinned) | The export's files, the board top (clock divider, reset, pins), what the report flagged. Utilization bars: 4 448 / 8 640 LUTs, 1 178 FFs, 10 / 26 BSRAMs. Where the LUTs went, by block (the export keeps the hierarchy: Yosys `stat` per module). Mockup step C. |
| 10 | Timing: the estimate against the tool | widget `fpgaTiming` (new CI: nextpnr) | Our static timing (sim/timing.ts) in LUT levels × a LUT + routing delay, against nextpnr's reported Fmax after place and route; where they disagree (routing, fan-out, the carry chain). Same shape as silicon's "The real thing". |
| 11 | FPGA, ASIC or CPU? | widget `fpgaCompare` | The same computer three ways: simulated here, on the FPGA, on sky130 (silicon's numbers): clock, area, energy per operation, cost for 1 / 1 000 / 1 000 000 units. When each wins. |
| R | Recap | | keep / three checks / practise |

Folded deeper material (Layers, `more`): LUT6 and fracturable LUTs, how a real CLB packs two LUTs, DSP blocks, the
Gowin family's names, partial reconfiguration, open-source toolchains (Yosys, nextpnr, Apicula) and why vendors' formats were
closed. Tours (Beats): step 2 (an input change walks down the mux tree), step 5 (a carry rippling up the chain).

## New code

- **lib/fpga.ts** (stage 1, built): `lut(k)` (the configuration bits are a `cfg` input; muxTree under it; a LUT4 is 60 NANDs; spec =
  the truth table up to k = 5), `SLICE` (LUT4 + carry: p ⊕ cin and cout = p ? cin : i0, a DFF, output select), `ROUTE_SWITCH` (a
  transmission gate and its inverter at switch level: 4 transistors). Stage 3 adds `switchBox(n)` and `islandGrid(w, h)` for the
  routing widget. Specs and behaviour tests as usual; layout tests apply.
- **sim/lutmap.ts** (stage 1, built): k-feasible priority cuts (k 2 … 6), depth-optimal then area recovery by area flow, on our flat
  NAND netlist; storage loops (gate SCCs) and behaviour leaves are boundaries, tie cells fold into the tables; returns LUTs with their
  tables (bigint: 64 bits at k = 6), levels and the gates each covers. Measured: full adder 2 LUTs / 1 level, rca4 10 / 3. Checked by
  simulating the mapped LUT netlist against the original over every input (≤ 12 bits) or random vectors. Numbers compared with
  Yosys's in a script, not pinned (they will differ: Yosys maps before our hierarchy is flattened the same way).
- **scripts/fpga-pnr.ts** + CI job: `nextpnr-himbaechel` for Gowin (Apicula's chip database; both on PyPI as YoWASP packages, as
  Yosys is) on the exported counter7 and computer, writing `src/fpga/fpgacosts.json` (LUTs, FFs, BSRAM per module, Fmax, the
  critical path's LUT levels and routing share). Checked in like `bench/results.json`; a test fails when the export changed
  and the numbers were not refreshed. Not a deploy gate at first.
- **widgets/fpga*.ts**: the widgets above, in their own chunk.
- **Codex** (chapters/taught.ts rows): look-up table, FPGA, configuration bitstream, block RAM, carry chain, routing switch / switch
  box. Check yourself: two quizzes each.
- **Campaign** (optional, Decision 5): one side level in act 4 "A look-up table" (build LUT2 → LUT4 from the 2:1 mux and
  flip-flops, graded on NANDs), and a drill "program the LUT" (a function given as a sentence → the 16 bits).

## Decisions (recommendation first)

1. **Placement.** *Recommended:* right after `silicon`, verification after it. Alternative: after verification.
2. **Live Yosys in the page?** *Recommended:* numbers from CI, checked in (fast, no 30 MB download), with an optional
   "Synthesize this in your browser" button on counter7 only, reusing hdl/yosys.ts's loader. Alternative: CI numbers only.
3. **Our own LUT mapper?** *Recommended:* yes (sim/lutmap.ts): every cover on the page is drawn over our own gates and checked by
   simulation, and any scene can be mapped. Alternative: show Yosys's counts only (no picture of a cut).
4. **Place and route for timing.** *Recommended:* add nextpnr-himbaechel in CI, numbers checked in. Alternative: our estimate only
   (step 10 becomes an estimate with no check, which the silicon chapter's precedent argues against).
5. **Campaign.** *Recommended:* codex entries + one optional side level (LUT from muxes) + one drill. Alternative: codex only.
6. **How Gowin-specific.** *Recommended:* teach a generic island FPGA with LUT4s (the model is ours, so every bit can be shown),
   and name the Tang Nano's real resources only where CI measures them or the vendor documents them. Facts to read from the
   GW1NR-9 datasheet before writing: flip-flop count, BSRAM block size and count (we use 26), configuration bitstream size,
   LUTs per CFU.

## Cost (rough)

| Piece | Days |
|---|---|
| lib/fpga.ts (LUT, slice, switch box, grid) + tests | 1.5 |
| sim/lutmap.ts + tests | 2 |
| CI nextpnr job, fpgacosts.json, pin test | 1 |
| Widgets (8) | 4 |
| Chapter prose, tours, layers, quizzes, recap | 2 |
| Codex (6 entries), side level, drill | 1.5 |
| Smoke, phone, both themes, review | 1 |
| **Total** | **≈ 13** |

Risks: nextpnr-himbaechel's YoWASP build and Apicula's GW1NR-9 database must run on the CI runner (check first, half a day);
the 8 640-LUT device leaves 48 % headroom for the computer today, so a bigger example (the pipelined core) may not fit.
