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
- ✅ Carry-lookahead and Kogge–Stone adders with depth comparison (optimization intro)
- ✅ Register file (32 × 32, x0 hard-wired), two read ports and one write port
- ✅ Workbench lists every library component: each generator is a family with parameter dropdowns
  (adders, multipliers, dividers, float units, register files, caches, …), plus every fixed processor part
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
- ✅ Static critical-path analysis → maximum clock frequency (highlighted on the schematic)
- ⏳ Animated active path per instruction
- ⏳ Memory-mapped I/O: LEDs, 7-segment display, a text console, a small pixel screen

### Phase 5 — Multicycle & microcode ✅
- ✅ Gate-level multicycle RV32I (one ALU, one memory port; IR, OldPC, A, B, Data, ALUOut), co-simulated per retirement
- ✅ One 13-state table → hardwired FSM (~400 NAND) and microprogrammed controller (µPC, microcode + dispatch ROMs)
- ✅ Equivalence: both controllers in lock-step over all states; live state-table panel; honest timing (period 85 vs 103, CPI ≈ 3.8)

### Phase 6 — Pipelining ✅
- ✅ Five-stage gate-level pipeline (61k NAND), co-simulated vs the ISS at every retirement
- ✅ Live pipeline diagram (stage × cycle) with stall / flush / forwarding events
- ✅ Data hazards → forwarding (M→E, W→E) and a W→D bypass; load-use stall; branch flush
- ✅ Does pipelining pay? Clock period (static timing) × CPI (measured), with honest analysis
- ✅ Balanced stages: look-ahead forwarding, dedicated branch comparator and jalr adder (145/93 → 103/59)
- ✅ Branch prediction: 16-entry BTB + 2-bit counters, parallel target check; measured CPI and time/instruction

### Phase 7 — Full RV32I + Zicsr + machine mode 🚧
- ✅ Complete RV32I incl. byte/halfword loads & stores (load/store unit, byte-banked memory)
- ✅ Memory-mapped I/O: console, LEDs, switches, mtime / mtimecmp timer
- ✅ Zicsr + machine mode: 12 CSRs, traps (illegal, ecall, ebreak, misaligned fetch/load/store), mret
- ✅ Timer and external interrupts; I/O panel with live CSR state; 67k-NAND system CPU co-simulated every cycle
- ✅ M extension (chapter 20): array and Wallace-tree multipliers (measured depth 310 vs 68 at 32 bits), Baugh–Wooley signed
  products, radix-4 Booth encoder + recoding explorer, restoring division (step, array divider, iterative divider), and an
  RV32IM system CPU (104k NAND) with one-cycle multiplies and 34-cycle stalling divides, co-simulated per retirement
- ⏳ Full Booth-recoded multiplier; non-restoring / SRT division; pipelined multiplier in the pipelined CPU
- ⏳ Passing the official `riscv-tests` / architecture tests in the browser (stretch)

### Phase 8 — Memory hierarchy 🚧
- ✅ Switch level gains transistor strengths and capacitive (charge-holding) nets
- ✅ 6T SRAM column (precharge, read, write, no read disturb, contention = short) and 1T1C DRAM cell at transistor level
- ✅ DRAM retention / refresh / charge-sharing widget; memory hierarchy table
- ✅ Gate-level direct-mapped write-through cache (4 × 4 words) with an 8-cycle miss FSM; 2-way tag compare
- ✅ Cache explorer on real ISS traces: size, line, ways, LRU/FIFO/random, write-back/through, 3C classification
- ✅ Single-cycle CPU with the data cache (stalls on misses), co-simulated per retirement
- ⏳ Write-back gate-level cache with dirty bits; instruction cache; cache in the pipelined CPU
- ⏳ Bus / interconnect basics

### Phase 9 — Performance & optimization ⏳
- ✅ Floating point (chapter 23): IEEE 754 explorer and number line; parametric gate-level FPU (unpack, align with sticky,
  add/sub, tree multiply, shared normalize & round with RNE and subnormals, compare, int→float), exhaustively tested on
  small formats and against host float32; single-cycle RV32IF CPU (subset) co-simulated with both register files
- ✅ RV32F without div / sqrt / fma: all five rounding modes (and dyn → frm) and the five exception flags in the shared
  normalize & round (tininess after rounding), fcvt.w[u].s with saturation, fmin / fmax (IEEE 754-2019), fclass, signaling
  compares, fcsr (fflags / frm / fcsr via Zicsr) in the FPU path; exhaustive small-format tests in every mode with flags
  (bit-parallel simulator, 32 vectors per pass); ISS on the exact reference
- ✅ fdiv.s / fsqrt.s: prenormalize + radix-2 restoring digit recurrences (27 / 26 steps, 29 / 28 cycles), each
  ending in the generic normalize & round, stalling the single-cycle CPU (retire gates PC, register writes and fflags); exhaustive small formats
- ⏳ fma (R4 format); a pipelined FPU
- Superscalar and out-of-order intuition (scoreboard / Tomasulo widget)
- Compressed instructions (C), A extension (LR/SC, AMO)
- Virtual memory (Sv32), TLB, U/S/M privilege levels (stretch)

### Phase 10 — Multi-core ✅ (chapter 24)
- ✅ Gate-level dual-core: one core definition instantiated twice, csrr mhartid, shared memory behind a round-robin arbiter
- ✅ amoswap.w / amoadd.w; race (20 of 40 updates survive), atomic add and spin-lock demos
- ✅ Multi-hart golden model with identical arbitration; both cores co-simulated every cycle
- ✅ MSI / MESI snooping coherence explorer (false sharing, private data, ping-pong); memory-ordering discussion
- ⏳ Private caches in the gate-level cores with a coherent bus; lr.w / sc.w; more than two cores

### Phase 11 — From netlist to silicon ✅ (chapter 25)
- ✅ INV / NAND2 / NOR2 standard cells in layout (layers, live conduction), λ dimensions, sky130 reference
- ✅ Fabrication cross-section, step by step (wells, STI, gate, lithography, etch, implants, contacts, metal)
- ✅ Technology mapping measured on our designs (inverters, double inversions)
- ✅ Simulated-annealing placer + two-layer Lee maze router on real flattened netlists (FA, 4-bit adder, counter)
- ✅ Clock distribution (H-tree vs spine, skew); floorplan of the dual-core from its NAND counts; wafer / yield / cost
- ⏳ Full-chip layout of the final CPU (see open questions); Yosys / OpenROAD / sky130 export

### Cross-cutting features 🚧
- ✅ Probe mode + logic-analyzer Timing panel (exact transitions in gate delays, clock edges,
  A/B cursors, VCD export); fixed-period clock that can be overclocked (late edges marked)
- ✅ Wire palettes: default, colour-blind safe (Okabe–Ito), Logic Sim, high contrast, print
- ✅ Hops at wire crossings; bit ranges on splitter / merger taps; click a net label to pair it
- ✅ Slow motion draws each change as a front travelling along its wires
- ✅ Download any component's hierarchy as SystemVerilog (exact structure or synthesizable),
  with a self-checking testbench; verified through Yosys
- ✅ Click a program line: the hardware it uses (and its pipeline stage), or its word in the ROM
- Glossary with hover definitions; search / command palette (`Ctrl+K`)
- Progress tracking and unlocks (local storage); "reset progress"
- Keyboard navigation; reduced-motion (the signal fronts already respect it)
- Export schematic as SVG/PNG
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
