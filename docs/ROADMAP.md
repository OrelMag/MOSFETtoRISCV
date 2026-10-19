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
in `References/` (NAND → pipelined RV32I, with SystemVerilog sources). Phase 12 brought the
sandbox level with the two games (I/O parts, chip faces, capacity, programs on your own CPU).

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
| `src/widgets/` | Bespoke interactive explainers that are not schematics (MOSFET cross-section, number wheel, memory grid, pipeline diagram, cache and coherence explorers, layout viewer, warp panel) |
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
- ✅ Mixed-level simulation for CPU-scale designs: behavioural leaves (`preferBehavior`: the program ROM, large
  memories; the flattener's `expand` policy decides where to cut), opened as a lock-step sub-simulation of their structure driven by the
  parent's ports (a stateful leaf seeds it: `Behavior.inside`); tests prove every behaviour equal to its structure

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
| 9 | Registers & counters | n-bit register with enable, counter, clocks; async reset, T/JK, up/down counter, universal shift register, LFSR, ring / Johnson counters, ripple clock divider; a state machine (101 detector) with its live diagram |
| 10 | Memory arrays | N words × W bits (user-scalable: 4×4 … 64×16), write path (decoder), read path (mux tree), cell grid view, timing; ROM (decoder + OR plane), PLA (Quine–McCluskey terms), FIFO, stack, CAM, multi-ported register file |

### Phase 2 — Computing ✅
- ✅ ALU (add, sub, and, or, xor, shifts, slt/sltu) and flags; barrel shifter
- ✅ Carry-lookahead and Kogge–Stone adders with depth comparison (optimization intro)
- ✅ Carry-select and carry-skip adders, static depth against simulated delay (carry-skip's false path); BCD adder
- ✅ Register file (32 × 32, x0 hard-wired), two read ports and one write port
- ✅ Comparison and coding blocks: log-depth magnitude comparator (signed / unsigned), encoder, recursive priority
  encoder, demultiplexer, population count, absolute value, parity, Hamming SEC-DED encoder / decoder (ECC step in ch. 22)
- ✅ Workbench lists every library component: each generator is a family with parameter dropdowns
  (adders, multipliers, dividers, float units, register files, caches, …), plus every fixed processor part
- ✅ **Sandbox** (`#/sandbox`): a Digital-Logic-Sim-style editor
  - ✅ Core (DOM-free, tested): chip documents, compile to ComponentDefs (pointers = named nets,
    switch level, derived gate-level models of transistor chips), user-chip library with cycle
    checks, pure edit operations, undo with transactions, local storage, share-link encoding
  - ✅ Editor: palette (IO, transistors, constants, displays, wiring, the whole library with family
    parameters, my chips; purist toggle), free-hand wires with corners / L flip / branches, pointers
    with jump-to-twin, select / drag / rubber band / copy / paste / undo, live values (switch level
    included), properties and diagnostics, tabs per chip, autosave, cycle (Hz) and gate-delay run modes
  - ✅ Files and links: File menu (export a chip with its dependencies or the whole sandbox, import
    with an added / renamed / skipped summary, drag and drop onto the canvas), share links
    (`#/sandbox/s/…`, the circuit compressed into the URL, imported only on a click, never
    overwriting), structural Verilog and SVG / PNG images of the canvas, a chip manager (sizes,
    users, duplicate, delete refused while used), autosave indicator, recovery of unreadable data, Delete local data
    (the sandbox's storage, or every key the site keeps)
  - ✅ Memories: Memory palette group (program ROM, word ROM, RAM); ROM properties (size, byte /
    word addressing, asm / hex with conversion, sample programs) and a program editor (code editor,
    live re-assembly, gutter diagnostics, listing, Apply = one undo step); the listing and the editor
    follow the address the running circuit reads; RAM contents live in the properties and initial
    contents seeded at power-on; Examples ▸ (fetch loop, counter on a 7-segment digit); the CPU
    panel's Edit box is the code editor too
  - ✅ Chips: "Package as chip" (name, colour, notes, live preview of the box and its pin order;
    Save & new circuit), My chips with colour and pin count (greyed when it would make a cycle),
    Edit chip with a breadcrumb and Back, pin renames that keep every parent wired, used by / uses,
    the flip-flop marking with the compiler's verdict, bidirectional pins driven Z / 0 / 1
  - ✅ Wide pins (up to 1024 bits, exact): pipeline registers, register-file read ports and the
    multiplier's 68-bit rows open in the sandbox too, so every library component round-trips;
    values are BigInt-exact in pins, the bit editor, labels, tooltips, probes and VCD
  - ✅ Switch-level parts: resistor (weaker than any transistor), pull-up / pull-down, capacitor
    (a charge-keeping node), transmission gate, tri-state buffer / inverter; shared buses (several
    drivers: value / Z / pulled value / X, contention warning for outputs that always drive),
    Examples ▸ shared bus, wired-AND, wired-OR; a pseudo-NMOS step in the inverter chapter
  - ✅ Look inside any placed part, read-only and live on the editor's own simulation, down to
    transistors (and a single MOSFET); the Inspector (info, truth table, Verilog) in a drawer
  - ✅ "Open in Sandbox" from the workbench and chapter scenes: the circuit on screen as an
    editable chip, pointers included (a CPU's ROM, constants and data memory come along)
  - ✅ CPU panel: a chip with a program ROM runs as a processor (ChipDoc.cpu: ROM, PC, register file,
    data memory, retire signal, ISS options; detected for the chapters' single-cycle, multicycle,
    pipelined, system, M, F and cache CPUs and for the fetch loop, overridable in the properties).
    A drawer with status, listing (current PC, pipeline stages, a click marks the parts the
    instruction uses and colours its field wires), the field breakdown, the pipeline diagram, the
    system CPU's I/O (console, LEDs, switches, IRQ, CSRs), registers, FP registers and fcsr, data
    memory and the retired instructions; Run to halt, Step instruction, Slow (an instruction at a
    set rate, the marks following execution), Reset, Edit program; the ISS steps on every retiring
    edge (EditorSim edge hooks) and the first difference (registers, PC, fcsr, memory after a store,
    console, LEDs) is reported. Parts inside chips are followed by path (the instruction cache's
    ROM); a chip of placed CPUs (the dual-core) runs against the multi-hart model (arbitration,
    every core's registers and PC, shared memory). Not yet: gate-level slow mode inside the drawer
    (the run bar's gate mode does it), the data-cache line view
  - ✅ One right-hand dock for the drawers (Inspector, CPU, challenges): tabs when several, the
    look-inside view beside it
  - ✅ I/O bar above the run bar: the chip's pins as switches, bus fields, buttons and the clock, outputs as lamps and
    readouts (the workbench's bar: inputs raised with ▸ before, outputs on a sunken strip with ▸ after); hideable
  - ✅ Rename in place (a click on a selected part's or pin's name, a double-click on it, or F2, pointers
    included) and a right-click menu: the selection's actions with their shortcuts, or the canvas's own
    (paste here, add a comment or pointer, select all, fit)
  - ✅ Analysis: probe mode and a timing panel (lanes follow the drawing across rebuilds, VCD),
    static timing of a chip (period, max clock, per-capture periods) with the critical path drawn
    on it, lint (nets drawn on one line, pointers without a twin, open inputs reading X);
    incremental drawing during drags, derived models cached by structure, per-chip simulations
    kept across tab switches
  - ✅ Build challenges (Turing-Complete style, optional): 21 chips from a CMOS inverter to an
    instruction fetch unit, every level of the journey; each checked exhaustively (truth table) or by a
    clocked sequence, the palette restriction (transistors / NAND / any) enforced on the compiled
    hierarchy, scored against par (NANDs, transistors, depth); Show answer imports the reference chips,
    Do it for me fills the challenge chip; progress in the site settings

### Phase 3 — The instruction set & assembly ✅
- ✅ RV32I instruction formats with an interactive encoder / decoder (bit-field explorer)
- ✅ In-browser assembler + disassembler, labels and pseudo-instructions (bit-exact vs the primer)
- ✅ Reference ISA simulator (golden model) used to check every CPU
- ✅ Program editor with sample programs (sum, Fibonacci, multiply, sort, GCD, primer test)

### Phase 4 — Single-cycle CPU ✅
- ✅ Datapath from Phase 1–3 parts; control unit (opcode decoder + ALU decoder), next-PC logic
- ✅ Gate-level (48k NAND) RV32I minus byte/half memory & system; co-simulated vs the ISS every cycle
- ✅ CPU panel: listing, registers, memory, live golden-model check, run to halt, program editor
- ✅ Per-instruction settle time in gate delays (dynamic critical path)
- ✅ Static critical-path analysis → maximum clock frequency (highlighted on the schematic)
- ✅ Active path per instruction: a listing line marks the hardware the instruction uses (insthw), and Slow mode moves
  the marks with execution (gate, cycle or instruction steps)
- ✅ Memory-mapped I/O: console, LEDs and switches on the system CPU (Phase 7); the sandbox computer adds a pixel
  screen; the 7-segment display is a sandbox part

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

### Phase 7 — Full RV32I + Zicsr + machine mode ✅
- ✅ Complete RV32I incl. byte/halfword loads & stores (load/store unit, byte-banked memory)
- ✅ Memory-mapped I/O: console, LEDs, switches, mtime / mtimecmp timer
- ✅ Zicsr + machine mode: 12 CSRs, traps (illegal, ecall, ebreak, misaligned fetch/load/store), mret
- ✅ Timer and external interrupts; I/O panel with live CSR state; 67k-NAND system CPU co-simulated every cycle
- ✅ M extension (chapter 21): array and Wallace-tree multipliers (measured depth 310 vs 68 at 32 bits), Baugh–Wooley signed
  products, radix-4 Booth encoder + recoding explorer, restoring division (step, array divider, iterative divider), and an
  RV32IM system CPU (104k NAND) with one-cycle multiplies and 34-cycle stalling divides, co-simulated per retirement
- ✅ Non-restoring division (step, array, iterative) and radix-2 SRT (carry-save remainder, 4-bit digit selection,
  normalization, signed-digit quotient), compared on area, step depth and clock period
- ✅ Iterative shift-and-add multiplier; full radix-4 Booth multiplier (rows, +1 bits, one sign constant, 3:2 tree),
  measured against Baugh–Wooley; 3-stage pipelined Booth multiplier (latency 4, one product per cycle)
- ✅ Radix-4 SRT divider: digits −2…+2, selection thresholds computed from the containment bounds and checked
  exhaustively, carry-save comparisons; n/2 + 3 cycles, 21 % faster than radix 2 at 32 bits
- ✅ M extension in the pipelined CPU (chapter 21): multiplier split over E / M (a multiply is a load for hazards), radix-4 SRT
  divide stalling the front for 18 cycles; +45 % NANDs, period 93 → 93 (fast adders), 59 → 79 (balanced: divider sign fix, Booth tree)
- ✅ Passing the official `riscv-tests` on every RV32 CPU (see Phase 13 and `docs/VERIFICATION.md`)

### Phase 8 — Memory hierarchy ✅
- ✅ Switch level gains transistor strengths and capacitive (charge-holding) nets
- ✅ 6T SRAM column (precharge, read, write, no read disturb, contention = short) and 1T1C DRAM cell at transistor level
- ✅ Transistor-level SRAM array (R × C): row decoder, per-column precharge, write driver and latch-type sense amplifier
- ✅ DRAM retention / refresh / charge-sharing widget; memory hierarchy table
- ✅ Gate-level direct-mapped write-through cache (4 × 4 words) with an 8-cycle miss FSM; 2-way tag compare
- ✅ Cache explorer on real ISS traces: size, line, ways, LRU/FIFO/random, write-back/through, 3C classification
- ✅ Single-cycle CPU with the data cache (stalls on misses), co-simulated per retirement
- ✅ Gate-level write-back, write-allocate cache with dirty bits and a write-back-then-fill miss controller; 2-way
  set-associative with an LRU bit; instruction cache; all three in the single-cycle CPU, co-simulated per cycle
- ✅ Data cache (write-through, write-back, 2-way) in the pipelined CPU: a miss freezes every stage, co-simulated at every retirement
- ✅ Bus / interconnect basics, DRAM and flash in depth: Phase 16 (chapters 34–37, campaign act 10)

### Phase 9 — Performance & optimization 🚧
- ✅ Floating point (chapter 24): IEEE 754 explorer and number line; parametric gate-level FPU (unpack, align with sticky,
  add/sub, tree multiply, shared normalize & round with RNE and subnormals, compare, int→float), exhaustively tested on
  small formats and against host float32; single-cycle RV32IF CPU (subset) co-simulated with both register files
- ✅ RV32F without div / sqrt / fma: all five rounding modes (and dyn → frm) and the five exception flags in the shared
  normalize & round (tininess after rounding), fcvt.w[u].s with saturation, fmin / fmax (IEEE 754-2019), fclass, signaling
  compares, fcsr (fflags / frm / fcsr via Zicsr) in the FPU path; exhaustive small-format tests in every mode with flags
  (bit-parallel simulator, 32 vectors per pass); ISS on the exact reference
- ✅ fdiv.s / fsqrt.s: prenormalize + radix-2 restoring digit recurrences (27 / 26 steps, 29 / 28 cycles), each
  ending in the generic normalize & round, stalling the single-cycle CPU (retire gates PC, register writes and fflags); exhaustive small formats
- ✅ fmadd / fmsub / fnmsub / fnmadd.s (R4 format in isa / asm / disasm / ISS, third f-register read port): exact
  product, swap-and-align add, one normalize & round; exhaustive on E3M2 (5.2 M cases), random on E4M3 / E5M2 / float32
- ✅ Pipelined FPU: six-stage RV32IF pipeline (F D E M X W, in-order retirement), the FMA split over E / M / X as the FP pipe
  for fadd / fsub / fmul / fma / fcvt.s.w and (unrounded) fdiv / fsqrt, one shared rounder; FP interlocks + forwarding from W,
  CSR serialization, structural stalls for the iterative units; period 121 vs 313 (single-cycle), CPI 1.6–2.7, co-simulated
- ✅ Superscalar and out-of-order execution: Phase 17 (chapter 25)
- Compressed instructions (C), A extension (LR/SC, AMO)
- RV64I (and RV64M): the datapath generators are already parametric in width (alu(n), regfile(k, w), the adders and
  shifters), so a 64-bit single-cycle core is mostly the W-suffixed instructions, sign extension of 32-bit results and a
  golden model in BigInt or paired words; riscv-tests' rv64ui / rv64um and Spike's rv64 log then check it (Phase 19)
- Virtual memory (Sv32), TLB, U/S/M privilege levels (stretch)

### Phase 10 — Multi-core ✅ (chapter 26)
- ✅ Gate-level dual-core: one core definition instantiated twice, csrr mhartid, shared memory behind a round-robin arbiter
- ✅ amoswap.w / amoadd.w; race (20 of 40 updates survive), atomic add and spin-lock demos
- ✅ Multi-hart golden model with identical arbitration; both cores co-simulated every cycle
- ✅ MSI / MESI snooping coherence explorer (false sharing, private data, ping-pong); memory-ordering discussion
- ✅ More than two cores: `multiCore(program, n)` (n = 2, 4, 8) on an n-way round-robin arbiter (`arbiterN`: a one-hot
  pointer, masked and unmasked priority chains, n − 1 flip-flops; on the workbench) and up to 64K words of shared memory;
  co-simulated every cycle against MultiISS with n harts. The 4-core runs ~4 500 cycles/s on the cycle engine in Node
  (scripts/sim-perf.ts). Chapter 26 keeps the dual-core; chapter 28 measures the lane core against `multiCore(4)`
- ⏳ Private caches in the gate-level cores with a coherent bus; lr.w / sc.w

### Phase 11 — From netlist to silicon ✅ (chapter 27)
- ✅ INV / NAND2 / NOR2 standard cells in layout (layers, live conduction), λ dimensions, sky130 reference
- ✅ Fabrication cross-section, step by step (wells, STI, gate, lithography, etch, implants, contacts, metal)
- ✅ Technology mapping measured on our designs (inverters, double inversions)
- ✅ Simulated-annealing placer + two-layer Lee maze router on real flattened netlists (FA, 4-bit adder, counter)
- ✅ Clock distribution (H-tree vs spine, skew); floorplan of the dual-core from its NAND counts; wafer / yield / cost
- ✅ The real flow: the dual-core exported as Verilog, synthesized by Yosys to the sky130 cell library and placed,
  clock-tree-built and routed by OpenROAD into a GDS (`.github/workflows/layout.yml`, published into the site); the
  export first cross-checked cycle by cycle against our gate-level simulation (`scripts/verify-export.ts`)
- ✅ The same flow for the system CPU: `systemCore({ m: true })` (RV32IM + Zicsr, traps, interrupts; both memories outside
  its ports, as SRAM macros), cross-checked by `verify-export.ts core-m` on a bench with its ROM, data memory and I/O; one
  flow job per design, published together (the system core under layout/sys/; only main and manual runs publish). Under
  each layout, our estimates of the same design (scripts/export-layout.ts → source.json): area per block from the NAND
  count at one NAND2 cell each against the cells placed in that block, and our critical path in NAND delays (outputs
  counted, as the flow's zero output delay counts them) against OpenSTA's after routing (summarize.mjs reads 6_finish.rpt),
  both drawn as bars by block, and the ps one of our NAND delays is worth in that layout

### Phase 12 — Parity with Turing Complete and Digital Logic Sim 🚧
The simulator already went further than both games: transistors and Z, gate delays (glitches,
metastability), X, static timing, VCD, Verilog with a Yosys-checked testbench, wide pins, golden-model
CPUs, and every library part opens down to a MOSFET. What they had and the sandbox lacked was I/O,
chip presentation, capacity and the program-solving half of Turing Complete; all four are now in, bar
per-puzzle pins and the campaign's program levels on your own core.

**I/O parts** (placeable, zero-cost like the displays, absent from Verilog)
- ✅ Key input (DLS Key, TC Keyboard): a Key part bound to a keyboard key (rebind it in the properties), 1 while the
  key is held, listening from any depth of the hierarchy and taking the key from the editor's shortcuts while that
  chip is open; a Keyboard part that queues typed keys (16 deep: `code` = the oldest as ASCII, `ready`, `ack` drops
  it, sampled at rising clock edges or, without a clock, whenever the logic has settled), fed while the circuit runs
  or with the Type toggle on. Both are *external sources*: behaviour-only leaves the editor drives through `Sim.poke`,
  at gate level (one delay, visible in gate mode) and at switch level (a key on a CMOS inverter); zero cost, a
  comment in Verilog, refused by the gate-level derivation of a transistor chip, released on every check
- ✅ Pixel screen (DLS dot display, TC screen): one part, three modes: write (x, y, colour and we into its own frame
  buffer, optional vsync), rows (a row latched from a bus: scan-out from your own RAM) and pixels (one wire per pixel);
  8–128 px, mono / RGB111 / 16-colour / RGB332 / RGB565, square pixels or dots, grid lines; Clear, Save PNG; a Screens
  drawer shows every screen and console at any depth
- ✅ LED bank: a wide LED shows one LED per bit (most significant first, rows of 8)
- ✅ Console and switch bank as parts, so a hand-built CPU can memory-map them: a console prints data at rising clk
  edges with we = 1 (\n, \b, \f clears, 500 lines of scrollback); a bank of 1–32 switches clicked on the canvas, in look
  inside or in the Screens drawer, kept through Reset like a held key. Both zero cost, a comment in Verilog
- ✅ Buzzer (DLS): A4 while its 1-bit input is high, or MIDI note v from a bus (Web Audio, square wave)
- ✅ Halt part (TC): a zero-cost sink that stops Run (and the CPU panel's Run to halt) after the step where its input
  reads 1 (any bit of a bus), from any depth of the hierarchy, so a hand-built CPU can halt itself; level sensitive
  (Run advances one step at a time while it stays 1; Step ignores it)
- ✅ Random source and cycle counter (TC), as library parts that open down to gates: an XNOR LFSR that runs
  from the power-on zero with no seed (4 / 8 / 16 bits) and a counter with its enable tied to 1 (8 / 16 / 32)

**Chips and canvas**
- ✅ Chip appearance (DLS): the Package dialog's face editor drags pins along an edge or onto another side (a
  pin dropped on another swaps with it), resizes the box from its corner (never below its pins and displays), and
  shows the chip's displays and I/O parts on its box, live, moved and scaled there: LED, LED bank, 7-segment, hex,
  value, buzzer, console, screen, switch bank (clickable on the box), or what a placed chip shows on its own box, so
  a display surfaces through any number of levels (look inside too). The name steps out of the displays' way or off
  the box. Kept in the chip document as an optional face (by pin id: renames keep it); none = the automatic box
- ✅ Free-text comments on the canvas (TC): T or the Wiring palette, multi-line, double-click to edit; selected, moved,
  copied and deleted with the rest, saved and shared, never compiled (writing one recompiles nothing)
- ✅ Library organization (DLS): folders of My chips (one level: a header button adds one, named in place; a chip
  dragged onto a folder is filed there; a Folder field in the chip's properties; the chip manager grouped by folder,
  rows dragged onto folders, folders renamed and deleted); the starred bar (palette favorites, keys 1–9); projects:
  separate workspaces switched at the top of the palette (New, Duplicate, Rename, Export, Import a file as a new
  project, Delete), the first one on the original storage key with the campaign's level chips. Folders live in the
  workspace, not the chip documents: filing a chip recompiles nothing and changes no id, link or Verilog
- ✅ Waypoints from the right-click menu: "Add a bend here" on a wire puts a new corner on the cursor, which carries
  it until a click drops it (Esc cancels; one undo step). On a simple connection it is a breakpoint; on a square wire
  the segment detours through it (a corner on the segment's own line would be simplified away)
- ✅ Unravel and collapse pointers (right-click, editor/unravel.ts): on a pointer, "Unravel into wires" replaces it and
  its twins with drawn wires (the driver's island is the hub, each twin's wire runs on to the nearest point of the net:
  a cheap search over square shapes, then an A* on the half grid when none is clean; the net keeps the pointer's name);
  on a part, a wire or a selection, "Unravel pointers…" lists the pointers it touches with check boxes (All / None).
  "Collapse to pointers…" on a wire turns it and the wires branched from it into one pointer per end (the net's
  name suggested, editable; refused when it names another net). "Unravel selected" / "Collapse selected" act on the
  selection. One undo step each; a test unravels every pointer and collapses every wire of every example, challenge
  answer, library block and chapter CPU and compares the nets, and checks no single unravel draws on another net

**Colourful mode** (Turing Complete style; mockup first). Colour says *which* signal, brightness and the
flowing bits still say its *value* (0 / 1 / X / Z must stay readable in every combination); light and dark themes
- ✅ User-coloured wires (sandbox, editor/wirehue.ts): a swatch row at the top of a wire's or pointer's right-click
  menu and in its properties colours its whole net: no colour, Auto (its colour-per-net hue, even with that switch off)
  or 9 hues clear of the X red; brightness still gives the value. Stored as `hue` on the wires and pointers, so a net
  shows the colour most of its coloured pieces carry (wires joined later take it, two coloured nets joined keep the
  larger group's); saved and shared, kept through collapse / unravel, never in the compile key (one undo step)
- ✅ Colour per net: a switch in the wire-colour menu (on with the vivid look, so on by default) gives every net a hue of its own, from its name
  or else its ends (stable across rebuilds, edits and reloads; a circuit opened in the sandbox keeps its chapter
  colours, bar the few nets its new drawing puts next to others); brightness still says the value (0 a dim tint, 1 bright with its glow), X and Z keep their colours and
  dashes, hues avoid the X red. Wires, dots, pointers, tap labels, bus labels, riding values and slow-motion fronts,
  in the chapters, the workbench and the sandbox. Nets drawn side by side are kept apart: a net whose own hue lies within
  60° of a neighbour's (running within a few units, or crossing it) moves to the nearest hue clear of them, the most
  crowded nets first, two refining passes; the rest keep their own. Across the 632 library schematics, neighbouring
  pairs closer than 20° drop from 8 338 to 3 058 (none left on the CPU tops); 40 ms on the 64-bit Kogge–Stone
- ✅ Vivid look (styles/vivid.css, `data-look="vivid"`, on by default with cartoon parts since 2026-10-12; saved settings get both once): library boxes and muxes filled with their category hue,
  user chips with their own, gates blue, white bold labels, wires and dots 1.6× thicker (`--wire-k`); switching it on
  turns colour per net on (and off again with it, unless set since). A Dark board switch (on by default) puts every
  schematic on a dark board in the light theme too: the SVG alone takes the dark theme's tokens, the chrome and
  panels keep the theme. Sandbox, chapters, workbench, codex figures and exported images
- ✅ Cartoon parts (a switch under the vivid look, `data-parts="cartoon"`): every body gets a drop shadow and a gloss
  highlight, outlines turn thick and round, boxes rounder, lettering rounded (Fredoka, bundled for the desktop
  program), and a box shows its category's icon (memory cells, a clock edge, ±, a fork, a chip) in an inner corner no
  text covers (view/boxtext.ts iconSpot, checked over every registered box). Same sizes and port positions; the extras
  are always drawn and hidden by CSS, so the switch is instant everywhere, image export included

**Capacity and speed**
- ✅ Large memories: RAM and ROM parts up to 2^16 words (lib/bigmem.ts), one behavioural leaf at run time over a
  real hierarchy of banks of banks (≤ 16 per level, down to gate-level 64-word banks), opened live (banks seeded
  from the leaf down to the latches); state survives edits and Back; costs, timing and HDL from the hierarchy
- ✅ Measure, then speed up, large sandbox circuits (scripts/sim-perf.ts): GateSim on typed arrays (same events at
  the same times), and a cycle engine for Run in cycle mode: flip-flops as verified tables, the rest levelized, every
  net equal to GateSim after every settle (DualSim hands over to GateSim for gate mode, probes, stepping, X clocks).
  Storage found by structure (sim/clusters.ts): flip-flops drawn from NANDs (marked or not), latches, async resets, T /
  JK flip-flops, clocks through inverters (the campaign's pipelines write their register file at the falling edge:
  their bench ~3 400 → ~16 000 cycles/s); gated and ripple clocks (clockDivider) stay on GateSim, with the reason.
  Single-cycle RV32I in the sandbox, cycles/s: Node 91 → 1 160 (GateSim) → ~9 000 (cycle engine); the page at max,
  CPU drawer open and checking: 35 Hz → ~4–5 kHz at 60 fps (64K-word data memory ~3.3 kHz, system CPU ~2.4 kHz)
- ✅ Examples ▸ Computer: a whole RISC-V computer tying the three together: the multi-core's RV32I core (`rv32i_core`,
  its data side a memory port), a 1K-word program ROM in assembly, a Memory map chip (decoder and read mux from
  library parts), 4K words of RAM, a 64 × 64 RGB332 screen, a console, LEDs and switches (RAM 0x0000_0000, console /
  LEDs / switches at the ISS's 0x8000_0000 / 4 / 8, screen 0xC000_0000 + 256·y + 4·x). It greets, paints a gradient,
  a sun and a triangle in the switches' colour and halts (10 251 cycles: ~1.2 s in Node, ~1.6 s in the page), the CPU
  drawer in lock-step: the ISS's `mmio` mode (I/O without the system) and the monitor's reading of a placed core,
  console part, switch bank and LED bank. ROM samples: live switches, a bouncing ball
- ✅ Computer polish: the memory side (decoder + RAM) and the devices (console, LEDs, switches) packaged as chips, the
  top level ~60 × 64 units (2× the scale at fit with the CPU drawer); a console's wheel scrollback; nested switch
  banks and keys on the I/O bar; Run's frame budget adapts to keep ~60 fps (headless Chrome, Run at max: the
  computer ~110 → ~135 kHz, the single-cycle remix ~670 → ~770 kHz); every sample checked on the hardware against
  the ISS (the bouncing ball and live switches pixel by pixel)

**Programs on your own CPU** (the second half of Turing Complete)
- ✅ Custom ISA (src/isa, editor/isaui.ts): an instruction set as a table: per instruction a mnemonic, operand letters
  and a bit pattern (0 / 1 fixed, - ignored, letters: the operand's bits, most significant first, splittable); each
  letter a register list, a name list (or a number), an immediate (signed, hex) or an address (a label; absolute or
  PC-relative with a scale). From it: an assembler (labels, .word, .org), a disassembler (the most specific pattern
  wins), the fields of a word, the highlighter, the ROM listing and the CPU drawer's breakdown; a check (incomplete
  patterns, unknown letters, two patterns that encode one word) and a line tried live. The ISA editor (File ▸
  Instruction sets…, a ROM's Language): presets read-only (the 4-bit CPU's ISA, equal to its assembler and
  disassembler on all 65 536 words), copies to edit, import / export as .json. The workspace keeps the tables; a ROM
  holds a copy of its own (it builds alone, in share links too), and an edit reaches every ROM that uses the table.
  Syntax only (the author's choice): a custom table has no golden model, so the drawer follows the PC, not checked.
  One Isa shape (src/isa/isa.ts: assemble, disasm, fields, words) wraps RV32, RV16, the 4-bit CPU and the tables
- ✅ Program puzzles (src/puzzles, editor/puzzleui.ts): 14 tasks given as word streams in 4 groups (streams, arithmetic,
  text, memory), solved by a program on a CPU of your choice and run on its gates. The Puzzles drawer starts one on a
  ready-wired computer (4-bit CPU, RV16, RV32I), a copy of your own chip with the two zero-cost ports (PUZZLE IN: data,
  ready, read; PUZZLE OUT: data, we) placed for you to wire, or your single-cycle campaign core. Its ROM may be in any
  language, a Custom ISA table included. Check plays every test from power-on until a halt part reads 1, and scores mean
  cycles, NANDs (the program ROM left out) and program words. There are 40 reference programs (no 4-bit ones for the
  memory puzzles), each measured on the gates (refdata.json). Stars come from the cost / speed front: ★★ no reference
  is both cheaper and faster, ★★★ cycles × NANDs below all. A chart plots the references, their front and your point.
  A click on a test plays it on the circuit, a cycle at a time, back and forth. Show answer gives the pseudocode and the
  references; Do it for me loads the reference program
- ⏳ After the puzzles: per-puzzle pins (a maze robot's sensors, a traffic light's lamps) as a third part kind; the
  campaign's RV16 program levels run on your own core

**Graphical instruction builder** (mockup approved 2026-10-19: four concepts, all to be built, RV32 first)
- ✅ 1. Composer, RV32 (riscv/compose.ts, widgets/composer.ts): one instruction edited from any side. Pick the
  operation, click registers, drag the immediate, flip any bit, or type asm / hex. Shown with it: the immediate
  generator's wires, the decode chain, the major-opcode map and the units it uses (insthw.ts). Every RV32 instruction
  (I, M, Zicsr, F, A, SIMT) goes both ways through the assembler (tests/compose.test.ts). Chapter 13's explorer is now
  the builder. The sandbox's program editor opens it on the caret's line (Ctrl+Space, Build instruction): Replace
  keeps the line's label, indentation and comment; Insert adds a line below
- ✅ 2. Any ISA (isa/composekit.ts, isa/compose.ts, riscv/rv16/compose16.ts): one adapter shape and four adapters (RV32,
  RV16 with each format's fields written out, Custom ISA tables, the 4-bit CPU's preset), each checked against its own
  assembler on every instruction. The builder draws any word width; a table operand split over the word is drawn
  gathered; "one bit away" lists what flipping one opcode bit makes. The program editor's Ctrl+Space works in every
  language with instructions (a ; or // comment kept). The CPU drawer's table strip no longer assumes 16-bit words
- ✅ 3. Encoding designer (isa/design.ts, editor/isadesign.ts): the ISA dialog's Design tab. A brush (0, 1, ignored,
  an operand letter) dragged across the bits writes the same pattern text; while it lasts the row's problems, clashes
  (with a word both decode), special cases (the most specific pattern wins), each operand's range against its bits,
  an opcode map over the 3–4 bits the patterns fix most, coverage, and a plain decoder's cost follow the draft (one AND
  per instruction over its fixed bits plus the NOT of each special case, in NANDs and gate delays; the model is held
  to stats(andN(k))). Letting go is one undo step
- ✅ 3b. The decoder as a chip (lib/isadecoder.ts): the Design tab's "Open the decoder in the sandbox" builds the table's
  decoder in gates (a match line per instruction, valid) as a chip of your own; checked against the table's match() and
  costing exactly the tab's estimate plus the valid OR
- ✅ 4. Program as tiles and a front panel (isa/tiles.ts, editor/romtiles.ts, the composer's Switches view). The program
  editor's Text | Tiles: a tile per line from the ISA's adapter (any language with instructions): name, operands, the
  word as a strip of its fields; branch arrows in the gutter to the target line; pointing at a tile outlines the lines
  above that wrote the registers it reads. The text stays what is stored: a click opens the builder on the line, a drag
  moves the line (one undo step). Switches: the word on toggle switches with a lamp each, grouped by field; Deposit next
  puts it on a new line below and moves on (the program editor), or into a small memory chapter 13 runs on the golden
  model
- ✅ 5. Your own instruction, end to end (mockup approved 2026-10-19; riscv/custom.ts, editor/owninstr.ts): a free
  custom opcode (custom-1…3, one instruction each), a format (R / I / S / B / U) and its behaviour as a row of the
  single-cycle CPU's control signals (register write, ALU sources and operation, memory write, result, next PC). The
  control unit gains one opcode class (an AND) and an OR input per signal it asserts (control(custom); lwx: +14 NANDs
  on 152), the golden model runs the row, the assembler and the instruction builder take it. Sandbox: the CPU drawer's
  Custom… (and the program editor's Custom instructions…) on an rv32i_core; Apply makes it a { core: { custom } }
  part and gives the ROM a copy of the rows. Eight rows run in lock step on the gates (tests/custom-instr.test.ts);
  what a row cannot do in one cycle is named
- ⏳ 5b. Then: chapter 14's challenge "add indexed load"; the pipelined CPU (a load-like row stalls like a load); RV16

**More builders, after the instruction builder** (proposed 2026-10-19, kept for later)
- ⏳ Microcode painter: the multicycle CPU's microprogram (MC_MICRO) as a grid of control signals × microinstructions,
  painted like the encoding designer; each microword lights its datapath, the result is checked against MC_STATES;
  microcode for a new instruction, or a shorter sequence and fewer cycles
- ⏳ Karnaugh map painter: 1s, 0s and don't-cares painted on a K-map or truth table, the minimal cover drawn as loops
  (minimize()), the circuit opened as two-level gates or a PLA with its NAND count; the campaign's K-map drills answered
  on it
- ⏳ Memory-map designer: address regions (RAM, ROM, screen, console, keys) dragged onto the address space, overlaps and
  gaps shown, the address decoder opened as a chip (the ISA decoder's match lines over address bits); chapter 36's bus
  and the sandbox computer's map
- ✅ Examples ▸ 4-bit CPU (4004-inspired; src/isa4, lib/cpu4.ts): the 4004's opcode map and mnemonics, one instruction
  per 16-bit ROM word and per clock (the 4004 byte high, its second byte low), 29 instructions (the 4004's set minus the
  4002 RAM-chip ones, FIN, KBP and DCL): 4-bit accumulator and carry, 16 × 4-bit index registers in 8 pairs, an 8-bit
  PC with a three-level stack, SRC + WRR to five output ports (four hex digits, four LEDs), RDR from four switches, JCN
  on the TEST key (Space), halt on a JUN to itself. Six blocks drawn as sandbox chips (PC & stack, Decode, Index
  registers, ALU, Accumulator, I/O), 3 357 NANDs without the ROM against the single-cycle RV32I's 48k, period 66.
  An assembler (a ROM language next to asm / rv16 / hex), a golden model and five samples (BCD addition 1234 + 5876,
  a counter, the switches, a multiply subroutine, TEST presses); the CPU drawer checks PC, A, CY, R0–R15, the stack,
  SRC and the ports every clock. Verified by lock-step on the samples and on 64 random ROMs (undefined words too)

**Campaign** (🚧, plan and status in [`docs/CAMPAIGN.md`](CAMPAIGN.md)): a tree of levels from a
transistor NAND to a pipelined 16-bit RISC-V-like CPU (RV16) with traps and interrupts. It has
graded build challenges, number and Boolean drills, assembly puzzles, a codex, skip with a reference
solution, and Unlock all. Its soft locks apply to the campaign only; the chapters and the sandbox
challenges stay open. Added since:
- ✅ **A level screen of its own** (`#/campaign/play/<node>`, ui/pages/level.ts): Play on the map opens it. The editor in
  level mode (the level's chip and the chips it uses, the level's parts first, a short toolbar, properties over the
  canvas while something is selected), the brief in tabs (Why, Task, Tips, Codex), Check, the score against par and
  the test player under the canvas, stars / Skip / Next in the level bar, and "Open in sandbox" for the same chip
- ✅ **Why we are building it** (campaign/cases*.ts): every build, core and program level has a case: the problem in
  the CPU it solves (the anatomy diagram lights its block, or the block its part ends up in), what breaks without it,
  what it costs against the alternatives (library parts, measured live), and the levels that use it. After a pass a
  card shows the learner's measured cost against par and the alternatives, and the copies of the part in the finished
  CPU (campaign/measure.ts: 64 full adders) times the NANDs saved
- ✅ **Step-by-step solution walkthrough** (campaign/walk.ts, ui/pages/levelwalk.ts): "Walk me through it" (and Show
  answer, at the last step) builds the reference answer step by step on a scratch chip, never the learner's: the
  step list, the narration and codex links, cost and depth so far against par, the rows each output already gets
  right. "I'll take it from here" copies the partial circuit into the level's chip (one undo step). Steps are
  generated in dataflow order (like parts grouped in big references) or authored (walks*.ts, the main path)
- ✅ **A fuller codex** (campaign/codexmore*.ts, ui/codexentry.ts): every entry has the idea, a worked example and
  common mistakes, where it sits in the CPU and links to its levels and chapter steps, next to generated figures:
  the library part simulated live (click an input), its datasheet with the truth table, and its cost against the
  alternatives. The one-liner stays as the summary and the hover text

- ✅ **Reference and par review**: references that wasted NANDs their pars counted were tightened and every par
  re-measured (scripts/campaign-pars.ts). The levels unlock storage cells at the learner's cost (D latch 4, flip-flop 9,
  enable flip-flop 13, 16-bit register 208 instead of the library's 240) and a 49-NAND bus mux; the PC drops its dead
  enable muxes (448 → 318), the non-branching pipelines their branch hardware (10 290 → 7 676), the trap cores their
  cause muxes, the finale its 16-bit valid register (15 050 → 13 035); Core I gets its own reference. Pipeline IV now
  beats Core III on time (116 610 against 121 128 NAND delays). docs/CAMPAIGN.md section 9
- ✅ **After the par review** (docs/CAMPAIGN.md section 9): the 4:1 and 8:1 bus muxes, the barrel shifter and the ALU
  as campaign parts built from the 49-NAND mux (`rv16_mux4x16` 147, `rv16_mux8x16` 343, `rv16_shift16` 299,
  `rv16_alu16` 1 055), three-way choices on two 2:1 muxes instead of a 4:1 with an idle input, 19 pars re-measured
  (the single-cycle core 5 236 → 4 741, the finale 13 035 → 12 059); a core's cycles counted to the end on any bench
  (1 495 on both for Pipeline IV); c_computer's ROM is the given part; earlier stars kept as earned
- ✅ The side quests' 16-bit 2:1 muxes: the FP adder, multiplier and int → float and the 16-bit divider take the 49-NAND
  mux in the campaign (a `Mux2Kind` option on the library generators); five pars re-measured (docs/CAMPAIGN.md section 9)

**Not planned**: online leaderboards and score histograms (static site; share links take their place).

### Cross-cutting features 🚧
- ✅ Probe mode + logic-analyzer Timing panel (exact transitions in gate delays, clock edges,
  A/B cursors, VCD export); fixed-period clock that can be overclocked (late edges marked)
- ✅ Wire palettes: default, colour-blind safe (Okabe–Ito), Logic Sim, high contrast, print
- ✅ Hops at wire crossings; bit ranges on splitter / merger taps; click a net label to pair it
- ✅ Slow motion draws each change as a front travelling along its wires
- ✅ Download any component's hierarchy as SystemVerilog (exact structure or synthesizable),
  with a self-checking testbench; verified through Yosys
- ✅ Click a program line: the hardware it uses (and its pipeline stage), or its word in the ROM
- ✅ Search palette (`Ctrl/⌘ K` or `/`) over every chapter and step; chapter menu on the top bar
- ✅ Hover definitions (campaign/glossary.ts): codex terms in the chapters' prose and on the level screen are underlined,
  their summary shown in a card with a link to the entry; a switch in the view menu turns them off (marked the first
  time a term is met in a chapter)
- ✅ A guide around the chapters' prose (learning-guide pass, merges 1–2): every chapter opens with goals and the
  chapters it builds on and closes with a recap step (what to keep, three Check yourself questions, its codex entries
  and campaign levels); parts named in the text light on the stage (a click frames them); a highlighted scene says what
  is lit; every wrong quiz option says why; reach challenges have hint ladders; try boxes tick themselves; Deeper folds;
  step dots and the chapter menu count checks solved
- ✅ The codex as a guide (merge 3): search over titles and summaries and a kind filter; under each summary where to
  learn it (chapters, levels), what it builds on and leads to (from the level graph) and related entries both ways;
  previous / next; figures from the site's widgets for entries without a part (the gate-level pipeline run a few cycles,
  the number explorer, instruction fields); two Check yourself questions per entry and a generated drill for the number
  entries; locked entries show their summary. Every quiz shows its options in a fixed shuffle per question
- ✅ The walkthrough as a guide (merge 4): one hint ladder (a nudge, the tips, the walk from step 1, the solution behind a
  confirm); every build and core level has an authored walk, each with one question to predict before the step that holds
  its trick; Build along: the step's parts as outlines, snapped into place, Check step compares the learner's wiring with
  the reference (parts by kind and place, nets by the ports they join)
- ✅ Content review (2026-10-19): 166 findings over the chapters, codex and walkthroughs fixed (no quiz answer was wrong;
  typed numbers drifted, model simplifications read as device facts, one core's choices as how GPUs work); breadth
  added inside existing steps (the flip-flop timing contract and synchronizers, LR/SC / acquire / Amdahl, virtual
  memory, real-GPU reconvergence, DDR timing rules, row hammer, power) and 25 codex entries for chapter topics; quoted
  numbers read back from the texts by `tests/content-*.test.ts`; three campaign references re-authored (docs/CAMPAIGN.md)
- ✅ Progress tracking (visited steps, solved challenges, in local storage) and "Reset progress"; the chapters
  stay open (soft locks exist only in the campaign, see `docs/CAMPAIGN.md`)
- ✅ Reduced motion: CSS animations and transitions off, slow-motion fronts drawn as plain changes
- ✅ Live state diagrams (state machines as data, `FsmSpec`): the multicycle controller panel's Diagram | Table (an arc
  hovered lights its AND gate and ORs), a chapter 9 step designing the 101 detector from its table, a second codex
  figure for a library part with a spec, and the campaign's `s_fsm` level reading the learner's circuit back over the
  target (wrong arcs red, the expected one dashed); tests prove both controllers and the detector equal to their diagrams
- ✅ Automatic clock (a setting, on by default): a clocked chip opened in the sandbox or a level, or a clocked scene in a
  chapter or the workbench, starts running at 2 Hz; Pulse, Step, Back, a hand-clocked edge and the test player pause
  it. Run steps half periods, so the clock is seen high
- ✅ Flowing bits: pellets along a 1-bit wire carrying 1, a bus's non-zero value riding along it as tags (a switch in
  the wire-colour menu), in the chapters, the workbench and the sandbox
- ✅ Offline desktop program: `npm run desktop` builds a portable Windows `.exe` (the built site in Electron, fonts
  bundled, data next to the `.exe`), published by the *Desktop program* workflow as the release `desktop-latest`
- ⏳ Keyboard navigation beyond the shortcuts. Done: one key table behind every `?` sheet, letters by position on non-Latin layouts, a switch for single-key shortcuts, `[ ] { }` through the chapters, a skip link and S to the circuit, Esc then Tab out of code editors, and the search (chapters, workbench, campaign, codex, `>` actions). Next: a part cursor on the stage (run, step, inputs, zoom by key), then placing and wiring in the sandbox by keyboard
- ✅ Export the sandbox canvas as SVG / PNG (current theme), and the level on a chapter's or the workbench's stage (the
  stage bar's Image menu: the whole level with its live values, whatever the zoom, without probe flags)
- VHDL view of every component
- Performance budget: 60 fps rendering of ≤ 5 000 visible elements; ≥ 100 CPU cycles/s at gate level (met: the sandbox's
  single-cycle RV32I runs ~4–5 kHz in the page on the cycle engine, ~400 Hz on GateSim)
- i18n-ready strings

### Phase 13 — Verification, precise claims, measurement 🚧
From an external review (2026-10). The project's depth is ahead of how it presents and proves itself: the CPUs are
checked only against our own golden model, the README both oversells (gate delays) and undersells (the sky130 flow),
and some measurements the simulator could make (power, benchmarks) are not made. Ideas the review raised that are
already done (adder and CPU comparisons, golden-model lock-step in the UI, instruction → hardware marks, cache and
coherence explorers, delay animation, static vs simulated paths, Yosys cross-check, the OpenROAD flow) are not repeated.

**Say exactly what is modelled**
- ✅ MIT license
- ✅ README: the campaign, how everything is checked (components, CPUs, drawings, HDL, the sky130 flow), and a
  **Scope and limitations** section: MOSFETs are switches with strengths and stored charge, not a SPICE model; timing is one unit per NAND,
  converted to time by an illustrative 25 ps / NAND (`PS_PER_NAND`), not characterized from a cell library; the
  built-in placer and router are a teaching model, the OpenROAD run is the real one; power-on state comes from a
  resolution model, not physics; CPUs are checked against our own ISS plus the independent checks below
- ✅ Screenshots and GIFs in the README (drill-down to transistors, carry ripple, pipeline, sandbox, layout)
- ✅ The timing panels (chapters and sandbox) and the static-timing step name the 25 ps / NAND as illustrative
- ✅ Chapter 27 separates the teaching P&R from the OpenROAD run; chapters 22 and 26 call cache-miss freezing and
  arbiter-serialized atomics deliberate simplifications (and name non-blocking caches, lr.w / sc.w)
- ✅ Repository description, homepage and topics on GitHub

**Independent verification** (our ISS and our CPUs share one author: a misreading of the spec passes in both)
- ✅ Official `riscv-tests` (`rv32ui`, `rv32um`, `rv32uf`, `rv32ua`, `rv32mi`): images built by
  `scripts/riscv-tests/build.mjs` (GNU toolchain), checked in with their source revision; env `p` on the system
  CPUs, our `bare` env (same tohost contract, no CSRs) on the rest, a loader for the Harvard data memory. In
  `npm test` on the golden model and on all 22 CPU variants at gate level, 32 programs per BitSim run (one per lane);
  the pass / fail matrix is in `docs/VERIFICATION.md`. Found: the golden model's RV32 shift decode, the missing id
  CSRs (golden model and system CPU), the pipelined divider's sign with forwarded operands
- ✅ A second ISS as oracle for ours: Spike in a CI job (`.github/workflows/spike.yml`, pinned revision, cached
  build), random programs for six ISA variants (RV32I / IM / IF, IMF with byte and halfword access, the system CPUs'
  machine mode with traps) linked as ELFs without a toolchain, commit logs compared instruction by instruction (pc,
  word, x / f writes, stores, load addresses, CSR writes, trap cause / epc / tval). Seeds 1–1000: 6000 programs,
  1 236 958 instructions, no difference beyond two legal ones (mtval on illegal / ebreak; mret's zero writes to
  tcontrol, a debug CSR ours lacks); it found `mstatush` missing from the golden model and the system CPU (added). Seeds 1–1000 per variant on every ISA change, 4000 more each night
- ✅ RV32 random-program fuzzing (`src/riscv/randprog32.ts`): ALU edge values, every branch, jal / jalr, loops,
  loads / stores of every width, hazard-dense operand choice, CSRs, traps and a timer interrupt, M, F (special
  values, every rounding mode), atomics on the dual-core; final state against the golden model on every CPU, a
  mismatch replayed in lock-step for the first difference; seeds 1–32 in `npm test`, a new 2048-seed range nightly
  (`.github/workflows/verify.yml`). Found: the six-stage FPU pipeline losing a taken branch while D waited
- ✅ Coverage of the CPU suites (`scripts/coverage.ts`, tables in `docs/VERIFICATION.md`): instructions and trap
  causes, forwarding paths, load-use / FP / divide stalls, flushes, mispredictions, cache hits / misses /
  write-backs, interrupts, memory conflicts, multicycle states; `npm test` fails on any gap (there are none)
- ✅ `scripts/verify-export.ts all` (Yosys netlist simulated against our gate-level run, every multi-core program) as
  the `verify-hdl` CI job with `yowasp-yosys`: the deploy waits on it
- ✅ The same cross-check on the system CPUs (RV32I and RV32IM + Zicsr): every system, M and two user programs, irq
  pulses and switch changes driven into both netlists, every output port (PC, console, LEDs, retire) compared per cycle
- ✅ The campaign's RV16 cores against iss16: the golden model drops what the cores lack: CSR 7 (was mcycle) reads 0
  in both, and the timer is gone (a cycle counter would count cycles in the hardware, instructions in the model)
- ✅ GateSim refuses a behavioural delay of 64 or more (the event wheel) instead of clamping it silently

**Measure more** (computed from the circuits, like every other number)
- ✅ Dynamic power, P ≈ α C V² f (sim/power.ts): GateSim counts every net's 0 ↔ 1 transitions, glitches included; C per
  net from its fan-out (0.5 fF per NAND input, 0.5 fF for the driver, 0.3 fF of wire per branch: illustrative 28 nm-class,
  like the 25 ps / NAND), ½ C V² per toggle, V set by the learner, f from static timing. The inspector's Power section
  (energy per cycle or operation, power, glitch share, α, split by the block driving each net, the clock net its own
  row: live on a chapter or workbench scene, else on seeded random inputs); energy per add and glitch share in chapter
  15's adders, energy per instruction in chapter 18's table, in the CPU panel and the sandbox's CPU drawer (gate mode);
  energy, energy per instruction, glitches and power on the Benchmarks tab (every run again on GateSim, its cycle count
  equal to BitSim's) with a speed-against-energy chart. Labelled an estimate: no leakage, no clock buffers. Found: the
  pipeline spends what the single-cycle CPU does per instruction (46 pJ) although it runs 50 % more cycles: its
  registers cut the glitches from 48 % to 10 % of the energy; the multicycle CPUs spend twice as much (every state
  clocks every register), microcode a little less than the hardwired FSM; an instruction cache doubles the energy per
  instruction; the single-cycle CPU's 64-word data memory and its clock net take half of its energy
- ✅ Benchmarks: the workbench's Benchmarks tab (`#/workbench/bench`). Six programs (recursive Fibonacci, insertion sort,
  4 × 4 matrix multiply in software and with mul, bitwise CRC-32, a float kernel with fdiv / fmadd / fsqrt), each with its
  result also computed in TypeScript, on all 22 gate-level CPUs: instructions, cycles (to the golden model's instruction
  count), CPI, period, time, NANDs, cache misses and stall cycles, every run's final state equal to the golden model's;
  a speed-against-cost chart with the best-trade-off front. `scripts/benchmarks.ts --write` (~9 min) saves the results;
  a test catches a changed program and re-measures the single-cycle CPU. Energy joins with the power estimate above.
  Found: an unbalanced pipeline is slower than the single-cycle CPU with the same adders; with 64 words of data the
  2-way write-back cache loses to write-through (write-allocate misses)
- ✅ Hardware statistics page: the workbench's Statistics tab (`#/workbench/stats`): every library component, every
  size the workbench families offer and the chapters' CPUs (transistors, NANDs, depth or clock period, levels, boxes
  inside), sortable, filtered by category and search, a family's sizes on one expandable row, each row opening on the
  workbench (a CPU in its chapter); computed by the build into hwstats.json, live without it
- ✅ Where is it used: the inspector's "Where it is used" (any library part, in the chapters, the workbench and the
  sandbox): the components placing it directly with their instance counts (sizes of one generator on one row, each
  opening on the workbench), and its copies in each of the chapters' CPUs once flattened (lib/usage.ts)

**Onboarding**
- ✅ The sandbox as a fourth entry on the home page (journey, campaign, workbench, sandbox)

**Not planned** (from the same review)
- Restructuring `src/` into new namespaces, splitting `ComponentDef`, separating geometry from netlists: churn with
  no learner-visible gain; the boundaries are documented in `CLAUDE.md`
- An analog MOSFET mode (voltages, currents): without a real device solver its numbers would be drawn, not
  computed; the cross-section widget carries the intuition
- A configurable-depth pipeline lab (3 / 5 / 7 stages): large; the adder swap, predictor, cache and multicycle
  comparisons already show the trade-offs

### Phase 14 — Before the transistor: relays, vacuum tubes, punch cards 🚧
Why the MOSFET won is best felt, not told: build the same adder from relays and from tubes and *see* the machine
it becomes. Mockup first for the 3D view, the technology setting and the new act. In the journey, a prologue act
before the MOSFET chapter; in the campaign, an act of its own (or a side branch) ending in a machine programmed
with punch cards.

**Relay and tube bricks** (switch level, like the MOSFET)
- ✅ Relay: a coil driving changeover contacts (normally open / normally closed), contacts conducting both ways (a
  pass switch), milliseconds per operation, a latching (self-holding) relay as memory. prim 'relay' in SwitchSim
  (relay steps, an open line reads 0 through the next coil), lib/relays.ts (NOT, NAND, XOR, a full adder with the
  carry through contacts on two rails, an n-bit adder settling in one step, latch, buzzer), prologue chapter P1
- ✅ Triode: the grid controls the plate current, one way only, with a plate resistor as the pull-up (ratioed
  logic, which `switchsim.ts` already models with its resistor strength); tube inverter and NOR, cathode follower,
  the Eccles–Jordan flip-flop; microseconds per operation, watts per tube. prim 'triode' and 'diode' in SwitchSim
  (one-way elements; a strength-0 bias resistor for the dividers' legs to −150 V), lib/tubes.ts (the diode NAND brick,
  the nine-NAND full adder in tubes), phys/triode.ts (levels, fan-out margins, power), prologue chapter P2 (7 steps,
  the divider explorer)
- ✅ Each device up close in 3D, live, on lumped physics (relay: src/phys/relay.ts, src/gl renderer, P1 step 1; triode: src/phys/triode.ts, widgets/triode3dview.ts, P2 step 1) (as chapter 1's cross-section opens the MOSFET; chapter 27's
  renderer, cylinders and glow added). Relay: coil current rising with L / R (and the flyback spike at turn-off), pull
  ∝ (N·I)² / gap² against the return spring, the armature a mass on a spring, so pull-in time, pull-in / drop-out
  hysteresis and contact bounce come out of the model. Triode: a heated cathode (Richardson emission, seconds of
  warm-up), the space-charge law I ≈ K·(Vg + Vp/μ)^1.5, electrons drawn flowing and turned back by a negative grid,
  plate heat as glow. Constants from real datasheets (ENIAC's 6SN7), labelled illustrative; the relay brick's delay
  and the triode's transfer curve are taken from these models (tests hold them equal), so the picture and the
  simulation cannot drift apart
- ✅ Gates and blocks in each technology, measured like the CMOS ones (relays / tubes, delay, power): first the
  NAND-mapped versions (the brick principle), then native designs that show what each technology is good at
  (changeover contacts make a relay XOR or a mux nearly free; tube logic prefers NOR), so the comparison is honest.
  lib/tech.ts prices any design through the NAND brick: a relay coil per NAND output with ⌈k / 4⌉ − 1 more for a net
  read by k contacts (sim/techcount.ts counts fan-out per definition, equal to the flattened count), a tube brick
  (½ 6SN7 + a 6AL5, 4.86 W) with cathode followers past the plate's fan-out of 3 (from the levels model); steps ×
  8.2 ms / 1 µs / 25 ps; volume and mass from a relay rack, the Z3 and ENIAC's panels. Native parts by their own
  devices, relay steps measured on SwitchSim (lib/techsteps.ts). Chapter 3's last step "One NAND, three
  technologies" (widgets/techcompare.ts): NAND, full adder, 32-bit adder, the two CPUs without their program ROM
  (withoutParts), NAND-mapped or native
- ✅ A technology setting for any chip (CMOS / relay / tube) in the chapters, the workbench and the sandbox:
  the netlist is the same, the counts, delay, power and volume follow the technology (view/techtable.ts: the
  inspector's "In relays and tubes", a sandbox chip's properties, the Statistics tab's CMOS / Relays / Tubes switch
  from hwstats.json's relay and tube cells); the relay and triode parts are in the sandbox's library palette

**The 3D machine** (to show the bulk)
- ✅ A 3D view of any design at physical scale: its flattened netlist as relays on boards in racks, or tubes in
  chassis in cabinets, with the same design in CMOS beside it (a speck) and a human figure for scale. Sizes,
  power and heat from per-device constants labelled illustrative (as the 25 ps / NAND is); historical machines
  for reference (Zuse Z3: about 2 600 relays; ENIAC: 17 468 tubes, about 150 kW and 27 t). Chapter 27 step 9
  "The same CPU in relays and tubes" (lib/hall.ts, widgets/hallview.ts): the 4-bit CPU and the RV32I without their
  program ROM, a block's racks or ENIAC panels of its own (RV32I: 78 racks, 70 if shared; 181 panels), every device
  drawn (55 699 relay boxes, 75 779 tube cylinders), the CMOS die at true size on a table. Only these two CPUs so
  far, not any design
- ✅ Live: relays click and tubes glow with the simulation's values; orbit, zoom, and a click on a rack opens
  that block's schematic (transparent boxes in 3D too). The cycle engine's settled values, at most 20 updates a
  second; clicks off by default; a flat isometric drawing without WebGL2
- ✅ Its own lazily loaded chunk (a small WebGL renderer, or three.js if it earns its size); the main bundle does
  not grow (the view is its own 19 kB chunk; the chapter's computed prose and lib/hall.ts add 7 kB to the main one)

**Punch cards**
- ✅ History step in the journey: Jacquard's loom (1804), Hollerith's census cards (1890), the IBM 80-column
  card (1928) and its Hollerith code. Prologue P3 (chapters/ch-cards.ts, widgets/cards.ts): a chain of cards weaving
  a pattern, Hollerith's pin press counting a census on dials (a combination through relay contacts), the card
  editor, a program as an object deck with the card sorter's radix sort, the card reader on a scene
- ✅ A card editor: 80 columns × 12 rows, click to punch, or type and it punches the Hollerith code; a binary
  mode for machine words (one word per column or per row); a deck of cards, reorderable, exportable. cards/ (the
  IBM 029 code, source and object cards: a word in row 9, a sequence number in 73–80; deck files .deck.json, the
  sorter), widgets/carddraw.ts (a to-scale card); P3's editor and the sandbox reader's properties. Machine words
  go one per card along row 9 (the mockup's choice); a deck is reordered by dropping and sorting, not by hand
- ⏳ A card reader part (sandbox and campaign) feeding a ROM or a word stream (like the keyboard part), and the
  program input of the relay / tube machine
  - Sandbox part done (editor/cardparts.ts, cardui.ts): the deck in the document, word or column mode, feed delay;
    properties punch cards by hand, type source cards, load / save / drop / sort decks, punch one from a ROM, follow
    the read station live; the campaign's reader in h_loader (14e). Still to do: the relay / tube machine's program input
- ✅ In the campaign: a Hollerith-code drill (`h_card`) and a level where the program arrives on cards (`h_loader`:
  the learner's loader fills a RAM from the reader for the 4-bit CPU, graded in relays and cycles to load)

**The campaign act** (14e)
- ✅ Act P "Before the transistor", optional, beside act 0 (docs/CAMPAIGN.md): relay levels at switch level (NAND, XOR,
  a 4-bit adder with the carry through contacts, a self-holding relay, the buzzer clock and its ÷2), tube levels (two
  inverters in a row with the grids behind dividers, Eccles–Jordan), a relay drill on the physical model's curves, the
  Hollerith drill and the card loader; strict part rules (no MOSFET, no NAND), graded in relays, relay steps and tube
  sections, the CMOS alternatives priced the same way through the technology setting
- ⏳ Cards for the RISC-V CPUs: any program (RV32 asm / hex in the ROM editor and the CPU panel, RV16 in the
  campaign) exported as a deck, one instruction per card (its word punched in binary, the source line printed in
  Hollerith along the top, a sequence number in columns 73–80 as on real decks so a dropped deck can be sorted),
  and a deck loaded back into a ROM; drop a deck file on the canvas to load it
  - Done for the sandbox's ROMs (RV32 asm / hex, RV16, 4-bit CPU, custom ISAs: Save as deck / Load deck in the
    ROM properties and program editor, a .deck.json dropped on the canvas) and the chapters' CPU panel (cards/program.ts).
    Still to do: the campaign's RV16 programs
- ⏳ A card-reader boot loader: a small sandbox example where the CPU starts from a boot ROM that reads cards from
  the reader part, word by word, into RAM and jumps to it, as IBM's machines loaded from cards (the 1401's Load
  key); the CPU drawer follows the loaded program like a ROM program, the golden model starting after the load
  - ✅ On chapter 37's bus computer: step "Booting from cards" (a card-reader slave AXI_CARDS at 0x7000_0000, the
    reader leaf holding the deck, a 13-instruction boot ROM that copies the deck to 0x400 and jumps there; the golden
    model counts edges for the reader, so the gate-level computer is co-simulated in lock-step at any feed delay;
    tests/buscards.test.ts)
  - ✅ Examples ▸ Boot from cards (editor/examplecards.ts): rv32i_core, a boot ROM part, a two-port RAM, the reader part at
    0xC000_0000 and a console; Drop / Sort in the reader's panel; the CPU drawer's golden model sits out (tests/editor-cardboot.test.ts)

### Phase 15 — Journey and campaign track: GPU ✅
The same bricks arranged for throughput instead of latency: one instruction stream, many lanes, latency hidden by
other threads rather than by forwarding and caches. Every unit is measured like the CPUs (NANDs, depth, period) and
co-simulated against a golden model.

**Decided** (mockup approved 2026-10-11): journey chapters 28–33 after silicon (Lanes, Threads in lock-step, Hiding
latency, Feeding the lanes, Pixels and triangles, The graphics pipeline); campaign act 9 after the side quests,
requiring the finale; explicit split / join divergence (Vortex's scheme) with pred for comparison, on custom-0
(funct3: tmc 0, wspawn 1, split 2, join 3, bar 4, pred 5) and read-only CSRs lane / warp / nlanes / tid / tmask
(0xCC0–0xCC4); a lane-count generator (2 / 4 / 8), 4 shown; RV16: SYSTEM funct3 4–7 (split, join, tmc, bar) and
CSR 7 = tid, a 32 × 32 RGB565 screen at 0xF000–0xF3FF, one pixel per word. Order: lane core + chapters 28–29, then
the campaign's first levels, then warps and memory (28–29), graphics last (30–31).

**Work in phases** (each merged and deployed on its own)
- ✅ 1. RV32 lane core, its golden model and chapters 28–29: deployed 2026-10-11 (913fec6). Groundwork before it:
  multiCore(n) with arbiterN (e3c6b2a), the 4-core baseline the lanes are measured against
- ✅ 2. Campaign act 9, first levels (below), with the RV16 encodings, a 4-lane RV16 golden model and a lane bench
- ✅ 3. Warps and memory (mockup approved 2026-10-13), in three parts: ✅ 3a warps, scoreboard, an 8-cycle memory and
  chapter 30; ✅ 3b coalescing, banked shared memory, bar, amoadd.w in the lanes and chapter 31; ✅ 3c the act's coalescer,
  two-warp and histogram levels
- ✅ 4. Graphics (mockup approved 2026-10-13: quarter-pixel vertices, 18-bit edges, 4 × 4 tiles walked as bands, depth with
  chapter 21's divider, a scan-out feeding a screen panel), in three parts: ✅ 4a the rasterizer, framebuffer, scan-out,
  depth and blending, chapter 32; ✅ 4b the vertex kernel, command unit and chapter 33; ✅ 4c the RV16 raster device,
  bench, k_edge / k_tile / k_raster / k_frame and p_spin

**Graphics**
- ✅ Pixels and triangles (chapter 32): a 64 × 64 RGB332 framebuffer in four byte banks, double buffered, a gate-level
  scan-out (a word a cycle, vsync, flip at vsync or at once: tearing); the rasterizer (lib/raster.ts, 11 989 NANDs, one
  pixel a cycle): set-up on one Booth multiplier, three edge steppers, a tile walk that skips tiles an edge rules out
  (the large preset 1 914 cycles against 3 368 for its box); with depth, a depth set-up (Booth, 30-bit divider, Horner;
  12 032 NANDs, +76 cycles) and a 32-bit stepper, and a ROP with a 64 × 64 × 16-bit depth buffer and alpha blending.
  Checked against gfx/raster.ts pixel for pixel and cycle for cycle (tests/raster.test.ts)
- ✅ The graphics pipeline (chapter 33): a vertex kernel (16.16 rotation with mul, one thread a vertex) on a one-warp
  core with a host port, a command unit (1 997 NANDs) that launches it a frame ahead, clears, reads the triangles and
  their vertices from a double-buffered vertex buffer and feeds chapter 32's rasterizer with depth; a spinning
  triangle (6 144 cycles a frame) and a cube (7 168–8 192) at gate level on the cycle engine, about three and two frames
  a second in the page, every frame checked against the reference. Where the gates go: the warp core 182 121 NANDs busy
  1 % of the frame, the clear 72 % of it (software on 16 threads clears in 804 cycles), the triangle in software 6 825
  cycles against 1 268
- ✅ A faster clear (chapter 33, step 5): a clear unit (278 NANDs, a word counter) writes four pixels and four depths a
  cycle into the frame's byte banks and a depth buffer split into four banks: the clear 1 026 cycles instead of 4 438,
  the triangle's frame 3 072 (was 6 144), the cube's 4 096 or 5 120 (was 7 168–8 192), about 580 NANDs in all; the
  scene switches between the two clears, every frame checked against the reference

**Compute**
- ✅ Lanes (chapter 28): laneCore(program, n) (lib/lanes.ts): the single-cycle front end feeding n lanes (registers,
  ALU, result mux each); the leader (lowest active lane) steers branches through one-hot muxes; a memory sequencer
  serves one active lane per cycle. Measured against multiCore(4): 149 043 NANDs against 181 713 (a lane is mostly its
  23 141-NAND register file), but 134 cycles against 96 on saxpy (a load stops every lane)
- ✅ SIMT (chapter 29): the active mask (inverted flip-flops: all lanes at power-on), tmc, split / join with a 4-entry
  shift-register stack (mask, else mask, resume PC, pending), pred; lane utilization per kernel (45–100 %). Golden
  model riscv/simt.ts, co-simulated every cycle (PC, mask, every lane's registers, the stack) on 2, 4 and 8 lanes; the
  Warp panel (widgets/lanes.ts) runs it in lock-step
- ✅ Warps (chapter 30, Hiding latency): warpCore(program, { warps, lanes, latency }) (lib/warps.ts): warp slots (PC,
  mask and stack, run bit, a scoreboard of pending bits), the scoreboard check, chapter 26's round-robin arbiter over the
  ready warps, a register bank per warp in every lane, and a data memory with a port per lane behind an L-cycle pipeline
  (initial contents as power-on hints). Co-simulated against riscv/warps.ts (WarpISS: the warp the scheduler issued
  steps) after every issue; riscv/warptiming.ts predicts its cycles exactly (tested). Measured, saxpy on 64 elements,
  8-cycle loads: 266 / 192 / 172 cycles on 1 / 2 / 4 warps (58 / 83 / 100 % of the issue slots); a warp costs 110 622
  NANDs (its registers 92 564). The Warp panel (widgets/warps.ts) draws the issue timeline and the scoreboards; the
  occupancy widget sweeps warps and latency; the top level drawn by hand in four bands (warps, decode, lanes, memory),
  about twice as large at fit in chapters 30, 31 and 33
- ✅ Feeding the lanes (chapter 31): warpCore(…, { lsu: true, mul }) (lib/warpmem.ts): one memory port behind an access
  unit (a global access serves the lanes in the leader's 16-byte line; a 4-bank shared memory at 0x1000 serves each lane
  whose bank row is its word, broadcasts included; amoadd.w one lane per access); a memory instruction holds the issue
  port one cycle per access. Shared accesses enter the pipeline Ls − 1 stages from the end (2 cycles against 8) when
  that slot is free; globalEvery = B limits global accesses to one every B cycles. bar: a waiting bit per warp, released
  when rs2 warps have arrived (one barrier). mul in the lanes (the low product). Golden model and timing model extended;
  co-simulated cycle for cycle on six new kernels. Measured: sums stored by rows 124 cycles (68 accesses) against 76 by
  columns (20); tree reduction 298 cycles (strided pairs, bank conflicts: 330); histogram 197; matmul 396 cycles plain
  against 592 tiled at a line per cycle, tiled ahead from a line every 3 cycles (622 against 668). The one-port core is
  cheaper than chapter 30's: 625 016 NANDs against 674 490 (four ports cost 183 964, a line memory 77 829)
- ✅ ISA: the SIMT extension above, assembler and disassembler, the multi-lane golden model; kernels saxpy, divergence,
  nested ifs, pred loops, tmc, a forgotten split; wspawn and nwarps (CSR 0xCC5) with the warps; bar, amoadd.w in the
  lanes, mul; reduction, histogram, plain and tiled matrix multiply
- ✅ The lane and warp cores' listing marks (insthw laneUse) and Slow mode, as the CPU panel has; chapters 28–31 on the
  cycle engine (Run to halt several times faster in the page)
- ✅ The campaign's lane cores on a sandbox bench (a failing program of k_simd, k_simt, k_warps or k_frame opens around the
  learner's core, a memory port per lane, the CPU drawer checking every thread live); the sandbox RAM gained ports

**Graphics**
- ✅ Framebuffer and scan-out to a pixel screen, double buffering, flips at vsync (chapter 32)
- ✅ Fixed-function blocks that open to gates (chapter 32): edge functions and a rasterizer (bounding box, half-plane tests, a
  tile walk), barycentric interpolation, a z-buffer test, a blend unit; fixed point first, then the FPU
- ✅ Vertex transform as a kernel on the compute cores (chapter 33); a spinning triangle (then a small mesh) with frames per
  second at gate level and the cost of each stage of the graphics pipeline

**Campaign**
- ✅ Act 9 "Throughput: a GPU" (RV16, 4 lanes × 16 bits), after the side quests, requiring only the finale (y_final);
  levels unlock their parts at the learner's cost, as the rest of the campaign (lib/rv16/lanes16.ts, campaign/buildk.ts).
  Every level of the act is playable. Measured references: four lanes 4 596
  NANDs, lane register file 8 772, active mask 102, reconvergence stack 1 995; SIMD core 15 774 NANDs, SIMT core
  17 837, both at period 100 with one instruction per cycle (each lane has a memory port until the coalescer)
  - ✅ phase 2: k_lesson (lesson: latency or throughput), k_lanes (build: four lanes), k_vrf (build: lane register file),
    k_mask (build: active mask), k_simd (core: SIMD core), k_stack (build: reconvergence stack), k_simt (core: SIMT
    core); kernel puzzles p_saxpy and p_reduce, scored on cycles and lane utilization
  - ✅ phase 3: k_coal (build: coalescer, 467 NANDs), k_warps (core: two warps taking turns over a memory one cycle
    late, 30 163 NANDs, period 95); puzzle p_hist (private counters and a bar, checked under two issue orders)
  - ✅ phase 4: k_edge (build: edge stepper, 984 NANDs), k_tile (build: tile walk, 479), k_raster (build: rasterizer
    with shift-and-add set-up, 9 251, period 145), k_frame (core: the two-warp core with the rasterizer as a device,
    41 250, period 147); puzzle p_spin (Minsky's rotation, two triangles a frame)
- ✅ RV16 groundwork: split / join / tmc / bar in SYSTEM funct3 4–7 (illegal on every scalar core, so the trap cores
  reject them), CSR 7 = tid (warp · 4 + lane; reads 0 on every scalar core, as before), the assembler, the lane golden
  model (riscv/rv16/simt16.ts: four Iss16 lanes over one memory), and the lane bench (campaign/lanecheck.ts: every
  lane's register writes and stores in order, four memory ports, 32 programs at once on BitSim)

### Phase 17 — Out of order ✅ (chapter 25)
More than one instruction per cycle, between floating point and many cores, so the journey runs from instruction-level to
thread-level to data-level parallelism. Mockup approved 2026-10-19 (E:/mockups/ooo/ooo-mockup.html), every recommendation:
chapter 25 (24–35 renumbered); two gate-level CPUs, `pipe-2w` (dual issue, in order) and `ooo` (2-wide out of order);
P6 style (values in the reorder buffer, the rename table maps a register to a ROB entry); ROB 16, issue queue 8, two
ports with a result bus each, store queue 4; BTB + 2-bit counters + a 4-entry return-address stack; recovery at commit;
the pipelines' 1-cycle data memory; RV32IM without traps; a cycle-exact model the gates must match; no campaign levels.
- ✅ 17a: the limit study and the model. `riscv/ilp.ts` (instruction classes, the golden model's trace, the dataflow
  limit and its critical path), `riscv/ooomodel.ts` (`OooModel`, `OOO_CORE`: the core's rules cycle by cycle, any
  width / window / latencies / predictor, recovery at commit or at execute, in-order issue for comparison; wrong-path
  instructions fetched and executed until the flush; tests/ooomodel.test.ts checks every rule every cycle on the
  benchmarks and random programs), `riscv/scoreboard.ts` (the CDC 6600's, reproducing Hennessy and Patterson's table).
  The model found the port policy: branches on both ports and binding to the less busy port take fib from CPI 1.15 to
  0.99. Chapter 25 with five model steps (the dataflow limit, where in-order stops, the scoreboard, rename / wait /
  commit, speculation) on `widgets/ooo.ts`; its numbers pinned by tests/ooo-chapter.test.ts. Found: on the benchmark
  set the front end limits more than the window (fib: CPI 0.99, perfect prediction 0.63)
- ✅ More than one retirement per cycle (feat/multi-retire): a CPU gives the count on `retire` (oldest first, `pcW0`);
  the CPU panel, the sandbox monitor, fuzz replay and the benchmark lanes step the golden model that many times.
- ✅ 17b: `pipe-2w` (lib/pipe2w.ts), the balanced RV32IM pipeline with prediction two lanes wide: two ROM reads, the BTB
  looked up for both slots, a 4-entry return-address stack (lib/ras.ts, the model's rules), a pair check (lane 1: no
  memory, multiplier or divider; one control instruction a pair; nothing after a divide; no read of slot 0's result:
  else hold and shift), a 4-read 2-write register file, look-ahead forwarding from both lanes. riscv-tests, 2048 random
  programs and the benchmarks match the golden model. 193 768 NANDs (+37 % on pipe-m-bal-bp), period 80 (79), CPI fib
  1.13, sort 1.01, matmul 1.05, matmul-m 1.09, crc 0.97 (1.35 / 1.18 / 1.30 / 1.25 / 1.23). Chapter 25 step 2; the
  pipeline diagram, listing and sandbox drawer show both lanes; the Benchmarks tab's two-wide family
- ✅ 17c-1: the out-of-order core's units (lib/ooo.ts): the return stack with two operations a cycle, the BTB trained at
  commit by the model's rules, the issue queue (wakeup, age matrix, select per port with bus slots and the divider), the
  rename table, the reorder buffer, the store queue with forwarding, a data memory with a read and a write port; each
  checked against the model's rules cycle by cycle (tests/ooounits.test.ts)
- ✅ 17c-2: the `ooo` core at gate level (lib/ooocore.ts), equal to the model every cycle on targeted programs, the
  benchmarks and 100 random programs (commits and each port's pick per cycle; every register after every commit); riscv-
  tests, fuzzing and coverage events. 359 262 NANDs (pipe-2w 193 768), period 93 NAND delays (wakeup → select → operand;
  port binding was 135 until its comparisons moved before the picks), CPI fib 0.99, sort 0.77, matmul 1.28, matmul-m
  0.84, crc 0.99. Random programs found a flushed divide still running inside the divider: a flush now aborts it
- ✅ 17c-3: the Out of order panel (widgets/ooopanel.ts: the reorder buffer, issue queue, rename table and store queue
  read from the gates by riscv/ooosnap.ts, equal to the model every cycle; the model's timeline beside them, its commits
  and picks checked every cycle; a row lights its units), also in the sandbox's CPU drawer; chapter 25's gate steps:
  the rename table, wakeup (one issue-queue entry), select (the age matrix and the wakeup-select loop that sets the
  clock), the reorder buffer, loads and stores (every load forwarded while a divide holds commit), the whole core
- ✅ 17c-3 follow-up: the core drawn in three bands, labels between blocks (lib/placer.ts, shared with the warp core)
- ✅ 17d: measured. "Measured, all together" (widgets/ooo.ts measuredWidget: the fastest single-cycle CPU, the best RV32IM
  pipeline, pipe-2w and ooo from results.json; CPI 1.00 / 1.26 / 1.04 / 0.99, but 106 / 99.6 / 83.1 / 92.3 NAND delays an
  instruction: the out-of-order core's period (93) costs it the lead except with the hardware multiply; 133.6 pJ an
  instruction; Pollack: 2.54× the pipeline's NANDs for 1.08×; width × window on the model: 16 entries are the knee at
  2 wide, 4 wide 0.79). "Code that helps the hardware": crc without its data-dependent branch (neg / and mask), 3 021 →
  2 330 cycles, 290 → 21 mispredictions, as much on the in-order machine; a reach challenge on the gates (the CRC of
  four words under 700 cycles: 807 → 610), with hints, Show answer and Do it for me. CI: long tests yield to the event
  loop (tests/yieldtick.ts: vitest's 60 s RPC timeout had failed a deploy with every test passing)
- ⏳ 17e: an out-of-order lab you configure (Phase 19; FREESS's strength). `OooModel` already takes any width, ROB,
  issue queue, store queue, latencies, predictor, BTB / RAS sizes, recovery point and in-order issue; what it lacks is
  ports decoupled from width and units per port (today port 0 takes memory, port 1 mul / div). Generalize the model
  (n ports, a unit mix per port, pipelined or iterative units, fetch / commit width separate from issue width), keep
  `OOO_CORE` as one point the gates are checked against, then a widget on chapter 25 and the workbench: the knobs, a
  program (the benchmarks, assembly, or chapter 15's Python), the per-cycle timeline, CPI and where the cycles go (front
  end, full ROB / queue, port conflicts, mispredictions, divider). Its cost side from the gates: ROB, issue queue and
  store queue sizes as parameters of lib/ooocore.ts (the core stays 2-wide), NANDs and period per size measured, so the
  lab prices a configuration instead of only timing it

### Phase 16 — Journey and campaign track: Memory ✅
Memory in depth, past today's arrays (chapter 10), cells and caches (Phase 8): how a DRAM chip really answers, what
a flash chip does when it cannot overwrite, and how the CPU, DMA and peripherals share one bus. In the journey, a
track of chapters after the memory hierarchy; in the campaign, an act of its own. Mockup first for the chapter
structure and the act.

Mockup approved 2026-10-16 (E:/mockups/memory/memory-mockup.html), every recommendation: chapters 34–37 after chapter 33
(Inside a DRAM, A memory controller, Flash, Buses and DMA; the appendix keeps its letter); charge as a level on
capacitive nets only, the sense amplifier the one part that reads it; leakage per clock cycle; DDR4-3200 at the
single-cycle CPU's clock (4 / 4 / 4, burst 4); the controller behind the write-back caches as new CPU variants; an
AXI-lite-shaped bus; a floating-gate switch-level part; act 10 "Memory" (optional). Sub-phases 16a–16e, each merged
on its own.

**DRAM in depth**
- ✅ The 1T1C array at switch level: bit lines precharged to V/2, charge sharing, the sense amplifier restoring the
  row (a destructive read and its write-back), leakage over simulated time and refresh before the cell is lost
  (16a, chapter 34: SwitchSim charge levels, lib/dram.ts, the DRAM panel)
- ✅ Organization: banks, rows and columns, the row buffer (page hit, miss, conflict), tRCD / tRP / tCAS / tRAS in
  cycles, burst transfers (chapter 34's row-buffer and timing widgets over dram/timing.ts)
- ✅ A DDR-style controller at gate level: open- and closed-page policies, refresh scheduling, an XOR bank hash; it
  drives the write-back cache's miss path, so misses cost what the row buffer says; CPUs sc-wb2-dram, sc-wb2-dramc,
  pipe-wb2-dram pass riscv-tests and fuzzing and are in the benchmark results (16b, chapter 35). FR-FCFS reordering is
  modelled (dram/schedule.ts) and shown; a gate-level request queue waits for several requesters (DMA, 16d)

**Non-volatile**
- ✅ The floating-gate transistor: stored charge shifts the threshold (a switch-level MOSFET with a programmable V_T),
  program and erase as slow operations; mask ROM (chapter 10) as the read-only ancestor (16c, chapter 36: prim 'fgmos')
- ✅ NOR and NAND flash arrays (random read against density), page program and block erase (lib/flash.ts)
- ✅ A flash controller: a logical-to-physical mapping table, garbage collection, wear levelling, bad blocks (flash/model.ts,
  chapter 36's widgets); ✅ a program that boots from flash into RAM (chapter 37)

**Interconnect**
- ✅ A simple bus with a valid / ready handshake (an AXI-lite-style set of channels), address decoding to several
  slaves, arbitration generalizing the dual-core's arbiter, wait states (16d, chapter 37: lib/axi.ts)
- ✅ DMA: a controller copying memory while the CPU runs, sharing the bus, raising an interrupt when done
- ✅ A system on one bus with a memory map: the system CPU (instructions fetched over the bus beyond a boot ROM), DMA,
  RAM, flash; it boots from flash into RAM by DMA (lib/soc.ts, lock-step with the golden model). ✅ the DRAM controller
  as a slave (a data mask on the device: a store writes its bytes without a read), a screen and a keyboard on the bus
  (chapter 37's last step, on the cycle engine). ✅ a boot from punched cards (a card-reader slave, chapter 37's
  sixth step; Phase 14). ✅ the sandbox example (Examples ▸ System on a bus: boot ROM and flash
  contents as ROM parts, a screen, keyboard and timer parts behind the bus; the cycle engine) and a timer part (palette,
  workbench family)

**Campaign**
- ✅ Act 10 "Memory" (16e, optional, after the finale; docs/CAMPAIGN.md): a lesson, a DRAM column at switch level
  around the sense amplifier, a bank with RAS-only refresh, a row-buffer controller with chapter 35's timings (16e-1);
  a bus with two masters and a round-robin arbiter, a DMA engine, a flash page store (a log, a mapping table, the
  owner in each page's spare area, garbage collection), a boot program puzzle on the golden model with a DMA engine
  and flash (16e-2); each device a model on its level's bench that names the rule broken

### Phase 18 — From Python to gates ✅ (chapter 15)
A program in a high-level language running on the gates, line by line. Mockup approved 2026-10-19
(E:/mockups/python/python-mockup.html): chapter 15, after the single-cycle CPU (15–37 renumbered); RV32I; the core
language and functions.
- ✅ src/lang/: a Python subset (ints that wrap at 32 bits, if / while / for-range, break / continue, def with
  recursion, global, fixed global lists, and / or / not, chained comparisons, `a if c else b`, print len abs min max),
  a reference interpreter (the golden model), and an RV32I code generator with source maps (Python line ↔ assembly ↔
  addresses). Tests: the samples on the ISS and two on the gates in lock step, the runtime routines' edge cases, error
  messages, 300 seeded random programs compiled vs interpreted (PY_FUZZ=n; 8 000 pass)
- ✅ The chapter (6 steps): three languages linked, expressions and registers, the cost of * // % per line, the program
  on the gate-level CPU with the Python panel (the line running, its cycles and toggles, the variables read from the
  registers and data memory, the output, the stack), functions and the stack, an editor compiling as you type;
  forty example programs in six sections (pyprograms.ts: each with what it prints, under 20 000 cycles)
- ⏳ The same programs on the pipeline (stalls and flushes per Python line); RV32IM (mul / div instead of the
  routines); strings and a heap

### Phase 19 — Where other tools still win ⏳
From a comparison with other tools (2026-10-19): Digital, DigitalJS, Circuit Artist, FREESS and Ripes each still do
something better. Their maturity, user bases and years of classroom polish are not roadmap items; the rest are. Each
gap here, closed the site's way (computed, transparent down to the transistor, checked against an independent tool):

**HDL in, not only out** (Digital drops a VHDL or Verilog component into a schematic; DigitalJS turns Verilog into an
animated schematic). The site exports Verilog and already runs Yosys in CI, so its JSON netlist is the way in.
- ✅ Yosys JSON as sandbox chips (hdl/yosysjson.ts): every fine-grained cell a library part (flip-flops with any reset,
  set, enable or clock polarity built from dff / dffe / dff_r / latches and gates, all 74 checked against Yosys's
  definitions), every module a user chip and its instances placed chips; placed left to right by logic depth (loops cut
  at storage), each column ordered by its drivers' rows, wires between neighbouring columns routed there (a trunk each,
  ordered so none runs along another: the router has nothing to untangle), long nets as pointers named after the
  Verilog signals. File ▸ Import and drag-and-drop of a `.json` (drawn chips: a netlist has no text)
- ✅ Verilog chips (editor/hdl.ts, hdlui.ts; mockup approved 2026-10-19): Yosys 0.68 in the page (`@yowasp/yosys`, 78 MB
  served beside the site as yosys/, fetched on the first synthesis), New chip ▾ Verilog chip or File ▸ Import of a
  `.v` / `.sv`; the text beside the canvas, synthesized a second after typing stops (or Ctrl/⌘ Enter), one chip per
  module (ids kept, so parents keep their wires); errors on their lines, the last good build kept; the drawing is
  generated (canvas edits refused, Detach makes ordinary chips); top module and gates (NAND / +XOR MUX / AND OR) in the
  properties. Round trip in the tests: our own export (both: the synthesizable one and File ▸ Export Verilog's
  structural one) of six library parts and the whole single-cycle CPU imported
  back simulates equal to the original, every output every cycle (tests/hdl-import.test.ts, Yosys from npm in Node)
- ✅ Examples ▸ The same adder in Verilog: ADD4 beside `assign {co, s} = a + b + ci;` on the same inputs (36 against
  44 NANDs with the default gates)
- ⏳ A chapter step with the Verilog adder; the analysis of a Verilog chip's critical path mapped back to its source lines
- VHDL through GHDL's Yosys plugin only if a WebAssembly build exists; else not planned

**Delay that depends on load** (Circuit Artist models wire delay from length and fan-out; here every NAND costs one
unit, wires nothing). The fan-out capacitance per net is already computed for the power estimate (sim/power.ts).
- ✅ Load-dependent delay in static timing (sim/delay.ts; mockup approved 2026-10-19): a NAND's delay by logical effort,
  d = p + g·h (NAND2: g = 4/3, p = 2τ), h its load over one input from netCaps (sim/netcap.ts, shared with power: 0.5 fF
  per NAND input, 0.3 fF of wire per branch); an inverter-pair buffer chain assumed where it pays ('load'), or none
  ('drawn'). One unit = a NAND driving one NAND input (4.13τ, ≈ 16.5 ps at 4 ps/τ); a part alone is measured
  between gates (inputs driven by a minimum NAND, outputs loading one input). analyzeTiming(design, { delay }) and
  logicDepth(def, model); the Timing panels (CPU scenes, the sandbox) have a Unit / Load switch and list the heaviest
  nets on the path, the inspector and chip properties give both depths, the view menu's Load-dependent delay picks
  the default. The single-cycle CPU: 155 NAND delays, 242.9 units (its control nets drive up to 576 inputs)
- ⏳ GateSim with the loaded delays on a finer grain (tenths of a unit) so glitches and races follow the loads too
- ✅ Where it changes the story: chapter 16's last step, "When fan-out costs": ripple, Brent–Kung and Sklansky (new to
  the library, lib/fastadd.ts prefixAdder) and Kogge–Stone, and a wide select, in unit, load and as-drawn delay.
  Unit delay ties Sklansky with Kogge–Stone; drawn without buffers the 64-bit Sklansky is the slowest of the three
- ⏳ Still to show both numbers: a memory's row decoder, the clock net
- ⏳ Checked against silicon: per path, the load-weighted estimate against OpenSTA's after routing on the two sky130
  layouts (today one NAND delay is worth ≈157–171 ps there; a load model should narrow the spread path to path)
- Wire length only where a design is placed (chapter 27's teaching placer, the OpenROAD runs), never from a
  schematic's drawn wires: a drawing's length is not a layout's

**Out of order you can configure** (FREESS: ROB size, issue width, functional units): Phase 17e. The gate-level
2-wide core (Phase 17c) stays fixed; the lab varies the model and prices sizes from the gates.

**ISA breadth** (Ripes: RV64, the C extension): RV64I / RV64M and C in Phase 9, each checked by riscv-tests and Spike
like the RV32 cores.

### Phase 20 — Reviewer feedback (2026-10-19) ⏳
An outside review asked for CMOS realism, cross-layer debugging, campaign polish and an FPGA path. Much of it was
already there: 0 / 1 / X / Z at switch level with shorts and floating nodes, the critical path drawn on the chip (unit
and load-dependent delay), instruction fields coloured to match their wires (CPU panel), the logic analyzer with
cursors, VCD and Back, star ratings against par on NANDs / transistors and depth / period, a failing Check opening the
test player on the failing case, the campaign's pipeline / forwarding / hazard levels and MMIO screens, compressed share
links, bus taps, duplicate and pin reordering. The gaps:

**CMOS realism** (at switch level, where bad habits form):
- ⏳ Shorts named, not just X: a net where a path to VDD and a path to GND are both on (crowbar) drawn pulsing red /
  orange, distinct from an X of unknown inputs; a floating net (Z) dashed. The solver already counts shorts
  (switchsim); the view and the lint need the reason per net. Both themes, every wire palette
- ⏳ Campaign transistor levels fail on a short with its own message ("row 3: VDD shorted to GND through …"), also where
  the output happens to resolve, and on every input transition taken one bit at a time (the switch solver has no
  time: a transition is the states between two vectors), so only complementary pull-up / pull-down networks pass
- ⏳ Weak levels (IEEE 1164 H / L): an nMOS passing a 1 or a pMOS passing a 0 drops a threshold; the net carries a weak
  level, drawn dimmed, and a gate input reading it is unreliable (X downstream) unless restored by an inverter or
  passed by a transmission gate. A new solver state (strength already exists: switchsim levels), so chapters 1–3's
  pass-transistor steps and the campaign's act 0 can show it. Mockup first (a new visual state)

**Cross-layer debugging**:
- ⏳ The drill-down breadcrumb live: each level's value at the opened instance (hex at the top, `bit [7] = 1` where a
  bus was sliced), following the simulation, in the chapters' stage and the sandbox's look inside
- ⏳ A slack heatmap: every gate coloured by how close its arrival time is to the critical path's (unit or load
  delay), a toggle on the Timing panel beside the drawn critical path

**Campaign and sandbox polish**:
- ✅ Rotation (R) for parts in the sandbox: `rot` (quarter turns after the mirror) on a part and an InstanceDef,
  one transform (geometry.ts orientGeom / instPort) for ports, boxes, hit tests, routing and look inside; a box is
  laid out again on its new sides (orientedBox: top and bottom names run across, clock markers on any side), other
  symbols turn whole with their text kept upright; R / Shift+R, the right-click menu, R / F while placing a part, a
  chip's face displays upright where their place lands; displays and I/O parts only mirror (face.ts canTurn)
- ⏳ Pong on the sandbox computer: a program for Examples ▸ Computer's 64 × 64 screen with the keyboard part (or
  switches) as paddles, and the same on the campaign's RV16 bench screen
- Separate stars for area and for speed (functional / area-optimal / speed-optimal) instead of one rating over every
  metric: a grading change across 125 levels' pars; decide before building

**An FPGA path** (a student's CPU on a $15 board such as a Tang Nano):
- ⏳ File ▸ Export Verilog for FPGA: the synthesizable export (vexport.ts: flip-flops as processes, behavioural parts
  from their hdl.synth bodies) from the sandbox, which today offers only the structural one (flip-flops as NAND
  loops, which FPGA tools reject or mangle); user chips marked as flip-flops (ChipDoc.ff) become processes, a drawn
  latch loop left is reported; a top wrapper and a pin-constraint example (Gowin .cst) for the board, checked by
  Yosys (synth_gowin) in CI
- `.dig` export for Digital: low priority (Verilog already reaches it)

### Appendix A — An 8-bit CPU of 1975: the MOS 6502 ✅
After the journey, a lettered appendix: the real 6502 rebuilt the way 1975 built it, at transistor level, and why
our RV32I is fifty times bigger. Mockup approved 2026-10-13 (lettered section after chapter 33, the "vintage" accent).
- ✅ NMOS depletion-load logic: prim `dep` (a weak always-on load), NMOS gates (n + 1 transistors), complex AOI gates
- ✅ NmosSim: an event-driven switch-level engine (channel-connected groups, as visual6502) for a chip of 4,500
  transistors; capacitance-weighted charge sharing (precharged buses), pending nodes kept after an oscillation
- ✅ A cycle-exact ISS (every bus cycle; all 1.51 M SingleStepTests and Klaus Dormann's functional test pass), a
  two-pass assembler, sample programs
- ✅ Our own microarchitecture after the real one (four precharged buses, one ALU, two-phase clock, the previous
  instruction finishing during the opcode fetch): a control table, a register-transfer model checked against the
  ISS (SingleStepTests, Klaus, lock-step with random IRQ / NMI), a decode PLA computed from the table (245 rows,
  undocumented opcodes as don't-cares)
- ✅ The chip at transistor level: 4,513 transistors (1,031 loads; the real one 3,510 + 1,018), every bus cycle in
  lock-step with the ISS from reset (programs, random interrupts), on all 1.51 M SingleStepTests cases and all 96 M
  cycles of Klaus's test (scripts/m6502/chip-full.ts, in parallel slices), schematics that
  pass the layout rules; the chapter (8 steps), the running panel, the opcode matrix, the transistor ledger
- ✅ The 6502 as a sandbox part (Library ▸ Processor parts, opening onto the transistor chip), ROMs in 6502
  assembly, Examples ▸ 6502 computer, the CPU panel following it
- ⏳ Undocumented opcodes in the ISS

---

## Open questions for the author
- Target audience depth: high-school / first-year university / practitioner refresher?
- ~~Should challenges *gate* progress?~~ Decided: the campaign gates softly (skip and Unlock all), the chapters stay open.
- Branding / name for the site?
- Hosting target (GitHub Pages assumed; CI already included)
- Sound effects / gamification (badges)?
