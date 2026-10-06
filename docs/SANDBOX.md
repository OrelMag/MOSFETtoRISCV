# The Sandbox

`#/sandbox` is a circuit editor in the spirit of Sebastian Lague's *Digital Logic Sim*, built on the
site's own simulator. Whatever you draw compiles to a real `ComponentDef`. It then simulates, opens
down to transistors, counts its NANDs and transistors, times its critical path and exports Verilog,
like any library component.

Every circuit in the chapters can be opened in the sandbox, and every level of the journey can be
rebuilt in it from the level below (both are checked by tests, see [Guarantees](#guarantees)).

- [Quick start](#quick-start)
- [Drawing](#drawing)
- [Parts](#parts)
- [Simulation](#simulation)
- [Chips](#chips)
- [Switch level](#switch-level)
- [Memories and programs](#memories-and-programs)
- [CPUs](#cpus)
- [Analysis](#analysis)
- [Files and sharing](#files-and-sharing)
- [Challenges](#challenges)
- [Open in Sandbox](#open-in-sandbox)
- [Limits](#limits)
- [Guarantees](#guarantees)
- [For contributors](#for-contributors)

## Quick start

1. Open **Sandbox** in the top bar. The palette is on the left, the canvas in the middle,
   properties on the right.
2. Drag two **Input** pins, a **NAND** (Library ▸ Gates) and an **Output** pin onto the canvas.
3. Drag from an input pin to a NAND input to draw a wire. Click empty canvas to add corners; click
   the target port to finish.
4. Click the input pins to toggle them. Wire colours and the output follow at once.
5. **Package** (toolbar) turns the circuit into a chip; it then appears under **My chips** and can
   be placed in other circuits.

## Drawing

| Action | How |
|---|---|
| Wire | Drag from a pin or port; click empty canvas for each corner; click a pin, port, pointer or wire to finish (on a wire: a branch) |
| Flip the wire's L | Space or `/` while drawing |
| Remove the last corner | Backspace while drawing |
| Branch from a wire | Ctrl/Alt + drag the wire |
| Pointer (named net label) | `L`, or Wiring ▸ Pointer |
| Jump to the twin pointer | Click a selected pointer, or double-click it |
| Select | Click; Shift + click to add or remove; drag empty canvas for a rubber band (Shift: add) |
| Move | Drag the selection; arrows nudge (Shift: ×5) |
| Flip left–right | `F` (there is no rotation, as in DLS) |
| Copy · cut · paste · duplicate · select all | Ctrl+C · X · V · D · A |
| Delete | Delete / Backspace (wires attached to deleted parts go too) |
| Undo · redo | Ctrl+Z · Ctrl+Shift+Z / Ctrl+Y (a drag is one step) |
| Pan · zoom | Space + drag or middle drag · wheel |
| Run / pause | Ctrl+Enter |
| Cancel | Esc |
| All shortcuts | `?` |

Wires are orthogonal and stored as the corners you drew. When you move a part, the wires attached
to it keep their shape: the nearest corner slides, or an L is added. A packaged chip's inside view
shows exactly the drawing you made.

**Pointers** are the net labels of the chapters' large schematics: every pointer with the same name
is the same net, with no wire between them. A pointer carries a bus as well as a single bit. In the
inside view of a chip, pointers sit where you put them.

## Parts

The palette is searchable. **Purist** limits it to transistors, NAND, IO, constants, wiring,
displays and your own chips.

| Group | Parts |
|---|---|
| Inputs & outputs | Input (toggle), Button (momentary), Clock (driven by Run / Step), Input bus, Output, Output bus. A pin can also be bidirectional (switch level). |
| Transistors | NMOS, PMOS, VDD, GND, strong NMOS, weak PMOS |
| Switch level | Resistor, Pull-up, Pull-down, Capacitor, Transmission gate, Tri-state buffer, Tri-state inverter |
| Constants | 0, 1, N-bit |
| Displays | LED, 7-segment (bit 0 = a … bit 6 = g, bit 7 = dot), Hex digit, Value. Displays cost nothing and do not appear in Verilog. |
| Wiring | Pointer, splitters and mergers (any widths, in the properties) |
| Memory | Program ROM (RV32), ROM (words), RAM |
| Library | Every library component and parametric family (widths and options in the properties) |
| My chips | Your chips, with their colour and pin count. Greyed when placing one would make a chip contain itself. |

## Simulation

The circuit is simulated live while you edit. After a change to its connections it is rebuilt,
and the state carries over: a counter keeps its count when you add an unrelated part. Moving things
rebuilds nothing.

- **Cycle** mode toggles the clock pins at a chosen rate (1 Hz up to "max") and shows the rate
  achieved. **Gate delay** mode advances one gate delay per tick, so you can watch a value ripple.
- **Step** runs one cycle (or one gate delay). **Reset** powers the circuit on again: to 0 (latches
  start at their power-on values), to X (unknown), or random (as real silicon).
- Values: 0, 1, X (unknown or contested) and, at switch level, Z (floating). An input left open
  reads X, and the view marks it.
- The badge in the run bar says whether the circuit runs at **gate level** (NANDs, unit delay) or
  **switch level** (transistors solved as switches).

## Chips

- **Package** opens a dialog: name, colour, notes, and a preview of the box as it will look when
  placed. Pin order follows the pins' positions: inputs, then bidirectional pins, then outputs,
  each top to bottom. Move a pin to reorder.
- **Edit chip**: double-click a placed chip of yours. It opens in a tab with a breadcrumb and Back.
  Every chip that uses it is rebuilt. Renaming a pin keeps the parents' wires connected.
- **Look inside**: double-click a library part, or use Look inside on any part. It shows a
  read-only schematic of its inside, with live values from your running circuit, and you can keep
  opening parts down to the transistors (and a single MOSFET).
- **Inspect** shows the Inspector for the chip or a part: what it is and costs, its truth table,
  and its Verilog.
- **This chip is an edge-triggered flip-flop**: tick it and choose d, q, clk (and en). The compiler
  checks it with a short clocked test. A confirmed flip-flop is a register boundary for static
  timing and is written as a clocked process in the synthesis export.
- Properties also list **Used by** and **Uses**. A chip in use cannot be deleted; the message names
  its users.

## Switch level

A circuit runs at switch level when it contains transistors (or parts whose outputs can float).
Transistors are switches with strengths: rails and driven inputs win over transistors, a strong
transistor over a weak one (ratioed logic, SRAM writes), any transistor over a resistor, and a
resistor over stored charge.

| Part | Behaviour |
|---|---|
| Resistor | Always conducts, more weakly than any transistor. Two resistors pulling opposite ways give X. |
| Pull-up / Pull-down | A resistor to VDD / GND: the node is 1 / 0 unless a transistor path overrides it |
| Capacitor | The node keeps its last value while nothing drives it (the same as ticking *keeps charge* on a wire) |
| Transmission gate | NMOS and PMOS in parallel: a bidirectional switch |
| Tri-state buffer / inverter | Output is Z while en = 0 |

- **Shared buses**: several tri-state drivers may share a net. One enabled gives its value, none
  gives Z (or the pulled value), two that disagree give X. Two outputs that always drive get a
  warning.
- **Wire properties**: *keeps charge* (DRAM nodes, bit lines) and a *power-on value* (a latch's
  stored bit).
- **Bidirectional pins** let a chip bring out a transistor terminal (an SRAM cell's bit lines).
  Clicking one cycles Z → 0 → 1.
- **Transistor chips as bricks**: a combinational chip built from transistors, with at most 12
  input bits and no output that can float, gets a gate-level model from its exhaustive truth table.
  Your own CMOS NAND can then be the only brick of everything above it, as the library NAND is.
  A chip with state (SRAM, DRAM), a floating output or more inputs stays switch level; the
  properties say why.

## Memories and programs

- **Program ROM (RV32)**: addressed in bytes like a PC. Its contents are RISC-V assembly or hex
  words, written in **Edit program…**: a code editor with highlighting, errors in the gutter as
  you type, and a listing (address · word · disassembly). Apply is one undo step. While the
  circuit runs, the listing and the editor follow the address the ROM is reading.
- **ROM (words)**: 2^k words of 8, 16 or 32 bits, addressed by word.
- **RAM**: up to 2^6 words. The properties show its contents live, and can set **initial
  contents** applied at power-on (Apply & reset).
- **Examples ▸**: Fetch loop (PC, PC + 4 and a ROM, joined by a pair of `pc` pointers), a 4-bit
  counter on a 7-segment display, Shared bus, Wired-AND, Wired-OR. Each loads as a new chip.

## CPUs

When a chip is a RISC-V CPU, the **CPU** panel opens in the right-hand dock:

- status: cycle, retired instructions, CPI, and the golden-model check (✓, or the first mismatch:
  which register, expected and actual value, after which instruction);
- Run to halt, Step instruction, Reset, Slow mode (one instruction per tick, with the hardware the
  instruction uses marked on the canvas);
- the program listing with the current PC (pipelines: a tag per stage), and the selected
  instruction's fields, with the wires that carry each field coloured;
- registers (and FP registers), data memory, a log of retired instructions;
- for pipelines, the stage × cycle diagram; for the system CPU, the I/O panel (console, LEDs,
  switches, an IRQ button, the machine-mode CSRs); for the dual-core CPU, both cores side by side.

The golden model is the site's instruction-set simulator, stepped whenever the CPU retires an
instruction. It compares registers, FP registers, `fcsr`, the PC, data memory and the console. The
panel configures itself for every CPU of the chapters (single-cycle with or without caches and
FPU, multicycle, pipelined, system, dual-core). For a CPU you build yourself, point it at your
parts in the **CPU** properties section: program ROM, PC, register file, data memory, retire signal,
and the ISS options.

## Analysis

- **Probe** (`P`): click wires or pointers to add lanes to a timing diagram docked under the canvas.
  The chip's pins get lanes of their own. Lanes follow the drawing across rebuilds; the recording
  downloads as VCD. Gate level only.
- **Timing**: static timing of the chip. It reports the period in NAND delays, the maximum clock
  (at about 25 ps per NAND) and the period each capturing flip-flop needs. **Show critical path**
  draws the path on the chip. It needs flip-flops: library ones, or your own chip marked as a
  flip-flop.
- **Cost**: NANDs, transistors, resistors, capacitors and logic depth, in the chip's properties.
- **Warnings** (click to locate): two nets drawn on one line, pointers without a twin or connected
  to nothing, inputs left open, outputs that fight over a net, width mismatches, two drivers.

## Files and sharing

- Everything is saved in the browser automatically. The top bar shows *Saved*, *Saving…* or
  *Storage full*. If saved data cannot be read, it is kept, and a banner offers to download it.
- **File ▸**:
  - **Export this chip…** (`<name>.chip.json`, with every chip inside it) or **Export all chips…**
  - **Import…**, or drop a `.json` file on the canvas. Import never overwrites: a chip with the
    same id and different contents is renamed, and an identical one is skipped.
  - **Share link…**: the chip and its sub-chips compressed into the URL (`#/sandbox/s/…`).
    Opening the link shows a banner; nothing is imported until you click Import. Links over about
    32 KB may break in some apps; export a file instead.
  - **Export Verilog** (structural SystemVerilog of the whole hierarchy), **Export image** (SVG or
    PNG, in the current theme).
  - **Manage chips…**: size, users, open, duplicate, delete.

## Challenges

**Challenges** lists 21 optional build challenges, one or more per level:

| Level | Challenges |
|---|---|
| Transistors | CMOS inverter, CMOS NAND, CMOS NOR |
| Gates (NAND only) | NOT, AND, OR, XOR, 2:1 multiplexer |
| Arithmetic | Half adder, full adder, 4-bit ripple adder, 4-bit incrementer, 2-bit comparator |
| Sequential | SR latch, D latch, edge-triggered D flip-flop, 4-bit register with enable, 4-bit counter |
| Memory | 4 × 4 RAM |
| Processor | 4-bit ALU, instruction fetch |

Start creates a chip with the required pins. **Check** runs the full truth table (up to 16 input
bits) or a clocked test sequence, enforces the allowed parts (transistors only, NAND only, or
anything), lists failing rows, and scores NANDs, transistors and depth against par. **Show answer**
imports the reference chips; **Do it for me** fills the challenge chip. Solved challenges are
remembered.

## Open in Sandbox

Every schematic in the chapters and the workbench has an **Open in Sandbox** button. It turns the
circuit on screen into a new editable chip, with its pointers. Parts a fresh page could not rebuild
by id come along as sandbox parts or chips: a CPU's program ROM becomes a Program ROM (hex, with
disassembly comments), its data memory a chip of its own.

## Limits

| Limit | Value |
|---|---|
| Pin width | 1024 bits (values exact at any width) |
| Constants | 53 bits |
| RAM | 2^6 words of up to 32 bits |
| ROM | 2^8 words |
| Gate-level model of a transistor chip | at most 12 input bits, no output that can float or is wider than 53 bits |
| Challenge truth tables | exhaustive up to 16 input bits |

The switch-level model has no threshold drop: an NMOS passes a full 1. Probes and the timing
diagram are gate level only. The chapters' cache-line view is not in the CPU panel.

## Guarantees

The test suite checks, on every build:

- **Round trip**: every component reachable from the library (722 of them), converted into a
  sandbox chip and compiled back, gives the same circuit (an isomorphic netlist) and, where it has
  a spec, the same outputs.
- **Every CPU opens**: each top-level CPU of the chapters opens in the sandbox and compiles without
  errors; the single-cycle CPU runs cycle for cycle like the original, and the CPU panel runs
  every variant to halt against the golden model.
- **The ladder**: every level is rebuilt by hand, each from the one below, and compared with the
  library part: CMOS inverter, NAND and NOR from transistors; NOT, AND, OR and XOR from the
  user's own transistor NAND; full adder and 4-bit adder; SR latch, D latch, flip-flop, register
  and counter; SRAM and DRAM cells; a 4 × 4 RAM; a 4-bit ALU; a fetch datapath joined by
  pointers.
- **Every chapter scene**: all 156 circuit scenes of the chapters open in the sandbox, compile and
  simulate.
- **Every challenge**: each reference answer passes its own check.

## For contributors

The sandbox lives in `src/editor/` (file map in `CLAUDE.md`) and is loaded as its own chunk from
`src/ui/pages/sandbox.ts`. The model, compiler, library, edit operations, history, storage and
sharing are DOM-free and tested in Node; the view, tools and panels are DOM.

- **Document model** (`model.ts`): a workspace of chips; a chip has pins, parts, wires (interior
  corners only) and pointers. Plain JSON, schema-versioned (`store.ts` migrates and sanitizes).
- **Compiler** (`compile.ts`): a chip → `ComponentDef`. Union-find over pins, ports, wires,
  branches and same-name pointers; width and driver checks; `ends[0]` = the driver; each sink's
  `via` = the drawn path, so the router draws exactly what the user drew; pointers become
  `tags` / `tagAt`. Diagnostics instead of exceptions.
- **User library** (`library.ts`): compiled chips are cached by a hash of the chip and its
  dependencies, so an unchanged chip keeps its def object (the simulator's caches are keyed by it).
  User chips are never put in the global registry; `setUserResolver` makes `u_*` ids resolvable.
- **Runtime** (`runtime.ts`): rebuilds the simulator only when connectivity changes and carries
  state across (`Sim.carry`).
- **Plugins**: features register themselves through `registerPaletteGroup`,
  `registerPropsSection`, `registerToolbarAction`, `registerEditorPlugin`, `registerDiagSource`,
  `Editor.slots`, `paintHooks` and the right-hand dock (`dock.ts`), and are imported by the page.

Storage key: `mosfet2riscv:sandbox:v1`. File format: `{ format: 'mosfet2riscv-sandbox', schema, chips }`.
Share links: `1z` + base64url(deflate-raw(JSON)), or `1j` + base64url(JSON).
