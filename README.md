# MOSFET → RISC-V

An interactive journey from a single transistor to a RISC-V processor, as a static website.

Every level is built only from the level below it, and **every box is transparent**: double-click
any part to look inside, all the way down to the MOSFETs. Wire values are computed live by a
gate-level simulator (with real gate delays) and a switch-level transistor solver. Transistor
counts, gate counts and critical paths are measured from the circuits themselves.

**Ready now:** the MOSFET · CMOS inverter · NAND · gates from NAND · binary numbers · adders ·
decoders & multiplexers · latches & flip-flops · registers & counters · scalable memory arrays,
plus a workbench for exploring any component on its own.

**Next:** ALU, register file, RISC-V assembly, single-cycle → pipelined CPU, multiply/divide,
interrupts, caches, multi-core, and finally layout on silicon. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # simulator + library correctness
npm run build      # static site in dist/ (works from any path or host)
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`
(enable it once under *Settings → Pages → Source: GitHub Actions*).

## How it is built

- `src/sim/`: hierarchy flattener, event-driven 0/1/X gate simulator, switch-level solver,
  statistics, Verilog generation
- `src/lib/`: the component library, from transistors to RAM, each defined as a netlist of
  smaller components
- `src/view/`: SVG schematics with drill-down, inspector (info, truth table, Verilog, waves)
- `src/chapters/`: the narrative
- `CLAUDE.md`: architecture and conventions in detail

Inspired by *Turing Complete*, Sebastian Lague's *Digital Logic Sim*, *nand2tetris*, and Harris &
Harris. The structure and HDL follow the companion primer in `References/`.
