# MOSFET → RISC-V

An interactive journey from a single transistor to a multi-core RISC-V processor laid out on
silicon, as a static website.

Every level is built only from the level below it, and **every box is transparent**: double-click
any part to look inside, all the way down to the MOSFETs. Wire values are computed live by an
event-driven gate-level simulator (one delay unit per NAND, so glitches and races are visible) and
a switch-level transistor solver. Transistor counts, gate counts and critical paths are measured
from the circuits themselves, every CPU is co-simulated against a RISC-V golden model, and the
dual-core is exported as Verilog and taken through Yosys and OpenROAD to a sky130 layout.

## What's inside

**26 chapters**, from the MOSFET, the CMOS inverter and NAND, through gates, binary numbers,
adders, multiplexers, latches, registers and memory arrays, to the ALU, the register file, RV32I
assembly, a single-cycle CPU, faster adders, pipelining (hazards, forwarding, branch prediction),
bytes and memory-mapped I/O, traps and interrupts, multiply / divide, caches, multicycle and
microcoded control, floating point (RV32F), many cores (atomics, coherence), and finally place
and route on silicon. Each chapter has optional challenges, each with a revealable answer.

**Campaign** (`#/campaign`): a tree of levels in the spirit of *Turing Complete*, from a NAND made
of transistors to a pipelined, interrupt-capable 16-bit RISC-V-like CPU. Each level is built only
from parts earlier levels unlocked, checked by a full test set, graded against par, and has a
reference solution; drills, assembly puzzles and a codex sit alongside. Plan and status in
[docs/CAMPAIGN.md](docs/CAMPAIGN.md).

**Workbench** (`#/workbench`): open any library component or parametric family on its own,
drive its inputs, drill into it, read its truth table, timing and Verilog.

**Sandbox** (`#/sandbox`): a circuit editor in the spirit of Sebastian Lague's *Digital Logic Sim*,
built on the same simulator, so whatever you build is a real component of the site. The full
guide is [docs/SANDBOX.md](docs/SANDBOX.md).

- Place parts from the whole library (or only NAND and transistors in *purist* mode), draw wires
  freehand with corners and branches, and connect distant nets with **pointers** (named net labels).
- Watch values live, per clock cycle or one gate delay at a time; probe wires into a timing
  diagram (VCD export), and read a chip's static timing with its critical path drawn on it.
- **Package** a circuit as a chip (name, colour, pin order), use it in other circuits, nest chips
  to any depth and edit them later: every user of the chip is rebuilt.
- **Look inside** any placed part, live, down to the transistors.
- Switch-level parts beyond the MOSFET: resistors, pull-ups / pull-downs, capacitors, transmission
  gates and tri-state drivers, so shared buses, wired-AND / wired-OR and pseudo-NMOS logic work.
- Recreate **every level** of the journey: chips built from transistors are solved at switch
  level and become gate-level bricks; latches, flip-flops (recognised by static timing), RAM with
  initial contents, and a **program ROM** whose contents you write in RISC-V assembly or hex.
- **Open in Sandbox** turns any schematic from the chapters or the workbench, CPUs included, into
  an editable copy.
- A **CPU panel** for any chip that is a processor (opened from a chapter or built by you): the
  program with the current instruction, registers, memory, Run to halt / Step instruction, and every
  retired instruction checked against the golden model.
- Save automatically in the browser, export / import chip files, share a circuit as a link,
  export structural Verilog or an image.
- 21 optional **build challenges** at every level, from a CMOS inverter to an instruction fetch
  unit, checked against a truth table or a clocked sequence, with par scores and reference answers.

## How it is checked

- **Components**: every combinational component carries a specification and is tested against its
  structure, exhaustively up to 12 input bits and on random vectors above; behavioural models
  (used to keep large designs fast) are proven equal to the structure they stand for.
- **CPUs**: each one (single-cycle, multicycle, pipelined, with caches, system, M, F, dual-core) is
  co-simulated against the instruction-set simulator in `src/riscv/`, which steps in lock-step and
  compares registers, PC and memory at every retirement. The campaign's RV16 cores are also fuzzed
  with seeded random programs.
- **Drawings**: every registered schematic is checked for nets sharing a line, overlapping symbols
  and hidden labels.
- **HDL**: generated SystemVerilog comes with a self-checking testbench drawn from our own
  simulation; `scripts/verify-export.ts` synthesizes the dual-core with Yosys, simulates the gate
  netlist and compares it cycle by cycle with the site's simulation.
- **Silicon**: `.github/workflows/layout.yml` runs the exported dual-core through
  OpenROAD-flow-scripts on SkyWater 130 nm (synthesis, floorplan, placement, clock tree, routing)
  and the GDS, tiles and reports are published into the site (chapter 25).

## Scope and limitations

This is a teaching instrument for engineers, not a sign-off tool. What it models, exactly:

- **Transistors are switches.** The switch-level solver resolves 0 / 1 / X / Z with drive
  strengths (rails, transistors, resistors) and stored charge on capacitive nodes. There is no
  I–V curve, threshold, sizing, leakage or analog transient: it is not SPICE.
- **Timing is in NAND delays.** Every NAND costs one unit; static timing finds the longest
  register-to-register path in those units. Clock rates in MHz assume an **illustrative 25 ps per
  NAND** (a loaded NAND2 in a 28 nm-class process), not timing characterized from a cell library:
  no slew, load, wire RC, skew or corners. The sky130 run's own reports are the real numbers.
- **Two kinds of place and route.** The placer (simulated annealing) and router (two-layer Lee) in
  `src/sim/pnr.ts` are teaching models run on small netlists; the full layout comes from OpenROAD.
- **Power-on is a model.** Storage loops are resolved to a deterministic (or chosen random) state
  so a design can settle; real power-up depends on mismatch, noise and ramp.
- **The CPUs are teaching microarchitectures**: in-order, a cache miss freezes the whole pipeline,
  and the dual-core's atomics are atomic because a round-robin arbiter serializes every access.
- **The golden model is ours.** The CPUs are checked against an ISS written for this project, so a
  misreading of the specification shared by both would pass. Running the official `riscv-tests`
  and an independent ISS is planned (`docs/ROADMAP.md`, Phase 13).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # simulator, library, CPUs and editor correctness
npm run build      # static site in dist/ (works from any path or host)
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`
(enable it once under *Settings → Pages → Source: GitHub Actions*).

## How it is built

Vite + TypeScript, no UI framework: plain DOM and SVG.

- `src/sim/`: hierarchy flattener, event-driven 0/1/X gate simulator, switch-level solver,
  bit-parallel test simulator, statistics, static timing, Verilog generation and export
- `src/lib/`: the component library, from transistors to CPUs, each defined as a netlist of
  smaller components
- `src/riscv/`: ISA tables, assembler, disassembler and the golden-model simulator
- `src/view/`: SVG schematics with drill-down, inspector (info, truth table, Verilog), timing panel
- `src/editor/`: the sandbox (document model, compiler to components, user-chip library, editor UI)
- `src/chapters/`: the narrative
- `CLAUDE.md`: architecture and conventions in detail; `docs/ROADMAP.md`: plan and status

## License

[MIT](LICENSE).

Inspired by *Turing Complete*, Sebastian Lague's *Digital Logic Sim*, *nand2tetris*, and Harris &
Harris. The structure and HDL follow the companion primer in `References/`.
