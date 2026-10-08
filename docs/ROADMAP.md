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
in `References/` (NAND → pipelined RV32I, with SystemVerilog sources). What the two games
have and this site still lacks is Phase 12.

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
| 9 | Registers & counters | n-bit register with enable, counter, clocks; async reset, T/JK, up/down counter, universal shift register, LFSR, ring / Johnson counters, ripple clock divider |
| 10 | Memory arrays | N words × W bits (user-scalable: 4×4 … 64×16), write path (decoder), read path (mux tree), cell grid view, timing; ROM (decoder + OR plane), PLA (Quine–McCluskey terms), FIFO, stack, CAM, multi-ported register file |

### Phase 2 — Computing 🚧
- ✅ ALU (add, sub, and, or, xor, shifts, slt/sltu) and flags; barrel shifter
- ✅ Carry-lookahead and Kogge–Stone adders with depth comparison (optimization intro)
- ✅ Carry-select and carry-skip adders, static depth against simulated delay (carry-skip's false path); BCD adder
- ✅ Register file (32 × 32, x0 hard-wired), two read ports and one write port
- ✅ Comparison and coding blocks: log-depth magnitude comparator (signed / unsigned), encoder, recursive priority
  encoder, demultiplexer, population count, absolute value, parity, Hamming SEC-DED encoder / decoder (ECC step in ch. 21)
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
    users, duplicate, delete refused while used), autosave indicator, recovery of unreadable data
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
- ✅ Non-restoring division (step, array, iterative) and radix-2 SRT (carry-save remainder, 4-bit digit selection,
  normalization, signed-digit quotient), compared on area, step depth and clock period
- ✅ Iterative shift-and-add multiplier; full radix-4 Booth multiplier (rows, +1 bits, one sign constant, 3:2 tree),
  measured against Baugh–Wooley; 3-stage pipelined Booth multiplier (latency 4, one product per cycle)
- ✅ Radix-4 SRT divider: digits −2…+2, selection thresholds computed from the containment bounds and checked
  exhaustively, carry-save comparisons; n/2 + 3 cycles, 21 % faster than radix 2 at 32 bits
- ✅ M extension in the pipelined CPU (chapter 20): multiplier split over E / M (a multiply is a load for hazards), radix-4 SRT
  divide stalling the front for 18 cycles; +45 % NANDs, period 93 → 93 (fast adders), 59 → 79 (balanced: divider sign fix, Booth tree)
- ⏳ Passing the official `riscv-tests` on every RV32 CPU (see Phase 13, independent verification)

### Phase 8 — Memory hierarchy 🚧
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
- ✅ fmadd / fmsub / fnmsub / fnmadd.s (R4 format in isa / asm / disasm / ISS, third f-register read port): exact
  product, swap-and-align add, one normalize & round; exhaustive on E3M2 (5.2 M cases), random on E4M3 / E5M2 / float32
- ✅ Pipelined FPU: six-stage RV32IF pipeline (F D E M X W, in-order retirement), the FMA split over E / M / X as the FP pipe
  for fadd / fsub / fmul / fma / fcvt.s.w and (unrounded) fdiv / fsqrt, one shared rounder; FP interlocks + forwarding from W,
  CSR serialization, structural stalls for the iterative units; period 121 vs 313 (single-cycle), CPI 1.6–2.7, co-simulated
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
- ✅ The real flow: the dual-core exported as Verilog, synthesized by Yosys to the sky130 cell library and placed,
  clock-tree-built and routed by OpenROAD into a GDS (`.github/workflows/layout.yml`, published into the site); the
  export first cross-checked cycle by cycle against our gate-level simulation (`scripts/verify-export.ts`)
- ⏳ The same flow for the system CPU (RV32IM + Zicsr); the flow's timing and area reports shown next to our own
  static timing and NAND-count floorplan, so the learner sees how far the unit-delay estimate is from sky130

### Phase 12 — Parity with Turing Complete and Digital Logic Sim ⏳
The simulator already goes further than both games: transistors and Z, gate delays (glitches,
metastability), X, static timing, VCD, Verilog with a Yosys-checked testbench, wide pins, golden-model
CPUs, and every library part opens down to a MOSFET. What they have and the sandbox lacks is I/O,
chip presentation, capacity and the program-solving half of Turing Complete.

