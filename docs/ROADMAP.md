# Roadmap — From MOSFET to RISC-V

The product is a static website that walks a learner from a single transistor to a
multi-core RISC-V processor laid out on silicon. Each level is built **only** from the
levels before it, and every block on screen is a **transparent box**: click it to see what
it is made of, all the way down to MOSFETs.

It is *not* primarily a logic simulator. A simulator is the engine that makes the
journey honest (every value you see is computed, not drawn), but the product is the
narrative: why each step exists, what problem it solves, and what it costs.

Inspirations: *Turing Complete* (progression, "build it to unlock it"), Sebastian Lague's
*Digital Logic Sim* (clean visuals, packaging a circuit into a chip), *nand2tetris*, Harris &
Harris *Digital Design and Computer Architecture: RISC-V Edition*, and the companion primer
in `References/` (NAND → pipelined RV32I, with SystemVerilog sources).

---

## Guiding principles

1. **One brick.** Above the transistor chapters, everything flattens to 2-input NAND
   gates. Gate counts, transistor counts and critical-path depth are therefore *measured*,
   not quoted.
2. **Transparent boxes.** Any instance at any level can be opened. Breadcrumbs always show
   where you are (`CPU › ALU › Adder › Full adder › NAND › transistors`).
3. **Wires tell the truth.** 1-bit wires glow when 1, dim when 0, red when unknown (X),
   dashed when floating (Z). Buses show their value as hex, binary or decimal (global
   setting, per-wire override).
4. **Abstraction is earned.** A component appears as a black box only after the learner
   has seen (and, in challenges, built) its inside.
5. **Cost is visible.** Each component shows transistors / NANDs / gate depth, so the
   learner feels why carry-lookahead, pipelining or caches exist.
6. **Real HDL.** Every component carries SystemVerilog: structural (generated from the
   very netlist on screen) and behavioural (hand-written). VHDL view later.
7. **Static deploy.** `npm run build` → `dist/` that runs from any static host or sub-path.

---

## Architecture (summary — details in `CLAUDE.md`)

| Layer | What it does |
|---|---|
| `src/sim/` | 3-valued (0/1/X) bit-level event-driven simulator with gate delays; hierarchy flattener; switch-level (MOSFET) solver with Z; stats (transistors, NANDs, depth); Verilog generator |
| `src/lib/` | The component library, defined as netlists of lower-level components, plus parametric generators (n-bit adders, decoders, N×W memories) |
| `src/view/` | SVG schematic renderer (ANSI gate symbols, transistor symbols, orthogonal wire routing), pan/zoom, drill-down, truth tables, waveforms, HDL panel |
| `src/widgets/` | Bespoke interactive explainers that are not schematics (MOSFET cross-section, number wheel, memory grid, later: pipeline diagram, layout viewer) |
| `src/chapters/` | Narrative content: steps, scenes, highlights, challenges |
| `src/ui/` | App shell, router (hash-based deep links), theme (light / dark / auto), settings, progress |

**Mixed-level simulation.** A scene is flattened down to NAND gates (exact gate-level
timing) while it stays under a size budget. Above the budget the flattener cuts at
components that provide a behavioural model, and opening such a box starts a *lock-step
sub-simulation* of its structure, driven by the parent's port values (state is seeded
from the behavioural model). Unit tests prove every behavioural model equal to its
structure (exhaustively for small widths, randomly for wide ones), the "formal-lite"
equivalent of the primer's Yosys proofs.

---

## Phases

Status legend: ✅ done · 🚧 in progress · ⏳ planned

### Phase 0 — Foundation ✅
- ✅ Repo, Vite + TypeScript, Vitest, GitHub Pages CI
- ✅ Simulation core: values, flattener, event-driven engine, oscillation detection + relaxation (metastability)
- ✅ Switch-level solver for transistor views (conducting channels highlighted)
- ✅ Schematic renderer: symbols, routing, value-coloured wires, bus labels, junction dots, pan/zoom
- ✅ Drill-down with breadcrumbs down to a single live MOSFET; "open on workbench"
- ✅ Inspector: info and measured cost, live truth table, hand-written + generated Verilog, waveforms
- ✅ App shell: chapters, progress, light / dark / auto theme, HEX/BIN/DEC, deep links, mobile layout
- ✅ Propagation: "slow motion" animation and single-step, settle time in gate delays
- ⏳ Mixed-level simulation (behavioural leaves + lock-step sub-simulation) for CPU-scale designs

### Phase 1 — The early chapters ✅
| # | Chapter | Content |
|---|---|---|
| 0 | The map | The abstraction ladder; how to inspect anything |
| 1 | The MOSFET | Cross-section widget (gate voltage → channel), NMOS / PMOS as switches |
| 2 | CMOS inverter | Pull-up / pull-down networks, no static current, X when both conduct |
| 3 | The NAND gate | 4 transistors, NOR for contrast, why NAND is *the* brick; packaging into a symbol |
| 4 | Gates from NAND | NOT, AND, OR, NOR, XOR, XNOR, 2:1 MUX, with costs |
| 5 | Binary numbers | Unsigned, hex, two's complement, overflow (number-wheel widget) |
| 6 | Adders | Half adder, 9-NAND full adder, ripple-carry (watch the carry ripple), adder/subtractor |
| 7 | Choosing & routing | Decoders 2→4 / 3→8, multiplexers 4:1 / 8:1, bus multiplexers |
| 8 | Memory from feedback | SR latch, gated D latch, master–slave D flip-flop, waveforms, setup/hold intuition |
| 9 | Registers & counters | n-bit register with enable, counter, clocks |
| 10 | Memory arrays | N words × W bits (user-scalable: 4×4 … 64×16), write path (decoder), read path (mux tree), cell grid view, timing |

