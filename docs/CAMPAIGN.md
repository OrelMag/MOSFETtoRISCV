# Campaign mode — plan and status

The campaign (`#/campaign`) is a guided path through the site's material. It is a tree of levels.
In each level you build one component from the ones before it, starting with a NAND made of
transistors. The last required level is a pipelined, interrupt-capable 16-bit RISC-V-like
processor. Each level comes with:

- why the component is needed, meaning where it sits in the CPU
- tips that build up step by step, and entries in a codex that unlocks as you go
- a complete test set, which is the level's success criterion
- a grade based on how well the design is optimized
- a reference solution

You may skip any level, and then our solution stands in for yours.

The chapters stay open and unordered. The soft locks apply only in the campaign, and
**Unlock all** removes them.

Status legend: ✅ done · 🚧 in progress · ⏳ planned

---

## 1. Requirements (from the feature request) → where they are met

| # | Requirement | Where | Status |
|---|---|---|---|
| R1 | Campaign mode: build a NAND from transistors, then build up to a CPU | Acts 0–7 (§5) | ✅ |
| R2 | A pipelined CPU "with all the goodies": hazards, forwarding, flushes, interrupts, traps | Acts 6–7 | ✅ |
| R3 | The campaign is a **tree**; each node is a component built on its predecessors | `src/campaign/nodes.ts` (`requires`), map page | ✅ |
| R4 | Number systems | drills `n_bin`, `n_twos`, `n_float` (binary16) | ✅ |
| R5 | Assembly | Act 4 (ISA lesson, encode drill, 7 program puzzles with an editor and a stepper); `p_handler` in Act 7 | ✅ |
| R6 | Tips and tricks (Boolean logic, …) | per-node progressive `tips`, codex "trick" entries, `l_bool` (lesson + drill), K-map drill | ✅ |
| R7 | A complete test set per level (success criteria shown before you start) | `BuildChallenge.check` / puzzle tests / core harness; node panel lists them | ✅ |
| R8 | Simplified 16-bit CPU similar to RISC-V | RV16 (§3): ISA, assembler, golden model, single-cycle, pipelined and trap-capable cores | ✅ |
| R9 | Guidance and complete solutions | tips + "Show solution" / "Do it for me"; every node has a reference answer | ✅ |
| R10 | Skipping a level is allowed, and our solution is used | **Skip** marks it skipped and unlocks its part | ✅ |
| R11 | Grade solutions on optimization | `grade.ts`: ★ / ★★ / ★★★ against par on NAND, depth, period, cycles, size | ✅ |
| R12 | Optional levels: multiply, divide, fast adders, FPU | ✅ fast adders, faster core, multipliers, divider, binary16 adder / multiplier, MD in the core (multiply, stalling divide), cache, multicycle core, branch prediction | ✅ |
| R13 | A narrative (nand2tetris / *Code* / Turing Complete) explaining why each block is built | per-node `why`, act intros, the intro's anatomy diagram | ✅ |
| R14 | Each level explains why it is needed | `why` field, shown first in the node panel | ✅ |
| R15 | Codex for each element discovered, plus laws and tools (K-maps, SoP, De Morgan) | `src/campaign/codex*`, `#/campaign/codex` | ✅ |
| R16 | Start with an introduction to what a CPU looks like and why, shown schematically | `intro` node: anatomy block diagram; built blocks light up | ✅ |
| R17 | Export and import designs | campaign export (progress + chips) as well as the sandbox's own export / import | ✅ |
| R18 | Save the plan as Markdown in the repo and track each item | this file | ✅ |
| R19 | Suggest more | §8 | ✅ |
| R20 | "Unlock all" | a toggle on the map, stored in campaign progress | ✅ |

---

## 2. Design

### Levels are build challenges
A campaign build level is a `BuildChallenge` (`src/editor/challenges.ts`). It is played in the
sandbox like the 21 existing challenges: Start creates `u_ch_<id>` with its pins, and Check runs
the tests. The engine gains the following:

- **`Allowed = { lib: globs }`**: NAND, wiring, constants, displays and any of your own chips, plus
  the library parts unlocked by the level's *requirements* (the transitive closure of `requires`,
  never your progress). There are no transistors after Act 0, so every later check runs at gate
  level and can use the bit-parallel simulator.