**I/O parts** (placeable, zero-cost like the displays, absent from Verilog)
- ✅ Key input (DLS Key, TC Keyboard): a Key part bound to a keyboard key (rebind it in the properties), 1 while the
  key is held, listening from any depth of the hierarchy and taking the key from the editor's shortcuts while that
  chip is open; a Keyboard part that queues typed keys (16 deep: `code` = the oldest as ASCII, `ready`, `ack` drops
  it, sampled at rising clock edges or, without a clock, whenever the logic has settled), fed while the circuit runs
  or with the Type toggle on. Both are *external sources*: behaviour-only leaves the editor drives through `Sim.poke`,
  at gate level (one delay, visible in gate mode) and at switch level (a key on a CMOS inverter); zero cost, a
  comment in Verilog, refused by the gate-level derivation of a transistor chip, released on every check
- ⏳ Pixel screen: a dot-matrix / RGB display driven by a frame-buffer RAM or row/column/colour
  pins (DLS dot display, TC screen); the 7-segment display already exists
- ✅ LED bank: a wide LED shows one LED per bit (most significant first, rows of 8)
- ⏳ Console and switch bank as parts, not only in the system CPU's I/O panel, so a hand-built CPU can
  memory-map them
- ✅ Buzzer (DLS): A4 while its 1-bit input is high, or MIDI note v from a bus (Web Audio, square wave)
- ✅ Halt part (TC): a zero-cost sink that stops Run (and the CPU panel's Run to halt) after the step where its input
  reads 1 (any bit of a bus), from any depth of the hierarchy, so a hand-built CPU can halt itself; level sensitive
  (Run advances one step at a time while it stays 1; Step ignores it)
- ✅ Random source and cycle counter (TC), as library parts that open down to gates: an XNOR LFSR that runs
  from the power-on zero with no seed (4 / 8 / 16 bits) and a counter with its enable tied to 1 (8 / 16 / 32)

**Chips and canvas**
- ⏳ Chip appearance: resizable box, pins on any side and in any order, displays inside a chip
  shown on the packaged chip's face (DLS)
- ✅ Free-text comments on the canvas (TC): T or the Wiring palette, multi-line, double-click to edit; selected, moved,
  copied and deleted with the rest, saved and shared, never compiled (writing one recompiles nothing)
- ⏳ Library organization: collections / folders of chips, a starred bar for frequent parts,
  several projects (separate workspaces) (DLS)
- ✅ Waypoints from the right-click menu: "Add a bend here" on a wire puts a new corner on the cursor, which carries
  it until a click drops it (Esc cancels; one undo step). On a simple connection it is a breakpoint; on a square wire
  the segment detours through it (a corner on the segment's own line would be simplified away)

**Colourful mode** (Turing Complete style; mockup first). Colour says *which* signal, brightness and the
flowing bits still say its *value* (0 / 1 / X / Z must stay readable in every combination); light and dark themes
- ⏳ User-coloured wires: pick a colour for a wire or a whole net (right-click menu, properties, a swatch row);
  saved in the chip document, shared with it, inherited by the net's other drawn wires
- ✅ Colour per net: a switch in the wire-colour menu (off by default) gives every net a hue of its own, from its name
  or else its ends (stable across rebuilds, edits and reloads; a circuit opened in the sandbox keeps its chapter
  colours, bar the few nets its new drawing puts next to others); brightness still says the value (0 a dim tint, 1 bright with its glow), X and Z keep their colours and
  dashes, hues avoid the X red. Wires, dots, pointers, tap labels, bus labels, riding values and slow-motion fronts,
  in the chapters, the workbench and the sandbox. Nets drawn side by side are kept apart: a net whose own hue lies within
  60° of a neighbour's (running within a few units, or crossing it) moves to the nearest hue clear of them, the most
  crowded nets first, two refining passes; the rest keep their own. Across the 632 library schematics, neighbouring
  pairs closer than 20° drop from 8 338 to 3 058 (none left on the CPU tops); 40 ms on the 64-bit Kogge–Stone
- ⏳ Vivid look: a dark grid, filled bright part bodies tinted by category or chip hue, thicker wires; a setting
  like `data-palette`, applied to the sandbox, the chapters' schematics and the workbench
- ⏳ Optional cartoonish components: a playful symbol set (rounded, chunky bodies, bold outlines, small icons for
  displays and memories) with the same sizes and port positions, so no layout or routing changes

**Capacity and speed**
- ⏳ Large memories: RAM well beyond 2^6 words and ROM beyond 2^8 (both games reach tens of KB),
  behavioural at runtime with the structure still openable (as the CPU's ROM already is)
- ⏳ Measure, then speed up, large sandbox circuits: compiled or levelized evaluation of settled
  combinational chips (DLS caches them), keeping the event-driven engine for anything timed or probed;
  publish cycles/s next to the cross-cutting performance budget

**Programs on your own CPU** (the second half of Turing Complete)
- ⏳ Custom ISA: define instruction fields, opcodes and mnemonics in a table, and get an assembler,
  a disassembler and the ROM listing from it (TC's assembly editor); RV32 stays the built-in ISA
- ⏳ Program puzzles: tasks with level inputs and expected outputs (a sequence over I/O pins, a
  maze, sorting), solved by writing a program for a CPU you built, scored on cycles and on the
  hardware's NANDs and depth; optional, each with a reference solution, as with the build challenges

**Campaign** (🚧, plan and status in [`docs/CAMPAIGN.md`](CAMPAIGN.md)): a tree of levels from a
transistor NAND to a pipelined 16-bit RISC-V-like CPU (RV16) with traps and interrupts. It has
graded build challenges, number and Boolean drills, assembly puzzles, a codex, skip with a reference
solution, and Unlock all. Its soft locks apply to the campaign only; the chapters and the sandbox
challenges stay open. Next:
- ⏳ **A level screen of its own** (`#/campaign/play/<node>`; mockup first): today a level opens in the general
  sandbox with a strip under the canvas. The level screen keeps the editor but drops the sandbox chrome (tabs, File
  menu, the full palette): the brief and the *why* in a side panel, the anatomy diagram with this block lit, only
  the level's unlocked parts, Check / stars / par / tips / Next built in, and a way out to the full sandbox
- ⏳ **Why we are building it**: each level's `why` grows from a line into a short explanation: which problem in
  the CPU this block solves (shown on the anatomy diagram), what breaks or slows down without it, what it costs
  against the alternatives, and which later levels use it. Shown before the level and again, with the learner's
  measured cost, after a pass
- ⏳ **Step-by-step solution walkthrough**, in every level: the reference answer built on the level's canvas one
  step at a time (a part, its wires, a sub-chip), each step narrated: why this part, which law or trick it applies
  (codex links), the cost so far against par, and the truth-table rows or test cases it already satisfies.
  Forward / back, and "I'll take it from here" at any step, which leaves the partial circuit to finish. Steps are
  generated from the reference chip documents in dataflow order, with authored narration per level; core levels
  go block by block. Complements "Show answer" (all at once) and "Do it for me" (no explanation)
- ⏳ **A fuller codex**: entries are dense shorthand today. Each gains an explanation an engineer can learn from,
  not only recall: the idea in a paragraph, a worked example (numbers, a K-map, a waveform), a diagram or a live
  mini-scene, common mistakes, where it sits in the CPU, and links to the chapter steps and levels that use it.
  The current one-liner stays as the summary (the glossary's hover text)

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
- ⏳ Glossary with hover definitions
- ✅ Progress tracking (visited steps, solved challenges, in local storage) and "Reset progress"; the chapters
  stay open (soft locks exist only in the campaign, see `docs/CAMPAIGN.md`)
- ✅ Reduced motion: CSS animations and transitions off, slow-motion fronts drawn as plain changes
- ⏳ Keyboard navigation beyond the shortcuts (search palette, sandbox keys)
- ✅ Export the sandbox canvas as SVG / PNG (current theme), and the level on a chapter's or the workbench's stage (the
  stage bar's Image menu: the whole level with its live values, whatever the zoom, without probe flags)
- VHDL view of every component
- Performance budget: 60 fps rendering of ≤ 5 000 visible elements; ≥ 100 CPU cycles/s at gate level
- i18n-ready strings

### Phase 13 — Verification, precise claims, measurement ⏳
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
- ⏳ Chapter 25 separates the teaching P&R from the OpenROAD run; the pipeline chapters call cache-miss freezing and
  arbiter-serialized atomics deliberate simplifications
- ✅ Repository description, homepage and topics on GitHub

**Independent verification** (our ISS and our CPUs share one author: a misreading of the spec passes in both)
- ⏳ Official `riscv-tests` (`rv32ui`, `rv32um`, `rv32uf`, `rv32mi`, `-p` environment): self-checking, so they need
  no oracle. Prebuilt images (checked in, with their source revision) run on the ISS in `npm test` and on every RV32
  CPU (single-cycle, multicycle, pipelined with and without prediction and caches, system, M, F, pipelined FPU)
  within a cycle budget; `tohost` mapped to a store the harness watches. A pass / fail matrix per CPU in `docs/`
- ⏳ A second ISS as oracle for ours: Spike (or Sail) in a CI job, random programs, commit logs compared
  instruction by instruction
- ⏳ RV32 random-program fuzzing (`randprog` exists for RV16 only): constrained generators for ALU, branches,
  loads / stores of every width, hazard-dense sequences (back-to-back dependences, load-use, branch after load),
  CSRs, traps and interrupts, M and F; each CPU co-simulated against the ISS; a failure keeps the seed, the program,
  the cycle and the first differing state; a short run in `npm test`, a long one in a scheduled CI job
- ⏳ Coverage of the CPU suites: opcodes executed, hazard events seen (M→E / W→E forwarding, load-use stall,
  flush, misprediction), cache hit / miss / write-back, trap causes; reported as a table, gaps become directed tests
- ✅ `scripts/verify-export.ts all` (Yosys netlist simulated against our gate-level run, every multi-core program) as
  the `verify-hdl` CI job with `yowasp-yosys`: the deploy waits on it
- ⏳ The same cross-check on the system CPU (RV32IM + Zicsr: its MMIO and interrupt pins need a testbench of their own)
- ✅ GateSim refuses a behavioural delay of 64 or more (the event wheel) instead of clamping it silently

**Measure more** (computed from the circuits, like every other number)
- ⏳ Dynamic power, P ≈ α C V² f: α from the gate simulator's toggle counts over a program or a vector set
  (glitches included: the ripple adder pays for its glitches), C from fan-out (NAND inputs driven, plus a wire
  estimate), V set by the learner, f from static timing. Per-block breakdown in the inspector, an energy column in
  the adder and CPU comparisons, energy per instruction in the CPU panel; labelled an estimate
- ⏳ Benchmarks: one fixed program set (Fibonacci, sort, matrix multiply, CRC, a float kernel) on every CPU:
  instructions, cycles, CPI, period, time, NANDs, cache misses, energy; generated by a script, shown on one page
- ⏳ Hardware statistics page: every library component (transistors, NANDs, depth, period) in one sortable table
  from the registry, each row opening it on the workbench
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

### Phase 14 — Before the transistor: relays, vacuum tubes, punch cards ⏳
Why the MOSFET won is best felt, not told: build the same adder from relays and from tubes and *see* the machine
it becomes. Mockup first for the 3D view, the technology setting and the new act. In the journey, a prologue act
before the MOSFET chapter; in the campaign, an act of its own (or a side branch) ending in a machine programmed
with punch cards.

**Relay and tube bricks** (switch level, like the MOSFET)
- ⏳ Relay: a coil driving changeover contacts (normally open / normally closed), contacts conducting both ways (a
  pass switch), milliseconds per operation, a latching (self-holding) relay as memory
- ⏳ Triode: the grid controls the plate current, one way only, with a plate resistor as the pull-up (ratioed
  logic, which `switchsim.ts` already models with its resistor strength); tube inverter and NOR, cathode follower,
  the Eccles–Jordan flip-flop; microseconds per operation, watts per tube
- ⏳ Gates and blocks in each technology, measured like the CMOS ones (relays / tubes, delay, power): first the
  NAND-mapped versions (the brick principle), then native designs that show what each technology is good at
  (changeover contacts make a relay XOR or a mux nearly free; tube logic prefers NOR), so the comparison is honest
- ⏳ A technology setting for any chip (CMOS / relay / tube) in the chapters, the workbench and the sandbox:
  the netlist is the same, the counts, delay, power and volume follow the technology; sandbox palette parts for
  the relay and the triode

**The 3D machine** (to show the bulk)
- ⏳ A 3D view of any design at physical scale: its flattened netlist as relays on boards in racks, or tubes in
  chassis in cabinets, with the same design in CMOS beside it (a speck) and a human figure for scale. Sizes,
  power and heat from per-device constants labelled illustrative (as the 25 ps / NAND is); historical machines
  for reference (Zuse Z3: about 2 600 relays; ENIAC: 17 468 tubes, about 150 kW and 27 t)
- ⏳ Live: relays click and tubes glow with the simulation's values; orbit, zoom, and a click on a rack opens
  that block's schematic (transparent boxes in 3D too)
- ⏳ Its own lazily loaded chunk (a small WebGL renderer, or three.js if it earns its size); the main bundle does
  not grow

**Punch cards**
- ⏳ History step in the journey: Jacquard's loom (1804), Hollerith's census cards (1890), the IBM 80-column
  card (1928) and its Hollerith code
- ⏳ A card editor: 80 columns × 12 rows, click to punch, or type and it punches the Hollerith code; a binary
  mode for machine words (one word per column or per row); a deck of cards, reorderable, exportable
- ⏳ A card reader part (sandbox and campaign) feeding a ROM or a word stream (like the keyboard part), and the
  program input of the relay / tube machine
- ⏳ In the campaign: a Hollerith-code drill and a level where the program arrives on cards

---

## Open questions for the author
- Target audience depth: high-school / first-year university / practitioner refresher?
- ~~Should challenges *gate* progress?~~ Decided: the campaign gates softly (skip and Unlock all), the chapters stay open.
- Branding / name for the site?
- Hosting target (GitHub Pages assumed; CI already included)
- Sound effects / gamification (badges)?
