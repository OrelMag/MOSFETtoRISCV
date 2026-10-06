# MOSFET → RISC-V

An interactive journey from a single transistor to a multi-core RISC-V processor laid out on
silicon, as a static website.

Every level is built only from the level below it, and **every box is transparent**: double-click
any part to look inside, all the way down to the MOSFETs. Wire values are computed live by a
gate-level simulator (with real gate delays) and a switch-level transistor solver. Transistor
counts, gate counts and critical paths are measured from the circuits themselves, and every CPU
is co-simulated against a RISC-V golden model.

## What's inside

**26 chapters**, from the MOSFET, the CMOS inverter and NAND, through gates, binary numbers,
adders, multiplexers, latches, registers and memory arrays, to the ALU, the register file, RV32I
assembly, a single-cycle CPU, faster adders, pipelining (hazards, forwarding, branch prediction),
bytes and memory-mapped I/O, traps and interrupts, multiply / divide, caches, multicycle and
microcoded control, floating point (RV32F), many cores (atomics, coherence), and finally place
and route on silicon. Each chapter has optional challenges, each with a revealable answer.

**Workbench** (`#/workbench`): open any library component or parametric family on its own,
drive its inputs, drill into it, read its truth table, timing and Verilog.

**Sandbox** (`#/sandbox`): a circuit editor in the spirit of Sebastian Lague's *Digital Logic Sim*,
built on the same simulator, so whatever you build is a real component of the site.

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

Inspired by *Turing Complete*, Sebastian Lague's *Digital Logic Sim*, *nand2tetris*, and Harris &
Harris. The structure and HDL follow the companion primer in `References/`.