- **Directed vectors** for table checks (0, 0xFFFF, 0x8000, shift by 15, …) on top of the random
  vectors used beyond 16 input bits.
- **`model` checks**: a sequential part (register file, pipeline register, CSR file) driven with
  random input streams and compared every cycle with a JS model.
- **`core` checks**: a whole CPU core run against the golden model (§4).

- **Constants and wiring** (constants, zero-extension, fan-out, bit reversal) are always allowed: they cost
  nothing. A level may **give** extra parts for itself only (the fast adder's prefix cells).
- **Drills** (`src/campaign/drills.ts`): generated questions with exact checkers (numbers in any base,
  a Boolean expression parser, an exact minimum-cover K-map solver with don't-cares). A drill passes
  after its goal of correct answers; ★★★ with at most 2 mistakes (a shown answer counts as one).
  The K-map shades the cells the typed expression covers as you type.
- **Clocked levels** are long deterministic sequences from a JS model (50–110 cycles: random data,
  enables, resets, writes to x0), graded on NANDs and clock period.

### Unlocks (Turing Complete style)
When you solve or skip a level, its component appears in the palette's **Unlocked parts** group as
a library part. The library part is the same circuit as the reference solution, it opens down to
NANDs, and it keeps working after a reload. Your own chips stay usable everywhere.

### Reference solutions from one description
The campaign's hardware is defined once as hierarchical library components (`src/lib/rv16/`). Each
netlist uses only NAND, wiring, and parts unlocked by earlier levels. The level's answer is that
component turned into a sandbox chip (`docFromDef`). The 21 existing hand-drawn answers are kept.
An **integrity test** checks every node: the answer compiles, passes its own test set with no
restriction violation, and meets par. This proves the whole chain from a transistor NAND to the
pipelined CPU.

### Grading
Each level has a **par** per metric:

| Level kind | Metrics |
|---|---|
| Transistor levels | transistors |
| Combinational | NANDs, depth (NAND delays) |
| Sequential | NANDs, clock period (static timing) |
| CPU cores | NANDs, period, cycles; time = period × Σ cycles |
| Program puzzles | size (words), cycles |

- ★ passes
- ★★ every metric ≤ 1.5 × par
- ★★★ every metric ≤ par

The best result is kept. Par is a target and is never required.

### Progress, skip, unlock all, export / import
- Progress is kept in local storage under `mosfet2riscv:campaign:v1`. It holds each node's status
  (locked / available / started / solved / skipped), best score, stars, chip id and puzzle source,
  plus the Unlock all flag and whether the intro has been seen.
- A node is **available** once every required node is solved or skipped. Optional nodes never
  block required ones.
- **Skip** marks a node skipped. Its part and codex entries unlock, and nothing is imported unless
  you ask for the solution.
- **Export** writes `{ format: 'mosfet2riscv-campaign', schema, progress, chips }`, where chips is
  the closure of your level chips.
- **Import** merges what it reads. Stars take the maximum, chips are imported without overwriting,
  and renamed ids are remapped.
- "Reset progress" on the home page clears the campaign too.

---

## 3. RV16: the campaign's processor

- 16-bit data and 16-bit instructions.
- 8 registers: x0 = 0, x1 ra, x2 sp, x3 a0, x4 a1, x5 a2, x6 t0, x7 t1.
- **Word addressed** and Harvard: instruction ROM and data memory are separate, and the PC
  advances by 1.
- Every field has a fixed position, so decoding is little more than wiring.

| bits | 15:13 | 12:10 | 9:7 | 6:4 | 3:0 |
|---|---|---|---|---|---|
| R / SYS | f3 | rs2 (csr) | rs1 | rd | op |
| I | imm[5:0] = instr[15:10] | | rs1 | rd | op |
| S / B | imm[5:3] | rs2 | rs1 | imm[2:0] | op |
| J | imm9 = instr[15:7] | | | rd | op |
| U | imm10 = {instr[15:7], instr[3]} | | | rd | op |

| op | name | fmt | semantics |
|---|---|---|---|
| 0000 | SYSTEM | SYS | f3 = 0, by rs2 field: 000 **illegal** (an all-zero word traps), 001 ecall, 010 ebreak, 011 mret, 100 wfi. f3 = 1/2/3: csrrw / csrrs / csrrc rd, csr, rs1 |
| 0001 | OP | R | f3: add, sll, slt, sltu, xor, srl, or, and (RISC-V funct3 order) |
| 0010 | OPX | R | f3 = 0 sub, f3 = 5 sra; other f3 values are illegal |
| 0011 | MD | R | mul, mulh, mulhsu, mulhu, div, divu, rem, remu (optional M; illegal without it) |
| 0100 | ADDI | I | rd = rs1 + sext(imm6) |
| 0101 | SHI | I | imm[5:4]: 00 slli, 01 srli, 10 srai (11 illegal); shamt = imm[3:0] |
| 0110 | LW | I | rd = M[rs1 + sext(imm6)] |
| x111 | LUI | U | rd = imm10 << 6 (op[3] is imm bit 0) |
| 10cc | BEQ / BNE / BLT / BGE | B | cc: 00 eq, 01 ne, 10 lt, 11 ge (op[0] inverts); target pc + sext(imm6) |
| 1100 | JAL | J | rd = pc + 1; pc += sext(imm9) |
| 1101 | JALR | I | rd = pc + 1; pc = rs1 + sext(imm6) |
| 1110 | SW | S | M[rs1 + sext(imm6)] = rs2 |

- **ALU control** is `{op == OPX, f3}`: 4 bits for 10 operations. SHI reuses the shift codes.
- **What is left out**, and the pseudo-instructions that replace it: andi / ori / xori, sltiu,
  bltu / bgeu (`sltu` + `bnez`), auipc, byte and halfword accesses.
- **Fixed words**: `nop` = `addi x0, x0, 0` = 0x0004; `halt` = `jal x0, 0` (a jump to itself) =
  0x000C. Only `jal` to itself halts the golden model: a branch to itself is a spin (waiting for an
  interrupt).
- **Pseudo-instructions**:
  - `li` (1 word when it fits; otherwise lui + addi with %hi / %lo rounding)
  - `mv`, `not`, `neg`, `seqz`, `snez`, `sltz`, `sgtz`
  - `j`, `jr`, `call`, `ret`, `tail`
  - `beqz`, `bnez`, `bltz`, `bgez`, `blez`, `bgtz`, `bgt`, `ble`
  - `csrr`, `csrw`, `csrs`, `csrc`
  - `push`, `pop`, `halt`, `exit`
  - directives `.word`, `.data`, `.text`
- **CSRs** (3-bit index): 0 mstatus (MIE bit 3, MPIE bit 7), 1 mie (MTIE 7, MEIE 11), 2 mip,
  3 mtvec, 4 mepc, 5 mcause (bit 15 = interrupt), 6 mscratch, 7 mcycle (read only).
- **MMIO**: the top of data memory, reachable as `imm(x0)` with a negative imm.

  | Address | Register | Notes |
  |---|---|---|
  | 0xFFFF | EXIT | |
  | 0xFFFE | CONSOLE | |
  | 0xFFFD | OUT | number stream |
  | 0xFFFC | IN | golden model only |
  | 0xFFFB | LEDS | |
  | 0xFFFA | SWITCHES | |
  | 0xFFF9 | IRQ | software-raised external interrupt |
  | 0xFFF8 | MTIME | |
  | 0xFFF7 | MTIMECMP | |

Software lives in `src/riscv/rv16/`: `isa16` (tables, encode, decode, disasm), `asm16` (with
`.data` sections: data labels are data-memory addresses), `iss16` (the golden model: every step
reports its register write, store or trap; `strictInit` flags reads of unwritten registers). The code
editor highlights RV16 (`rv16asm`) from the same tables. ✅ A random-program generator for fuzzing
(`randprog.ts`: every core level runs seeded random programs, with MD instructions for the side quests).

**Program puzzles** (`src/campaign/puzzles.ts`): each test gives IN words, data memory, switches or
interrupt times and expects OUT words, console text or memory. Graded on size (words) and cycles
(mean instructions over the tests). In the level panel: an editor (source saved as typed), Run the
tests, and a stepper over one test (registers, current line, outputs).

---

## 4. Checking a CPU core

A core level asks for a chip with fixed pins:

- **in**: `clk rst instr[16] drdata[16] (irq)`
- **out**: `pc[16] daddr[16] dwdata[16] dwe rwe rwa[3] rwd[16]`

Early stages need only the pins they use. Memory is **served by the test harness**, so it is
neither part of the design nor of its score. Each cycle the harness:

1. settles the circuit, serves `instr = imem[pc]` and `drdata = dmem[daddr]`, and repeats until
   nothing changes (a loop through memory is reported);
2. samples the store port and the register-write port;
3. applies a rising clock edge and then a falling one.

**The test set** (`src/campaign/coretests.ts`): directed programs (ALU edge cases, memory, a table,
every branch condition, calls with a stack, gcd) plus seeded random programs
(`src/riscv/rv16/randprog.ts`: registers initialised first, loads / stores in words 0–31, forward
branches only): 15 programs for Core I, 19 for Core II, 28 for Core III. They run side by side as
lanes of the bit-parallel simulator (the event-driven one when the circuit has behavioural leaves).
The clock period is measured on a bench with 8-delay instruction and data memories, so the path
PC → memory → decode → … → register counts. The core levels share one pin set, so one chip can grow
from Core I to Core III.

- **Pipelines** report register writes from W and stores from M; the same comparison works because a
correct pipeline makes the same writes in the same order, only later. Interrupt tests are written so
that nothing in main depends on exactly which instruction the interrupt lands on (main spins until the
handler has run).

**Pass**: the register-write trace and the store trace are equal to the golden model's, the
  final data memory is equal, and the core finishes within the cycle budget.
- **A failure names**: the test, the write number, the instruction (disassembled) and the cycle.
- **Interrupt tests** are software-raised and independent of where exactly the core takes the
  interrupt, so a pipelined core and the golden model agree.

---

## 5. The tree

Legend: `id` ← requires · *opt* optional · (ex) an existing sandbox challenge.

✅ playable · ⏳ on the map as "coming soon" (it can be skipped so that what follows opens).

### Act 0 — Prologue: what are we building?
- ✅ `intro`: anatomy of a CPU. The block diagram, the fetch–decode–execute loop, and why each block
  exists.
- ✅ `t_inv` (ex) ← intro
- ✅ `t_nand` (ex) ← t_inv
- ✅ *opt* `t_nor` (ex) ← t_inv

### Act 1 — Logic
- ✅ `l_bool`: Boolean algebra (identities, De Morgan, bubble pushing), lesson + simplification drill ← intro
- ✅ `g_not` (ex) ← t_nand
- ✅ `g_and` (ex) ← g_not
- ✅ `g_or` (ex) ← g_not
- ✅ `g_xor` (ex) ← g_and, g_or
- ✅ `g_mux` (ex) ← g_not
- ✅ `d_kmap`: K-map drill ← l_bool
- ✅ `g_sop`: a prime detector from its truth table via SoP / K-map, graded on NANDs ← d_kmap, g_and, g_or
- ✅ `g_wide`: 16-bit OR / zero detect as a tree, graded on depth ← g_and, g_or
- ✅ `g_dec`: 3→8 decoder ← g_wide
- ✅ `g_mux8`: 2:1 × 16 bus mux (unlocks the wider muxes) ← g_mux
- ✅ `g_eq16`: 16-bit equality ← g_xor, g_wide

### Act 2 — Numbers and arithmetic
- ✅ `n_bin`: binary and hex drill ← intro
- ✅ `n_twos`: two's complement, overflow drill ← n_bin
- ✅ `a_ha` (ex) ← g_xor, n_bin
- ✅ `a_fa` (ex) ← a_ha
- ✅ `a_add4` (ex) ← a_fa
- ✅ `a_add16` ← a_add4
- ✅ `a_inc16` ← a_ha
- ✅ `a_addsub16` ← a_add16, n_twos
- ✅ `a_slt` ← a_addsub16
- ✅ `a_shift16`: barrel shifter ← g_mux8, g_and
- ✅ `a_alu16` ← a_addsub16, a_slt, a_shift16, g_wide
- ✅ *opt* `o_fastadd`: parallel-prefix adder, graded on depth (the g / p cells are given) ← a_add16

### Act 3 — State and memory
- ✅ `s_sr` (ex) ← g_not
- ✅ `s_dlatch` (ex) ← s_sr
- ✅ `s_dff` (ex) ← s_dlatch
- ✅ `s_reg4` (ex) ← s_dff, g_mux
- ✅ `s_reg16` ← s_reg4
- ✅ *opt* `s_cnt4` (ex) ← s_reg4
- ✅ `s_pc`: program counter with reset and load ← s_reg16, a_inc16, g_mux8
- ✅ *opt* `s_fsm`: a "101" detector (Mealy machine) from its state table ← s_dff, d_kmap
- ✅ *opt* `m_ram` (ex) ← s_reg4, g_dec
- ✅ `m_rf`: 8 × 16 register file, x0 = 0, model check ← s_reg16, g_dec, g_mux8
- ✅ `m_mem`: ROM and RAM lesson (unlocks the memory parts) ← m_rf

### Act 4 — The instruction set and assembly
- ✅ `i_isa`: the RV16 instruction set (lesson + explorer) ← n_twos
- ✅ `i_enc`: encode / decode drill ← i_isa
- ✅ `p_add` ← i_isa
- ✅ `p_loop` ← p_add
- ✅ `p_mem` ← p_loop
- ✅ `p_call` ← p_mem
- ✅ `p_mul`: multiply in software ← p_loop
- ✅ *opt* `p_sort` ← p_mem
- ✅ *opt* `p_print`: print a number in decimal ← p_mul

### Act 5 — A single-cycle CPU
- ✅ `c_lesson`: the datapath ← i_isa, a_alu16, m_rf
- ✅ `c_imm`: immediate generator ← i_isa, g_mux8
- ✅ `c_ctl`: decoder / control unit (checked with don't-cares) ← i_enc, g_dec, d_kmap
- ✅ `c_br`: branch comparator ← g_eq16, a_slt, g_mux
- ✅ `c_npc`: next-PC logic ← a_add16, a_inc16, c_br, g_mux8
- ✅ `c_core1`: OP / OPX / ADDI / SHI / LUI ← c_lesson, c_imm, c_ctl, s_pc, m_rf, a_alu16
- ✅ `c_core2`: + LW / SW ← c_core1, m_mem
- ✅ `c_core3`: all of RV16I ← c_core2, c_npc
- ✅ `c_computer`: core + ROM + RAM + LED register with partial address decoding, checked cycle by cycle; then load your own RV16 program ← c_core3, p_loop
- ✅ *opt* `c_fast`: graded on clock period ← c_core3, o_fastadd

### Act 6 — Pipelining
- ✅ `pi_lesson` ← c_core3
- ✅ `pi_reg`: pipeline register with stall / flush ← s_reg16, g_mux8, g_or
- ✅ `pi_core0`: 5 stages, programs without hazards ← pi_lesson, pi_reg
- ✅ `pi_fwd`: forwarding unit ← g_eq16, pi_lesson
- ✅ `pi_core1`: + forwarding ← pi_core0, pi_fwd
- ✅ `pi_haz`: load-use hazard detection ← g_eq16, pi_lesson
- ✅ `pi_core2`: + load-use stall ← pi_core1, pi_haz
- ✅ `pi_core3`: + branch / jump flush ← pi_core2
- ✅ *opt* `o_bpred`: static branch prediction in F (jal and backward branches taken), graded on cycles over loop programs ← pi_core3

### Act 7 — The system: traps and interrupts
- ✅ `y_lesson` ← c_core3
- ✅ `y_csr`: CSR file (a long random sequence against a model) ← s_reg16, g_dec, g_mux8, y_lesson
- ✅ `y_trap`: CSR instructions, ecall / ebreak / illegal, mret (the illegal-instruction detector and the system decoder are given) ← c_core3, y_csr
- ✅ `y_irq`: interrupts ← y_trap
- ✅ `p_handler`: an interrupt-driven program ← y_lesson, p_call
- ✅ **`y_final`**: the pipelined RV16 with precise traps and interrupts ← pi_core3, y_irq

### Act 8 — Side quests (all optional)
- ✅ `o_mulseq`: shift-and-add multiplier ← a_add16, s_reg16
- ✅ `o_mularr`: 8 × 8 array multiplier ← a_add16
- ✅ `o_mcore`: the MD opcode's multiplies in your core (a 16 × 16 array is given; signed high halves by correction) ← c_core3, o_mularr
- ✅ `o_div`: sequential divider ← a_addsub16, s_fsm
- ✅ `o_dcore`: div / divu / rem / remu, holding the PC until the iterative divider is done ← o_mcore, o_div
- ✅ `n_float`: floating-point drill (fp16) ← n_twos
- ✅ `o_fpadd`, `o_fpmul`: binary16 adder and multiplier, all five rounding modes ← n_float, a_shift16 / o_mularr
- ✅ `o_cache`: direct-mapped cache, 8 one-word lines, write-through; on a hit the bench serves junk for memory ← m_mem, g_eq16
- ✅ `o_mc`: multicycle CPU (one-hot FSM: F, E, M, W) ← c_core3, s_fsm

---

## 6. Codex

The codex (`#/campaign/codex`) collects what you discover. An entry unlocks when its level is
opened (lessons) or solved / skipped (components).

- ✅ **Components**: one entry per built block (cost, structure, where it is used).
- ✅ **Laws**: Boolean identities, De Morgan, absorption, consensus, duality, completeness.
- ✅ **Tools**: truth tables, SoP / PoS, K-maps (with don't-cares), Quine–McCluskey, bubble
  pushing, NAND–NAND.
- ✅ **Numbers**: positional notation, hex, two's complement, sign extension, overflow rules,
  floating point.
- ✅ **Timing**: depth, critical path, setup / hold, clock period.
- ✅ **Architecture**: ISA, encoding, calling convention, CPI and the iron law, hazards (RAW / WAR /
  WAW, structural, control), forwarding, stalls, flushes, precise traps.
- ✅ A component entry's live datasheet (pins, truth table, measured cost) from the library parts its levels unlock (`src/campaign/datasheet.ts`).

---

## 7. Implementation phases

Each phase lands as commits on the campaign branch, with tests, and updates this file.

- ✅ **0. Plan.** This document; the roadmap now says that soft locks exist in the campaign only.
- ✅ **A. Foundation.**
  - `src/campaign/` with types, graph, progress, grade, layout, anatomy and the codex.
  - In the engine: `Allowed { lib }`, the "Unlocked parts" palette group, and the sandbox strip
    showing campaign levels (stars, Back to campaign, Next level, tips).
  - The `#/campaign` page with intro, map, node panel, lessons, codex, Unlock all, and export /
    import.
  - The 21 existing challenges as nodes.
- ✅ **B. Logic and numbers.**
  - Drills (numbers, Boolean, K-map) and the K-map widget.
  - Directed vectors and `model` checks.
  - RV16 arithmetic and state blocks; Acts 1–3.
- ✅ **C. RV16 ISA.**
  - isa16, asm16, iss16 and the samples.
  - Highlighting in the code editor.
  - Program puzzles and their UI; Act 4.
- ✅ **D. Single-cycle.**
  - Measure simulation speed first and record it here.
  - Control blocks and the reference core; the core harness; Act 5.
- ✅ **H. RV16 in the sandbox.**
  - ✅ An RV16 ROM language (`lang: 'rv16'`: 16-bit words, word addressed; RV16 highlighting, listing
    and disassembly; conversion to and from hex; an RV16 sample program).
  - ✅ `c_computer`.
  - ✅ The CPU drawer for RV16 computers (`src/editor/cpu16.ts`): a chip with an RV16 ROM and a placed core
    (any part with the core pins) is checked like the core bench does, through the core's write port and
    store port in program order, so nothing inside the core needs a name and single-cycle, multicycle and
    pipelined cores all work. It shows the listing, the registers as the core wrote them, the next expected
    write and the first mismatch. (The RV32 drawer keeps its own monitor: it reads register files by name.)
  - ✅ **Debug this test in the sandbox** (`src/campaign/bench.ts`): a failing core level offers a button that
    builds the failing program into a computer around the learner's core (ROM, a 64-word RAM decoded on its
    low bits with the golden model wrapping the same way, LEDs, the IRQ line) and opens it with the drawer.
  - ✅ **Start from your previous core** on the campaign page: a core level can begin as a copy of the
    nearest earlier core level's chip, with the new level's pins added.
- ✅ **E. Pipeline.** Pipeline blocks and the reference pipelined cores; Act 6.
- ✅ **F. System.** CSRs, traps and interrupts in the golden model, the harness and the
  hardware; Act 7 and the finale.
- ✅ **G. Side quests.** Shift-and-add and array multipliers, the divider, the binary16 drill, adder
  and multiplier (each gives the reference design's building blocks: side quests are about arranging
  them); the MD opcode in the core (`o_mcore`, `o_dcore`: their multiplier and divider units come with
  the reference as chips of their own), the cache, the multicycle core and branch prediction
  (`src/campaign/build9.ts`, hardware in `src/lib/rv16/md.ts` and `multi.ts`, `rv16Pipe({ predict })`).

### Budgets
- **Expected sizes**: about 5k NANDs for the single-cycle core, about 8k pipelined, and about 12k
  with traps and interrupts.
- **Core check in the browser**: ≤ 1.5 s (32 lanes × ≤ 1200 cycles).
- **Test suite**: ≤ 5 s per reference core and ≤ 60 s for the whole campaign.
- **Measured** (phases E, F): the reference pipelines are 10.5k (no hazard handling), 11.0k (forwarding),
  11.1k (load-use stall) and 11.2k NANDs (branch flush), period 65–82; the single-cycle core with traps and
  interrupts 9.0k (period 100); the finale, the pipeline with precise traps and interrupts, 15.1k NANDs,
  period 88, its 45 programs checked in about 1.5 s. Honest lesson for the learner: with a 16-bit ripple ALU
  the E stage is almost as slow as the whole single-cycle path, so pipelining pays only once the stages are
  balanced (the fast-adder side quest).
- **Measured** (phase G): the multiply core 9.1k NANDs, period 191 (the 16 × 16 array doubles it: why real
  cores pipeline the multiplier); with the stalling divider 11.7k, period 193, 18 cycles per divide; the
  multicycle core 6.2k, period 78 against 98, but 3.1× the cycles; the predicting pipeline 11.8k, period 85,
  13% fewer cycles than Pipeline IV on loop programs; the cache 3.5k NANDs, period 36.
- **Measured** (phase D): the reference single-cycle core is 5 748 NANDs, clock period 98 NAND delays with
  8-delay memories in the path (81 with Kogge–Stone adders). The bench runs 28 programs (≈1 240 cycles in
  all) in 0.2–0.6 s on 32 bit-parallel lanes; the event-driven fallback gives identical results.

---

## 8. More ideas (suggested, not yet scheduled)

- ✅ **Continue from your previous core**: a core stage starts from a copy of your last one.
- ✅ **Debug a failing test**: open it as a sandbox bench with probes and the timing panel.
- ⏳ **Codex as a glossary**: hover definitions in the chapters, which closes the roadmap's
  ⏳ Glossary.
- ⏳ **Achievements**: XOR in 4 NANDs, a full adder in 9, CPI < 1.2, a period below the
  reference's.
- ⏳ **A share link for campaign progress** (stars only).
- ⏳ **Bug-hunt levels**: a circuit with a planted fault, to find and fix.
- ⏳ **A timing level**: fix a setup violation, or overclock until it breaks.
- ⏳ **Where your NANDs go**: a per-component breakdown of your CPU.
- ⏳ **Boss level**: snake on an LED matrix, on your own pipelined core.
- ⏳ **Custom ISA**: an instruction table that generates the assembler (reusing isa16's tables).