### Phase 2 — Computing 🚧
- ✅ ALU (add, sub, and, or, xor, shifts, slt/sltu) and flags; barrel shifter
- ⏳ Carry-lookahead and Kogge–Stone adders with depth comparison (optimization intro)
- ✅ Register file (32 × 32, x0 hard-wired), two read ports and one write port
- **Sandbox**: full wiring editor (today the *workbench* opens any library component with free inputs) (place parts from the library, wire, package into a new
  chip, save to local storage and share via URL); Turing-Complete-style build challenges
  checked against a truth table or test vectors

### Phase 3 — The instruction set & assembly ✅
- ✅ RV32I instruction formats with an interactive encoder / decoder (bit-field explorer)
- ✅ In-browser assembler + disassembler, labels and pseudo-instructions (bit-exact vs the primer)
- ✅ Reference ISA simulator (golden model) used to check every CPU
- ✅ Program editor with sample programs (sum, Fibonacci, multiply, sort, GCD, primer test)

### Phase 4 — Single-cycle CPU 🚧
- ✅ Datapath from Phase 1–3 parts; control unit (opcode decoder + ALU decoder), next-PC logic
- ✅ Gate-level (48k NAND) RV32I minus byte/half memory & system; co-simulated vs the ISS every cycle
- ✅ CPU panel: listing, registers, memory, live golden-model check, run to halt, program editor
- ✅ Per-instruction settle time in gate delays (dynamic critical path)
- ⏳ Static critical-path analysis → maximum clock frequency
- ⏳ Animated active path per instruction
- ⏳ Memory-mapped I/O: LEDs, 7-segment display, a text console, a small pixel screen

### Phase 5 — Multicycle & microcode ⏳
- FSM control vs microprogrammed control (primer Appendix D), equivalence shown

### Phase 6 — Pipelining ⏳
- Five-stage pipeline with pipeline-diagram widget (stage × cycle)
- Data hazards → forwarding; load-use stall; control hazards → flush
- Branch prediction (static, then BTB + 2-bit counters) with measured CPI
- Does pipelining pay? Clock period vs CPI comparison from real netlists

### Phase 7 — Full RV32IM + privileged architecture ⏳
- Complete RV32I (all loads/stores, shifts, LUI/AUIPC, JALR, all branches)
- M extension: array multiplier, shift-add, Booth, Dadda tree; restoring / non-restoring division
- Zicsr, machine mode, traps and exceptions (illegal instruction, misaligned access, ECALL/EBREAK)
- Interrupts: CLINT timer, external interrupts via a minimal PLIC, mtvec/mepc/mcause flow animated
- Passing the official `riscv-tests` / architecture tests in the browser (stretch)

### Phase 8 — Memory hierarchy ⏳
- SRAM cell (6T) at transistor level vs the flip-flop array; DRAM cell (1T1C) intuition
- Caches: direct-mapped → set-associative, write-back, hit/miss animation, measured hit rates
- Bus / interconnect basics; MMIO

### Phase 9 — Performance & optimization ⏳
- Floating point (F extension): IEEE 754 explorer, FPU add/mul
- Superscalar and out-of-order intuition (scoreboard / Tomasulo widget)
- Compressed instructions (C), A extension (LR/SC, AMO)
- Virtual memory (Sv32), TLB, U/S/M privilege levels (stretch)

### Phase 10 — Multi-core ⏳
- Two or more cores with private caches and shared memory
- Coherence protocol (MSI → MESI) with an animated bus
- Atomics and a spin-lock demo; memory ordering (FENCE)

### Phase 11 — From netlist to silicon ⏳
- Standard cells: the NAND you met in Chapter 3 drawn as layout (diffusion, poly, metal, contacts)
- Stick diagrams → layout rules (λ rules); DRC intuition
- Synthesis → placement → routing → clock tree → timing closure, applied to *our* CPU's netlist
- Floorplan of the multi-core chip; die, wafer, fabrication steps (photolithography, doping, etching), packaging
- Optional export of the netlist / Verilog for real open-source flows (Yosys, OpenROAD, SkyWater 130 nm)

### Cross-cutting features ⏳
- Waveform viewer for any probed nets (also VCD export)
- Glossary with hover definitions; search / command palette (`Ctrl+K`)
- Progress tracking and unlocks (local storage); "reset progress"
- Keyboard navigation; reduced-motion; colour-blind-safe wire palette option
- Export schematic as SVG/PNG; download Verilog for any component
- VHDL view of every component
- Performance budget: 60 fps rendering of ≤ 5 000 visible elements; ≥ 100 CPU cycles/s at gate level
- i18n-ready strings

---

## Open questions for the author
- Target audience depth: high-school / first-year university / practitioner refresher?
- Should challenges *gate* progress (Turing Complete) or be optional?
- Branding / name for the site?
- Hosting target (GitHub Pages assumed; CI already included)
- Sound effects / gamification (badges)?
